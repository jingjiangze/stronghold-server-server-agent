// server/http/asset-jump.js — 缺失素材的 302 跳转，做在**游戏进程内**。
//
// 为什么进程内也要有这一层：素材跳转（把 /assets|fonts 缺的文件 302 到当前素材源）本来只有容器
// 边缘层（deploy/stardust/ms-edge 的 nginx + sidecar）。2026-10-11 实测创空间容器里 nginx 不在
// 链路上——镜像按提交重建成功、游戏在跑，但 /assets 请求直接落到游戏进程的 404。跳转不该押在
// 「平台是否执行我们的 CMD」上，所以游戏进程用**同一份 sources.json、同一组纯函数**兜底：
// 白名单、路径校验、例外表、?sp_source 覆盖都只有 edge-sidecar.mjs 一处实现，禁止在本文件里
// 拷贝或另立一套规则。
//
// 语义（本地优先）：static.js 只在**文件本机不存在**时才问这里；有文件仍走文件。
// 非 /assets|fonts 路径、不允许的扩展名、配置读不到 → 返回 null，交回原来的 404。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, noopLog } from './config.js';
import { decide, parseSources, stripSourceParam } from '../../deploy/stardust/ms-edge/edge-sidecar.mjs';
import { createMirrorProbe } from '../mirrorProbe.js';

/**
 * 排名端点。**多个 URL 是同一个对象的不同门牌**，按序回退：
 *   1. 魔搭数据集门牌 —— 同一份 rank.json 镜像进 `jingjiangze/Stronghold-Protocol-Assets` 数据集，
 *      容器侧实测 0.16 s（本机 curl）/ 67 ms（容器视角）可达，是「容器自己就能稳定读到」的那一个；
 *   2. speedcdn —— 同桶自定义域，2026-10-14 实测容器侧慢/抖动；
 *   3. weishucdn —— 同桶主域，作为最后兜底。
 *
 * 2026-10-14 实测容器里 weishucdn/speedcdn 两个门牌拿 rank.json 都要 4.7~20 s，旧代码的 4 s 超时
 * 让这三条**全部**读失败 —— 排名于是永远取不到，`ranked ?? config.order` 一路退化成静态 order。
 * 所以镜像进数据集（快门牌）+ 抬高超时（容忍慢门牌）两件事都要做。
 */
export const DEFAULT_RANK_URLS = [
  'https://modelscope.cn/api/v1/datasets/jingjiangze/Stronghold-Protocol-Assets/repo?Revision=master&FilePath=cdn%2Fv1%2Frank.json',
  'https://speedcdn.jiangjiangze.icu/cdn/v1/rank.json',
  'https://weishucdn.jiangjiangze.icu/cdn/v1/rank.json',
];
/** 旧名保留：SP_RANK_URL 仍可作为「首选 URL」。 */
export const DEFAULT_RANK_URL = DEFAULT_RANK_URLS[0];
export const RANK_TTL_MS = 300_000;
/**
 * rank.json 的抓取超时。门牌里最慢的一条实测要 4.7 s（容器到 CF 系），4 s 会让它必然超时，
 * 于是三条门牌全都失败、排名永远取不到。取 15 s：仍远小于 5 分钟的 TTL，失败也只浪费一次空等，
 * 换来慢门牌真的有机会成功。
 */
export const RANK_TIMEOUT_MS = 15_000;
/**
 * 排名里的 id → 边缘源表的 id。两边的命名不同名（CDN 侧叫 ms-dataset/ms-edge/r2-alt，边缘侧叫
 * modelscope/r2），而且 **ms-edge 就是本容器自己**——映射成 null 表示"跳过"：否则边缘会 302 到自己，
 * 客户端跟着无限跳。未列出的 id 按同名处理（两边同名时零配置即可用）。
 */
export const RANK_ID_MAP = { 'r2': 'r2', 'r2-alt': 'r2', 'ms-dataset': 'modelscope', 'ms-edge': null };

/**
 * **合格集**：只有「真的测过」的条目才有资格进生效顺序的**头部**。
 *
 * 为什么必须卡这一条（2026-10-14 实读线上 rank.json）：rank 的前两名是 `ms-dataset` / `ms-edge`，两条都是
 * `measured:false, usable:null` —— 它们是按 `origins.json` 的**登记顺序**排的，不是测出来的。若照单全收，
 * 「最快」就只是「谁先登记」的另一种写法，跳转层会把这个顺序放大成对外的速度结论。
 *
 * 未实测/未进榜的**已配置源不丢**，只是按静态 order 接到尾部（见 applyRank）。
 */
export function rankQualified(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.excluded === true || r.down === true || r.usable === false) return false;
  if (r.coverage === 'partial') return false;
  return r.measured === true;
}

export const DEFAULT_SOURCES_PATH = path.join(ROOT, 'deploy', 'stardust', 'ms-edge', 'sources.json');

/**
 * 抽样池 = 随服务发布的素材清单里的相对路径（`data/assets.json`）。读不到就退回一个内置路径，
 * 保证探测器至少还能量出「小文件延迟」这一项；**绝不**从网络或调用方取路径。
 */
export function loadProbePaths(fsImpl = fs, pathImpl = path, root = ROOT, log = noopLog) {
  const fallback = ['/assets/char/avatar/char_003_kalts.png'];
  try {
    const manifest = JSON.parse(fsImpl.readFileSync(pathImpl.join(root, 'data', 'assets.json'), 'utf8'));
    const urls = [];
    (function walk(o) {
      if (typeof o === 'string') urls.push(o);
      else if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') Object.values(o).forEach(walk);
    })(manifest);
    const rel = [...new Set(urls.filter((u) => u.startsWith('/assets/') && !u.includes('?')))];
    return rel.length ? rel : fallback;
  } catch (e) {
    log.warn?.(`[http] asset jump: cannot read data/assets.json (${e?.message || e}) — probe uses the built-in sample`);
    return fallback;
  }
}

/**
 * Build the jump decision function. Off when the sources file is unreadable or SP_ASSET_JUMP=0 —
 * a jump layer must never take the game down with it.
 * @param {{ sourcesPath?: string, disabled?: boolean, log?: { info?: Function, warn?: Function } }} [opts]
 * @returns {(pathname: string, query: string, method: string) => { status: number, headers: Record<string, string> } | null}
 */
export function createAssetJump({ sourcesPath = process.env.SP_EDGE_SOURCES || DEFAULT_SOURCES_PATH, disabled = process.env.SP_ASSET_JUMP === '0', log = noopLog, rankUrl = process.env.SP_RANK_URL || '', rankUrls = null, fetchImpl = globalThis.fetch, healthIntervalMs = process.env.SP_ASSET_HEALTH === '0' ? 0 : Number(process.env.SP_ASSET_HEALTH_INTERVAL_MS || 60_000), probeIntervalMs = process.env.SP_PROBE === '0' ? 0 : Number(process.env.SP_PROBE_INTERVAL_MS || 300_000), probeLeads = process.env.SP_PROBE_LEADS === '1' } = {}) {
  if (disabled) {
    log.info?.('[http] asset jump: disabled (SP_ASSET_JUMP=0)');
    return () => null;
  }
  let config;
  try {
    config = parseSources(fs.readFileSync(sourcesPath, 'utf8'));
  } catch (e) {
    log.warn?.(`[http] asset jump: off — cannot read ${sourcesPath}: ${e?.message || e}`);
    return () => null;
  }
  log.info?.(`[http] asset jump: on — order=${config.order.join(' > ')}, exceptions=${config.exceptions.size} (${sourcesPath})`);
  // 候选门的顺序：显式参数 > SP_RANK_URLS > SP_RANK_URL（旧名，作首选）> 内置两条（同桶的两个门牌）。
  const urls = (rankUrls
    || (process.env.SP_RANK_URLS ? process.env.SP_RANK_URLS.split(',').map((s) => s.trim()).filter(Boolean) : null)
    || (rankUrl ? [rankUrl, ...DEFAULT_RANK_URLS.filter((u) => u !== rankUrl)] : DEFAULT_RANK_URLS)).slice();
  // 动态次序：rank.json 把**实测最快**的源排在前面。只在**已配置的源**里取（不引入未知 id），
  // 取不到/没有合格条目就沿用静态 order——排名是优化，不是依赖。
  // rankCheckedAt = 上一次**尝试**的时间（成功、无合格条目、失败都算），TTL 一视同仁：否则「没有合格条目」
  // 会让 ranked 保持 null，而 effective() 的 `!ranked` 判断就会变成「每个请求都去 fetch 一次」。
  let ranked = null, rankCheckedAt = 0, inflight = null, rankState = { at: null, ok: null };
  /** 按序试每个门牌，返回第一个**解析成功**的（HTTP 非 2xx 与网络错都算这一路失败）。 */
  async function fetchRank() {
    let last = null;
    for (const u of urls) {
      if (!u) continue;
      try {
        const res = await fetchImpl(u, { signal: AbortSignal.timeout(RANK_TIMEOUT_MS) });
        if (!res.ok) { last = `HTTP ${res.status} @ ${u}`; continue; }
        const doc = await res.json();
        return { url: u, doc };
      } catch (e) { last = `${e?.message || e} @ ${u}`; }
    }
    throw new Error(last || 'no rank url configured');
  }
  /**
   * rank 文档 → 生效顺序。**头部只放合格集**（见 rankQualified），已配置但未实测的源按静态 order 接在尾部。
   * 没有任何合格条目 ⇒ 返回 null（不动 order）：宁可承认「没有测速结论」，也不把登记顺序当结论。
   */
  function applyRank(doc) {
    const rows = Array.isArray(doc?.rank) ? doc.rank : [];
    const head = [];
    for (const r of rows) {
      if (!rankQualified(r)) continue;
      const id = Object.prototype.hasOwnProperty.call(RANK_ID_MAP, r.id) ? RANK_ID_MAP[r.id] : r.id;
      if (typeof id === 'string' && id && config.byId.has(id) && !head.includes(id)) head.push(id);
    }
    if (!head.length) return null;
    const tail = config.order.filter((id) => !head.includes(id));
    return { head, order: [...head, ...tail] };
  }
  function refresh() {
    if (inflight || !urls.length || !fetchImpl) return;
    inflight = (async () => {
      try {
        const { url, doc } = await fetchRank();
        const applied = applyRank(doc);
        if (applied) {
          ranked = applied.order;
          rankState = { at: new Date().toISOString(), ok: true, url, qualified: applied.head, order: [...ranked] };
          log.info?.(`[http] asset jump: rank(${url}) qualified=[${applied.head.join(',')}] → ${ranked.join(' > ')}`);
        } else {
          ranked = null;
          rankState = { at: new Date().toISOString(), ok: true, url, qualified: [], order: [...config.order], note: 'no measured/usable entry in rank - keeping the static order' };
          log.warn?.('[http] asset jump: rank has no measured/usable entry — keeping the static order');
        }
      } catch (e) {
        rankState = { at: new Date().toISOString(), ok: false, error: String(e?.message || e) };
        log.warn?.(`[http] asset jump: rank unavailable (${e?.message || e}) — using the static order`);
      } finally { rankCheckedAt = Date.now(); inflight = null; }
    })();
  }
  /** 同步返回当前有效配置（后台按 TTL 刷新）：请求路径上永不等待网络。 */
  const effective = () => {
    if (Date.now() - rankCheckedAt >= RANK_TTL_MS) refresh();
    let order = ranked ?? config.order;
    if (probeLeads) {
      // 容器实测序（至少两个源测成功才有意义）插到最前，其余保持原相对顺序。
      const measured = speedProbe.measuredOrder().filter((id) => config.byId.has(id));
      if (measured.length > 1) order = [...measured, ...order.filter((id) => !measured.includes(id))];
    }
    return { ...config, order };
  };
  refresh();   // 启动即预热

  // ---- 存在性缓存：让 302 尽量不落到「还没有这个文件的镜像」上 -------------------------------------------
  // 跳转本身是同步的（static.js 直接调用），所以这里不阻塞：只信缓存里已知的「缺件」，未命中就先按既有顺序
  // 跳出去，同时对刚选中的源做一次 HEAD，把结果写进缓存（TTL 10 分钟）。⇒ 第一个请求可能仍打到缺件源，
  // 后续请求会自动避开；同步补齐（如刚上传的场景素材）在一个 TTL 之后自动恢复。
  const EXIST_TTL_MS = 10 * 60_000;
  const EXIST_MAX = 5000;
  const exists = new Map();            // key = 源 id + '\n' + 路径 → { v: 'ok' | 'miss' | null, at }
  const existProbing = new Set();
  const existKey = (id, pathname) => id + '\n' + pathname;
  const knownMiss = (id, pathname) => {
    const e = exists.get(existKey(id, pathname));
    return !!e && e.v === 'miss' && Date.now() - e.at < EXIST_TTL_MS;
  };
  const noteExist = (id, pathname, v) => {
    if (exists.size >= EXIST_MAX) { const first = exists.keys().next().value; if (first !== undefined) exists.delete(first); }
    exists.set(existKey(id, pathname), { v, at: Date.now() });
  };
  /** 对一个 (源, 路径) 做一次 HEAD：2xx/3xx=有（镜像自己再跳也算能供），403/404=没有，其余=未知（不缓存结论）。 */
  const probeExist = (id, base, pathname, query) => {
    const key = existKey(id, pathname);
    if (existProbing.has(key) || !base) return;
    existProbing.add(key);
    const rest = stripSourceParam(query || '');
    const target = base + pathname + (rest ? `?${rest}` : '');
    Promise.resolve()
      .then(() => fetchImpl(target, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) }))
      .then((r) => noteExist(id, pathname, r.status < 400 ? 'ok' : (r.status === 403 || r.status === 404 ? 'miss' : null)))
      .catch(() => noteExist(id, pathname, null))
      .finally(() => existProbing.delete(key));
  };

  // ---- 源健康缓存：让 302 顺延到「下一个还能用的源」 -----------------------------------------------------
  // 与存在性缓存**正交**，别混成一个：这里只回答「这个源现在通不通」，不管它有没有某个文件。
  //   status < 400（**含 403/404**）    = 通（域名/节点活着；缺某个文件是存在性缓存的事，在这判 down 会误杀
  //                                     一个只是缺某文件的镜像）
  //   status >= 500 / 网络错 / 超时     = 不通 → 本轮不进候选，302 顺延到下一个源
  // **不做「太慢就降权」**：延迟阈值随网络抖动来回翻，会把 302 变成抖动源；ms 只记录、供诊断。
  const HEALTH_INTERVAL_MS = healthIntervalMs;
  const HEALTH_TTL_MS = Number(process.env.SP_ASSET_HEALTH_TTL_MS || 3 * 60_000);
  const HEALTH_PATH = process.env.SP_ASSET_HEALTH_PATH || '/assets/char/avatar/char_003_kalts.png';
  const HEALTH_TIMEOUT_MS = 4000;
  const health = new Map();          // 源 id → { v: 'ok' | 'down', at, ms, status|error }
  const healthProbing = new Set();
  let healthSkips = 0;
  const knownDown = (id) => {
    const h = health.get(id);
    return !!h && h.v === 'down' && Date.now() - h.at < HEALTH_TTL_MS;
  };
  /** 对**固定健康路径**做一次 HEAD（可达性判定，口径见上）。可 await（诊断/测试用），也可 fire-and-forget。 */
  const probeHealth = (id, base) => {
    if (healthProbing.has(id) || !base || !fetchImpl) return Promise.resolve(health.get(id) ?? null);
    healthProbing.add(id);
    const t0 = Date.now();
    return Promise.resolve()
      .then(() => fetchImpl(base + HEALTH_PATH, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }))
      .then((r) => {
        const v = { v: r.status >= 500 ? 'down' : 'ok', at: Date.now(), ms: Date.now() - t0, status: r.status };
        health.set(id, v);
        if (v.v === 'down') log.warn?.(`[http] asset jump: source ${id} answered ${r.status} on ${HEALTH_PATH} — the next source will be used`);
        return v;
      })
      .catch((e) => {
        const v = { v: 'down', at: Date.now(), ms: Date.now() - t0, error: String(e?.message || e).slice(0, 80) };
        health.set(id, v);
        log.warn?.(`[http] asset jump: source ${id} unreachable (${v.error}) — the next source will be used`);
        return v;
      })
      .finally(() => healthProbing.delete(id));
  };
  // 常驻循环（与 server/upstreamWatch.js 同一范式）：每轮探**所有已配置源**，所以一个源挂掉/恢复都会在
  // 一个间隔内被发现，不需要任何 GitHub/CF 定时器。`unref()` 保证它不吊住进程退出（测试友好）。
  const healthTimer = HEALTH_INTERVAL_MS > 0
    ? setInterval(() => { for (const id of config.order) probeHealth(id, config.byId.get(id)); }, HEALTH_INTERVAL_MS)
    : null;
  healthTimer?.unref?.();
  if (healthTimer) for (const id of config.order) probeHealth(id, config.byId.get(id));   // 启动即预热

  // ---- 容器视角的测速（实测证据；默认只报告，不掌舵）----------------------------------------------------
  // 源集合**只来自 sources.json 的已配置源**；抽样池**只来自随服务发布的素材清单**
  // （data/assets.json 里的相对路径）—— 两边都不接受任何外部传入的 URL（否则这个端点就是一台扫描器）。
  const probePaths = loadProbePaths(fs, path, ROOT, log);
  const speedProbe = createMirrorProbe({
    sources: config.order.map((id) => ({ id, base: config.byId.get(id) })),
    paths: probePaths, fetchImpl, log, intervalMs: probeIntervalMs,
  });
  log.info?.(`[http] asset jump: speed probe — ${speedProbe.poolSize()} sample paths from data/assets.json`);

  /**
   * 顺延链的最后一跳：给定源 id，返回**指向同一路径**的后备绝对地址（复用 decide 的同一套实现，
   * 靠 `?sp_source=<id>` 点名 —— 不在这里另写一份拼 URL 的规则）。取不到就返回 null。
   */
  const altUrl = (conf, id, pathname, query) => {
    const q = new URLSearchParams(query || '');
    q.set('sp_source', id);
    const out = decide(conf, { method: 'GET', pathname, query: q.toString() });
    return out.status === 302 && out.location ? out.location : null;
  };
  /** 取（可能被 rank 覆盖过 order 的）当前配置：static.js 在每次请求前 await 一次，命中缓存时是零成本。 */
  const jump = (pathname, query, method, cfg = null) => {
    const conf = cfg || config;
    const order = Array.isArray(conf.order) ? conf.order : [];
    // 两条剔除线：①「这个源没有这个文件」（存在性）②「这个源现在不可达」（健康，本轮新增）。
    const down = order.filter((id) => knownDown(id));
    const skip = new Set(order.filter((id) => knownMiss(id, pathname)));
    for (const id of down) skip.add(id);
    // 点名一个**已知不可达**的源，等于点名到一个死链 —— 这时把点名降级为"偏好"：按顺序顺延，
    // 而不是照办给玩家一个打不开的地址。（点名一个只是缺这个文件的源，仍然照办。）
    let q = query;
    if (query && down.length) {
      const named = new URLSearchParams(query).get('sp_source');
      if (named && down.includes(named)) {
        q = stripSourceParam(query);
        log.info?.(`[http] asset jump: named source ${named} is unreachable — falling through by order`);
      }
    }
    let out = decide(conf, { method, pathname, query: q, skip: skip.size ? skip : null });
    // 全部候选都被剔除（缺件 / 不可达）→ 退回不带 skip 的主源兜底（给客户 302 比给 404 好），并让缓存继续刷新
    if (out.status !== 302 && skip.size) out = decide(conf, { method, pathname, query: q });
    if (out.status !== 302) return null;
    const chosen = order.find((id) => conf.byId.get(id) && String(out.location).startsWith(conf.byId.get(id)));
    if (chosen) probeExist(chosen, conf.byId.get(chosen), pathname, query);
    if (down.length) {
      healthSkips += down.length;
      log.info?.(`[http] asset jump: skip(health) ${down.join(',')} → ${chosen || out.location}`);
    }
    // 后备清单（客户端侧的顺延）：生效顺序去掉已选中的、去掉已知不可达的，最多 3 条。
    // 标准 `Link: rel="alternate"` + 一个傻瓜头（我们的 pick.js / APK 更容易直接读），两头都给；
    // 不解析这两个头的客户端完全不受影响。
    const headers = { ...out.headers };
    const alts = order
      .filter((id) => id !== chosen && !down.includes(id) && conf.byId.get(id))
      .slice(0, 3)
      .map((id) => altUrl(conf, id, pathname, query))
      .filter(Boolean);
    if (alts.length) {
      headers.Link = alts.map((u) => `<${u}>; rel="alternate"`).join(', ');
      headers['X-SP-Fallbacks'] = alts.join(',');
    }
    return { status: out.status, headers };
  };
  /** 诊断用：存在性缓存的规模与其中「已判缺件」的条数（/sp-edge/status 会带上）。 */
  jump.exists = () => ({ size: exists.size, known: [...exists.values()].filter((e) => e.v === 'miss').length });
  /** 诊断用：每个源的健康判定 + 因为健康被顺延掉的次数（/sp-edge/status 会带上）。 */
  jump.health = () => ({
    sources: Object.fromEntries([...health].map(([id, v]) => [id, { ...v }])),
    byHealth: healthSkips,
    cfg: { intervalMs: HEALTH_INTERVAL_MS, ttlMs: HEALTH_TTL_MS, path: HEALTH_PATH },
  });
  /** 立刻把测速跑一轮并等到结果（线上排查/测试用；正常请求路径不需要它）。 */
  jump.checkProbe = async () => speedProbe.refresh();
  jump.probe = () => ({ ...speedProbe.state(), leads: probeLeads });
  /** 立刻把所有源探一遍并等到结果（线上排查/测试用；正常请求路径不需要它）。 */
  jump.checkHealth = async () => {
    await Promise.all(config.order.map((id) => probeHealth(id, config.byId.get(id))));
    return jump.health();
  };
  jump.config = effective;
  /**
   * Read-only status for the deployment's own diagnostics: what the jump knows (sources, rank) and, on demand, a
   * HEAD probe of the first source and of the upstream (so an operator can tell what this container can reach).
   * Never throws; probe failures are reported as data.
   */
  jump.status = async ({ probe = false, probeUrl = 'https://github.com/sgangs/Stronghold-Protocol/releases.atom' } = {}) => {
    const out = {
      order: effective().order,
      sources: effective().order.map((id) => ({ id, base: config.byId.get(id) })),
      rankUrls: [...urls], rank: rankState,
      jumpEnabled: true, sourcesPath,
      // 存在性缓存：size = 记录条数，known = 其中已判「该源没有这个文件」的条数（302 会避开这些源）
      exists: typeof jump.exists === 'function' ? jump.exists() : null,
      // 源健康：每个源当前通不通，以及因为健康被顺延掉的次数（byHealth）
      health: typeof jump.health === 'function' ? jump.health() : null,
      // 容器视角测速：逐源 TTFB/吞吐（EWMA 平滑）+ 实测序；leads 表示是否让实测序掌舵
      probe: { ...speedProbe.state(), leads: probeLeads },
    };
    if (!probe) return out;
    const head = async (u) => {
      const t0 = Date.now();
      try {
        const r = await fetchImpl(u, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
        return { url: u, status: r.status, ms: Date.now() - t0 };
      } catch (e) { return { url: u, error: String(e?.message || e), ms: Date.now() - t0 }; }
    };
    // Fixed probe list (never a caller-supplied URL: this endpoint must not be an SSRF pivot): every configured
    // source's avatar, plus the upstream endpoints a listener would need.
    const targets = [
      ...effective().order.map((id) => config.byId.get(id) + '/assets/char/avatar/char_003_kalts.png'),
      probeUrl,
      'https://github.com/sganggs/Stronghold-Protocol/releases',
      'https://raw.githubusercontent.com/sganggs/Stronghold-Protocol/master/package.json',
      'https://ghfast.top/https://raw.githubusercontent.com/sganggs/Stronghold-Protocol/master/package.json',
      'https://api.github.com/repos/sganggs/Stronghold-Protocol',
      'https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest',
    ];
    out.probes = await Promise.all([...new Set(targets)].map(head));
    return out;
  };
  return jump;
}
