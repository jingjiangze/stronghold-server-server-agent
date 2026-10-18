// server/lineupPublish.js — 把本地布阵学习库发出去：GitHub 只读镜像 + R2 promote 写回。
// (i18n-ignore-file: 上传失败原因与运维日志，不进 UI —— 由中心/日志消费，见 docs/I18N.md)
//
// 为什么不是「服务器直接推 GitHub」：玩家服务器（含魔搭容器）没有、也不该有 GitHub 写权限——
// 一个被拿下的服务器不该能改公共镜像。所以写回走既有的后台上传通道（R2 staging → promote），
// 与 mod 素材同一条路、同一套 sha256 核对；GitHub 镜像由另一条链从 R2 落，服务器只读它。
//
// 三条硬规矩（与 lineupSync.js / upstreamWatch.js 同一范式）：
//   1. 发布是**尽力而为**：任何一步失败只记日志，绝不影响对局、绝不抛进调用链。
//   2. 只增不改：键名带日期，重复发布同一批字节会被 R2 的 begin 拒掉（409），这是特性不是错误。
//   3. 只发本模块自己写的库文件，绝不遍历用户卷上的其它内容。
//
// 配置（环境变量）：
//   SP_LINEUP_PUBLISH=0    关闭本模块（默认关——没有密钥时本来也发不出去）。
//   CDN_ADMIN_KEY          上传后台口令（与 tools/agent-upload.mjs 同一口径：env 优先，否则 ~/.cdn_admin_key）。
//   SP_LINEUP_PUBLISH_URL  覆盖上传端点（默认 https://downcdn.jiangjiangze.icu）。
//   SP_LINEUP_PUBLISH_SRC  hosted.json 的分组 id，默认 lineup-library。
//
// 复用而不是重写：begin → presigned PUT → commit 的流程与 tools/agent-upload.mjs 逐字节同构，
// 差别只有「入口是库文件而不是命令行参数」。密钥只走 env / 文件，绝不进命令行参数与日志。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DEFAULT_BASE = 'https://downcdn.jiangjiangze.icu';
const DEFAULT_SOURCE = 'lineup-library';
const KEY_PREFIX = 'packs/lineup-library/';
const MAX_BYTES_PER_FILE = 3 * 1024 * 1024; // 与 lineupLibrary 的 MAX_BYTES 同量级：超了就不值得占 CDN
const PUT_TIMEOUT_MS = 300_000;
/** begin/commit 的兜底超时：admin 接口偶发被 Clash 掐住 Node TLS，curl 兜底本身就慢，这里给足。 */
const API_TIMEOUT_MS = 15_000;

/** 日期戳：同一天多次发布会 409，所以键名按「模式+日期」唯一即可，不掺时分秒。 */
const dayStamp = (now = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
};

/**
 * 一个库文件要不要发。
 *
 * 空文件不发（一个模式没人玩过就没有字节），超限不发（单份 3 MiB 是学习库的量级上限，
 * 超过说明 roll 没生效或有人在灌数据，发上去只会污染镜像）。返回 { ok, reason }。
 */
export function publishableFile(abs, stat) {
  if (!stat || !stat.isFile()) return { ok: false, reason: '不是普通文件' };
  if (stat.size === 0) return { ok: false, reason: '空文件' };
  if (stat.size > MAX_BYTES_PER_FILE) return { ok: false, reason: `超过 ${MAX_BYTES_PER_FILE} 字节` };
  if (path.basename(abs).includes('.' + 'partial')) return { ok: false, reason: '上传中间文件' };
  return { ok: true };
}

/** 口令：env 优先，否则 ~/.cdn_admin_key。绝不打印、绝不进 git（与 tools/agent-upload.mjs 同口径）。 */
function adminKey(env = process.env, home = os.homedir()) {
  const fromEnv = (env.CDN_ADMIN_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(home, '.cdn_admin_key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '');
  return null; // 没有口令：调用方只记日志，不抛
}

/**
 * POST/GET 到上传后台。
 *
 * 先 Node fetch，失败退回 curl 并经临时 config 传口令——口令不进命令行参数（会留在进程列表与
 * shell 历史里）。这是 tools/agent-upload.mjs 的同一套兜底，本机出口对部分域名会掐 Node TLS。
 */
async function api(method, urlPath, body, headers, base, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const all = { 'x-admin-key': headers.key, 'content-type': 'application/json', ...headers.extra };
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await doFetch(base + urlPath, { method, headers: all, body: payload, signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    try { return { status: res.status, doc: JSON.parse(text) }; } catch { return { status: res.status, doc: { ok: false, error: text.slice(0, 200) } }; }
  } catch (error) {
    clearTimeout(timer);
    return apiViaCurl(method, urlPath, payload, all, base, error);
  }
}

function apiViaCurl(method, urlPath, payload, headers, base, firstError) {
  const cfg = path.join(os.tmpdir(), `lineup-pub-${process.pid}-${Date.now()}.cfg`);
  const lines = [`url = "${base}${urlPath}"`, `request = "${method}"`];
  for (const [k, v] of Object.entries(headers)) lines.push(`header = "${k}: ${v}"`);
  fs.writeFileSync(cfg, `${lines.join('\n')}\n`);
  const args = ['-sS', '--ssl-no-revoke', '-m', '45', '-w', '\nHTTPCODE=%{http_code}', '-K', cfg];
  let bodyFile = null;
  if (payload !== undefined) {
    bodyFile = path.join(os.tmpdir(), `lineup-pub-body-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(bodyFile, payload);
    args.push('--data-binary', `@${bodyFile}`);
  }
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const status = Number((out.match(/HTTPCODE=(\d+)/) || [])[1] || 0);
    const text = out.replace(/\n?HTTPCODE=\d+$/, '');
    let doc = { ok: false, error: text.slice(0, 200) };
    try { doc = JSON.parse(text); } catch { /* 保持原样 */ }
    if (!status) throw new Error(`curl 也没拿到状态码（先试 Node fetch：${firstError && firstError.message}）`);
    return { status, doc };
  } finally {
    for (const f of [cfg, bodyFile]) {
      if (!f) continue;
      try { fs.unlinkSync(f); } catch { /* 临时文件删不掉不影响结果 */ }
    }
  }
}

function sha256OfFile(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(abs);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * presigned PUT：文件流直接进桶的 S3 端点。Content-Length 必须显式给，S3 不接受 chunked。
 *
 * 传输按 URL 的协议选（不是写死 https）：预签名地址永远是 https，但写死 https 会让一个 http://
 * 的地址被静默连到 443（Node 的 https.request 不校验 scheme），报一个跟真实原因无关的 ECONNREFUSED。
 * 测试因此用本地 http 服务就能跑完整条链，不必连真桶。
 */
function putToR2(putUrl, abs, size) {
  return new Promise((resolve, reject) => {
    const url = new URL(putUrl);
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'PUT',
        headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
        timeout: PUT_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('上传超时')));
    fs.createReadStream(abs).pipe(req);
  });
}

/**
 * begin → PUT → commit 发一个文件。
 *
 * 409（键已存在）不是错误：那一天这个模式已经发过同样的键名，镜像上那份就是答案。
 * 返回 { ok, key, status, reason }，绝不抛。
 */
async function uploadOne(abs, targetKey, source, what, base, key, fetchImpl) {
  const stat = fs.statSync(abs);
  const sha256 = await sha256OfFile(abs);
  const begun = await api('POST', '/api/cdn/upload/begin', { key: targetKey, size: stat.size, sha256, source, note: what }, { key }, base, fetchImpl);
  if (begun.status === 409 || (begun.doc && begun.doc.error && /exist|已存在/i.test(begun.doc.error))) {
    return { ok: true, key: targetKey, status: 409, reason: '已发布过（只增不改）' };
  }
  if (!begun.doc || begun.doc.ok !== true) return { ok: false, key: targetKey, status: begun.status, reason: `begin 被拒：${(begun.doc && begun.doc.error) || ''}` };
  const { id, putUrl, stagingKey } = begun.doc;
  const put = await putToR2(putUrl, abs, stat.size);
  if (put.status !== 200) return { ok: false, key: targetKey, status: put.status, reason: `直传失败：${put.text.slice(0, 200)}` };
  const committed = await api('POST', '/api/cdn/upload/commit', { id, stagingKey, key: targetKey, sha256, size: stat.size, source, what }, { key }, base, fetchImpl);
  if (!committed.doc || committed.doc.ok !== true) return { ok: false, key: targetKey, status: committed.status, reason: `commit 被拒：${(committed.doc && committed.doc.error) || ''}` };
  return { ok: true, key: targetKey, status: 200, id };
}

/**
 * 发布一个库（`<modeId>__<DIFFICULTY>`）的**增量记录**（outbox 通道用）：把调用方攒好的一批
 * lineup 记录写进当日键 `packs/lineup-library/<key>-<YYYY-MM-DD>.jsonl`，走与 publishLibrary 完全相同的
 * begin → presigned PUT → commit 链。
 *
 * 「只增不改」在这里是有用的语义：同一天对同一模式的第二次发布会 409，publishOne 把它报成
 * ok（reason「已发布过」）——键已在中心即代表此前那批字节已被接受，调用方（lineupOutbox）据
 * 此确认删除。代价是日期粒度内的增量合并靠中心 promote 侧重读整键；换取的是零新端点、零新守卫。
 *
 * @param {{dir?: string, modeId: string, records: Array<object>, base?, source?, now?, log?, env?, home?, fetchImpl?}} args
 *   records 的每一行必须已经是 lineupLibrary 语义的 lineup 记录（t/modeId/stageId/.../cells）。
 * @returns {Promise<{ok: boolean, status: number, key: string, reason?: string}>} 绝不抛。
 */
export async function publishOneMode({
  key: libraryKey, records, base = DEFAULT_BASE, source = DEFAULT_SOURCE, now = new Date(),
  log = console, env = process.env, home = os.homedir(), fetchImpl,
} = {}) {
  const out = { ok: false, status: 0, key: `${KEY_PREFIX}${libraryKey || ''}-${dayStamp(now)}.jsonl`, reason: null };
  const key = adminKey(env, home);
  if (!key) { out.reason = '没有上传口令（CDN_ADMIN_KEY 或 ~/.cdn_admin_key）'; log.warn?.(`[lineup-publish] ${out.reason}`); return out; }
  if (!Array.isArray(records) || !records.length) { out.reason = '没有可发布的记录'; return out; }
  const tmp = path.join(os.tmpdir(), `lineup-outbox-${process.pid}-${Date.now()}.jsonl`);
  try {
    const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(tmp, body, 'utf8');
    const stat = fs.statSync(tmp);
    const gate = publishableFile(tmp, stat);
    if (!gate.ok) { out.reason = `批次被门拒绝：${gate.reason}`; return out; }
    const res = await uploadOne(tmp, out.key, source, `lineup outbox for ${libraryKey || '(no key)'}`, base, key, fetchImpl);
    out.ok = res.ok; out.status = res.status; out.reason = res.reason || null;
    log.info?.(`[lineup-publish] outbox ${libraryKey || '(no key)'} → ${out.key} ${res.ok ? 'ok' : 'FAIL'} ${res.reason || ''}`.trim());
  } catch (e) {
    out.reason = String((e && e.message) || e);
    log.warn?.(`[lineup-publish] outbox ${libraryKey || '(no key)'} 异常：${out.reason}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响结果 */ }
  }
  return out;
}

/**
 * 发布整座本地库：把 `dir` 下每个 `lineups_<mode>.jsonl` 发成
 * `packs/lineup-library/<mode>-<YYYY-MM-DD>.jsonl`。
 *
 * 键名保留 **.jsonl**（上传白名单已加，见 stronghold-cdn src/upload.mjs）：与本地文件、与 lineupSync
 * 拉取时拼的 `<base>/lineups_<mode>.jsonl` 三方同名——少一个「发出去要改名」的转换，就少一处能错的地方。
 * 内容是 JSONL（一行一条记录），扩展名与内容形态一致。
 */
export async function publishLibrary({
  dir, base = DEFAULT_BASE, source = DEFAULT_SOURCE, now = new Date(),
  log = console, env = process.env, home = os.homedir(), fetchImpl,
} = {}) {
  const out = { ok: 0, skipped: 0, failed: 0, files: [], error: null };
  if (!dir) { out.error = '没有库目录'; return out; }
  const key = adminKey(env, home);
  if (!key) {
    out.error = '没有上传口令（CDN_ADMIN_KEY 或 ~/.cdn_admin_key）——跳过发布';
    log.warn?.(`[lineup-publish] ${out.error}`);
    return out;
  }
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^lineups_.+\.jsonl$/.test(n));
  } catch (e) {
    out.error = `读库目录失败：${e.message}`;
    log.warn?.(`[lineup-publish] ${out.error}`);
    return out;
  }
  const stamp = dayStamp(now);
  for (const name of names) {
    const abs = path.join(dir, name);
    const gate = publishableFile(abs, fs.statSync(abs));
    if (!gate.ok) { out.skipped++; out.files.push({ name, ok: false, skipped: true, reason: gate.reason }); continue; }
    const modeId = name.slice('lineups_'.length, -'.jsonl'.length);
    const targetKey = `${KEY_PREFIX}${modeId}-${stamp}.jsonl`;
    try {
      const res = await uploadOne(abs, targetKey, source, `lineup library for ${modeId}`, base, key, fetchImpl);
      out.files.push({ name, key: targetKey, ...res });
      if (res.ok) out.ok++;
      else out.failed++;
      log.info?.(`[lineup-publish] ${name} → ${targetKey} ${res.ok ? 'ok' : 'FAIL'} ${res.reason || ''}`.trim());
    } catch (e) {
      out.failed++;
      out.files.push({ name, ok: false, reason: String((e && e.message) || e) });
      log.warn?.(`[lineup-publish] ${name} 异常：${(e && e.message) || e}`);
    }
  }
  return out;
}
