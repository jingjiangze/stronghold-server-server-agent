// The openp2p handshake platform link (server/platform.js): a room created on a configured server is announced
// to the platform, and the returned join link is broadcast as room.state.inviteUrl. Fail-soft: with no platform
// configured (or an unreachable one) the room works exactly as before, with inviteUrl null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { platformConfigFromEnv } from '../server/platform.js';

async function withPlatform(handler, body) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const doc = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seen.push({ method: req.method, url: req.url, doc });
      handler(req, res, doc, seen);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await body({ base, seen }); } finally {
    await new Promise((r) => server.close(r));
  }
}

const ok = (joinUrl) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ roomId: 'room-1', joinUrl }));
};

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test('platformConfigFromEnv: off without a URL; p2p with a host node; direct with an upstream', () => {
  assert.equal(platformConfigFromEnv({}), null);
  const p2p = platformConfigFromEnv({ SP_PLATFORM_URL: 'https://p2p.example', SP_PLATFORM_HOSTNODE: 'host-node-1' });
  assert.equal(p2p.mode, 'p2p');
  assert.equal(p2p.hostNode, 'host-node-1');
  const direct = platformConfigFromEnv({ SP_PLATFORM_URL: 'https://p2p.example', SP_PLATFORM_UPSTREAM: 'https://game.example' });
  assert.equal(direct.mode, 'direct');
  assert.equal(direct.upstream, 'https://game.example');
});

test('a configured server announces the room and broadcasts the platform link as room.state.inviteUrl', async () => {
  await withPlatform(ok('https://p2p.example/go/room-1?room=ABCD'), async ({ base, seen }) => {
    await withEnv({ SP_PLATFORM_URL: base, SP_PLATFORM_HOSTNODE: 'probe-host-node' }, async () => {
      const srv = await startServer({ port: 0, quiet: true });
      try {
        const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
        await c.hello('Probe');
        await c.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
        const frame = await c.waitFor(null, (m) => m.t === 'room.state' && !!m.inviteUrl, 4000);
        assert.equal(frame.inviteUrl, 'https://p2p.example/go/room-1?room=ABCD');
        assert.equal(seen.length, 1, 'one registration POST');
        assert.equal(seen[0].doc.hostNode, 'probe-host-node');
        assert.match(seen[0].doc.code, /^[A-Z0-9]{4}$/);
        const status = await fetch(`http://127.0.0.1:${srv.port}/api/platform`).then((r) => r.json());
        assert.equal(status.enabled, true);
        assert.equal(status.mode, 'p2p');
        assert.equal(status.rooms, 1);
      } finally { await srv.close(); }
    });
  });
});

test('an unreachable platform costs the room nothing: inviteUrl stays null, the room still works', async () => {
  // a port nothing listens on: the registration fails fast and is swallowed
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  await withEnv({ SP_PLATFORM_URL: `http://127.0.0.1:${port}`, SP_PLATFORM_HOSTNODE: 'probe-host-node' }, async () => {
    const srv = await startServer({ port: 0, quiet: true });
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      await c.hello('Probe');
      const st = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
      assert.equal(st.t, 'ok');
      const state = await c.waitFor(null, (m) => m.t === 'room.state', 3000);
      assert.equal(state.inviteUrl, null, 'no link, and no crash');
    } finally { await srv.close(); }
  });
});

test('with no platform configured /api/platform says disabled and rooms carry no link', async () => {
  await withEnv({ SP_PLATFORM_URL: null, SP_PLATFORM_HOSTNODE: null }, async () => {
    const srv = await startServer({ port: 0, quiet: true });
    try {
      const status = await fetch(`http://127.0.0.1:${srv.port}/api/platform`).then((r) => r.json());
      assert.deepEqual(status, { enabled: false });
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      await c.hello('Probe');
      await c.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
      const state = await c.waitFor(null, (m) => m.t === 'room.state', 3000);
      assert.equal(state.inviteUrl, null);
    } finally { await srv.close(); }
  });
});
