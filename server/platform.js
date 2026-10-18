// server/platform.js — this game server's own handshake with the openp2p "handshake-only" platform.
//
// The platform (https://p2p.jiangjiangze.icu) never relays game traffic: `GET /go/<id>` answers exactly one 302
// that says where a player goes, and the browser then talks to a game server directly. Registering a room here
// therefore costs this process one small HTTPS POST and zero bytes of gameplay.
//
// Two room kinds, picked by configuration (see platformConfigFromEnv):
//
//   p2p     SP_PLATFORM_HOSTNODE names the host machine's openp2p node. Players tunnel straight to that machine
//           through the platform's 302; when the hole cannot be punched, the platform sends them to
//           SP_PLATFORM_UPSTREAM instead (the public game server). This is "p2p first, server multiplayer second".
//   direct  no host node: the platform only 302s players to this server's own public origin (ModelScope space).
//
// Nothing in this module may affect gameplay. Every failure is logged once and swallowed; a room without a
// platform link keeps the local invite link the web client already builds from `location`.

const DEFAULT_BASE = 'https://p2p.jiangjiangze.icu';
const DEFAULT_TIMEOUT_MS = 4000;
// Platform rooms expire 6 h after they are created (ROOM_TTL_SEC on the platform). Game rooms are usually much
// shorter lived, but a long lobby should not hand out a link that has already expired, so refresh before the TTL.
const DEFAULT_REFRESH_MS = 5 * 3600 * 1000;

const noopLog = { info() {}, warn() {}, error() {} };

/** @param {string} s @returns {string} an http(s) origin without a trailing slash, or '' when unusable */
function normalizeOrigin(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  return u.origin;
}

/**
 * Read the platform settings out of the environment. Returns null when the feature is off, which is the default:
 * an install that sets none of these variables behaves exactly as it did before this module existed.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ base: string, hostNode: string, upstream: string, mode: 'p2p' | 'direct' } | null}
 */
export function platformConfigFromEnv(env = process.env) {
  const url = String(env.SP_PLATFORM_URL ?? '').trim();
  if (url === '0' || url.toLowerCase() === 'off' || url.toLowerCase() === 'false') return null;
  const base = normalizeOrigin(url || DEFAULT_BASE);
  if (!base) return null;
  const hostNode = String(env.SP_PLATFORM_HOSTNODE ?? '').trim();
  // The studio host ModelScope injects is this server's own public origin, so it is the natural default upstream.
  const studio = String(env.STUDIO_HOST || env.SPACE_HOST || '').trim();
  const upstream = normalizeOrigin(env.SP_PLATFORM_UPSTREAM || (studio ? `https://${studio}` : ''));
  if (!hostNode && !upstream) return null; // nothing this server could advertise
  return { base, hostNode, upstream, mode: hostNode ? 'p2p' : 'direct' };
}

/**
 * @param {{ base: string, hostNode: string, upstream: string, mode: 'p2p' | 'direct' }} config
 * @param {{
 *   log?: { info: Function, warn: Function, error: Function },
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   refreshMs?: number,
 *   now?: () => number,
 * }} [deps]
 */
export function createPlatformLink(config, {
  log = noopLog,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  refreshMs = DEFAULT_REFRESH_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { roomId: string, joinUrl: string, at: number, pending: Promise<any> | null }>} */
  const rooms = new Map();
  let lastError = null;
  let lastOkAt = 0;
  let warned = false;

  const fail = (code, why) => {
    lastError = why;
    if (!warned) {
      warned = true;
      log.warn?.(`[platform] ${config.mode} room for ${code} unavailable: ${why} (rooms keep working; the invite link stays local)`);
    }
    return null;
  };

  const body = (code) => (config.hostNode
    ? { hostNode: config.hostNode, code, ...(config.upstream ? { upstream: config.upstream } : {}) }
    : { upstream: config.upstream, code });

  async function post(code) {
    let res;
    try {
      res = await fetchImpl(`${config.base}/api/room`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(code)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return fail(code, e?.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : String(e?.message || e));
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 160); } catch { /* body is optional */ }
      return fail(code, `HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    let json;
    try { json = await res.json(); } catch { return fail(code, 'response was not JSON'); }
    if (!json?.joinUrl || !json?.roomId) return fail(code, 'response carried no joinUrl');
    lastOkAt = now();
    lastError = null;
    return { roomId: String(json.roomId), joinUrl: String(json.joinUrl) };
  }

  return {
    enabled: true,
    mode: config.mode,
    base: config.base,
    upstream: config.upstream,

    /**
     * Register (or re-use) this game room's platform entry. Never rejects.
     * @param {string} code the game's own 4-char alliance code
     * @returns {Promise<{ roomId: string, joinUrl: string } | null>}
     */
    register(code) {
      const key = String(code || '').toUpperCase();
      if (!key) return Promise.resolve(null);
      const hit = rooms.get(key);
      if (hit) {
        if (hit.pending) return hit.pending;
        if (now() - hit.at < refreshMs) return Promise.resolve({ roomId: hit.roomId, joinUrl: hit.joinUrl });
      }
      const pending = post(key).then((res) => {
        const cur = rooms.get(key);
        if (res) rooms.set(key, { roomId: res.roomId, joinUrl: res.joinUrl, at: now(), pending: null });
        else if (cur) rooms.set(key, { ...cur, pending: null });
        return res;
      });
      rooms.set(key, hit ? { ...hit, pending } : { roomId: '', joinUrl: '', at: 0, pending });
      return pending;
    },

    /**
     * Drop the platform entry when the game room is disposed. Best effort: a leftover entry expires on its own
     * after the platform's TTL, so a failed DELETE is not an error worth reporting twice.
     * @param {string} code
     */
    release(code) {
      const key = String(code || '').toUpperCase();
      const hit = rooms.get(key);
      if (!hit) return;
      rooms.delete(key);
      if (!hit.roomId) return;
      Promise.resolve()
        .then(() => fetchImpl(`${config.base}/api/room/${encodeURIComponent(hit.roomId)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(timeoutMs),
        }))
        .catch((e) => log.warn?.(`[platform] release ${hit.roomId} failed: ${e?.message || e}`));
    },

    /** Diagnostics for GET /api/platform — counts only, never player data. */
    status() {
      return {
        enabled: true,
        mode: config.mode,
        base: config.base,
        upstream: config.upstream || null,
        hostNode: config.hostNode || null,
        rooms: rooms.size,
        lastOkAt: lastOkAt || null,
        lastError,
      };
    },
  };
}

/** The `GET /api/platform` answer for an install with the feature switched off. */
export const PLATFORM_DISABLED = Object.freeze({ enabled: false });
