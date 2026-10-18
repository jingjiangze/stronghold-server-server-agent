// server/lineupOutbox.js — 布阵学习增量的「先本地、后补传」队列（方案 a），补传走既有的专用数据通道。
//
// 为什么是 outbox 而不是直接 POST：p2p 联机里游戏服务器跑在房主自己的机器上，网络随时断（隧道抖动、
// 笔记本合盖、拨号重连）。一场对局结算（flushMatchLineups）在本地落库的同时把同批记录追加进
// outbox 文件；之后定时器把积压**经 lineupPublish 的上传链**发成
// packs/lineup-library/<modeId>__<DIFFICULTY>-<YYYY-MM-DD>.jsonl，确认（2xx）才删行。
// 断线期间积压、上线后自动续传——这就是「优先到本地（缓存），连不上服务器则下次」。
//
// 日期键的语义（与 Phase 7 的专用通道一致）：上传键只增不改，同一天对同一模式第二次发布必然 409。
// 409 **不代表本次这批记录已上传**，所以不删行、不重试到爆——推到下一个 UTC 零点用新键再发。
// 于是有效上行粒度是「每模式每天一份」，首份在有数据的第一个 tick 就发（不必等 24h 的整库发布）。
//
// 与 lineupPublish 的关系：publish 是「此刻的整库快照」发布器（无口令则干净跳过）；本模块是增量
// 语义层——决定「哪一批记录还没确认过」，并按库目录分模式攒批调用 publish 的同一条上传链。中心侧
// （CDN promote + R2 稳定别名 + GitHub 镜像）全部是既有设施，这里不引入任何新端点。
//
// 三条硬规矩（与 lineupSync / upstreamWatch / lineupPublish 同一范式）：
//   1. 尽力而为：入队、补传的任何失败只记日志，绝不影响对局、绝不抛进调用链。
//   2. 定时器 unref()，不吊住进程退出。
//   3. 未配置 SP_LINEUP_PUBLISH（无口令）时整个模块零动作：不建文件、不读盘、不发请求——
//      本地库照常记录，行为与未接入完全一致。
//
// 配置（环境变量）：
//   SP_LINEUP_OUTBOX=0   关闭本模块（不建 outbox、不入队；本地库不受影响）。
//   SP_LINEUP_OUTBOX_MS  补传间隔，默认 15 分钟。
//   （口令与端点沿用 lineupPublish 的口径：CDN_ADMIN_KEY / ~/.cdn_admin_key、SP_LINEUP_PUBLISH_URL。）
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
/** 结算后立即补传的合并窗口：一局刚结束、同一进程里可能连着几局，3 秒内的多次请求只跑一趟。 */
const FLUSH_DEBOUNCE_MS = 3000;
/** outbox 自身上限：独立于学习库的 3 MiB 窗口——补传长期失败时丢最旧的增量，保住最新的教学数据。 */
const MAX_OUTBOX_LINES = 8000;
const TMP_SUFFIX = '.partial';

/** outbox 文件名：不匹配 lineups_*.jsonl，publish 的枚举与 lineupModes 天然看不见它。 */
export const OUTBOX_NAME = 'outbox.jsonl';

/** 是否启用：publish 口令在（或可能在其默认位置 ~/.cdn_admin_key）且未被显式关闭。 */
export function outboxEnabled(env = process.env) {
  return env.SP_LINEUP_OUTBOX !== '0';
}

/** 规范化 URL：与 lineupPublish 一致地接受空值（调用方据此决定是否启动）。 */
export function ingestEndpoint(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  return trimmed || null;
}

/**
 * 入队一批：由 flushMatchLineups 在本地落库的同一循环里调用（outcome/farm/validCells 门控都已在
 * 调用方跑过）。记录带信封字段：mid（对局标识 battlePrefix——跨主机可碰撞，仅作排查线索）、
 * outcome（结算结果 {victory, reason}，中心复核用）。fire-and-forget：任何失败只记日志。
 */
export async function enqueueOutbox(dir, recs, meta = {}, env = process.env) {
  if (!outboxEnabled(env) || !dir || !Array.isArray(recs) || !recs.length) return;
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, OUTBOX_NAME);
    const lines = recs.map((rec) => JSON.stringify({
      t: 'lineup', ...rec,
      mid: meta.mid ?? null,
      outcome: meta.outcome ?? null,
    })).join('\n');
    await appendFile(file, `${lines}\n`, 'utf8');
    const [{ size }, text] = await Promise.all([stat(file), readFile(file, 'utf8')]);
    const count = text.split('\n').filter(Boolean).length;
    if (size > 2 * 1024 * 1024 || count > MAX_OUTBOX_LINES) await trimOutbox(file);
  } catch (e) {
    console.error('[lineup-outbox] enqueue failed:', e && e.message); // telemetry off, never into the match
  }
}

/** 超限丢最旧的四分之一（保留最新——学习数据的新近度就是它的价值）。.partial+rename 原子重写。 */
export async function trimOutbox(file) {
  let lines;
  try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { return; }
  if (lines.length < 2) return;
  const kept = lines.slice(Math.floor(lines.length * 0.25));
  try {
    await writeFile(file + TMP_SUFFIX, `${kept.join('\n')}\n`, 'utf8');
    await rename(file + TMP_SUFFIX, file);
    console.warn(`[lineup-outbox] over cap: dropped ${lines.length - kept.length} oldest`);
  } catch (e) {
    console.error('[lineup-outbox] trim failed:', e && e.message);
    try { await rm(file + TMP_SUFFIX, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * 补传器。dir 是库目录；`publish` 是 lineupPublish.publishLibrary 的注入点（测试换假实现，
 * 生产用真上传链）。每轮把积压按模式分组，以「当日 + 该模式」为目标键发布；
 * publish 报 ok（200 或 409「已发布过」）的记录确认删除，其余留在队列。
 * 形状与 createLineupSync 一致：start/stop/syncOnce/state，失败指数退避、绝不上抛。
 */
export function createLineupOutbox({
  dir, publish, log = console, intervalMs = DEFAULT_INTERVAL_MS, now = () => Date.now(),
  flushDebounceMs = FLUSH_DEBOUNCE_MS,
} = {}) {
  const state = { startedAt: null, lastTick: null, ticks: 0, sent: 0, failures: 0, error: null, pending: 0 };
  let timer = null, flushTimer = null, busy = false, backoffUntil = 0, consecutiveFailures = 0;
  const file = join(dir, OUTBOX_NAME);

  async function readPending() {
    try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
  }

  /** 删掉已确认的这批行：重写时按「当前盘上内容」过滤，补传窗口内新 append 的行（不在确认集里）留下。 */
  async function confirmDelete(confirmed) {
    const set = new Set(confirmed);
    const remaining = (await readPending()).filter((s) => !set.has(s));
    if (!remaining.length) { await rm(file, { force: true }); return; }
    await writeFile(file + TMP_SUFFIX, `${remaining.join('\n')}\n`, 'utf8');
    await rename(file + TMP_SUFFIX, file);
  }

  async function tick() {
    if (busy || now() < backoffUntil) return;
    busy = true;
    state.ticks++;
    state.lastTick = new Date().toISOString();
    try {
      const lines = await readPending();
      state.pending = lines.length;
      if (!lines.length) { state.error = null; consecutiveFailures = 0; return; }
      // 按「玩法 + 难度」分组（发布键以库为粒度，与 lineupLibrary.libraryKey 同构），每组的记录组装成一批发给 publish。
      // 解析不了的行直接进确认集：它永远发不出去，留着只会每一轮重新失败。
      const byMode = new Map();
      const corrupt = [];
      for (const s of lines) {
        let rec;
        try { rec = JSON.parse(s); } catch { corrupt.push(s); continue; }
        const mode = `${rec.modeId || ''}__${String(rec.difficulty || '').toUpperCase()}`;
        if (!byMode.has(mode)) byMode.set(mode, { records: [], lines: [] });
        const g = byMode.get(mode);
        g.records.push(rec);
        g.lines.push(s);
      }
      if (!byMode.size) { await confirmDelete(lines); return; } // 全是坏行：清空，无可发送
      let anyOk = false, anyFail = false, slotTaken = false;
      const confirmed = [];
      for (const [key, g] of byMode) {
        try {
          const res = await publish({ dir, key, records: g.records });
          // 409 = 今日该模式的日期键已被占（只增不改）。这**不是**确认：本次这批记录并没有上传，
          // 删掉就是数据丢失。留着等次日的新键（与 publishLibrary 的日粒度对齐），这里只把下一次
          // 尝试推到下一个 UTC 零点之后。
          if (res && res.status === 409) { slotTaken = true; continue; }
          if (res && res.ok === true) { anyOk = true; state.sent += g.lines.length; confirmed.push(...g.lines); }
          else anyFail = true;
        } catch (e) {
          anyFail = true;
          log.warn?.(`[lineup-outbox] publish ${key || '(no key)'} failed: ${(e && e.message) || e}`);
        }
      }
      if (confirmed.length || corrupt.length) await confirmDelete([...confirmed, ...corrupt]);
      if (slotTaken) {
        const nextMidnight = Math.ceil(now() / 86400000) * 86400000 + 120000; // 次日 00:02 UTC，错开整点
        backoffUntil = nextMidnight;
        state.error = 'today\'s key already published — waiting for the next UTC day';
        log.info?.(`[lineup-outbox] slot taken for today; next attempt in ${Math.round((nextMidnight - now()) / 60000)} min`);
      }
      if (anyFail && !anyOk) throw new Error('every mode failed to publish'); // 触发退避
      state.pending = (await readPending()).length;
      if (!slotTaken) { state.error = null; consecutiveFailures = 0; }
    } catch (e) {
      consecutiveFailures++;
      state.failures++;
      state.error = String((e && e.message) || e).slice(0, 160);
      backoffUntil = now() + Math.min(60 * 60_000, intervalMs * Math.pow(2, Math.min(consecutiveFailures, 5)));
      log.warn?.(`[lineup-outbox] flush failed (${state.error}) — backoff ${Math.round((backoffUntil - now()) / 1000)}s`);
    } finally { busy = false; }
  }

  return {
    start() {
      if (timer) return;
      state.startedAt = new Date().toISOString();
      log.info?.(`[lineup-outbox] start (${file} → lineup publish channel, every ${Math.round(intervalMs / 1000)}s)`);
      tick();
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } },

    /**
     * 立即补传（结算后调用）：合并 FLUSH_DEBOUNCE_MS 内的多次请求，避免一局刚结束就连发多批。
     * 与定时器共用同一个 tick，busy/退避照旧；失败不抛、留给下一轮。
     */
    requestFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; void tick(); }, flushDebounceMs);
      if (flushTimer.unref) flushTimer.unref();
    },
    /** 立刻补传一次（可 await：诊断/测试用）。 */
    syncOnce: tick,
    state: () => ({ ...state, intervalMs, file }),
  };
}

/** 测试/诊断辅助：outbox 是否存在非空（existsSync 在这里够用——诊断路径不追求原子性）。 */
export function outboxHasPending(dir) {
  if (!dir) return false;
  try { return existsSync(join(dir, OUTBOX_NAME)); } catch { return false; }
}
