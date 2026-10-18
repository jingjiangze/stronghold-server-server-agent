// A/B 的服务器侧：固定种子 + 加速相位 + 可注入的 Match 选项
import { startServer } from './server/index.js';
import { Match } from './server/match/Match.js';

const port = Number(process.env.AB_PORT || 3100);
const seed = Number(process.env.AB_SEED || 20261015);

// timerScale 只压缩相位墙钟（预演成本由候选 spec 决定，不受它影响）；delegateMs 放大到 30s 原始值
// （scaled 后 4.5s），让进程外的「浏览器」有足够时间算完并回话。
class ABMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 0.15, botRehearsalDelegateMs: 30000, combatSpeed: 40,
    ...(process.env.AB_REHEARSAL !== undefined ? { botRehearsal: Number(process.env.AB_REHEARSAL) } : {}) }); }
}

const srv = await startServer({ port, host: '127.0.0.1', seedFn: () => seed, MatchClass: ABMatch });
console.log(`[ab] ready port=${srv.port} seed=${seed} SP_BOT_REHEARSAL=${process.env.SP_BOT_REHEARSAL || '(off)'}`);
process.on('SIGTERM', () => { srv.close().then(() => process.exit(0)); });
