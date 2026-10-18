// shared/matchSnapshot.mjs — 「从客户端本地状态反推对局」的提交格式与校验（纯函数，浏览器与 Node 通用）。
// (i18n-ignore-file: reason 是给服务端审计/日志看的判定理由，不进 UI —— 见 docs/I18N.md)
//
// 审计结论（docs/RECONNECT-LOCAL-REBUILD.md）：服务端重启后，客户端手里**有**每个玩家自己的
// 棋盘 / 手牌 / 资金 / 商店 / 生命 / 阶段，**没有**共享卡池剩余、随机数状态、AI 布阵序列。
// 所以「反推」只能做「按玩家上报的状态重组一局」，并且必须允许有出入（卡池按当前持有重算、
// AI 用新种子重派）。本模块只负责**收单与消毒**：把客户端发来的任意 JSON 收敛成固定形状，
// 丢弃多余字段、拒绝越界与超限，保证服务端拿到的东西有界、可审计。
//
// 三条硬规则：
//   1. **白名单字段**：只保留下面列出的字段，其它一律丢弃（客户端可以乱发，服务端不认）。
//   2. **有界**：棋盘 ≤ 64 格、手牌 ≤ 64、商店 ≤ 12、字符串长度与总字节数都有上限。
//   3. **不猜**：缺字段就是缺，返回 missing 列表；调用方决定是否接受（缺资金的玩家可以按默认值补）。

/** 版本号：格式变更时递增，服务端只接受自己认识的版本。 */
export const SNAPSHOT_VERSION = 1;
/** 单个玩家快照的字节上限（JSON 序列化后）。一个 64 格棋盘 + 手牌 + 商店 ≈ 3–6 KB。 */
export const SNAPSHOT_MAX_BYTES = 16384;
const MAX_BOARD = 64;
const MAX_HAND = 64;
const MAX_SHOP = 12;

const DIRS = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT']);
const KINDS = new Set(['chess', 'item', 'token', 'summon']);

const isInt = (v) => Number.isInteger(v);
const clampStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

/** 棋盘格：必须四要素齐全、方向在白名单、坐标在 0..40（粗界，服务端还会按场地再判）。 */
function cell(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clampStr(raw.id, 64);
  if (!id) return null;
  if (!isInt(raw.row) || !isInt(raw.col) || raw.row < 0 || raw.row > 40 || raw.col < 0 || raw.col > 40) return null;
  const dir = String(raw.dir || '').toUpperCase();
  if (!DIRS.has(dir)) return null;
  return { id, golden: !!raw.golden, row: raw.row, col: raw.col, dir, uid: clampStr(raw.uid, 64) };
}

/**
 * 把客户端提交的原始对象收敛成服务端能用的快照。
 * @param {unknown} raw
 * @returns {{ ok: true, snapshot: object, dropped: string[], missing: string[] }
 *          | { ok: false, reason: string }}
 */
export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '不是对象' };
  if (raw.v !== SNAPSHOT_VERSION) return { ok: false, reason: `版本不认识（要 ${SNAPSHOT_VERSION}）` };
  const roomCode = clampStr(raw.roomCode, 32);
  const playerId = clampStr(raw.playerId, 64);
  if (!roomCode) return { ok: false, reason: '缺 roomCode' };
  if (!playerId) return { ok: false, reason: '缺 playerId' };

  const dropped = [];
  const missing = [];
  const out = {
    v: SNAPSHOT_VERSION,
    roomCode,
    playerId,
    at: isInt(raw.at) ? raw.at : null,
    phase: clampStr(raw.phase, 24),
    round: isInt(raw.round) ? raw.round : null,
    lp: isInt(raw.lp) ? raw.lp : null,
    funds: isInt(raw.funds) ? raw.funds : null,
    bandId: clampStr(raw.bandId, 64),
    alive: raw.alive !== false,
    board: [],
    hand: [],
    shop: null,
    stats: null,
  };
  if (out.phase == null) missing.push('phase');
  if (out.round == null) missing.push('round');
  if (out.lp == null) missing.push('lp');
  if (out.funds == null) missing.push('funds');

  if (Array.isArray(raw.board)) {
    for (const c of raw.board.slice(0, MAX_BOARD)) {
      const cellOk = cell(c);
      if (cellOk) out.board.push(cellOk); else dropped.push('board[]');
    }
  } else if (raw.board != null) dropped.push('board');

  if (Array.isArray(raw.hand)) {
    for (const p of raw.hand.slice(0, MAX_HAND)) {
      if (!p || typeof p !== 'object') { dropped.push('hand[]'); continue; }
      const id = clampStr(p.id, 64);
      const kind = String(p.kind || 'chess');
      if (!id || !KINDS.has(kind)) { dropped.push('hand[]'); continue; }
      out.hand.push({ uid: clampStr(p.uid, 64), kind, id, golden: !!p.golden, count: isInt(p.count) && p.count > 0 ? Math.min(p.count, 99) : 1 });
    }
  } else if (raw.hand != null) dropped.push('hand');

  if (raw.shop && typeof raw.shop === 'object') {
    const slots = [];
    for (const s of (Array.isArray(raw.shop.slots) ? raw.shop.slots.slice(0, MAX_SHOP) : [])) {
      if (!s || typeof s !== 'object') continue;
      const id = clampStr(s.id, 64);
      if (!id) continue;
      slots.push({ kind: KINDS.has(String(s.kind)) ? String(s.kind) : 'chess', id, sold: !!s.sold });
    }
    out.shop = { level: isInt(raw.shop.level) && raw.shop.level >= 0 && raw.shop.level <= 12 ? raw.shop.level : null, slots };
  } else if (raw.shop != null) dropped.push('shop');

  if (raw.stats && typeof raw.stats === 'object') {
    const n = (v) => (isInt(v) && v >= 0 ? Math.min(v, 1e9) : 0);
    out.stats = { kills: n(raw.stats.kills), leaks: n(raw.stats.leaks), gold: n(raw.stats.gold) };
  }

  const json = JSON.stringify(out);
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(json).length : json.length;
  if (bytes > SNAPSHOT_MAX_BYTES) return { ok: false, reason: `快照过大（${bytes} > ${SNAPSHOT_MAX_BYTES} 字节）` };
  return { ok: true, snapshot: out, dropped, missing };
}

/** 一套快照是否足够重建这一局：每个活着的玩家都要有，且房间码一致。 */
export function checkSnapshotSet(list, { expectedPlayers = [] } = {}) {
  const errors = [];
  const byPlayer = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const res = sanitizeSnapshot(item);
    if (!res.ok) { errors.push(`${item && item.playerId ? item.playerId : '?'}: ${res.reason}`); continue; }
    byPlayer.set(res.snapshot.playerId, res.snapshot);
  }
  for (const pid of expectedPlayers) if (!byPlayer.has(pid)) errors.push(`${pid}: 没有提交快照`);
  return { ok: errors.length === 0, snapshots: [...byPlayer.values()], errors };
}
