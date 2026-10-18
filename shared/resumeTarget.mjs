// shared/resumeTarget.mjs — 「服务器重启后，客户端还能拿本地记录自动回哪个房间」（纯函数，浏览器与 Node 通用）。
//
// 背景（审计结论）：
//   · 对局状态 100% 在服务端内存，重启即失；客户端不可能凭本地数据「续一局」。
//   · 但客户端**确实**握着可复用的东西：本机最近若干 token（localStorage 环）与每个 token 记下的
//     房间名 + 房间码（sp.matches）。服务端重启后 token 失效、playerId 重发，但房间壳若被恢复
//     （T1：只存 code/mode/difficulty 等，不存座位与对局），拿房间码重新 room.join 就能回到同一个房间。
//   · 没有房间壳时这次 join 会失败，走既有的回大厅路径——所以「尝试」本身是安全降级。
//
// 这个模块只回答「该拿哪一条去试」：取最近记录、限定时效、忽略不完整记录。不碰存储、不碰网络。

/** 服务端的重连窗口（与 server/net.js 的 reconnectWindowMs 默认值一致）：超过这个年龄的房间码不再自动尝试。 */
export const RESUME_WINDOW_MS = 10 * 60 * 1000;

/**
 * 从 recovery 列表里挑最新的一条可复用记录。
 * @param {Array<{ name?: string, code?: string, at?: number }>} list
 *   `at` = 该记录最后一次被确认的时间（毫秒）。缺失 `at` 的记录按「未知时间」处理：仍可被选中，
 *   但不参与「最新」比较（优先选有时间的），因为老版本的记录没有这个字段。
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 * @returns {{ name: string, code: string, at: number | null } | null}
 */
export function pickResumeTarget(list, { now = Date.now(), maxAgeMs = RESUME_WINDOW_MS } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  const fresh = [];
  for (const item of list) {
    if (!item || typeof item.code !== 'string') continue;
    const code = item.code.trim();
    // 房间码是固定长度的字母数字码；不完整/占位的记录不试（避免拿垃圾去 join）
    if (!/^[A-Za-z0-9]{3,32}$/.test(code)) continue;
    const at = Number.isFinite(item.at) ? item.at : null;
    if (at != null) {
      const age = now - at;
      if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) continue; // 未来时间或过期都不算
    }
    fresh.push({ name: typeof item.name === 'string' ? item.name.slice(0, 64) : '', code, at });
  }
  if (!fresh.length) return null;
  // 有时间的按时间倒序；没有时间的排在后面（记录存在但不知道多旧，仍可一试）
  fresh.sort((a, b) => {
    if (a.at != null && b.at != null) return b.at - a.at;
    if (a.at != null) return -1;
    if (b.at != null) return 1;
    return 0;
  });
  return fresh[0];
}
