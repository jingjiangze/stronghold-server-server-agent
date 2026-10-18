# 离线聚合与「客户端运算」方案（审计）

> 针对上一版 `AI-LINEUP-CHAIN.md` 里两条错误/不足的结论做修正与设计：
> ① 「没有离线聚合」——**错**，R2 的日期键就是完整历史，缺的只是一个聚合工具；
> ② 「特征化/训练/质量复算要靠中心」——**可以下沉到客户端**，本文给出边界与信任模型。

## 一、更正：R2 就是离线语料库

| 事实 | 证据 |
|---|---|
| 日期键**只增不改**：`packs/lineup-library/<模式>__<难度>-<YYYY-MM-DD>.jsonl` | 上传 API 对已存在键返回 409；`lineupOutbox` 把 409 当作「今日键位已占，留到次日」 |
| 可以枚举全量历史 | `src/r2.mjs` 的 `listKeys(config, prefix)`：S3 ListObjectsV2 分页，**1000 条/页、最多 60 页**（6 万对象上限，远超实际） |
| 读侧只用到「最新一份」 | `src/lineup-alias.mjs` 把每库最新日期文件 CopyObject 成稳定别名；`lineupSync` 只拉别名 |

所以「离线聚合」的物料一直都在，缺的是**把历史拉下来、去重、合并**的那一步。已实现：

`tools/lineups-aggregate.mjs`
- 输入：同步到本地的 R2 前缀目录（rclone / wrangler / CDN 仓脚本都行），递归认两种文件名：
  `<模式>__<难度>-<日期>.jsonl` 与 `lineups_<模式>__<难度>.jsonl`（后者是它自己的输出，可重复跑）。
- 去重：按 `sig`（与 `server/lineupLibrary.sigOf` 同构，测试逐字比对）；坏行计数后丢弃。
- 过滤/裁剪：`--since YYYY-MM-DD`、`--max-lines N`（保留最新）。
- 输出：每库一份合并 `lineups_<键>.jsonl` + `stats.json`（含每库行数与几何特征汇总）。
- 不联网、不进游戏进程、可进 CI 做数据集快照。

## 二、可以在客户端算的三件事

| 能力 | 现状 | 方案 |
|---|---|---|
| **特征化** | 已实现 `shared/lineupFeatures.mjs`（纯函数，无 Node API，浏览器/Worker 直接 import） | cells → `{n, golden, rowMin/Max/Mean, colSpread, facings, depthShare, centroidDist}`；`summarizeFeatures()` 做均值/中位数汇总。不猜强度、不碰战斗规则 |
| **质量复算/抽样** | 引擎已具备：`sim/spec.js createBattleFromSpec(spec, dataSource)`；rehearsal 的评分口径是 **leaks 少者胜、再比 kills**（`server/match/bot.js`） | 客户端把一条记录按同 stage/难度/种子重放一局，回报 `{sig, leaks, kills, roundsPassed}`。CPU 由玩家浏览器出，中心零运算 |
| **「训练」** | 当前不是梯度训练（见 `AI-LINEUP-CHAIN.md`） | 这里的「训练」= 用聚合语料 + 客户端评分产出**质量表**（每 sig 的胜/负/leaks 分布），再决定哪些进候选库。仍是「候选 + 模拟择优」，不引入模型权重 |

### 客户端评分的最小闭环

```
聚合语料（R2 历史去重） → 抽样下发（每库 N 条候选 sig）
   → 客户端 Worker：createBattleFromSpec 重放 → {sig, leaks, kills, roundsPassed}
   → 回报（小体积，走同一专用通道，只能传训练文件）
   → 中心只做存储与统计（R2 日期键 + promote），不做 CPU 复算
```

## 三、信任模型（这一节是审计重点）

客户端不可信，所以「客户端算的质量」只能是**建议性**的：

1. **只接受已在 R2 集合里的 sig**：回报里出现库里没有的 sig 直接丢弃——防止客户端凭空造布阵刷分。
2. **多方一致才采纳**：同一 sig 至少 3 个互不相同的 host 给出同向结论（都在容差内）才计入质量表；
   单 host 的回报只留档。
3. **与服务端抽查交叉**：现有的 `SP_VERIFY=sample` 机制抽到的战斗结果，可用来给客户端评分做锚点
   （同一局服务端也算过，两边偏差超阈值则该 host 的后续回报降权）。
4. **频控与体积**：每 host 每小时回报条数上限、单条 ~100 字节级；沿用专用通道的 per-host 限流。
5. **失败开放**：客户端算不动（低端机/切后台）就什么都不报，库照常工作；不引入「必须上报」的阻塞。

## 四、成本与边界

- **浏览器 CPU**：一局模拟是秒级；只在「AI 托管 / 明确同意 / 空闲」时跑，超时即放弃，不拖累对局帧率。
- **数据体积**：4 千行/库的窗口是**读取**上限，不是语料上限；R2 历史可无限累积（键只增不改）。
- **聚合频率**：天级（缓存 300s 的别名在 promote 后才更新），不是分钟级。
- **仍未做**：真正的模型训练（需要固定特征向量、标签与离线训练环境）；当前方案到「质量表 + 候选择优」为止。

## 五、已实现 / 未实现

| 项 | 状态 |
|---|---|
| R2 历史枚举与别名 | 已有（CDN 仓，`edc7c66` 起） |
| 历史聚合工具（去重/过滤/统计） | **已实现**：`tools/lineups-aggregate.mjs` + 5 例测试 |
| 客户端特征化 | **已实现**：`shared/lineupFeatures.mjs`（纯函数，随内核可导出到 ai-local） |
| 客户端调度策略（优先级/机型/中断） | **已实现**：`shared/scoringPolicy.mjs`（托管 > 房间 > 高配空闲；低配不跑；不可见/离线立即停）+ `shared/scoringQueue.mjs`（预算、暂停、单条/全量中断） |
| 客户端评分执行壳 | **已实现**：`public/js/ai/scoringRunner.js`（信号 → 决策 → 队列 → Worker）+ Worker 新增 `t:'score'` 模式，返回每条 `{index, built, leaks, kills, score}` |
| 任务来源（抽样下发 / 从公共库拉取） | **未接线**：`nextTask()` 注入点留空——服务端下发 `b.scoring` 或客户端按 `libraryKey` 拉别名都要先定 |
| 回报通道（评分送回中心） | **未接线**：`report()` 注入点留空，需要复用专用数据通道（只收训练文件） |
| 多方一致 / 降权策略 | 设计完成，未实现 |
| 真·模型训练 | 未做（当前不需要） |
