'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot, progressBar } = require('../src/model');

test('读取官方多额度组响应，按窗口时长显示剩余额度', () => {
  const result = normalizeSnapshot({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1800000000 } },
    rateLimitsByLimitId: {
      other: { limitId: 'other', primary: { usedPercent: 50, windowDurationMins: 60 } },
      codex: {
        limitId: 'codex', primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1800000000 },
        secondary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 1800500000 }
      }
    }
  }, { account: { type: 'chatgpt', email: 'example@example.com', planType: 'plus' } });
  assert.equal(result.buckets[0].id, 'codex');
  assert.equal(result.buckets[0].primary.label, '5小时');
  assert.equal(result.buckets[0].primary.shortLabel, '5h');
  assert.equal(result.buckets[0].secondary.label, '7天');
  assert.equal(result.buckets[0].secondary.shortLabel, '7d');
  assert.equal(result.buckets[0].primary.remainingPercent, 83);
  assert.equal(result.buckets[0].secondary.remainingPercent, 57);
  assert.equal(result.buckets[0].secondary.resetsAt, 1800500000000);
  assert.equal(result.buckets.length, 2);
  assert.equal(result.plan, 'plus');
});

test('缺失窗口不能被当成 0% 使用量', () => {
  const result = normalizeSnapshot({
    rateLimits: { limitId: 'codex', primary: { usedPercent: null }, secondary: null }
  }, null);
  assert.equal(result.buckets[0].primary, null);
  assert.equal(result.buckets[0].secondary, null);
  assert.equal(result.email, null);
});

test('多额度组缺少 Codex 时保留兼容响应中的 Codex', () => {
  const result = normalizeSnapshot({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300 } },
    rateLimitsByLimitId: { reserve: { limitId: 'reserve', primary: { usedPercent: 6, windowDurationMins: 10080 } } },
    ordinaryUsageAllowed: false
  }, null);
  assert.deepEqual(result.buckets.map(bucket => bucket.id), ['codex', 'reserve']);
  assert.equal(result.buckets[0].primary.remainingPercent, 0);
  assert.equal(result.ordinaryUsageAllowed, false);
});

test('状态栏五格进度条按剩余额度填充且不越界', () => {
  assert.equal(progressBar(0), '▱▱▱▱▱');
  assert.equal(progressBar(40), '▰▰▱▱▱');
  assert.equal(progressBar(53), '▰▰▰▱▱');
  assert.equal(progressBar(100), '▰▰▰▰▰');
  assert.equal(progressBar(120), '▰▰▰▰▰');
});
