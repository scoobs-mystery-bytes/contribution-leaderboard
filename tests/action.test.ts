import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

async function execute(event: string, dryRun: boolean, period = 'previous') {
  const directory = mkdtempSync(join(tmpdir(), 'leaderboard-test-'));
  const output = join(directory, 'output');
  const summary = join(directory, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const server = createServer((request, response) => {
    const issue = {
      number: 1, user: { login: 'reporter', type: 'User' },
      created_at: '2026-10-29T00:00:00Z', state: 'closed', closed_at: '2026-10-30T00:00:00Z', state_reason: 'completed',
    };
    const data = request.url === '/graphql' ? { data: { repository: { issue: {
      state: 'CLOSED', stateReason: 'COMPLETED', closedAt: issue.closed_at,
      timelineItems: { nodes: [{ createdAt: issue.closed_at, closer: null }] },
    } } } } : request.url === '/repos/owner/repo/issues/1'
      ? { ...issue, closed_by: { login: 'closer', type: 'User' } }
      : request.url?.startsWith('/repos/owner/repo/pulls') ? [{
      user: { login: 'alice', type: 'User' },
      merged_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
    }] : [issue];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const script = `
    const OriginalDate = Date;
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : ['2026-11-03T08:17:00Z'])); }
      static now() { return new OriginalDate('2026-11-03T08:17:00Z').getTime(); }
    };
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname === 'discord.com') {
        if (!(options.body instanceof FormData) || !options.body.get('files[0]')?.size) {
          throw new Error('Missing icon attachment');
        }
        console.log('MOCK_DISCORD_DELIVERY');
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }
      throw new Error('Unexpected request');
    };
    require(${JSON.stringify(resolve('dist/index.cjs'))});
  `;
  try {
    const processResult = await promisify(execFile)(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 20_000,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event, GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: 'http://127.0.0.1:' + address.port, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        GITHUB_GRAPHQL_URL: 'http://127.0.0.1:' + address.port + '/graphql',
        'INPUT_GITHUB-TOKEN': 'test-token', 'INPUT_REPOSITORY': 'owner/repo',
        'INPUT_DISCORD-WEBHOOK-URL': 'https://discord.com/api/webhooks/123/fake-token',
        INPUT_CADENCE: 'weekly', 'INPUT_INTERVAL-MONTHS': '2', 'INPUT_ANCHOR-MONTH': '2026-01',
        INPUT_PERIOD: period,
        'INPUT_INTERVAL-WEEKS': '3', 'INPUT_ANCHOR-WEEK': '2026-10-19',
        INPUT_TOP: '10', 'INPUT_PR-WEIGHT': '3', 'INPUT_ISSUE-WEIGHT': '1',
        'INPUT_ISSUE-CREATED-WEIGHT': '1',
        'INPUT_EXCLUDE-USERS': '', 'INPUT_INCLUDE-BOTS': 'false', 'INPUT_DRY-RUN': String(dryRun),
      },
    });
    return { output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8'), stdout: processResult.stdout };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('bundled action skips scheduled non-boundary days', async () => {
  const result = await execute('schedule', false);
  assert.match(result.output, /skipped[^]*true/);
  assert.match(result.summary, /Skipped/);
  assert.doesNotMatch(result.stdout, /MOCK_DISCORD_DELIVERY/);
});

test('bundled manual dry run produces ranking without Discord delivery', async () => {
  const result = await execute('workflow_dispatch', true);
  assert.match(result.output, /"login":"alice","pullRequests":1,"issues":0,"issuesCreated":0,"score":3/);
  assert.match(result.output, /"login":"reporter","pullRequests":0,"issues":0,"issuesCreated":1,"score":1/);
  assert.match(result.output, /"login":"closer","pullRequests":0,"issues":1,"issuesCreated":0,"score":1/);
  assert.match(result.summary, /alice/);
  assert.match(result.summary, /reporter/);
  assert.match(result.summary, /Issues opened/);
  assert.match(result.summary, /Dry run/);
  assert.doesNotMatch(result.stdout, /MOCK_DISCORD_DELIVERY/);
});

test('bundled manual live run confirms mocked Discord delivery', async () => {
  const result = await execute('workflow_dispatch', false);
  assert.match(result.stdout, /MOCK_DISCORD_DELIVERY/);
  assert.match(result.output, /posted[^]*true/);
  assert.match(result.summary, /Discord message posted successfully/);
});

test('bundled action separates weekly schedule from all-time and month-to-date counts', async () => {
  const allTime = await execute('workflow_dispatch', true, 'all-time');
  assert.match(allTime.output, /1970-01-01T00:00:00\.000Z/);
  assert.match(allTime.output, /"login":"alice"/);
  assert.match(allTime.output, /2026-11-03T08:17:00\.000Z/);
  const monthToDate = await execute('workflow_dispatch', true, 'month-to-date');
  assert.match(monthToDate.output, /2026-11-01T00:00:00\.000Z/);
  assert.doesNotMatch(monthToDate.output, /"login":"alice"/);
  const scheduled = await execute('schedule', true, 'all-time');
  assert.match(scheduled.output, /skipped[^]*true/);
});

test('bundled action uses the anchored three-week window without changing the posting cadence', async () => {
  const result = await execute('workflow_dispatch', true, 'weeks-to-date');
  assert.match(result.output, /2026-10-19T00:00:00\.000Z/);
  assert.match(result.output, /2026-11-03T08:17:00\.000Z/);
  assert.match(result.output, /"login":"alice"/);
  const scheduled = await execute('schedule', true, 'weeks-to-date');
  assert.match(scheduled.output, /skipped[^]*true/);
});
