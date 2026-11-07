import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rank, type Contribution } from '../src/leaderboard.js';

test('ranking aggregates case-insensitively, applies weights and excludes bots and users', () => {
  const contributions: Contribution[] = [
    { login: 'Alice', type: 'User', metric: 'pullRequests' },
    { login: 'alice', type: 'User', metric: 'issues' },
    { login: 'bob', type: 'User', metric: 'pullRequests' },
    { login: 'robot[bot]', type: 'Bot', metric: 'pullRequests' },
    { login: 'excluded', type: 'User', metric: 'issues' },
    { login: 'reporter', type: 'User', metric: 'issuesCreated' },
    { login: 'robot[bot]', type: 'Bot', metric: 'issuesCreated' },
    { login: 'excluded', type: 'User', metric: 'issuesCreated' },
  ];
  assert.deepEqual(rank(contributions, { prWeight: 3, issueWeight: 1, issueCreatedWeight: 1, includeBots: false, excluded: new Set(['excluded']) }), [
    { login: 'Alice', pullRequests: 1, issues: 1, issuesCreated: 0, score: 4 },
    { login: 'bob', pullRequests: 1, issues: 0, issuesCreated: 0, score: 3 },
    { login: 'reporter', pullRequests: 0, issues: 0, issuesCreated: 1, score: 1 },
  ]);
});

test('ties sort by login and disabled metrics do not create zero-point entries', () => {
  const options = { prWeight: 3, issueWeight: 0, issueCreatedWeight: 0, includeBots: true, excluded: new Set<string>() };
  assert.deepEqual(rank([
    { login: 'zebra', type: 'User', metric: 'pullRequests' },
    { login: 'alpha[bot]', type: 'Bot', metric: 'pullRequests' },
    { login: 'issue-only', type: 'User', metric: 'issues' },
    { login: 'reporter', type: 'User', metric: 'issuesCreated' },
  ], options).map(entry => entry.login), ['alpha[bot]', 'zebra']);
});

test('issue creation and completion are independently weighted milestones for the same author', () => {
  const contributions: Contribution[] = [
    { login: 'reporter', type: 'User', metric: 'issuesCreated' },
    { login: 'reporter', type: 'User', metric: 'issues' },
  ];
  const options = { prWeight: 0, issueWeight: 2, issueCreatedWeight: 3, includeBots: false, excluded: new Set<string>() };
  assert.deepEqual(rank(contributions, options), [
    { login: 'reporter', pullRequests: 0, issues: 1, issuesCreated: 1, score: 5 },
  ]);
  assert.deepEqual(rank(contributions, { ...options, issueWeight: 0 }), [
    { login: 'reporter', pullRequests: 0, issues: 0, issuesCreated: 1, score: 3 },
  ]);
});
