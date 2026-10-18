# 服务器部署/重启后的重连方案（审计）

> 目标：服务器重启（发版、崩溃、平台重建容器）之后，玩家能**复用本地已有数据**尽快回到原处。
> 审计结论先给：**能复用身份与房间，不能复用对局**——对局状态 100% 在服务端内存，客户端本地没有可复原的副本。

## 一、现状事实（代码证据）

| 事实 | 证据 |
|---|---|
| 对局/房间状态全在内存 | `SessionRegistry` 是纯内存 Map（`server/net.js`）；`Match` / `PlayerState` 是活对象，定时器、场、runner 都在里面，无任何落盘 |
| 重启后 token 必然 miss | 新进程没有旧 session → `hello` 走 `registry.create()` → **新 playerId** |
| 客户端识别到 id 变化就回大厅 | `public/js/main.js` 的 `onWelcome`：`prevId !== msg.playerId` → `backToLobby()`（清 room/match/ticker）+「会话已重置」提示 |
| 重连窗口 | 默认 10 分钟（`server/net.js` `reconnectWindowMs`）；solo 对局延到 24h（`lobby.js`） |
| 同进程内重连回原座位是现成的 | `lobby.js` 的 `seat.connected=true` → `broadcastState` → `resync`；`room.replay` 缓存上一局的结束帧 |
| 客户端已持久化 | `sp.token`（sessionStorage）、`sp.tokens`（localStorage，最近 4 个）、`sp.name`、`sp.matches`（每个 token 记房间名+房间码）、`sp.pref.*` |
| `sp.matches` 原来只写不用 | 仅在「在房间里且有自己的座位」时写入；除 `resumeMatch` 的显式恢复按钮外，没有任何自动路径使用它 |

## 二、本地数据能复用到什么程度

| 层 | 客户端本地有什么 | 重启后能否复用 |
|---|---|---|
| 身份 | 名称、本标签页 token、最近 4 个 token；token 与 playerId 一一绑定 | **不能**：服务端 session 已失，token 必然 miss；只能拿到新 playerId |
| 房间 | `sp.matches` 里的房间码（+ 名称） | **可以**：房间壳若还在，`room.join(code)` 就能回去 |
| 对局 | 页面内存里的 `m.public` / `m.private` 视图、本地战斗实例 | **不能**：刷新即失；且服务端才是权威，缺共享卡池等字段，无法反推一局 |
| 静态数据 | `/data/*.json` 已按页加载并缓存（`warmGameData`） | **可以**：同页复用；重启用浏览器缓存 |

所以「复用本地数据」的正确边界是：**用本地记录把玩家送回原来的房间**，而不是「接着上一局」。

## 三、三档方案（按代价排序）

### T0 · 排水部署（零丢局，最优先）

发版/重启前先让场上对局自然结束：网关的 `handleGameRedeploy` 从「场上有局就 409」改成 **drain**——
轮询 `/healthz` 的 `matches/rooms/humans` 归零再 `reset_restart`，超时（建议 15 分钟）强制重启。
不改变任何状态模型，只改变「什么时候重启」。**这是唯一能做到零丢局的措施**，其余都是补偿。

### T1 · 房间壳持久化 + 客户端自动重进（本次已实现客户端一半）

- **服务端（未做）**：`Lobby` 新增 `snapshotRooms()` / `restoreRooms()`，只存
  `code / mode / difficulty / variant / private / matchCount`（**不存 seats、不存 match**）；
  恢复时 `match=null`、seats 空、`hostId=null`，靠现有的房主迁移接住第一个进来的人。
- **客户端（本次已做）**：`onWelcome` 检测到 playerId 变化时，先读 `identity.recoverable()`（本地
  `sp.matches`，带时间戳），用 `shared/resumeTarget.mjs` 选一条**在 10 分钟窗口内**的记录，
  设 `ui.pendingJoin = code` 走既有的自动加入通道；房间不在时按原路径回大厅（安全降级）。
  记录的时间戳在每次 `rememberMatch` 时写入。

效果：重启后玩家自动回到同一个房间（座位已清空，需要重新入座/等房主），不用手动找房间码。
对局本身不会恢复（那是 T2）。

### T2 · 对局粗快照（真要「接着这一局」）

- 恢复点选 **PREP 进入时**（`startRound` 会清空场/runner/wave，最干净；COMBAT/UNITE 有活战斗对象不可序列化）。
- 必须存（字段名已按 `server/match/Match.js` 构造函数核对）：Match 身份
  `seed / roomCode / mode / difficulty / modeId / isSolo / aiPicksLast / battlePrefix`、`players` + `order` +
  `spectators`、`phase / round / uidSeq / deadline / overtimeAt`、`pool`（cap/left/tier + banned）、
  `itemPool`（left 由持有推导）、`diyStock`（玩家私有 stock，含负值）、`stageId / stage / factions /
  bossId / hiddenBossId / bossPairs`、`disabledBonds / staticInactiveBonds / bannedChess`、六条 RNG 的 `state()`、
  `teamLp / bossPool(hp+byPlayer) / hiddenLayerSum / outcome`、`draft / sp / wave / bossWaves`。
  ⚠️ 早版本这里写的 `cs / vs / stageForced` 在当前代码里不存在（审计核对时发现），已更正。
- RNG 可精确续流：`rng.state()` 存、`createRng(savedState)` 恢复（6 个流）。
- 难点：有玩法插件的房间对局跑在独立子进程（父进程只有 MatchProxy），快照要么子进程自己写盘，
  要么由它上报；漏一个字段就会出现怪状态。工作量天级。

## 四、本次落地的改动

| 文件 | 改动 |
|---|---|
| `shared/resumeTarget.mjs`（新增） | 纯函数 `pickResumeTarget(list, {now, maxAgeMs})`：只认完整房间码、限 10 分钟窗口、多条取最新、无时间戳的旧记录仍可试但排后、未来时间戳忽略 |
| `public/js/net.js` | `sp.matches` 的记录带 `at`（最后一次确认时间）；`identity.recoverable()` 一并返回 |
| `public/js/main.js` | 会话重置分支：先用本地记录挑一个目标，再 `backToLobby()`；有目标则设 `pendingJoin` 并提示「正在尝试回到房间 {code}」，失败仍回大厅 |
| `test/resume-target.test.js` | 5 例：空/坏记录、取最新、过期不试、无时间戳排后、未来时间戳忽略 |

## 五、建议顺序

1. **T0** 先上（部署流程，零风险、零丢局）；
2. **T1 服务端**（房间壳 snapshot/restore）与本次的客户端自动重进配套——这样重启后房间还在，玩家自动回去；
3. **T2** 单独排期，按上面「先 PREP 恢复点 + 必须存字段」的清单做，并配一个「快照 → 恢复 → 逐帧比对」的回归。
