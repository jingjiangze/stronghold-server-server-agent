// server/mirrorProbe.js — 容器视角的镜像测速（服务端实测证据，请求路径上永不等待）。
//
// 本轮升级（用户 2026-10-14 指令）：
//   * **每次抽样不同的素材**（从随服务一起发布的清单里随机抽，避开最近抽过的）；
//   * 抽到的**同一个文件在所有镜像上各测一次**（这样才可比）；
//   * **小文件测延迟（TTFB）、大文件测吞吐（B/s）** —— 文件大小由**实测字节数**判定，不靠猜；
//   * 抽样过程顺手产出**素材缺失表**：同一路径在哪个镜像上 404/403，就记一条
//     （"镜像站还没同步这个文件"是用户点名要的动态清单之一）。
//
// 为什么是「容器视角」而不是「玩家视角」：容器在 cn-beijing，玩家在全国各地 —— 两条链路不同。
// 但容器是唯一能**主动、持续、零外部额度**地测的位置：玩家浏览器的测速要有消费者才有意义
// （superbig 外壳拿不到也改不了游戏 iframe 里的相对素材路径），CF 边缘量的是「CF 节点 → 镜像」
// 且每个素材请求都要过 Worker（免费额度会被全站素材吃光）。所以这里产出的是**实测证据**，
// 由 `/sp-edge/*` 与单一对外域名统一返回，供跳转层/第三方/监控/文档站消费。
//
// 与另外两层的分工（别混）：
//   健康（asset-jump 内）= 通不通        —— 固定路径 HEAD，秒级、判定成 skip
//   存在性（asset-jump 内）= 有没有这个文件 —— 用户请求命中的 (源,路径) HEAD
//   本模块 = 快不快 + 谁缺件              —— 抽样 GET + 计时，分钟级、产出排序证据与缺失表
export const DEFAULT_INTERVAL_MS = 300_000;   // 5 分钟
export const DEFAULT_TIMEOUT_MS = 20_000;     // 大文件要留够时间
export const EWMA_ALPHA = 0.4;                // 平滑：单次抖动不该翻盘
export const SMALL_MAX_BYTES = 256 * 1024;    // < 256 KiB 视为小文件（测 TTFB）
export const LARGE_MIN_BYTES = 1024 * 1024;   // ≥ 1 MiB 视为大文件（测吞吐）
export const MAX_PATHS = 500;                 // 路径记录上限（LRU 丢最旧）
export const MAX_MISSING = 200;               // 缺失表上限

const noop = { info() {}, warn() {} };

/** 从清单里挑候选：只要静态素材，排除明显不适合抽样的东西。 */
export function samplerPool(paths = []) {
  const ok = /\.(png|jpg|jpeg|webp|skel|atlas|mp3|m4a|ogg|wav|ttf|otf|woff2?)$/i;
  return [...new Set(paths.filter((p) => typeof p === 'string' && p.startsWith('/assets/') && ok.test(p)))];
}

/**
 * @param {{ sources?: {id:string, base:string}[], paths?: string[], fetchImpl?: Function, log?: object,
 *           intervalMs?: number, timeoutMs?: number, alpha?: number, rand?: () => number, samplesPerRound?: number }} [opts]
 */
export function createMirrorProbe({
  sources = [], paths = [], fetchImpl = globalThis.fetch, log = noop,
  intervalMs = DEFAULT_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, alpha = EWMA_ALPHA,
  rand = Math.random, samplesPerRound = 2,
} = {}) {
  // 只测调用方给的源（= sources.json 的已配置源），**绝不**接受外部传入的 URL：
  // 一个能被调用方指定目标的测速端点就是一台扫描器。
  const list = sources.filter((s) => s && typeof s.id === 'string' && typeof s.base === 'string' && s.base.startsWith('https://'));
  const baseOf = new Map(list.map((s) => [s.id, s.base]));
  const pool = samplerPool(paths);
  const pathsState = new Map();     // path → { bytes, at, rounds, per: { id: {ok,ttfbMs,bps,missing} } }
  const missing = new Map();        // path → { sources: Set<id>, at }
  const agg = new Map();            // id → { smallTtfb, largeBps, smallSamples, largeSamples, lastOk, error, at }
  const recent = [];                // 最近抽过的路径（避免连续重复）
  let round = 0, lastAt = null, inflight = null;

  const note = (id) => {
    if (!agg.has(id)) agg.set(id, { smallTtfb: null, largeBps: null, smallSamples: 0, largeSamples: 0, lastOk: null, error: null, at: null });
    return agg.get(id);
  };
  for (const s of list) note(s.id);

  /** 抽这一轮的样本：优先补「还没量过」的路径（先学会它多大），其次从已知小/大池里随机抽。 */
  function pickSamples() {
    const fresh = pool.filter((p) => !pathsState.has(p) && !recent.includes(p));
    const known = pool.filter((p) => pathsState.has(p) && !recent.includes(p));
    const smallPool = known.filter((p) => (pathsState.get(p).bytes ?? Infinity) < SMALL_MAX_BYTES);
    const largePool = known.filter((p) => (pathsState.get(p).bytes ?? 0) >= LARGE_MIN_BYTES);
    const pick = (arr) => (arr.length ? arr[Math.floor(rand() * arr.length) % arr.length] : null);
    const out = [];
    const wantSmall = pick(smallPool) ?? pick(fresh) ?? pick(known);
    if (wantSmall) out.push({ path: wantSmall, kind: 'small' });
    const wantLarge = pick(largePool) ?? pick(fresh.filter((p) => p !== wantSmall)) ?? pick(known.filter((p) => p !== wantSmall));
    if (wantLarge) out.push({ path: wantLarge, kind: 'large' });
    // 池子太小或全被 recent 挡住时，兜一个已知路径，保证每轮都有样本（**必须有界**：池子只有 1 条时
    // 「抽到的已经在 out 里」会让 while 永远不前进 —— 这就是一轮 refresh 挂死的写法）
    for (let guard = 0; guard < Math.max(4, pool.length * 2) && out.length < samplesPerRound && pool.length; guard++) {
      const p = pool[Math.floor(rand() * pool.length) % pool.length];
      if (!out.some((o) => o.path === p)) out.push({ path: p, kind: 'auto' });
    }
    return out.slice(0, Math.max(1, samplesPerRound));
  }

  async function measure(id, path) {
    const base = baseOf.get(id);
    const t0 = Date.now();
    try {
      const res = await fetchImpl(base + path, { signal: AbortSignal.timeout(timeoutMs) });
      const ttfb = Date.now() - t0;
      const status = res?.status ?? 0;
      if (status === 403 || status === 404) return { ok: false, missing: true, ttfbMs: ttfb, status };
      if (!res || res.ok === false || status >= 400) throw new Error(`HTTP ${status || '?'}`);
      let n = 0;
      if (typeof res.arrayBuffer === 'function') n = (await res.arrayBuffer())?.byteLength ?? 0;
      else if (typeof res.text === 'function') n = (await res.text()).length;
      const ms = Math.max(1, Date.now() - t0);
      return { ok: true, ttfbMs: ttfb, bytes: n, bps: n > 0 ? Math.round((n * 1000) / ms) : null, status };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 80), ttfbMs: Date.now() - t0 };
    }
  }

  function record(id, path, r) {
    const a = note(id);
    a.at = new Date().toISOString();
    a.lastOk = r.ok === true;
    a.error = r.ok ? null : (r.error ?? (r.missing ? 'missing' : null));
    if (!r.ok) return;
    const bytes = r.bytes ?? 0;
    const row = pathsState.get(path) ?? { bytes: null, at: null, rounds: 0, per: {} };
    row.bytes = row.bytes == null ? bytes : Math.max(row.bytes, bytes);
    row.at = new Date().toISOString();
    row.per[id] = { ok: true, ttfbMs: r.ttfbMs, bps: r.bps };
    pathsState.set(path, row);
    // 按**实测大小**分池累计（不靠猜）
    if (bytes >= LARGE_MIN_BYTES) {
      a.largeBps = a.largeBps == null ? r.bps : Math.round(alpha * (r.bps ?? a.largeBps) + (1 - alpha) * a.largeBps);
      a.largeSamples += 1;
    } else if (bytes < SMALL_MAX_BYTES) {
      a.smallTtfb = a.smallTtfb == null ? r.ttfbMs : Math.round(alpha * r.ttfbMs + (1 - alpha) * a.smallTtfb);
      a.smallSamples += 1;
    }
  }

  function noteMissing(path, per) {
    const lacking = Object.entries(per).filter(([, v]) => v.ok !== true).map(([id]) => id);
    const having = Object.entries(per).filter(([, v]) => v.ok === true).length;
    if (!lacking.length) { missing.delete(path); return; }
    // 全部源都缺 ⇒ 这条路径本身有问题（不在任何镜像），不是「镜像缺失」，不记表也不再用它抽样
    if (having === 0) { missing.delete(path); const i = pool.indexOf(path); if (i >= 0) pool.splice(i, 1); return; }
    if (missing.size >= MAX_MISSING && !missing.has(path)) missing.delete(missing.keys().next().value);
    missing.set(path, { sources: lacking, at: new Date().toISOString() });
  }

  /** 跑一轮：抽 1~2 个不同素材 × 所有源（并行）。可 await，也可 fire-and-forget。 */
  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      round += 1;
      const picks = pickSamples();
      const jobs = [];
      for (const { path } of picks) {
        recent.push(path);
        while (recent.length > Math.max(8, pool.length)) recent.shift();
        jobs.push((async () => {
          const per = {};
          await Promise.all(list.map(async (s) => { const r = await measure(s.id, path); per[s.id] = r; record(s.id, path, r); }));
          const row = pathsState.get(path);
          if (row) row.per = { ...row.per, ...per };
          noteMissing(path, per);
          if (pathsState.size > MAX_PATHS) pathsState.delete(pathsState.keys().next().value);
        })());
      }
      await Promise.all(jobs);
      lastAt = new Date().toISOString();
      return state();
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /** 实测序：小文件 TTFB 升序优先，其次大文件吞吐降序。没测出数字的源不参与（也就不会被抬高）。 */
  function measuredOrder() {
    return list
      .map((s) => ({ id: s.id, ...note(s.id) }))
      .filter((r) => r.smallTtfb != null || r.largeBps != null)
      .sort((a, b) => ((a.smallTtfb ?? 1e9) - (b.smallTtfb ?? 1e9)) || ((b.largeBps ?? 0) - (a.largeBps ?? 0)))
      .map((r) => r.id);
  }

  function state() {
    return {
      at: lastAt,
      round,
      intervalMs,
      samplesPerRound,
      thresholds: { smallMaxBytes: SMALL_MAX_BYTES, largeMinBytes: LARGE_MIN_BYTES },
      pool: pool.length,
      sources: list.map((s) => ({ id: s.id, base: s.base, ...note(s.id) })),
      measuredOrder: measuredOrder(),
      // 最近抽过的素材（证明「每次不一样」）+ 它们的实测大小与逐源结果
      lastSamples: recent.slice(-2).map((p) => ({ path: p, bytes: pathsState.get(p)?.bytes ?? null, per: pathsState.get(p)?.per ?? {} })),
      missing: [...missing].map(([path, v]) => ({ path, sources: v.sources, at: v.at })),
    };
  }

  const timer = intervalMs > 0 && fetchImpl ? setInterval(() => { refresh(); }, intervalMs) : null;
  timer?.unref?.();
  if (timer) refresh();   // 启动即预热（容器重建后几秒内就有第一批数字）

  return { refresh, state, measuredOrder, stop: () => timer && clearInterval(timer), ids: list.map((s) => s.id), poolSize: () => pool.length };
}
