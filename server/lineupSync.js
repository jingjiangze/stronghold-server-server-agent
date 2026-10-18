// server/lineupSync.js — 把「AI 布阵学习库」从远端只读仓库同步到本地缓存，供 server/lineupLibrary.js 读取。
//
// 为什么单独一个模块：lineupLibrary 的读路径（readTail/openSync/load）是**同步**且**绑本地文件路径**的——那是
// 它的性能契约（bot 布阵时同步查库，不能等网络）。所以远端同步必须是**另一个异步层**：把字节拉到本地缓存文件，
// 再让 lineupLibrary 照旧读本地文件。两个模块的边界就是这一行。
//
// 与 asset-jump.js 的关系：那边是「给客户端 302 到素材源」，同步返回、JSON 特化、闭包未导出，语义不同，不复用。
// 这里只借鉴它 fetchRank() 的「按序回退、第一个成功即返回」形状（asset-jump.js:119-131）。
//
// 三条硬规则（与 upstreamWatch.js 同一范式）：
//   1. 失败只记日志 + 退避，**绝不抛进启动链**——学习库是增强，缺了它 AI 只是回到默认布阵。
//   2. 定时器 `unref()`，不吊住进程退出。
//   3. 远端**只读**：本模块只写本地缓存，从不回写远端。写回走 R2 promote 通道（另一条链）。
//
// 配置（环境变量）：
//   SP_LINEUP_LIBRARY   —— 本地路径（目录/文件，lineupLibrary 的既有语义）**或**远端说明 `remote:<urls>|<cacheDir>`。
//                          `<urls>` 是逗号分隔的有序远端地址，第一个可用即停。
//   SP_LINEUP_SYNC_MS  —— 同步间隔，默认 6 小时（远端内容一天最多变几次，没必要分钟级轮询）。
//   SP_LINEUP_SYNC=0   —— 关闭本模块（本地路径语义完全不受影响）。

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** 远端拉下来的内容先落这里再原子改名：一个读到一半的文件永远不会被 lineupLibrary 看见。 */
const TMP_SUFFIX = '.partial';

/** 远端说明 → { urls, cacheDir }；不是远端说明则返回 null（本地语义，本模块不参与）。 */
export function parseRemoteSpec(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.toLowerCase().startsWith('remote:')) return null;
  const body = s.slice('remote:'.length);
  const bar = body.lastIndexOf('|');
  if (bar < 0) return null;                       // 没有缓存目录：不知道该把字节放哪，宁可不启用
  const urls = body.slice(0, bar).split(',').map((u) => u.trim()).filter(Boolean);
  const cacheDir = body.slice(bar + 1).trim();
  if (!urls.length || !cacheDir) return null;
  return { urls, cacheDir };
}

/** 本地缓存里某个 mode 的文件名（与 lineupLibrary 的分模式布局同前缀，便于人肉核对）。 */
export function remoteCacheFile(cacheDir, key) {
  return join(cacheDir.replace(/[\\/]+$/, ''), `lineups_${key || ''}.jsonl`);
}

/**
 * 按序试每个 URL，返回第一个**完整读到的文本**。非 2xx 与网络错都算这一路失败，继续下一个；
 * 全部失败抛出最后一个错误（调用方只记日志）。
 * @param {string[]} urls
 * @param {{ fetchImpl?: Function, timeoutMs?: number, etag?: string|null, log?: object }} [opts]
 * @returns {Promise<{ url: string, text: string, etag: string|null, notModified: boolean }>}
 */
export async function fetchFirstText(urls, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  let last = null;
  for (const url of urls) {
    if (!url) continue;
    const headers = { 'user-agent': 'stronghold-lineup-sync/1.0' };
    if (opts.etag) headers['if-none-match'] = opts.etag;
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (res.status === 304) return { url, text: '', etag: opts.etag || null, notModified: true };
      if (!res.ok) { last = `HTTP ${res.status} @ ${url}`; continue; }
      const text = await res.text();
      return { url, text, etag: res.headers.get('etag'), notModified: false };
    } catch (e) {
      last = `${(e && e.message) || e} @ ${url}`;
    }
  }
  throw new Error(last || 'no lineup source configured');
}

/**
 * 建同步器。`spec` 由 parseRemoteSpec 产出；`keys` 是「要同步哪些库」的列表
 * （`<modeId>__<DIFFICULTY>`，见 lineupLibrary.libraryKey；部署方显式列出，或 lineupModes() 现读）。
 * 设计成注入而不是 import lineupLibrary：避免循环依赖，也让测试能只测这一层。
 */
export function createLineupSync({
  spec, keys = [], log = console, intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const state = { startedAt: null, lastTick: null, ticks: 0, pulls: 0, failures: 0, sources: {}, error: null };
  let timer = null, busy = false, backoffUntil = 0, consecutiveFailures = 0;

  /** url → etag：只对「真的拿到过 200」的地址记，304 才有意义。 */
  const etags = new Map();

  async function pullOne(key) {
    const urls = spec.urls.map((base) => `${base.replace(/[\\/]+$/, '')}/lineups_${key || ''}.jsonl`);
    const etagKey = urls[0];
    const { url, text, etag, notModified } = await fetchFirstText(urls, {
      fetchImpl, timeoutMs, etag: etags.get(etagKey) || null, log,
    });
    const dest = remoteCacheFile(spec.cacheDir, key);
    if (notModified) {
      state.sources[key] = { at: new Date().toISOString(), url, changed: false };
      return { key, changed: false };
    }
    // 先写 .partial 再改名：半途失败不会留下一个被 lineupLibrary 读到的残file
    await fsp.mkdir(spec.cacheDir, { recursive: true });
    await fsp.writeFile(dest + TMP_SUFFIX, text, 'utf8');
    await fsp.rename(dest + TMP_SUFFIX, dest);
    if (etag) etags.set(etagKey, etag);
    state.sources[key] = { at: new Date().toISOString(), url, changed: true, bytes: Buffer.byteLength(text) };
    state.pulls++;
    return { key, changed: true };
  }

  async function tick() {
    if (busy || now() < backoffUntil) return;
    busy = true;
    state.ticks++;
    state.lastTick = new Date().toISOString();
    try {
      const list = typeof keys === 'function' ? keys() : keys;
      if (!list.length) throw new Error('no library key to sync — nothing to pull');
      for (const key of list) await pullOne(key);
      state.error = null;
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      state.failures++;
      state.error = String((e && e.message) || e).slice(0, 160);
      backoffUntil = now() + Math.min(60 * 60_000, intervalMs * Math.pow(2, Math.min(consecutiveFailures, 5)));
      log.warn?.(`[lineup-sync] pull failed (${state.error}) — backoff ${Math.round((backoffUntil - now()) / 1000)}s`);
    } finally { busy = false; }
  }

  return {
    start() {
      if (timer) return;
      state.startedAt = new Date().toISOString();
      log.info?.(`[lineup-sync] start (${spec.urls.length} source(s) → ${spec.cacheDir}, every ${Math.round(intervalMs / 1000)}s)`);
      tick();
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    /** 立刻同步一次（可 await：诊断/测试/启动后预热用）。 */
    syncOnce: tick,
    state: () => ({ ...state, sources: { ...state.sources }, intervalMs }),
  };
}
