// shared/scoringPolicy.mjs + shared/scoringQueue.mjs — 客户端评分调度：优先级、机型档位、可中断。
// 用户裁决：托管 > 房间界面 > 压力不大（高配 + 页面空闲）；低配不跑；不可见/离线立即停。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideScoring, deviceTier, pollIntervalFor } from '../shared/scoringPolicy.mjs';
import { createScoringQueue } from '../shared/scoringQueue.mjs';

test('priority: autoplay beats room beats idle-in-match', () => {
  const base = { visible: true, online: true, deviceTier: 'high', pageBusy: false };
  assert.equal(decideScoring({ ...base, away: true }).mode, 'autoplay');
  assert.equal(decideScoring({ ...base, autoplay: true }).mode, 'autoplay');
  // 托管压过一切（哪怕在房间里、哪怕页面忙）
  assert.equal(decideScoring({ ...base, autoplay: true, screen: 'room', pageBusy: true }).mode, 'autoplay');
  assert.equal(decideScoring({ ...base, screen: 'room' }).mode, 'room');
  assert.equal(decideScoring({ ...base, screen: 'lobby' }).mode, 'room');
  assert.equal(decideScoring({ ...base, screen: 'game' }).mode, 'idle', 'high tier + idle page runs in-match');
});

test('a busy page or a mid/low tier never runs during a match', () => {
  const inMatch = { visible: true, online: true, screen: 'game' };
  assert.equal(decideScoring({ ...inMatch, deviceTier: 'high', pageBusy: true }).run, false);
  assert.equal(decideScoring({ ...inMatch, deviceTier: 'mid' }).run, false);
  assert.equal(decideScoring({ ...inMatch, deviceTier: 'low' }).run, false);
  // room/autoplay still refuse a low tier: 低配机在任何情况下都不主动跑
  assert.equal(decideScoring({ ...inMatch, screen: 'room', deviceTier: 'low' }).run, false);
  assert.equal(decideScoring({ ...inMatch, autoplay: true, deviceTier: 'low' }).run, false);
});

test('invisible / offline / full queue stop everything', () => {
  const on = { autoplay: true, visible: true, online: true, deviceTier: 'high' };
  assert.equal(decideScoring({ ...on, visible: false }).run, false);
  assert.equal(decideScoring({ ...on, online: false }).run, false);
  assert.equal(decideScoring({ ...on, queued: 1, maxQueue: 1 }).run, false);
  assert.match(decideScoring({ ...on, online: false }).reason, /离线/);
});

test('deviceTier: cores/memory first, a measured benchmark wins when given', () => {
  assert.equal(deviceTier({ cores: 16, memory: 16 }), 'high');
  assert.equal(deviceTier({ cores: 4, memory: 8 }), 'low');
  assert.equal(deviceTier({ cores: 6, memory: 8 }), 'mid');
  assert.equal(deviceTier({ cores: 16, memory: 16, benchmarkMs: 60 }), 'low', 'a slow benchmark is believed even on many cores');
  assert.equal(deviceTier({ cores: 16, memory: 16, benchmarkMs: 5 }), 'high');
  assert.equal(deviceTier({ cores: 12, memory: 12, benchmarkMs: 50 }), 'low');
});

test('poll cadence: autoplay fastest, idle slowest, off means no polling', () => {
  assert.ok(pollIntervalFor('autoplay') < pollIntervalFor('room'));
  assert.ok(pollIntervalFor('room') < pollIntervalFor('idle'));
  assert.equal(pollIntervalFor('off'), 0);
});

test('queue: budget runs out on its own, resume resets it', () => {
  let t = 1000;
  const q = createScoringQueue({ maxQueue: 5, budgetMs: 100, now: () => t });
  for (let i = 0; i < 3; i++) q.push({ id: `t${i}` });
  assert.equal(q.next().id, 't0');
  t += 150; // past the budget
  assert.equal(q.next(), null, 'over budget → nothing handed out');
  assert.match(q.state().paused, /预算/);
  q.resume();
  assert.equal(q.next().id, 't1');
});

test('queue: abort() clears and pauses; abort(id) marks one task; done() clears the marker', () => {
  const q = createScoringQueue({ maxQueue: 5, budgetMs: 1000, now: () => 0 });
  q.push({ id: 'a' }); q.push({ id: 'b' });
  q.abort(null, '玩家回来了');
  assert.equal(q.size(), 0);
  assert.equal(q.next(), null);
  assert.match(q.state().paused, /玩家回来/);
  q.resume();
  q.push({ id: 'c' });
  const task = q.next();
  assert.equal(task.id, 'c');
  q.abort('c');
  assert.equal(q.isAborted('c'), true, 'the runner checks this between slices');
  q.done('c');
  assert.equal(q.isAborted('c'), false);
});

test('queue: maxQueue rejects the overflow instead of growing without bound', () => {
  const q = createScoringQueue({ maxQueue: 1, budgetMs: 1000, now: () => 0 });
  assert.equal(q.push({ id: 'x' }), true);
  assert.equal(q.push({ id: 'y' }), false);
  assert.equal(q.state().rejected, 1);
  assert.equal(q.size(), 1);
});
