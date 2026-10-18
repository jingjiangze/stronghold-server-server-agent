// A/B 的「浏览器」侧（独立进程）：开一局 1 真人(托管) + 3 AI，把每个 b.rehearsal 用与浏览器 worker 逐字相同的
// RehearsalRun 算完并回 choice —— 两侧选中的候选与服务器自己算的一致，两局可比。
//
// CPU 采集：/healthz 的 process.cpu.totalMs 是「上一个采样窗口」的 CPU（不是累计），所以按 sampledAt 去重后累加
// 连续窗口 = 该段时间的服务器 CPU 总量。
import { TestClient } from './test/helpers/wsClient.js';
import { getData } from './server/data.js';
import { DataSource } from './server/sim/simdata.js';
import { createBattleFromSpec } from './server/sim/spec.js';
import { RehearsalRun } from './server/sim/rehearsal.js';

const PORT = Number(process.env.AB_PORT || 3100);
const ROUNDS = Number(process.env.AB_ROUNDS || 4);
const MAX_MS = Number(process.env.AB_MAX_MS || 600000);
const label = process.env.AB_LABEL || 'run';
const H = `http://127.0.0.1:${PORT}/healthz`;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const ds = new DataSource(getData({ log: quietLog }), null);

let cpuMs = 0;
const samples = new Set();
const pollCpu = async () => {
  try {
    const j = await (await fetch(H)).json();
    const at = j.performance.sampledAt;
    const t = j.performance.process.cpu.totalMs;
    if (t != null && !samples.has(at)) { samples.add(at); cpuMs += t; }
  } catch { /* ignore */ }
};

const c = await TestClient.connect(`ws://127.0.0.1:${PORT}/ws`);
const w = await c.hello('AB');
const ok = async (m) => { const r = await c.request(m, 20000); if (r.t !== 'ok') throw new Error(`${m.t}: ${JSON.stringify(r)}`); };
await ok({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
for (let i = 0; i < 3; i++) await ok({ t: 'room.addBot' });
await c.waitFor('room.state', (s) => s.seats.filter((x) => x && x.isBot).length === 3, 20000);
await ok({ t: 'room.start' });
await c.waitFor('m.public', () => true, 20000);
await ok({ t: 'g.autoplay', on: true });

const t0 = Date.now();
let tasks = 0, answered = 0, errored = 0, cancels = 0, round = 0, stopped = null;
const seen = new Set();
const pump = async () => {
  await pollCpu();
  for (const msg of c.log) {
    if (msg.t === 'm.public' && Number.isInteger(msg.round)) round = Math.max(round, msg.round);
    if (msg.t === 'b.rehearsalCancel') { cancels++; continue; }
    if (msg.t !== 'b.rehearsal' || seen.has(msg.taskId)) continue;
    seen.add(msg.taskId); tasks++;
    try {
      const run = new RehearsalRun(
        msg.specs.map((spec) => () => createBattleFromSpec(spec, ds, { quiet: true, recordEvents: false })),
        msg.playerId, msg.cap);
      run.run();
      c.send({ t: 'b.rehearsalResult', taskId: msg.taskId, choice: run.score.index });
      answered++;
    } catch {
      errored++;
      c.send({ t: 'b.rehearsalResult', taskId: msg.taskId, error: true });
    }
  }
  // 到目标轮次就离开，给这次测量封顶（战斗是实时钟，一局十几分钟）
  if (!stopped && round >= ROUNDS) { stopped = 'rounds'; c.send({ t: 'g.leave' }); }
};
const timer = setInterval(() => { pump().catch(() => {}); }, 1000);

let ended = null;
const deadline = Date.now() + MAX_MS;
while (!stopped && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  const got = c.log.find((m) => m.t === 'm.result');
  if (got) { ended = got; stopped = 'result'; }
}
if (!stopped) stopped = 'timeout';
clearInterval(timer);
await pollCpu();
const wallS = (Date.now() - t0) / 1000;
const cpuS = cpuMs / 1000;
console.log(JSON.stringify({
  label, stopped, rounds: round, wallS: +wallS.toFixed(1),
  serverCpuS: +cpuS.toFixed(2), cpuPerRoundS: round ? +(cpuS / round).toFixed(2) : null,
  tasks, answered, errored, cancels, victory: ended ? ended.victory : null, reason: ended ? ended.reason : null,
}, null, 1));
await c.terminate();
process.exit(0);
