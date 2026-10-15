// server/upstreamWatch.js — 常驻监听上游仓库（sganggs/Stronghold-Protocol）的自动更新。
//
// 为什么在容器里：上游没有 webhook 能给我们（我们不是它的管理员）；条件请求（If-None-Match）拿到 304
// **不消耗 GitHub 额度**（实测 200 rem=4744 → 304 rem=4744 → 304 rem=4744），所以轮询成本≈0，
// 唯一代价是容器的几 KB 出网。容器实测能到 api.github.com（698ms）/ github.com / ghfast。
//
// 两种模式，**默认零凭据**：
//   observe-only  —— 只轮询 + 暴露状态（GET /sp-edge/upstream）。没配 token 时就是这个模式。
//   on            —— 配了 SP_UPSTREAM_TOKEN 时：检测到上游变化（且不是进程内的第一次观测）就主动
//                    POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches，触发**既有的
//                    workflow_dispatch** 工作流（不需要给工作流加任何 trigger）。
//
// 四条硬规则：
//   1. 幂等：同一 tag/sha 只派发一次（记在 dispatched 里）。
//   2. 容器重建即丢状态 ⇒ 进程内第一次观测只记账、**绝不派发**（否则每次重建都会连锁触发）。
//   3. 抖动退避：单次失败只记 error 并退避，不抛、不影响游戏。
//   4. 凭据最小化：token 只用于 dispatch，且只发给 dispatchTargets 里列出的仓/工作流。

const API = 'https://api.github.com';
const UPSTREAM = 'sganggs/Stronghold-Protocol';

/** 上游的两个观测点：发布 tag 与 master 的提交 sha（各带 ETag）。 */
const WATCH_POINTS = [
  { key: 'tag', url: `${API}/repos/${UPSTREAM}/releases/latest`, pick: (j) => (j && j.tag_name) || null },
  { key: 'sha', url: `${API}/repos/${UPSTREAM}/commits?per_page=1`, pick: (j) => (Array.isArray(j) && j[0] && j[0].sha) || null },
];

/** 默认执行器：既有 workflow_dispatch 工作流（不改它们，只被调用）。 */
const DEFAULT_TARGETS = [
  { repo: 'jingjiangze/Stronghold-Protocol-CDN', file: 'sync.yml', ref: 'main' },
  { repo: 'jingjiangze/stronghold-server', file: 'sync-upstream.yml', ref: 'master' },
];

export function createUpstreamWatch({
  log = console, token = (typeof process !== 'undefined' ? process.env?.SP_UPSTREAM_TOKEN : null) || null,
  intervalMs = 45_000, targets = DEFAULT_TARGETS, upstream = UPSTREAM,
  fetchImpl = globalThis.fetch, now = () => Date.now(),
} = {}) {
  const etags = new Map();   // url → etag
  const seen = new Map();    // key → 上次观测值
  const dispatched = [];     // { at, repo, file, value }
  const state = {
    startedAt: null, lastTick: null, ticks: 0, failures: 0,
    mode: token ? 'on' : 'observe-only',
    upstream: {}, error: null, dispatched,
    intervalMs,
  };
  let timer = null, busy = false, backoffUntil = 0, consecutiveFailures = 0;

  async function pollOne(p) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'stronghold-upstream-watch/1.0' };
    const et = etags.get(p.url);
    if (et) headers['if-none-match'] = et;
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetchImpl(p.url, { headers, signal: AbortSignal.timeout(8000) });
    if (r.status === 304) return { changed: false, first: false, value: seen.get(p.key) ?? null };
    if (!r.ok) throw new Error(`${p.key}: HTTP ${r.status}`);
    const etag = r.headers.get('etag');
    if (etag) etags.set(p.url, etag);
    const value = p.pick(await r.json());
    const first = !seen.has(p.key);
    const changed = !first && !!value && value !== seen.get(p.key);
    seen.set(p.key, value);
    state.upstream[p.key] = value;
    return { changed, first, value };
  }

  async function dispatch(reason, value, dedupeKey) {
    for (const t of targets) {
      const url = `${API}/repos/${t.repo}/actions/workflows/${encodeURIComponent(t.file)}/dispatches`;
      let http = null, error = null;
      try {
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: {
            accept: 'application/vnd.github+json', 'content-type': 'application/json',
            'user-agent': 'stronghold-upstream-watch/1.0', authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ ref: t.ref || 'main' }),   // 不带 inputs：各工作流的输入声明不同，带错会 422
          signal: AbortSignal.timeout(10_000),
        });
        http = r.status;                            // 204 = 已触发
        if (!r.ok && r.status !== 204) error = `HTTP ${r.status}`;
      } catch (e) { error = String((e && e.message) || e).slice(0, 120); }
      dispatched.push({ at: new Date().toISOString(), repo: t.repo, file: t.file, reason, value, key: dedupeKey, http, error });
      log[error ? 'warn' : 'info']?.(`[upstream-watch] dispatch ${t.repo}/${t.file} (${reason}=${value}) → ${http ?? error}`);
    }
  }

  async function tick() {
    if (busy || now() < backoffUntil) return;
    busy = true;
    state.ticks++;
    state.lastTick = new Date().toISOString();
    try {
      const results = await Promise.all(WATCH_POINTS.map(async (p) => ({ key: p.key, ...(await pollOne(p)) })));
      state.error = null;
      consecutiveFailures = 0;
      const firstPass = results.every((x) => x.first);     // 进程内第一次观测：只记账，绝不派发
      const changedNow = results.filter((x) => x.changed);
      if (changedNow.length && !firstPass) {
        const ev = changedNow[0];
        const key = `${ev.key}=${ev.value}`;
        const already = dispatched.some((d) => d.key === key && !d.error);
        if (!already) {
          if (token) await dispatch(ev.key, ev.value, key);
          else log.info?.(`[upstream-watch] upstream changed (${key}) — observe-only, not dispatching`);
        }
      }
    } catch (e) {
      consecutiveFailures++;
      state.failures++;
      state.error = String((e && e.message) || e).slice(0, 160);
      backoffUntil = now() + Math.min(10 * 60_000, intervalMs * Math.pow(2, Math.min(consecutiveFailures, 5)));
      log.warn?.(`[upstream-watch] poll failed (${state.error}) — backoff ${Math.round((backoffUntil - now()) / 1000)}s`);
    } finally { busy = false; }
  }

  return {
    start() {
      if (timer) return;
      state.startedAt = new Date().toISOString();
      log.info?.(`[upstream-watch] start (mode=${state.mode}, every ${Math.round(intervalMs / 1000)}s)`);
      tick();                                                        // 进程内第一次：只记账
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();                                 // 不阻止进程退出
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    state: () => ({ ...state, upstream: { ...state.upstream }, dispatched: dispatched.slice(-20) }),
  };
}
