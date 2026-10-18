// public/js/ai/scoringRunner.js — 客户端「布阵评分」的调度壳（策略 + 可中断队列 + Worker 执行）。
// (i18n-ignore-file: 日志与中断原因是诊断输出，不进 UI —— 见 docs/I18N.md)
//
// 分层（便于在 Node 里测，不把 DOM 拖进断言）：
//   shared/scoringPolicy.mjs  决定「现在能不能跑、跑多快」——纯函数；
//   shared/scoringQueue.mjs   任务队列、预算、暂停/中断语义——纯逻辑；
//   本文件                    把它们接到浏览器：读信号 → 决定 → 取任务 → 交给 Worker → 回报。
//
// 信号来源（全部注入，缺省从 store / document / navigator 读）：
//   autoplay / away  玩家此刻是否把操作交给了 AI（托管）——最高优先；
//   screen           'room' / 'lobby' / 其它——房间界面次优先；
//   visible/online   页面可见、连接在线；任一为假立即中断（结果无处可报）；
//   pageBusy         页面吃紧（对局内掉帧、正在结算）——高配机也不再抢 CPU；
//   deviceTier       机器档位（见 shared/scoringPolicy.deviceTier）。
//
// 中断是协作式的：队列的 isAborted(id) 是运行器在切片之间检查的点；真正的硬中断 = 终止 Worker，
// 与 public/js/battle/rehearsal.js 的做法一致（消息只能在当前模拟结束后才被读到）。
//
// 任务来源与回报都是注入的：`nextTask()` 给下一批候选（服务端下发 / 从公共库拉取都由调用方决定），
// `report(task, results)` 负责把评分送出去。两者都没有时本模块不启动，避免空转。

import { decideScoring, deviceTier, pollIntervalFor } from '../../../shared/scoringPolicy.mjs';
import { createScoringQueue } from '../../../shared/scoringQueue.mjs';

/** 一段固定的微基准（越大越慢），给 deviceTier 一个实测值；失败返回 null（退化为按核数估）。 */
export function microBenchmark(iterations = 200000) {
  try {
    const t0 = (globalThis.performance || Date).now();
    let x = 0;
    for (let i = 0; i < iterations; i++) x = (x + i * 2654435761) % 2147483647;
    const ms = (globalThis.performance || Date).now() - t0;
    return Number.isFinite(ms) && x >= 0 ? ms : null;
  } catch { return null; }
}

/**
 * @param {{
 *   signals?: () => { autoplay?: boolean, away?: boolean, screen?: string, visible?: boolean, online?: boolean,
 *                     pageBusy?: boolean, deviceTier?: string },
 *   nextTask?: () => ({ id: string, playerId: string, cap: number, specs: object[] } | null),
 *   report?: (task: object, results: object[]) => void,
 *   createWorker?: () => Worker,
 *   log?: object,
 *   now?: () => number,
 * }} deps
 * @returns {null | { start: () => void, stop: () => void, kick: () => void, state: () => object }}
 *   null when there is no task source (nothing to score) — the caller never gets a spinning loop
 */
export function installScoring({
  signals = null, nextTask = null, report = null,
  createWorker = () => new Worker('/js/battle/rehearsalWorker.js', { type: 'module' }),
  log = console, now = () => Date.now(),
} = {}) {
  if (typeof nextTask !== 'function') return null;
  const queue = createScoringQueue({ maxQueue: 1, budgetMs: 20000, now });
  const tier = (signals && signals().deviceTier) || deviceTier({
    cores: globalThis.navigator?.hardwareConcurrency || 2,
    memory: globalThis.navigator?.deviceMemory || 0,
    benchmarkMs: microBenchmark(),
  });

  let worker = null;
  let timer = null;
  let current = null;       // { task, worker }
  const stats = { scored: 0, batches: 0, errors: 0, interruptions: 0 };

  /** 与 public/js/battle/rehearsal.js 同一套：Worker 就绪后先给数据，再给任务；中断即终止。 */
  function ensureWorker(onReady) {
    const w = createWorker();
    w.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (!msg) return;
      if (msg.t === 'ready') { onReady(w); return; }
      if (msg.t === 'done' && current && msg.taskId === current.task.id) {
        queue.done(current.task.id);
        if (Array.isArray(msg.results)) { stats.scored += msg.results.length; stats.batches++; report?.(current.task, msg.results); }
        else stats.errors++;
        finish();
        return;
      }
      if (msg.t === 'error') {
        stats.errors++;
        log.warn?.('[scoring] worker error', msg.message);
        queue.done(current?.task?.id || '');
        finish();
      }
    };
    w.onerror = (e) => { stats.errors++; log.warn?.('[scoring] worker failed', e?.message || e); finish(); };
    return w;
  }

  function stopWorker() {
    if (!worker) return;
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
    current = null;
  }

  function finish() { stopWorker(); tick(); }

  function tick() {
    const sig = signals ? signals() : {};
    const decision = decideScoring({
      autoplay: !!sig.autoplay, away: !!sig.away, screen: sig.screen || '',
      visible: sig.visible !== false, online: sig.online !== false,
      deviceTier: sig.deviceTier || tier, pageBusy: !!sig.pageBusy, queued: queue.size(), maxQueue: 1,
    });
    if (!decision.run) {
      if (decision.mode === 'off' && (queue.state().running || queue.size())) {
        stats.interruptions++;
        queue.abort(null, decision.reason); // 协作式中断：清空并暂停
        stopWorker();
      }
      return;
    }
    queue.resume();
    if (current) return; // one batch at a time
    const task = queue.size() ? queue.next() : (queue.push(nextTask() || {}) ? queue.next() : null);
    if (!task) return;
    current = { task };
    worker = ensureWorker((w) => { w.postMessage({ t: 'score', ...task }); });
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, pollIntervalFor('autoplay'));
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } queue.abort(null, '停止'); stopWorker(); },
    /** 外部条件变化（托管开始/结束、界面切换）时立刻重算一次，不等轮询。 */
    kick: tick,
    state: () => ({ ...stats, tier, queue: queue.state(), running: !!current }),
  };
}
