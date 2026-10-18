// _probe-outcome.mjs — 真机实测（本机、进程内真实类）：异常结算不入库。
//
// 做法：真实 Match + VirtualScheduler 跑到第一次 prep 结束（endPrep 里强制把机器人当真人调
// recordPrepLineups，与 _probe-learn.mjs 同一手法，只为让「暂存」发生），然后直接 m.finish({reason})
// 快进到结算。五种 reason 各跑一局、各自一个临时库文件，最后数行数。
//
// 另外验 SP_LINEUP_MODE 的翻译：public → remote（两个 base + 临时缓存目录）、local → <root>/lineups、
// 显式 SP_LINEUP_LIBRARY 优先。
//
// 不改仓库文件；库文件在系统临时目录，跑完删除。用完即弃，不提交。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Match } = await import('./server/match/Match.js');
const { PlayerState } = await import('./server/match/PlayerState.js');
const { VirtualScheduler } = await import('./server/match/scheduler.js');
const { getData } = await import('./server/data.js');
const { recordPrepLineups } = await import('./server/lineupLibrary.js');
const { PHASE } = await import('./shared/constants.js');

const log = { info() {}, debug() {}, warn() {}, error() {} };
const data = getData({ log });
const SEED = 20261015;

// endPrep 里把「机器人」暂时当真人，让 recordPrepLineups 真的暂存（只为制造数据；过滤器本身没被改）
const botCtrlDesc = Object.getOwnPropertyDescriptor(PlayerState.prototype, 'botControlled');
const origEndPrep = Match.prototype.endPrep;
let stagedCount = 0;
Match.prototype.endPrep = function patchedEndPrep() {
  if (this.phase === PHASE.PREP) {
    Object.defineProperty(PlayerState.prototype, 'botControlled', { ...botCtrlDesc, get() { return false; } });
    try { recordPrepLineups(this); } finally {
      Object.defineProperty(PlayerState.prototype, 'botControlled', botCtrlDesc);
    }
    stagedCount++;
  }
  return origEndPrep.call(this);
};

async function trial({ reason, victory }) {
  const dir = mkdtempSync(join(tmpdir(), `sp-outcome-${reason}-`));
  process.env.SP_LINEUP_LIBRARY = dir;
  stagedCount = 0;

  const sched = new VirtualScheduler();
  const seats = [];
  for (let i = 0; i < 4; i++) seats.push({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true });
  const m = new Match({
    roomCode: `OUT-${reason}`, mode: 'coop', difficulty: 'HARD', seats, seed: SEED, data,
    log, scheduler: sched, send: () => true, broadcast: () => {}, onEnd: () => {},
  });

  m.start();
  sched.runUntil(() => stagedCount > 0, { maxSteps: 5e6 });
  const staged = stagedCount;
  // 快进到结算：直接给 reason，不真打完
  m.finish({ victory, reason });
  await new Promise((r) => setTimeout(r, 300)); // append 是 fire-and-forget

  const file = join(dir, `lineups_${m.modeId}.jsonl`);
  const existed = existsSync(file);
  let lines = [];
  if (existed) lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let first = null;
  if (lines.length) { try { first = JSON.parse(lines[0]); } catch { first = { parse: 'failed' }; } }
  m.dispose();
  rmSync(dir, { recursive: true, force: true });
  process.env.SP_LINEUP_LIBRARY = '';
  return { reason, staged, file: existed ? 'exists' : 'absent', lines: lines.length, first };
}

const cases = [
  { reason: 'victory', victory: true, want: true },
  { reason: 'defeat', victory: false, want: true },
  { reason: 'eliminated', victory: false, want: false },
  { reason: 'abandoned', victory: false, want: false },
  { reason: 'error', victory: false, want: false },
];

console.log('== 结算原因过滤（真实 Match，5 局各自独立库文件）==');
let ok = 0;
for (const c of cases) {
  const r = await trial(c);
  const pass = (r.lines > 0) === c.want;
  const shape = r.first && r.first.t === 'lineup' && Array.isArray(r.first.cells) && r.first.cells.length >= 2;
  if (pass && (c.want ? shape : true)) ok++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${c.reason.padEnd(10)} staged=${r.staged} file=${r.file} lines=${r.lines}` +
    (r.first ? `  first={t:${r.first.t}, cells:${r.first.cells ? r.first.cells.length : '-'}, modeId:${r.first.modeId}}` : ''),
  );
}

// ---- SP_LINEUP_MODE 翻译（真实 startServer 装配）----
console.log('\n== SP_LINEUP_MODE 翻译（真实 startServer）==');
const { startServer } = await import('./server/index.js');
const saved = { ...process.env };
async function startWith(env) {
  for (const k of ['SP_LINEUP_MODE', 'SP_LINEUP_LIBRARY', 'SP_LINEUP_SYNC', 'SP_LINEUP_PUBLISH', 'SP_LINEUP_OUTBOX']) delete process.env[k];
  // 默认把三条链路全关掉：只测 MODE 翻译，不要让同步/发布/outbox 去打网络或写盘
  Object.assign(process.env, { SP_LINEUP_SYNC: '0', SP_LINEUP_PUBLISH: '0', SP_LINEUP_OUTBOX: '0' }, env);
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const resolved = process.env.SP_LINEUP_LIBRARY || '';
  const health = await (await fetch(`${srv.url}/healthz`)).json();
  await srv.close();
  return { resolved, ok: health.ok === true };
}
const trials2 = [
  { name: 'public', env: { SP_LINEUP_MODE: 'public', SP_LINEUP_SYNC: '0' }, want: (s) => s.startsWith('remote:') && s.includes('speedcdn') && s.includes('ghfast.top') && s.includes('|') },
  { name: 'local', env: { SP_LINEUP_MODE: 'local', SP_LINEUP_SYNC: '0', SP_LINEUP_PUBLISH: '0', SP_LINEUP_OUTBOX: '0' }, want: (s) => /lineups$/.test(s.replace(/[\\/]+$/, '')) },
  { name: 'explicit wins', env: { SP_LINEUP_MODE: 'public', SP_LINEUP_LIBRARY: join(tmpdir(), 'explicit-lineups'), SP_LINEUP_SYNC: '0' }, want: (s) => s === join(tmpdir(), 'explicit-lineups') },
  { name: 'unknown = off', env: { SP_LINEUP_MODE: 'nonsense', SP_LINEUP_SYNC: '0' }, want: (s) => s === '' },
];
for (const t of trials2) {
  const r = await startWith(t.env);
  const good = t.want(r.resolved) && r.ok;
  if (good) ok++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${t.name.padEnd(14)} resolved=${r.resolved || '(empty)'}  healthz.ok=${r.ok}`);
}

for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
Object.assign(process.env, saved);
// local 模式会在仓库根建一个空的 lineups/ 目录；清掉（只在它确实是空的时）
try { rmSync(join(process.cwd(), 'lineups'), { recursive: false }); } catch { /* 非空或不存在：不动 */ }

const total = cases.length + trials2.length;
console.log(`\n${ok}/${total} PASS`);
process.exit(ok === total ? 0 : 1);
