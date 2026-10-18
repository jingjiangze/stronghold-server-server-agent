// shared/scoringQueue.mjs — 可中断的评分任务队列（纯逻辑，无 Worker / 无网络）。
//
// 为什么要独立一层：模拟要能在三种时刻被打断——玩家从托管回来、对局进入需要响应的阶段、页面
// 不可见 / 离线。这些中断是**外部条件**，不该让调用方各自记状态；队列持有「暂停原因」与「预算」，
// 运行器每一轮问它「还能不能继续（拿什么任务）」，跑完一个再问一次。
//
// 语义：
//   · push(task)      入队（超过上限直接拒绝，调用方记一次丢弃即可）
//   · next()          取下一个任务；暂停中 / 超预算 / 队列空 → null
//   · pause(reason)   暂停并记原因（幂等；多个原因取最后一个非空）
//   · resume()        恢复（清原因，重置本轮预算）
//   · abort(taskId?)  中断：不带 id = 全部丢弃并暂停；带 id = 只取消那一条（它可能正在跑）
//   · isAborted(task) 运行器在长任务的每个切片里检查它（任务带一个 token 字段）
//
// 这是「协作式中断」：队列不杀线程，只给运行器一个稳定的判断点；真正的硬中断由运行器终止 Worker。

/** @typedef {{ id: string, [k: string]: any }} ScoringTask */

/**
 * @param {{ maxQueue?: number, budgetMs?: number, now?: () => number }} [opts]
 *   budgetMs: 一次「允许跑」的连续工作时间上限（到点自动暂停，避免页面长时间被占）
 */
export function createScoringQueue({ maxQueue = 1, budgetMs = 20000, now = () => Date.now() } = {}) {
  /** @type {ScoringTask[]} */
  let items = [];
  let paused = null;      // 暂停原因（字符串）或 null
  let running = null;     // 正在跑的任务 id
  let budgetStart = now(); // 本轮预算的起点（创建即起算：0 会被当成过期）
  let aborted = new Set();
  const stats = { pushed: 0, rejected: 0, taken: 0, completed: 0, aborted: 0 };

  const budgetLeft = () => (paused ? 0 : Math.max(0, budgetMs - (now() - budgetStart)));

  return {
    /** @param {ScoringTask} task @returns {boolean} 是否入队成功 */
    push(task) {
      if (!task || typeof task.id !== 'string' || !task.id) return false;
      if (items.length >= maxQueue) { stats.rejected++; return false; }
      items.push(task);
      stats.pushed++;
      return true;
    },
    /**
     * 取下一个可跑的任务；没有就 null（调用方据此休眠）。
     * @returns {ScoringTask | null}
     */
    next() {
      if (paused) return null;
      if (!items.length) return null;
      if (budgetLeft() <= 0) { paused = '本轮预算用完'; return null; }
      const task = items.shift();
      running = task.id;
      stats.taken++;
      return task;
    },
    /** 运行器报「这条跑完了」。@param {string} id */
    done(id) {
      if (running === id) running = null;
      aborted.delete(id);
      stats.completed++;
    },
    /**
     * 中断：不带 id = 清空并暂停（玩家回来了 / 不可见 / 离线）；
     * 带 id = 只标记那一条（正在跑的运行器会在下一个切片看到 isAborted）。
     */
    abort(id = null, reason = '被中断') {
      if (id) { aborted.add(id); stats.aborted++; return; }
      stats.aborted += items.length;
      items = [];
      running = null;
      paused = reason;
    },
    /** @param {string} id */
    isAborted(id) { return aborted.has(id); },
    /** 外部条件恢复：清暂停、重置预算。 */
    resume() {
      paused = null;
      budgetStart = now(); // 重新起算：锚点留在 0 会让恢复后立刻又被判超预算
    },
    /** @param {string} reason */
    pause(reason = '暂停') { paused = reason; },
    size() { return items.length; },
    state: () => ({
      size: items.length, paused, running, budgetLeftMs: budgetLeft(), maxQueue, budgetMs, ...stats,
    }),
  };
}
