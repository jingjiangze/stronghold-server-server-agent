// 素材跳转 sidecar：只回答「这个请求该 302 到哪个源」，不代理一个字节。
//
// 为什么是独立进程而不是 nginx 里的 Lua（Stardust 的 openi-resolver 也是这个形状）：
//   * nginx 的 Lua 是动态模块，配置里少一行 include 就会让所有 lua_* 变成未知指令、nginx
//     直接起不来；换成普通 nginx 就把这个失败模式整个删掉。
//   * 这一段是纯函数式决策，node --test 直接就能测，不需要为了测 Lua 去装一个 Lua VM。
//
// 不猜「哪个源对当前玩家最快」：容器在 ModelScope 机房，玩家在全国各地，容器量出来的链路
// 速度不代表玩家的。这里是静态顺序（可被客户端用 ?sp_source=<id> 覆盖），按玩家网络选最快
// 是客户端 pick.js 的事——两者分工，而不是让服务端假装自己知道。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG_PATH = path.join(HERE, 'sources.json');
export const DEFAULT_PORT = 3130;
export const CACHE_SECONDS = 300;
export const MAX_TARGET = 8192;
export const MAX_PATH = 2048;

// 只分流确实可重定向的扩展名。清单/代码（js/css/json）留在游戏本体，因为它们可能与本地
// 构建产物不同版本。nginx 用同一张表做粗筛，这里做权威判定。
export const ALLOWED_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'atlas', 'skel', 'obj', 'mtl',
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav',
  'ttf', 'otf', 'woff', 'woff2',
]);

// 每段必须是 [A-Za-z0-9_[-] 开头、之后允许 . —— 于是 ".."、"尾点段"、控制字符全部被拒。
const SEGMENT = /^[A-Za-z0-9_[-][A-Za-z0-9_.[\]-]*$/;

/**
 * 扩展名闸门：白名单之外只放一个例外 —— `/fonts/fonts.css`，官方客户端唯一的字体清单（它属于字体集，
 * 镜像里就在 fonts/ 下）。`/assets/` 下的 css/js/json 仍然留给游戏本体：那些可能与本地构建产物版本不同。
 */
export function allowedExt(pathname) {
  const ext = extensionOf(pathname);
  if (ALLOWED_EXT.has(ext)) return true;
  // `/fonts/fonts.css`（官方客户端唯一的字体清单）与提取出来的**本地美术**（`/assets/local/**` 的
  // scene.json / scene.bin 与其它 json 清单）在容器里没有本地副本，不存在「与本地构建产物版本不一致」
  // 的问题 —— 它们是本地美术的一部分，跟着同一张源表走。`/assets` 下其它位置的 css/js/json 仍留给游戏本体。
  if (ext === 'css' && pathname.startsWith('/fonts/')) return true;
  return (ext === 'json' || ext === 'bin') && pathname.startsWith('/assets/local/');
}

export function splittable(pathname) {
  return pathname.startsWith('/assets/') || pathname.startsWith('/fonts/');
}

export function validPath(pathname) {
  if (pathname.length < 2 || pathname.length > MAX_PATH) return false;
  if (pathname.includes('//')) return false;
  for (const seg of pathname.split('/')) {
    if (seg === '') continue; // 前导 '/'
    if (!SEGMENT.test(seg) || seg.endsWith('.')) return false;
  }
  return true;
}

export function extensionOf(pathname) {
  const i = pathname.lastIndexOf('.');
  if (i < 0) return '';
  return pathname.slice(i + 1).toLowerCase();
}

/**
 * Parse and validate sources.json. Throws on anything that would turn this sidecar into an open
 * redirect: the file is a build-time artifact, but a hand edit must not get that far.
 */
export function parseSources(raw) {
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sources) || !Array.isArray(doc.order)) {
    throw new Error('sources.json: expected { sources: [], order: [] }');
  }
  const byId = new Map();
  for (const src of doc.sources) {
    if (typeof src?.id !== 'string' || typeof src?.base !== 'string') continue;
    if (!src.base.startsWith('https://') || src.base.includes('..')) continue;
    byId.set(src.id, src.base);
  }
  if (byId.size === 0) throw new Error('sources.json: no usable source');
  // 个别路径任何一个源都供不了（平台的审核会把它们挡下），必须点名改道。
  // 只接受指向已知源的 id：例外表也不能变成任意 URL。
  const exceptions = new Map();
  if (doc.exceptions && typeof doc.exceptions === 'object') {
    for (const [p, id] of Object.entries(doc.exceptions)) {
      if (typeof p === 'string' && typeof id === 'string' && byId.has(id)) exceptions.set(p, byId.get(id));
    }
  }
  return { byId, order: doc.order.filter((id) => byId.has(id)), exceptions };
}

/** First source in config order, or null when the file names none that exist. */
export function pick(config, id, pathname, skip = null) {
  if (id) return config.byId.get(id) ?? null;
  const forced = config.exceptions.get(pathname);
  // `skip` 由调用方给出「已知缺这个文件」的源 id（进程内跳转会按存在性探测填它）；
  // 例外表也要能被跳过，否则一个缺件的强制源会把 302 变成客户的 404。
  if (forced && !(skip && [...skip].some((k) => config.byId.get(k) === forced))) return forced;
  for (const want of config.order) {
    if (skip && skip.has(want)) continue;
    const base = config.byId.get(want);
    if (base) return base;
  }
  return null;
}

/** Drop only the `sp_source` key; every other query byte is forwarded verbatim. */
export function stripSourceParam(query) {
  if (!query) return '';
  return query
    .split('&')
    .filter((part) => part !== '' && part.split('=')[0] !== 'sp_source')
    .join('&');
}

/**
 * The whole decision, as a pure function: no sockets, no clock, no globals.
 * @returns {{status:number, location?:string, headers:Record<string,string>, source?:string}}
 */
export function decide(config, { method = 'GET', pathname = '/', query = '', skip = null } = {}) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
  if (method === 'OPTIONS') {
    return { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' } };
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } };
  }
  // nginx 已经按扩展名粗筛过；这里再判一次是防守，不是主逻辑。
  if (!splittable(pathname) || !validPath(pathname) || !allowedExt(pathname)) {
    return { status: 404, headers: {} };
  }

  const forced = query ? new URLSearchParams(query).get('sp_source') : null;
  const base = pick(config, forced, pathname, skip);
  if (!base) {
    // 配置缺失时明确失败：静默 404 会让「边缘层有没有在工作」变成一个只能靠猜的问题。
    return { status: 503, headers: { 'Content-Type': 'text/plain' } };
  }

  const rest = stripSourceParam(query);
  const target = base + pathname + (rest ? `?${rest}` : '');
  if (target.length > MAX_TARGET) return { status: 414, headers: {} };

  return {
    status: 302,
    location: target,
    source: base,
    headers: {
      ...cors,
      Location: target,
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      'X-SP-Edge': forced ? `forced:${forced}` : 'order',
    },
  };
}

export function createServer(config, { verbose = false } = {}) {
  return http.createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 15_000 }, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let out;
    try {
      out = decide(config, { method: req.method, pathname: url.pathname, query: url.search.slice(1) });
    } catch (err) {
      out = { status: 500, headers: { 'Content-Type': 'text/plain' } };
      console.error('sp-edge: decide failed:', err?.message || err);
    }
    if (verbose) console.log(`sp-edge: ${req.method} ${url.pathname} -> ${out.status}${out.source ? ` ${out.source}` : ''}`);
    res.writeHead(out.status, out.headers);
    res.end();
  });
}

function main() {
  const configPath = process.env.SP_EDGE_SOURCES || DEFAULT_CONFIG_PATH;
  const port = Number(process.env.SP_EDGE_PORT || DEFAULT_PORT);
  let config;
  try {
    config = parseSources(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    // 起不来就明确失败：nginx 的 @fallback 仍然能供素材，整容器不该因为这个进程停摆。
    console.error(`sp-edge: cannot start — ${err?.message || err}`);
    process.exit(1);
  }
  const server = createServer(config, { verbose: process.env.SP_EDGE_VERBOSE === '1' });
  server.listen(port, '127.0.0.1', () => {
    console.log(`sp-edge: listening on 127.0.0.1:${port}, order=${config.order.join(' > ')}, exceptions=${config.exceptions.size}`);
  });
  // 容器停的时候平台发 TERM；收紧到 in-flight 请求结束为止就够了。
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
