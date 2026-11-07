import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOctokit } from '@actions/github';
import { collect, rank } from '../src/leaderboard.js';
import { getPeriod } from '../src/period.js';

function closureResponse(closedAt: string, closer: { __typename: string } | null = null) {
  return { data: { repository: { issue: {
    state: 'CLOSED', stateReason: 'COMPLETED', closedAt,
    timelineItems: { nodes: [{ createdAt: closedAt, closer }] },
  } } } };
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
        return new Response(JSON.stringify(closureResponse('2026-10-26T00:00:00Z')), { headers });
      }
      if (target.pathname.endsWith('/issues/1')) {
        return new Response(JSON.stringify({ state: 'closed', state_reason: 'completed', closed_at: '2026-10-26T00:00:00Z', closed_by: { login: 'closer', type: 'User' } }), { headers });
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
      assert.equal(target.searchParams.get('since'), '2026-10-26T00:00:00.000Z');
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
  assert.equal(paths.length, 5);
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
        return new Response(JSON.stringify(closureResponse(base.closed_at)), { headers: { 'content-type': 'application/json' } });
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
    'issuesCreated', 'issuesCreated', 'issuesCreated', 'issues', 'issuesCreated',
  ]);
});

test('PR and commit closures earn no extra completion points; verified manual closures do', async t => {
  const closedAt = '2026-10-30T00:00:00Z';
  const manual = closureResponse(closedAt);
  const missingEvent = closureResponse(closedAt);
  missingEvent.data.repository.issue.timelineItems.nodes = [];
  const stale = closureResponse('2026-10-29T00:00:00Z');
  const cases = [
    { name: 'closing PR', response: closureResponse(closedAt, { __typename: 'PullRequest' }), completion: false },
    { name: 'closing commit', response: closureResponse(closedAt, { __typename: 'Commit' }), completion: false },
    { name: 'manual closure', response: manual, completion: true },
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
