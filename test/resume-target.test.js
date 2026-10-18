// shared/resumeTarget.mjs — 服务器重启后，客户端从本地 sp.matches 里挑一条可自动重进的目标。
// 规则：只认完整的房间码；超过服务端重连窗口（10 分钟）的记录不试；多条取最新。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickResumeTarget, RESUME_WINDOW_MS } from '../shared/resumeTarget.mjs';

test('no records / malformed records → null (never a garbage join)', () => {
  assert.equal(pickResumeTarget([]), null);
  assert.equal(pickResumeTarget(null), null);
  assert.equal(pickResumeTarget([{ name: 'x' }]), null, 'no code');
  assert.equal(pickResumeTarget([{ code: '' }]), null, 'empty code');
  assert.equal(pickResumeTarget([{ code: 'has space' }]), null, 'not a room code');
});

test('the freshest record inside the window wins', () => {
  const now = 1_000_000_000;
  const out = pickResumeTarget([
    { name: 'old', code: 'AAAA', at: now - 9 * 60_000 },
    { name: 'new', code: 'BBBB', at: now - 30_000 },
  ], { now });
  assert.equal(out.code, 'BBBB');
  assert.equal(out.name, 'new');
});

test('records past the server reconnect window are not tried', () => {
  const now = 1_000_000_000;
  assert.equal(pickResumeTarget([{ code: 'ZZZZ', at: now - RESUME_WINDOW_MS - 1 }], { now }), null);
  assert.equal(pickResumeTarget([{ code: 'ZZZZ', at: now - RESUME_WINDOW_MS + 1000 }], { now })?.code, 'ZZZZ');
});

test('timeless (old-format) records are still usable but rank behind timed ones', () => {
  const now = 1_000_000_000;
  const out = pickResumeTarget([
    { name: 'timeless', code: 'TTTT', at: null },
    { name: 'timed', code: 'MMMM', at: now - 60_000 },
  ], { now });
  assert.equal(out.code, 'MMMM');
  // alone, a timeless record is still worth a try
  assert.equal(pickResumeTarget([{ code: 'TTTT', at: null }], { now })?.code, 'TTTT');
});

test('a record with a timestamp in the future is ignored (clock skew / corruption)', () => {
  const now = 1_000_000_000;
  assert.equal(pickResumeTarget([{ code: 'FUT1', at: now + 60_000 }], { now }), null);
});
