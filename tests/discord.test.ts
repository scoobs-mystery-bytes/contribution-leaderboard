import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessage, postMessage, validateWebhook } from '../src/discord.js';
import { getPeriod, getReportingPeriod } from '../src/period.js';
import { readFileSync } from 'node:fs';

const webhook = 'https://discord.com/api/webhooks/123/secret-token';
const period = getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly');
const message = createMessage('owner/repo', period, [], 10);
const icon = readFileSync('assets/images/contribution-leaderboard-logo.png');

test('webhook validation rejects non-Discord hosts and unexpected paths', () => {
  for (const value of ['http://discord.com/api/webhooks/123/token', 'https://example.com/api/webhooks/123/token', 'https://discord.com.evil.test/api/webhooks/123/token', 'https://discord.com/api/webhooks/123']) {
    assert.throws(() => validateWebhook(value));
  }
  assert.equal(validateWebhook(webhook).hostname, 'discord.com');
});

test('ongoing periods display their actual UTC cutoff and label all-time clearly', () => {
  const now = new Date('2026-11-03T08:17:30Z');
  const allTime = createMessage('owner/repo', getReportingPeriod(now, 'weekly', 'all-time'), [], 10);
  const monthly = createMessage('owner/repo', getReportingPeriod(now, 'weekly', 'month-to-date'), [], 10);
  assert.equal(allTime.embeds[0]!.fields[1]!.value, 'All time → 2026-11-03T08:17:30.000Z (end exclusive)');
  assert.equal(monthly.embeds[0]!.fields[1]!.value, '2026-11-01 → 2026-11-03T08:17:30.000Z (end exclusive)');
});

test('messages disable mentions, escape bot labels and fit the Discord description limit', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    login: `${'a'.repeat(39)}-${index}[bot]`, pullRequests: 100000, issues: 100000, issuesCreated: 100000, score: 100000000,
  }));
  const payload = createMessage('owner/repo', period, entries, 25);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.ok(payload.embeds[0]!.description.length <= 4096);
  assert.ok(payload.embeds[0]!.description.includes('\\[bot\\]'));
  assert.ok(payload.embeds[0]!.description.includes('100000 issues opened'));
  assert.ok(message.embeds[0]!.description.includes('No qualifying contributions'));
});

test('posting requests delivery confirmation and retries rate limits', async () => {
  let calls = 0;
  await postMessage(webhook, message, icon, async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).searchParams.get('wait'), 'true');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.headers, undefined);
    const payload = JSON.parse(String(init.body.get('payload_json')));
    assert.equal(payload.embeds[0].thumbnail.url, 'attachment://contribution-leaderboard-logo.png');
    assert.equal(payload.attachments[0].filename, 'contribution-leaderboard-logo.png');
    const file = init.body.get('files[0]');
    assert.ok(file instanceof File);
    assert.equal(file.name, payload.attachments[0].filename);
    assert.equal(file.type, 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), icon);
    return calls === 1
      ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
      : new Response('{}', { status: 200 });
  });
  assert.equal(calls, 2);
});

test('delivery errors do not expose webhook tokens or retry uncertain delivery', async () => {
  let calls = 0;
  await assert.rejects(postMessage(webhook, message, icon, async () => {
    calls++;
    throw new Error(webhook);
  }), error => error instanceof Error && !error.message.includes('secret-token'));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(postMessage(webhook, message, icon, async () => {
    calls++;
    return new Response('{}', { status: 403 });
  }), /HTTP 403/);
  assert.equal(calls, 1);
});
