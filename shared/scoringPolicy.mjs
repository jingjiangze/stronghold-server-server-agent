// shared/scoringPolicy.mjs — 客户端什么时候允许跑「布阵评分」模拟（纯函数，浏览器与 Node 通用）。
// (i18n-ignore-file: reason 是给开发者/调试看的判定理由，不进 UI —— 见 docs/I18N.md)
//
// 用户裁决的优先级（高 → 低）：
//   1. 托管中（away 或 autoplay）：玩家把操作交给 AI，页面本来就不等他 → 优先跑模拟；
//   2. 房间界面（房间/大厅屏）：不在对局里，没有实时操作压力 → 次优先；
//   3. 压力不大（high 配置的机器 + 页面空闲）：对局里但页面不吃紧时，才用空闲时间跑。
// 低配机（低核数/低内存）任何情况下都不主动跑；一旦不可见、离线、或排队已满，立刻停。
//
// 这个模块只做「该不该跑、跑多快」的判断，不碰 Worker、不碰网络——便于用注入的输入在 Node 里逐条断言。

/** 跑模拟的模式：off 不跑；idle 只在空闲时跑一条；room 房间界面持续跑；autoplay 托管时最高优先。 */
export const SCORING_MODES = Object.freeze(['off', 'idle', 'room', 'autoplay']);

/**
 * 机器档位：high 才允许「对局内空闲时」跑；low 完全不跑；其余只在托管/房间跑。
 * @param {{ cores?: number, memory?: number, benchmarkMs?: number | null }} [d]
 *   cores: navigator.hardwareConcurrency；memory: navigator.deviceMemory（GB，可能缺失）；
 *   benchmarkMs: 一段固定微基准的耗时（毫秒，越小越快；缺失时按核数/内存估）
 */
export function deviceTier({ cores = 2, memory = 0, benchmarkMs = null } = {}) {
  const c = Number(cores) || 2;
  const m = Number(memory) || 0;
  // 有实测基准就信基准（<12ms 算快，>40ms 算慢），否则按核数 + 内存估
  if (Number.isFinite(benchmarkMs)) {
    if (benchmarkMs <= 12 && c >= 6) return 'high';
    if (benchmarkMs >= 40 || c <= 4) return 'low';
    return 'mid';
  }
  if (c >= 8 && m >= 8) return 'high';
  if (c <= 4 || (m > 0 && m <= 4)) return 'low';
  return 'mid';
}

/**
 * 是否允许跑评分模拟，以及以什么强度。
 * @param {{
 *   autoplay?: boolean, away?: boolean, screen?: string, visible?: boolean, online?: boolean,
 *   deviceTier?: 'high'|'mid'|'low', pageBusy?: boolean, queued?: number, maxQueue?: number,
 * }} s
 * @returns {{ run: boolean, mode: 'off'|'idle'|'room'|'autoplay', reason: string }}
 */
export function decideScoring({
  autoplay = false, away = false, screen = '', visible = true, online = true,
  deviceTier: tier = 'mid', pageBusy = false, queued = 0, maxQueue = 1,
} = {}) {
  if (!visible) return { run: false, mode: 'off', reason: '页面不可见' };
  if (!online) return { run: false, mode: 'off', reason: '离线（结果无处可报）' };
  if (queued >= maxQueue) return { run: false, mode: 'off', reason: '队列已满' };
  if (tier === 'low') return { run: false, mode: 'off', reason: '低配机不主动跑模拟' };
  // 1) 托管：玩家把操作交给了 AI，页面最不缺这几秒
  if (away || autoplay) return { run: true, mode: 'autoplay', reason: '托管中，优先跑' };
  // 2) 房间界面：不在对局内，没有实时操作
  if (screen === 'room' || screen === 'lobby') return { run: true, mode: 'room', reason: '房间界面，次优先' };
  // 3) 对局内：只有高配 + 页面空闲才跑
  if (tier === 'high' && !pageBusy) return { run: true, mode: 'idle', reason: '高配且空闲，低优先跑' };
  if (pageBusy) return { run: false, mode: 'off', reason: '页面忙（掉了帧/正在结算）' };
  return { run: false, mode: 'off', reason: '对局中且非托管，不抢 CPU' };
}

/** 模式 → 每隔多久检查一次任务（毫秒）。托管最快，空闲最慢。 */
export function pollIntervalFor(mode) {
  switch (mode) {
    case 'autoplay': return 1500;
    case 'room': return 4000;
    case 'idle': return 12000;
    default: return 0;
  }
}
