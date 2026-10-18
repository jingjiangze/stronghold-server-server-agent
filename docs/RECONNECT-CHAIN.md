# 断线重连链路（当前实现，完整版）

> 覆盖三种断线：**网络抖动**（socket 断、页面还活着）、**页面刷新/重开标签**（socket 与内存全丢）、
> **服务端进程重启**（会话表与对局全丢）。三种走的是同一条客户端状态机，但恢复深度不同。
> 所有常量与分支都取自当前代码；文件路径相对服务器仓根目录。

## 〇、一图流

```
                     网络抖动                 页面刷新               服务端重启
客户端               socket close          新页面 + 旧 token      新进程 + 旧 token
                       │                       │                       │
                       ▼                       ▼                       ▼
                  reconnecting             connecting            handshaking
                  (指数退避)                (hello 带 token)        (hello 带 token)
                       │                       │                       │
                       └───────────┬───────────┴───────────┬───────────┘
                                   ▼                       ▼
                        token 命中 → 同一 playerId      token miss → 新 playerId
                                   │                       │
                                   ▼                       ▼
                     resync: room.state + m.public     onWelcome 检测到 id 变化
                     + m.private + 战场帧 + m.result        │
                                   │                        ▼
                                   ▼                  backToLobby()
                        客户端清掉服务端没重推的部分        │
                        （RESTORE_GRACE_MS=1.5s 后）        ├─ 本地 sp.matches 有 10 分钟内的记录
                                   │                        │    → pendingJoin 自动 join（失败回大厅）
                                   ▼                        └─ 否则回大厅 + 「会话已重置」提示
                              继续对局
```

## 一、客户端连接层（`public/js/net.js`）

### 状态机

`idle → connecting → handshaking → connected → online`，断线后进入 `reconnecting`，不可恢复时 `closed`。

| 状态 | 含义 |
|---|---|
| `connecting` | 首次建连（`attempt === 0`） |
| `handshaking` | socket 已开，等 `welcome` |
| `connected` | 收到 welcome 但 hello 被拒（版本/满员），等重发 hello |
| `online` | 可发请求 |
| `reconnecting` | 已联机过又断了，正在退避重试 |
| `closed` | 手动关闭 / 被替换（4001）/ 无法恢复 |

### 常量

| 常量 | 值 | 作用 |
|---|---|---|
| `HELLO_TIMEOUT_MS` | 8000 | hello 发出后 8 秒没 welcome ⇒ 静默换连（不弹横幅） |
| `PING_INTERVAL_MS` | 4000 | 每 4 秒 ping |
| `DEAD_AFTER_MS` | 15000 | 最老一条未应答 ping 超过 15 秒 ⇒ 判定死连接，主动重连 |
| `BACKOFF` | base 500 / ×2 / max 10000 / jitter ±20% | 重连退避 |
| `REQUEST_TIMEOUT_MS` | 8000 | 单个请求的超时（排队中的请求同样受它约束） |

### 重连期间的请求

`request()` 在 `connecting / handshaking / reconnecting` 且**已有名字、非手动关闭**时把请求**排队**，
`welcome` 后统一 flush（仍受各自超时约束）；其余情况立即 `OFFLINE` 拒绝。
所以玩家在断线期间点的操作不会静默丢失，也不会永远挂着。

### 关闭码（`server/net.js` 的 `CLOSE`）

| 码 | 含义 | 客户端行为 |
|---|---|---|
| 4001 `REPLACED` | 同一 token 在另一个标签页连上 | **不自动重连**，横幅提示「该身份已在其他页面登录」+「在此页面继续」 |
| 4002 `HELLO_TIMEOUT` | 服务端等 hello 超时 | 静默换连（保持当前状态，不弹横幅） |
| 1008 `POLICY` | 滥用洪泛被踢 | 不自动重连 |
| 1001 `SHUTDOWN` | 服务端优雅关闭 | 正常走重连退避 |

## 二、身份与本地数据（`public/js/net.js` identity + `public/js/main.js`）

| 存储 | 键 | 内容 |
|---|---|---|
| sessionStorage | `sp.token` | 本标签页的 token（刷新本页仍用它） |
| sessionStorage | `sp.entered` | 已过标题页（刷新后自动重进） |
| localStorage | `sp.tokens` | 本浏览器最近 4 个 token（关标签再开可续） |
| localStorage | `sp.name` | 名字 |
| localStorage | `sp.matches` | 每个 token 记 `{ name, code, at }`（房间名 + 房间码 + 最后确认时间） |

- `identity.init()` 决定本页用哪个 token：优先本页 token → 否则最近 token；跳过被**其他活标签页**
  通过 BroadcastChannel 声明占用的 token（防两个标签互相踢）；`CLAIM_QUERY_MS = 150`。
- `sp.matches` 在「在房间里且有自己的座位」时写入（`main.js` 的 `onRoomState`），带 `at` 时间戳。

## 三、服务端会话与重连（`server/net.js` / `server/lobby.js`）

### 会话表

`SessionRegistry` 是**纯内存** Map（token → session）。断线后 session 不立即删，保留到重连窗口结束：

| 场景 | 窗口 |
|---|---|
| 普通房间 | `reconnectWindowMs` 默认 **10 分钟** |
| solo 对局 | `soloReconnectWindowMs` 默认读 `data` 的 `singleReconnectTime`（**24 小时**），兜底 86400 秒 |
| 冻结中的对局 | 由 Match 的 `frozenReconnectMs` 决定 |

窗口到期 → `onExpire`：移出房间、清 `pendingResult`。

### hello 之后重推什么（`onHello` → `resync`）

1. `room.state`（房间层：code / hostId / mode / difficulty / inMatch / seats / spectators；p2p 分支另有 `inviteUrl`）；
2. 若 `room.match` 存在 → `onReconnect`：
   - `m.public`（整帧，含 phase/round/deadline/players[]/fields[]/boss 等）；
   - `m.private`（该玩家自己的 funds/hand/board/shop/bonds/loadout/stats…）；
   - clientCombat 模式下补发战场帧（`_resendBattle`）；
   - 若对局已结束，补发 `m.result`；
3. 若对局已结束且房间回到大厅 → 从 `room.replay` 补发**最后一帧 `m.public` + 该玩家的 `m.result`**；
4. 重复 hello 会被合并：重活（对局状态/结果回放）每 session 最多 `resyncMinGapMs = 1000` 一次。

### `room.replay`（结算时的掉线补帧）

`onMatchEnd` 时缓存 `{ publicFrame: 最后一份 m.public, frames: Map<playerId, m.result> }`；
结算时掉线的人下次 resync 仍能拿到结果；玩家在房间里有动作（ready/离开）即从 pending 删除，
pending 清空、房间销毁、下一局开始都会清掉它。**它不是录像**，不能用来续战。

### 志愿者冻结

对局中所有已连接真人掉线 ⇒ `holdForReconnect`：对局**冻结**而不是继续推进；冻结期内有人回来 ⇒
`thawForReconnect` 继续；超时（`frozenReconnectMs`）⇒ 结算为 `abandoned`。

## 四、三种断线场景的实际路径

### A. 网络抖动（页面还活着）

socket close / 心跳静默 ⇒ `reconnecting` ⇒ 退避重连 ⇒ `hello` 带 token ⇒ token 命中 ⇒ 同一 playerId
⇒ 服务端 resync 重推 ⇒ 客户端保留本地 store 内容，只丢弃服务端没重推的部分（`RESTORE_GRACE_MS = 1500` 后
`maybeFinishRestore`）。断线期间排队的请求在 `welcome` 后发出；`b.result` 这类权威上报若标了
`undelivered`，会在 `status === 'online'` 时 `redeliver()`。

### B. 页面刷新 / 重开标签

新页面没有内存状态；token 从 sessionStorage（刷新）或 localStorage 最近一条（重开）取。
hello 后如果窗口内，仍是同一 playerId ⇒ 走 A 的 resync 全量重推（room.state + m.public + m.private + 战场帧）。

### C. 服务端进程重启（发版 / 崩溃 / 容器重建）

服务端内存全丢 ⇒ token miss ⇒ `registry.create()` 发**新 playerId**。客户端 `onWelcome` 检测到 id 变化：

1. 读本地 `sp.matches`，用 `shared/resumeTarget.mjs` 的 `pickResumeTarget()` 选一条**10 分钟窗口内**的记录
   （只认完整房间码；多条取最新；无时间戳的旧记录仍可试但排后；未来时间戳忽略）；
2. `backToLobby()` 清掉旧的 room/match/ticker/emote；
3. 命中 ⇒ 设 `ui.pendingJoin = code`，`schedulePendingJoin()`（延迟 `JOIN_DELAY_MS = 350`）走既有自动加入通道：
   - 房间壳还在（同一进程内会话过期、或服务端恢复了房间壳）⇒ **回到原房间**；
   - 房间不在 ⇒ 走普通失败路径，回大厅；
4. 未命中 ⇒ 回大厅并提示「服务器会话已重置」。

**注意**：对局状态本身不恢复——`Match`/`PlayerState` 全在服务端内存，重启即失。
「用本地状态反推一局」的设计与边界见 `docs/RECONNECT-LOCAL-REBUILD.md`，魔搭版见 `docs/RECONNECT-MOTA.md`。

## 五、p2p 形态的差异

- 玩家的 ws 连的是**自己本机** `127.0.0.1:<srcPort>`（openp2p 隧道到房主机器上的游戏进程），
  `defaultWsUrl()` 只按 `location` 推导，所以 p2p 与服务器联机走的是**同一套**客户端状态机。
- 「服务端重启」在 p2p 下 = **房主进程重启**：客户端页面仍活着，旧 token 在房主新进程里必然 miss ⇒
  新 playerId ⇒ 走上面 C 的路径；客户端本地 store 里仍有最后一份对局视图（但权威已失）。
- 房主进程重启后，房间需要重建（当前没有房间壳持久化）；平台侧的 `room.state.inviteUrl` 随房间重建重新登记。
- p2p 的一个天然优势：房主自己的客户端与游戏进程在同一台机器上，本地快照最全——这也是
  「客户端携带恢复包」在 p2p 上最先能落地的原因。

## 六、客户端 UI 表现（`public/js/ui/connBanner.js`）

| 连接状态 | 横幅 |
|---|---|
| 首连（从未 online）的 connecting/handshaking/idle | 不显示 |
| `reconnecting` | 「连接中断，重连中」+「第 N 次 · Xs」+「立即重连」（局内移到顶栏下方） |
| `online` 且正在恢复（`ui.restoring`） | 「正在同步同盟状态…」 |
| `online` 但本页构建过期 | 「服务器已更新，本局结束后刷新」 |
| `closed` / 被替换 / hello 被拒 | 对应文案 + 「重新连接」/「在此页面继续」/「重试」 |

## 七、这条链路**不**覆盖的

| 边界 | 说明 |
|---|---|
| 对局状态跨重启 | 不落盘，重启即失；反推方案未接线（见 `RECONNECT-LOCAL-REBUILD.md`） |
| 房间壳跨重启 | 未持久化（T1 未做）；重启后靠客户端 `sp.matches` 尝试重进，但房间本身要先被重建 |
| 房主/玩家清缓存 | `sp.matches` 丢失 ⇒ 只能手动输房间码 |
| 单房间多端恢复的一致性 | 快照格式与一致性校验已实现（`shared/matchSnapshot.mjs`），重建器未接线 |
| 跨进程（玩法插件子进程）的对局 | 快照必须由子进程上报，当前无实现 |
