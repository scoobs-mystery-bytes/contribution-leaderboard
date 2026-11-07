import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOctokit } from '@actions/github';
import { collect, rank } from '../src/leaderboard.js';
import { getPeriod } from '../src/period.js';

function closureResponse(closedAt: string, closer: { __typename: string } | null = null, login = 'maintainer') {
  const issue = {
    state: 'CLOSED', stateReason: 'COMPLETED', closedAt,
    timelineItems: { nodes: [{ createdAt: closedAt, closer, actor: { login, __typename: 'User' } }] },
  };
  return { data: { repository: { i1: issue, i2: issue } } };
}

test('collection paginates and filters event dates, issue reasons, and PRs returned as issues', async () => {
  const paths: string[] = [];
  const user = { login: 'alice', type: 'User' };
  const client = getOctokit('test-token', {
    request: { fetch: async (url: string | URL | Request) => {
      const target = new URL(String(url));
      paths.push(target.pathname + target.search);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (target.pathname.endsWith('/graphql')) {
        return new Response(JSON.stringify(closureResponse('2026-10-26T00:00:00Z', null, 'closer')), { headers });
      }
      if (target.pathname.endsWith('/pulls')) {
        if (target.searchParams.get('page') === '2') {
          return new Response(JSON.stringify([
            { user, merged_at: '2026-10-27T12:00:00Z', updated_at: '2026-10-27T12:00:00Z' },
            { user, merged_at: '2026-10-25T12:00:00Z', updated_at: '2026-10-25T12:00:00Z' },
          ]), { headers });
        }
        headers.link = '<https://api.github.com/repos/owner/repo/pulls?page=2>; rel="next"';
        return new Response(JSON.stringify([
          { user, merged_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' },
          { user, merged_at: null, updated_at: '2026-10-31T00:00:00Z' },
          { user: null, merged_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z' },
        ]), { headers });
      }
      assert.equal(target.searchParams.get('since'), '2026-10-25T23:59:59.000Z');
      assert.equal(target.searchParams.get('state'), 'all');
      return new Response(JSON.stringify([
        { number: 1, user, created_at: '2026-10-25T00:00:00Z', state: 'closed', closed_at: '2026-10-26T00:00:00Z', state_reason: 'completed' },
        { user, closed_at: '2026-10-28T00:00:00Z', state_reason: 'not_planned' },
        { user, closed_at: '2026-10-28T00:00:00Z', state_reason: null },
        { user, closed_at: '2026-10-28T00:00:00Z', state_reason: 'completed', pull_request: {} },
        { user, closed_at: '2026-11-02T00:00:00Z', state_reason: 'completed' },
      ]), { headers });
    } },
  });
  const period = getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly');
  assert.deepEqual(await collect('test-token', 'owner/repo', period, client), [
    { login: 'alice', type: 'User', metric: 'pullRequests' },
    { login: 'closer', type: 'User', metric: 'issues' },
  ]);
  assert.equal(paths.length, 4);
});

test('manual closer credit survives a missing author and skips unknown, stale and bot closures', async () => {
  const reporter = { login: 'reporter', type: 'User' };
  const base = { state: 'closed', state_reason: 'completed', closed_at: '2026-10-30T00:00:00Z', created_at: '2026-10-28T00:00:00Z' };
  const details = [
    { ...base, closed_by: { login: 'closer', type: 'User' } },
    { ...base, closed_by: null },
    { ...base, state: 'open', closed_at: null, closed_by: reporter },
    { ...base, closed_at: '2026-11-02T00:00:00Z', closed_by: reporter },
    { ...base, closed_by: { login: 'helper[bot]', type: 'Bot' } },
  ];
  const client = getOctokit('test-token', {
    request: { fetch: async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/graphql')) {
        const repository = Object.fromEntries(details.map((detail, index) => [`i${index + 1}`, {
          state: detail.state.toUpperCase(), stateReason: detail.state_reason.toUpperCase(), closedAt: detail.closed_at,
          timelineItems: { nodes: [{ createdAt: base.closed_at, closer: null,
            actor: detail.closed_by ? { login: detail.closed_by.login, __typename: detail.closed_by.type } : null }] },
        }]));
        return new Response(JSON.stringify({ data: { repository } }), { headers: { 'content-type': 'application/json' } });
      }
      const match = path.match(/\/issues\/(\d+)$/);
      const data = path.endsWith('/pulls') ? [] : match
        ? details[Number(match[1]) - 1]
        : details.map((_, index) => ({ ...base, number: index + 1, user: index === 0 ? null : reporter }));
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    } },
  });
  const contributions = await collect('test-token', 'owner/repo', getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly'), client);
  assert.deepEqual(contributions.filter(item => item.metric === 'issues').map(item => item.login), ['closer']);
  assert.deepEqual(rank(contributions, { prWeight: 3, issueWeight: 1, issueCreatedWeight: 1, includeBots: false, excluded: new Set<string>() }), [
    { login: 'reporter', pullRequests: 0, issues: 0, issuesCreated: 4, score: 4 },
    { login: 'closer', pullRequests: 0, issues: 1, issuesCreated: 0, score: 1 },
  ]);
});

test('GitHub API failures fail collection rather than returning a partial ranking', async () => {
  const client = getOctokit('test-token', {
    request: { fetch: async () => new Response(JSON.stringify({ message: 'Forbidden' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    }) },
  });
  await assert.rejects(collect('test-token', 'owner/repo', getPeriod(new Date(), 'weekly'), client), /Forbidden/);
});

test('issue creation counts open, reopened and closed issues across pages, without counting PRs or out-of-window dates', async () => {
  const user = { login: 'reporter', type: 'User' };
  const client = getOctokit('test-token', {
    request: { fetch: async (url: string | URL | Request) => {
      const target = new URL(String(url));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (target.pathname.endsWith('/graphql')) {
        return new Response(JSON.stringify(closureResponse('2026-10-31T00:00:00Z')), { headers });
      }
      if (target.pathname.endsWith('/pulls')) return new Response('[]', { headers });
      if (target.pathname.endsWith('/issues/2')) {
        return new Response(JSON.stringify({ state: 'closed', state_reason: 'completed', closed_at: '2026-10-31T00:00:00Z', closed_by: user }), { headers });
      }
      if (target.searchParams.get('page') === '2') {
        return new Response(JSON.stringify([
          { number: 2, user, created_at: '2026-10-30T00:00:00Z', state: 'closed', closed_at: '2026-10-31T00:00:00Z', state_reason: 'completed' },
          { user, created_at: '2026-10-31T00:00:00Z', state: 'closed', closed_at: '2026-11-01T00:00:00Z', state_reason: 'not_planned' },
        ]), { headers });
      }
      headers.link = '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"';
      return new Response(JSON.stringify([
        { user, created_at: '2026-10-26T00:00:00Z', state: 'open', closed_at: null },
        { user, created_at: '2026-10-28T00:00:00Z', state: 'open', closed_at: null, state_reason: 'reopened' },
        { user, created_at: '2026-10-25T23:59:59Z', state: 'open', closed_at: null },
        { user, created_at: '2026-11-02T00:00:00Z', state: 'open', closed_at: null },
        { user, created_at: '2026-10-28T00:00:00Z', pull_request: {}, state: 'closed', closed_at: '2026-10-29T00:00:00Z', state_reason: 'completed' },
        { user: null, created_at: '2026-10-28T00:00:00Z', state: 'open', closed_at: null },
      ]), { headers });
    } },
  });
  const period = getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly');
  assert.deepEqual((await collect('test-token', 'owner/repo', period, client)).map(item => item.metric), [
    'issuesCreated', 'issuesCreated', 'issuesCreated', 'issuesCreated', 'issues',
  ]);
});

test('PR and commit closures earn no extra completion points; verified manual closures do', async t => {
  const closedAt = '2026-10-30T00:00:00Z';
  const manual = closureResponse(closedAt);
  const missingEvent = closureResponse(closedAt);
  missingEvent.data.repository.i1.timelineItems.nodes = [];
  const stale = closureResponse('2026-10-29T00:00:00Z');
  const equivalentTimestamp = closureResponse('2026-10-30T00:00:00.000Z');
  const slightlyDelayedEvent = closureResponse(closedAt);
  slightlyDelayedEvent.data.repository.i1.timelineItems.nodes[0]!.createdAt = '2026-10-30T00:00:01Z';
  const tooDelayedEvent = closureResponse(closedAt);
  tooDelayedEvent.data.repository.i1.timelineItems.nodes[0]!.createdAt = '2026-10-30T00:00:06Z';
  const cases = [
    { name: 'closing PR', response: closureResponse(closedAt, { __typename: 'PullRequest' }), completion: false },
    { name: 'closing commit', response: closureResponse(closedAt, { __typename: 'Commit' }), completion: false },
    { name: 'manual closure', response: manual, completion: true },
    { name: 'equivalent timestamp formatting', response: equivalentTimestamp, completion: true },
    { name: 'closure event one second after closed_at', response: slightlyDelayedEvent, completion: true },
    { name: 'closure event beyond tolerance', response: tooDelayedEvent, completion: false },
    { name: 'missing closure event', response: missingEvent, completion: false },
    { name: 'stale closure event', response: stale, completion: false },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const issue = {
        number: 1, user: { login: 'reporter', type: 'User' },
        created_at: '2026-10-27T00:00:00Z', state: 'closed', state_reason: 'completed', closed_at: closedAt,
        closed_by: { login: 'maintainer', type: 'User' },
      };
      const client = getOctokit('test-token', {
        request: { fetch: async (url: string | URL | Request) => {
          const path = new URL(String(url)).pathname;
          const data = path.endsWith('/graphql') ? scenario.response
            : path.endsWith('/pulls') ? [{ user: { login: 'developer', type: 'User' }, merged_at: closedAt, updated_at: closedAt }]
            : path.endsWith('/issues/1') ? issue : [issue];
          return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
        } },
      });
      const contributions = await collect('test-token', 'owner/repo', getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly'), client);
      const entries = rank(contributions, { prWeight: 3, issueWeight: 1, issueCreatedWeight: 1, includeBots: false, excluded: new Set<string>() });
      assert.equal(entries.find(entry => entry.login === 'developer')?.score, 3);
      assert.equal(entries.find(entry => entry.login === 'reporter')?.score, 1);
      assert.equal(entries.some(entry => entry.login === 'maintainer'), scenario.completion);
      assert.equal(entries.reduce((total, entry) => total + entry.score, 0), scenario.completion ? 5 : 4);
    });
  }
});

test('batches closure metadata for many issues and does not fetch individual issue details', async () => {
  const closedAt = '2026-10-30T00:00:00Z';
  const calls: number[] = [];
  const issues = Array.from({ length: 60 }, (_, index) => ({
    number: index + 1, user: null, created_at: '2026-10-01T00:00:00Z',
    state: 'closed', state_reason: 'completed', closed_at: closedAt,
  }));
  const client = getOctokit('test-token', {
    request: { fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const headers = { 'content-type': 'application/json' };
      if (path.endsWith('/pulls')) return new Response('[]', { headers });
      if (path.endsWith('/graphql')) {
        const query = JSON.parse(String(init?.body)).query as string;
        const numbers = [...query.matchAll(/i(\d+): issue\(number: \d+\)/g)].map(match => Number(match[1]));
        calls.push(numbers.length);
        const repository = Object.fromEntries(numbers.map(number => [`i${number}`, {
          state: 'CLOSED', stateReason: 'COMPLETED', closedAt,
          timelineItems: { nodes: [{ createdAt: closedAt, closer: null, actor: { login: 'closer', __typename: 'User' } }] },
        }]));
        return new Response(JSON.stringify({ data: { repository } }), { headers });
      }
      assert.equal(path, '/repos/owner/repo/issues');
      return new Response(JSON.stringify(issues), { headers });
    } },
  });
  const contributions = await collect('test-token', 'owner/repo', getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly'), client);
  assert.equal(contributions.length, 60);
  assert.ok(contributions.every(item => item.login === 'closer' && item.metric === 'issues'));
  assert.deepEqual(calls, [25, 25, 10]);
});

test('includes issues updated exactly at period start with GitHub strict since filtering', async () => {
  const start = '2026-10-26T00:00:00Z';
  const user = { login: 'creator', type: 'User' };
  const records = [
    { number: 1, user, created_at: start, updated_at: start, state: 'open', closed_at: null },
    { number: 2, user, created_at: '2026-10-25T00:00:00Z', updated_at: start, state: 'closed', state_reason: 'completed', closed_at: start },
    { number: 3, user, created_at: '2026-10-25T23:59:59Z', updated_at: '2026-10-25T23:59:59Z', state: 'open', closed_at: null },
    { number: 4, user, created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', state: 'open', closed_at: null },
  ];
  const client = getOctokit('test-token', {
    request: { fetch: async (url: string | URL | Request) => {
      const target = new URL(String(url));
      const headers = { 'content-type': 'application/json' };
      if (target.pathname.endsWith('/pulls')) return new Response('[]', { headers });
      if (target.pathname.endsWith('/graphql')) return new Response(JSON.stringify(closureResponse(start, null, 'closer')), { headers });
      const since = Date.parse(target.searchParams.get('since')!);
      return new Response(JSON.stringify(records.filter(record => Date.parse(record.updated_at) > since)), { headers });
    } },
  });
  const period = getPeriod(new Date('2026-11-02T08:17:00Z'), 'weekly');
  assert.deepEqual(await collect('test-token', 'owner/repo', period, client), [
    { login: 'creator', type: 'User', metric: 'issuesCreated' },
    { login: 'closer', type: 'User', metric: 'issues' },
  ]);
});

test('all-time collection requests issues without a since cutoff', async () => {
  let checked = false;
  const client = getOctokit('test-token', {
    request: { fetch: async (url: string | URL | Request) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/issues')) {
        checked = true;
        assert.equal(target.searchParams.has('since'), false);
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    } },
  });
  await collect('test-token', 'owner/repo', { start: new Date(0), end: new Date('2026-11-02T08:17:00Z'), due: true }, client);
  assert.equal(checked, true);
});
