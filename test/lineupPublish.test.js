// The write-back path (server/lineupPublish.js): a server's local lineup library is published to the CDN through
// the existing admin upload channel (begin → presigned PUT → commit). It must be fail-soft: a server with no
// credentials, or with a CDN that is unreachable, still runs matches normally — it just does not publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishLibrary, publishOneMode, publishableFile } from '../server/lineupPublish.js';

const cells = (id, row, col) => ({ id, golden: false, row, col, dir: 'UP' });
const line = (modeId) => JSON.stringify({
  t: 'lineup', at: '2026-10-17T00:00:00Z', modeId, stageId: 'act1_m01', difficulty: 'HARD', round: 3, sig: 's', cells: [cells('char_a', 9, 3), cells('char_b', 9, 4)],
});

/** A library dir with two modes' files (plus one empty, to exercise the gate). */
function makeLibrary(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lineups_mode_single_hard.jsonl'), `${line('mode_single_hard')}\n`);
  writeFileSync(join(dir, 'lineups_mode_multi_hard.jsonl'), `${line('mode_multi_hard')}\n`);
  writeFileSync(join(dir, 'lineups_mode_single_abyss.jsonl'), '');
  return dir;
}

/**
 * A stand-in for the real CDN upload channel, on 127.0.0.1.
 *
 * begin/commit are JSON endpoints and the PUT is a byte sink, exactly like the real one — so the whole
 * chain (including the presigned URL round-trip and the streamed PUT) runs for real. `behavior` decides
 * what begin answers, which is where the interesting cases live.
 */
async function withCdn(behavior, body) {
  const seen = { begins: [], puts: [], commits: [] };
  const server = http.createServer((req, res) => {
    const u = req.url || '';
    const reply = (code, doc) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(doc)); };
    if (u.endsWith('/api/cdn/upload/begin')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const doc = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        seen.begins.push(doc);
        const out = behavior.begin ? behavior.begin(doc, seen) : { ok: true, id: 'id-1', putUrl: `http://127.0.0.1:${server.address().port}/put/${encodeURIComponent(doc.key)}`, stagingKey: `cdn/incoming/id-1/${doc.key}` };
        if (out.status) reply(out.status, out.doc || { ok: false, error: out.error });
        else reply(200, out);
      });
      return;
    }
    if (u.startsWith('/put/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.puts.push({ url: u, bytes: Buffer.concat(chunks), contentLength: req.headers['content-length'] });
        if (behavior.put) { behavior.put(seen.puts[seen.puts.length - 1]); res.writeHead(200); res.end(''); return; }
        res.writeHead(200); res.end('');
      });
      return;
    }
    if (u.endsWith('/api/cdn/upload/commit')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const doc = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        seen.commits.push(doc);
        reply(200, { ok: true, message: 'published' });
      });
      return;
    }
    reply(404, { ok: false, error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await body({ base, seen });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('only real, non-empty, in-budget, non-partial library files are published', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-pub-'));
  try {
    const good = join(dir, 'lineups_mode_single_hard.jsonl');
    writeFileSync(good, 'x');
    assert.deepEqual(publishableFile(good, { isFile: () => true, size: 10 }), { ok: true });
    assert.equal(publishableFile(join(dir, 'lineups_x.jsonl'), null).ok, false, 'a missing stat is not publishable');
    assert.equal(publishableFile(good, { isFile: () => true, size: 0 }).ok, false, 'an empty file teaches nothing');
    assert.equal(publishableFile(good, { isFile: () => true, size: 9 * 1024 * 1024 }).ok, false, 'oversized means roll failed or someone is flooding');
    assert.equal(publishableFile(join(dir, 'lineups_x.jsonl.partial'), { isFile: () => true, size: 5 }).ok, false, 'a half-written temp file is never published');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no admin key nothing is uploaded and nothing throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-pub-'));
  const emptyHome = mkdtempSync(join(tmpdir(), 'lineup-pub-home-'));
  const logs = [];
  try {
    makeLibrary(dir);
    // an injected empty home: the real machine may have ~/.cdn_admin_key, which would publish for real
    const out = await publishLibrary({
      dir, env: {}, home: emptyHome, log: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
    });
    assert.equal(out.ok, 0);
    assert.equal(out.failed, 0, 'no key is a clean skip, not a failure');
    assert.match(out.error, /口令/);
    assert.ok(logs.some((l) => l.includes('口令')), 'the reason is logged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('the whole chain runs for real against a local CDN stand-in: begin → presigned PUT → commit, keyed by mode and date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-pub-'));
  try {
    makeLibrary(dir);
    await withCdn({}, async ({ base, seen }) => {
      const out = await publishLibrary({
        dir, base, env: { CDN_ADMIN_KEY: 'test-key' }, log: { warn() {}, info() {} },
      });
      // The two real files publish; the empty one is skipped without an upload attempt
      assert.equal(out.ok, 2, `two files published, got ${out.ok}: ${JSON.stringify(out.files)}`);
      assert.equal(out.skipped, 1);
      assert.equal(out.failed, 0);
      const keys = out.files.filter((f) => f.ok && f.key).map((f) => f.key).sort();
      // The key carries today's UTC date (dayStamp), so assert the shape, not a literal date: a hardcoded day
      // turns this green test red at the first UTC midnight after it was written.
      assert.equal(keys.length, 2);
      assert.match(keys[0], /^packs\/lineup-library\/mode_multi_hard-\d{4}-\d{2}-\d{2}\.jsonl$/);
      assert.match(keys[1], /^packs\/lineup-library\/mode_single_hard-\d{4}-\d{2}-\d{2}\.jsonl$/);
      // begin carried the real size and a computed sha256, and named the source group
      assert.equal(seen.begins.length, 2);
      for (const b of seen.begins) {
        assert.match(b.sha256, /^[0-9a-f]{64}$/, 'sha256 is computed, not invented');
        assert.ok(b.size > 0);
        assert.equal(b.source, 'lineup-library');
        assert.ok(b.note, 'a note explains what the bytes are');
      }
      // the presigned PUT really happened, streamed, with an explicit Content-Length
      assert.equal(seen.puts.length, 2);
      for (const p of seen.puts) {
        assert.equal(Number(p.contentLength), p.bytes.length, 'Content-Length matches the body (S3 rejects chunked)');
        assert.match(p.bytes.toString('utf8'), /"t":"lineup"/, 'the bytes on the wire are the library records');
      }
      // one commit per begin
      assert.equal(seen.commits.length, 2);
      for (const c of seen.commits) assert.equal(c.size, Number(c.size));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key that already exists (409) counts as published, not as a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-pub-'));
  try {
    makeLibrary(dir);
    await withCdn({ begin: () => ({ status: 409, error: 'key already exists' }) }, async ({ base, seen }) => {
      const out = await publishLibrary({ dir, base, env: { CDN_ADMIN_KEY: 'k' }, log: { warn() {}, info() {} } });
      assert.equal(out.ok, 2, 'only-add-never-edit: re-publishing the same day is a no-op success');
      assert.equal(out.failed, 0);
      assert.equal(out.skipped, 1);
      assert.equal(seen.puts.length, 0, 'and no bytes were pushed for a key that already exists');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CDN that rejects the upload is reported per-file and never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-pub-'));
  try {
    makeLibrary(dir);
    await withCdn({ begin: () => ({ status: 403, error: 'bad key' }) }, async ({ base }) => {
      const out = await publishLibrary({ dir, base, env: { CDN_ADMIN_KEY: 'wrong' }, log: { warn() {}, info() {} } });
      assert.equal(out.ok, 0);
      assert.equal(out.failed, 2, 'both real files failed');
      assert.ok(out.files.some((f) => /bad key/.test(f.reason || '')), 'the reason is kept');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a library dir that is gone is a skip, not a crash', async () => {
  const out = await publishLibrary({
    dir: join(tmpdir(), 'lineup-pub-does-not-exist-xyz'), env: { CDN_ADMIN_KEY: 'k' }, log: { warn() {}, info() {} },
  });
  assert.equal(out.ok, 0);
  assert.match(out.error, /读库目录失败/);
});

test('files the publisher must never touch are ignored (only lineups_*.jsonl matches)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineup-pub-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'operator notes — must not be published');
    writeFileSync(join(dir, 'lineups_ok.jsonl'), line('mode_x') + '\n');
    await withCdn({}, async ({ base, seen }) => {
      const out = await publishLibrary({ dir, base, env: { CDN_ADMIN_KEY: 'k' }, log: { warn() {}, info() {} } });
      assert.equal(out.ok, 1);
      assert.equal(seen.begins.length, 1, 'only the library file is offered');
      assert.match(seen.begins[0].key, /^packs\/lineup-library\/ok-\d{4}-\d{2}-\d{2}\.jsonl$/);
      assert.ok(!seen.begins.some((b) => String(b.key).includes('notes')), 'the operator file is never uploaded');
      assert.equal(seen.puts.length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- publishOneMode: the outbox's incremental upload path (same channel, same dated key) ----

test('publishOneMode: a batch of records goes up the same chain under the mode\'s dated key', async () => {
  await withCdn({}, async ({ base, seen }) => {
    const records = [
      { t: 'lineup', at: '2026-10-18T00:00:00Z', modeId: 'mode_single_hard', stageId: 's', difficulty: 'HARD', round: 3, sig: 'x', cells: [cells('a', 9, 3), cells('b', 9, 4)] },
      { t: 'lineup', at: '2026-10-18T00:00:01Z', modeId: 'mode_single_hard', stageId: 's', difficulty: 'HARD', round: 4, sig: 'y', cells: [cells('c', 9, 5), cells('d', 9, 6)] },
    ];
    const out = await publishOneMode({ modeId: 'mode_single_hard', records, base, env: { CDN_ADMIN_KEY: 'k' }, log: { warn() {}, info() {} } });
    assert.equal(out.ok, true);
    assert.match(out.key, /^packs\/lineup-library\/mode_single_hard-\d{4}-\d{2}-\d{2}\.jsonl$/);
    assert.equal(seen.begins.length, 1);
    assert.equal(seen.puts.length, 1);
    const body = seen.puts[0].bytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(body.length, 2);
    assert.deepEqual(body.map((r) => r.sig), ['x', 'y']);
    assert.equal(seen.commits.length, 1);
  });
});

test('publishOneMode: 409 (same-day key exists) is reported ok — the dated key is the receipt', async () => {
  await withCdn({ begin: () => ({ status: 409, error: 'key already exists' }) }, async ({ base, seen }) => {
    const out = await publishOneMode({
      modeId: 'm', records: [{ t: 'lineup', at: 'x', modeId: 'm', round: 1, cells: [cells('a', 9, 3), cells('b', 9, 4)] }],
      base, env: { CDN_ADMIN_KEY: 'k' }, log: { warn() {}, info() {} },
    });
    assert.equal(out.ok, true);
    assert.equal(out.status, 409);
    assert.equal(seen.puts.length, 0, 'no bytes are pushed for a key that already exists');
  });
});

test('publishOneMode: no key and empty records are clean non-ok answers, never throws', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'lineup-pub-home-'));
  try {
    const noKey = await publishOneMode({ modeId: 'm', records: [{}], env: {}, home: emptyHome, log: { warn() {}, info() {} } });
    assert.equal(noKey.ok, false);
    assert.match(noKey.reason, /口令/);
    const empty = await publishOneMode({ modeId: 'm', records: [], env: { CDN_ADMIN_KEY: 'k' }, log: { warn() {}, info() {} } });
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /没有可发布/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});
