# 用客户端本地状态「反推」对局：方案审计

> 结论：**可以反推，但不是逐帧续战**。客户端手里有每个玩家自己的棋盘/手牌/资金/商店/生命/阶段，
> 没有共享卡池剩余、随机数状态、AI 布阵序列。所以可行的形态是——
> **进程重启后，按所有玩家上报的状态重组一局，在下一个整备（PREP）边界接着打，并显式标注漂移。**

## 一、客户端到底有什么、没有什么（审计证据）

`m.public`（`server/match/match/views.js:63-158`，整帧节流，boss 回合约 1Hz）：

| 有 | 没有 |
|---|---|
| phase / round / lastRound / deadline / serverNow / modeId / difficulty / stageId | 随机种子 seed |
| factions / disabledBonds / bannedChess / bossId / hiddenBossId / bossRound / hiddenRound / bossPairs | RNG 状态 |
| players[]：playerId / seat / name / isBot / connected / alive / **lp** / bandId / shopLevel / boardCount / ready / bonds / fieldId / status / autoplay | **共享卡池剩余份数**（只有 shop.slots[].sold 布尔） |
| fields[]：fieldId / kind / players / live / progress{killed,resolved,total,done} | 阶段推进的本地权威计时器（只有 deadline + serverNow 换算） |
| teamLp / overtimeAt / bossHp / draft / sp / unite / uniteResult | AI 的行动历史（`_botFocusId` 等） |

`m.private`（`server/match/player/views.js:52-121`，每人一份）：

- **有**：funds、hand[]、temp[]、**board[]（含 row/col/dir）**、shop{level, slots[], rewardOffer}、bonds（完整）、effects、
  loadout、ops、standIns、diy/diyBanned、deployCap/deployCount、prepMapChars、bossMate、stats{kills,leaks,gold}、nextEnemies。
- **没有**：池剩余、seed、RNG、AI 的布阵序列。

客户端 `store.match` 是纯内存（`public/js/store.js:8-13`、`main.js:241-252`），**刷新即空**；
只有 token/名称/最近房间（`sp.matches`）/偏好落 localStorage。
本地战斗 runner 能导出 `b.snap`（单位级快照）/`b.ev`（事件流）/`unitStats`——但那是客户端的模拟视图，
**不是权威**，服务端不能拿它当状态源。

## 二、服务端重建需要什么、哪些只能重置（审计证据）

| 类别 | 内容 | 反推可行性 |
|---|---|---|
| 身份/配置 | seed、mode、difficulty、modeId、isSolo、aiPicksLast、battlePrefix | **必须另存**（客户端没有 seed）；否则无法保证 AI/波次一致 |
| 一次性派生 | stageId/stage/factions/bossId/hiddenBossId/disabledBonds/bannedChess/pool/itemPool | 由 seed 派生，**但需要 rngSetup 的状态**；`waves.js:169-172` 还会从 rngSetup 当前状态再派生二级流 |
| 玩家状态 | lp/funds/hand/board/shop/bonds/loadout/stats | **客户端有**，可上传 |
| 共享卡池 `left` | `pool.js:81-96`，`left = cap − Σheld − debt`，**允许为负**（#498 决策） | **不可反推**（debt 与 effect-granted 0-copy 棋子） ⇒ 按「cap − 当前持有」重置、debt 归零 |
| 道具池 | `SharedItemPool`：`left = cap − held`（`pool.js:191-210`） | **可反推**（除 unlimited-gift 家族） |
| AI 布阵 | `bot.js:1014` 每个候选消耗 `rngBots`；候选集依赖当前棋盘/地形 | **不能只靠 seed** ⇒ 用新 rngBots 重派（容差），或取宿主浏览器已有的 rehearsal 结果 |
| AI 战斗 | `sim/ai.js` 无随机源；Battle 自带 seed（`Battle.js:77-78`） | **可完全重算** |
| 房间回放 | `room.replay` 只存「最后一帧 m.public + 每人 m.result」（`lobby.js:912-948`） | 不是录像，不能用来续战 |

## 三、容差（这是方案能被接受的关键）

| 项 | 恢复方式 | 容差 |
|---|---|---|
| 玩家棋盘/手牌/资金/生命/商店 | 客户端上报（白名单 + 有界校验） | **精确**（以最后一次 PREP 的 `m.private` 为准） |
| 共享卡池剩余 | 按 `cap − 当前所有玩家持有` 重算，debt 归零 | **漂移**：商店出现概率会变；单局最多影响后续几次刷新 |
| 道具池 | 同上（可反推，误差只在 unlimited-gift） | 近似 |
| AI 的布阵 | 新 `rngBots`（seed 派生 + 恢复时的轮次）重派；优先取宿主浏览器缓存的选择 | **漂移**：AI 可能换一套布阵，但强度不变（仍走 rehearsal 择优） |
| 波次/关卡/首领 | 由 seed 重新派生 | 精确（前提是 seed 已存） |
| 进行中的战斗 | **丢弃**：恢复到下一个 PREP，重打这一回合的整备 | 明确：不做「战斗中续战」 |
| 阶段计时 | deadline 重新给（新一轮） | 精确（新时限） |

## 四、协议与流程（建议）

```
① 服务端启动/重启后，房间壳恢复（T1），对局为空
② 客户端重连（hello）拿到新 playerId，凭 sp.matches 自动 join（本次已实现）
③ 服务端发现「这个房间原本在打、但没有 match」→ 向所有座位下发 b.snapshotRequest { matchId, round, phase }
④ 客户端回 b.snapshot { …见 shared/matchSnapshot.mjs 的白名单… }
⑤ 全部活人齐了（或 15s 超时，缺的按默认值补）→ 服务端 rebuildMatch(snapshots, seed, rngState)
⑥ 重建后广播 m.public，带 recovered: { at, drift: ['pool','ai-layout'], missing: [...] }
⑦ 对局从下一个 PREP 继续；标记为非排位（防作弊）
```

- **seed 必须由服务端保存**（房间壳里带 `seed`/`rngSetup.state` 两个字段即可，见 T2 清单）——
  否则上面的「精确」项全部退化为随机。
- 快照走 WS（不是 HTTP）：与现有 `b.*` 同一通道；`shared/matchSnapshot.mjs` 已经给出白名单、
  尺寸上限（16 KB/人）与越界丢弃规则。
- **反作弊**：客户端可以谎报 LP/棋盘，所以 recovered 局必须
  ① 标记 `recovered` 并在结算里标注；② 不计排行/不计学习库；③ 单房间最多恢复一次；
  ④ 多人上报互相对照（棋盘格数/装备与公共视图 `boardCount` 对不上就拒绝）。

## 五、p2p 与服务器联机、AI 本地

| 形态 | 谁是权威 | 重启意味着 | 反推怎么用 |
|---|---|---|---|
| 服务器联机（ms/公网） | 服务器进程 | 服务端内存全丢 | 房间壳 + 快照重建都在服务端进程里 |
| p2p | 房主机器上的游戏进程 | **房主进程重启** | 同一套重建逻辑，只是「服务器」在房主机器上；玩家的 ws 经隧道重连到房主机。房主自己的客户端也在本地，快照最全 |
| AI 本地 | 服务端仍持有 Match；AI 的**战斗**可在客户端/服务端重算 | 同上 | AI 战斗由 seed 重算（无需上报）；AI 布阵按第四节的漂移策略重派，或复用宿主浏览器 rehearsal 的选择 |

p2p 的一个额外优势：房主的客户端和游戏进程在同一台机器上，**即使服务端进程重启，
房主浏览器的 store 里仍有最后一份 `m.public/m.private`**——快照请求的第一份几乎总能拿到。

## 六、落地状态

| 项 | 状态 |
|---|---|
| 快照格式与校验（白名单/有界/缺字段/整组检查） | **已实现**：`shared/matchSnapshot.mjs` + 6 例测试 |
| 客户端自动回房间（T1 客户端半边） | **已实现**（`shared/resumeTarget.mjs` + `main.js`） |
| 房间壳持久化（T1 服务端半边，含 seed） | **未做** |
| `b.snapshotRequest` / `b.snapshot` 协议 + `rebuildMatch` | **未做**（需要服务端 Match 重建器） |
| 非排位标记与一致性校验 | **未做**（规则已在上面写死） |

## 七、建议顺序

1. **T0 排水部署**（不重启在打的局）——零成本、零丢局；
2. **T1 房间壳 + seed 持久化**（快照重建的前提）；
3. **本次的快照协议 + 重建器**（先只在 COOP 开，SOLO 直接重开一局即可）；
4. 跑一轮「杀进程 → 重建 → 逐字段比对」的回归，把漂移项写成允许集合。
