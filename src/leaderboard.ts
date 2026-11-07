import { getOctokit } from '@actions/github';
import { inPeriod, type Period } from './period.js';

export interface Contribution {
  login: string;
  type: string;
  metric: 'pullRequests' | 'issues' | 'issuesCreated';
}
export interface Entry {
  login: string;
  pullRequests: number;
  issues: number;
  issuesCreated: number;
  score: number;
}
export interface RankingOptions {
  prWeight: number;
  issueWeight: number;
  issueCreatedWeight: number;
  includeBots: boolean;
  excluded: Set<string>;
}

interface ClosureResponse {
  repository: {
    issue: {
      closedAt: string | null;
      state: string;
      stateReason: string | null;
      timelineItems: { nodes: ({ createdAt: string; closer: { __typename: string } | null } | null)[] };
    } | null;
  } | null;
}

async function wasManuallyCompleted(client: ReturnType<typeof getOctokit>, owner: string, repo: string, number: number, closedAt: string): Promise<boolean> {
  const result = await client.graphql<ClosureResponse>(`
    query ClosureSource($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          state stateReason closedAt
          timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
            nodes { ... on ClosedEvent { createdAt closer { __typename } } }
          }
        }
      }
    }
  `, { owner, repo, number });
  const issue = result.repository?.issue;
  const event = issue?.timelineItems.nodes[0];
  return issue?.state === 'CLOSED' && issue.stateReason === 'COMPLETED'
    && issue.closedAt === closedAt && event?.createdAt === closedAt && event.closer === null;
}

export function rank(contributions: Contribution[], options: RankingOptions): Entry[] {
  const entries = new Map<string, Entry>();
  for (const item of contributions) {
    const key = item.login.toLowerCase();
    if (options.excluded.has(key) || (!options.includeBots && (item.type === 'Bot' || key.endsWith('[bot]')))) continue;
    const weight = item.metric === 'pullRequests' ? options.prWeight
      : item.metric === 'issuesCreated' ? options.issueCreatedWeight : options.issueWeight;
    if (weight === 0) continue;
    const entry = entries.get(key) ?? { login: item.login, pullRequests: 0, issues: 0, issuesCreated: 0, score: 0 };
    entry[item.metric]++;
    entry.score += weight;
    entries.set(key, entry);
  }
  return [...entries.values()].sort((a, b) => b.score - a.score || a.login.toLowerCase().localeCompare(b.login.toLowerCase(), 'en'));
}

export async function collect(token: string, repository: string, period: Period, client = getOctokit(token)): Promise<Contribution[]> {
  const [owner, repo] = repository.split('/') as [string, string];
  const contributions: Contribution[] = [];
  for await (const response of client.paginate.iterator(client.rest.pulls.list, {
    owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100,
  })) {
    for (const pr of response.data) {
      if (pr.user && inPeriod(pr.merged_at, period)) {
        contributions.push({ login: pr.user.login, type: pr.user.type, metric: 'pullRequests' });
      }
    }
    if (response.data.some(pr => Date.parse(pr.updated_at) < period.start.getTime())) break;
  }
  for await (const response of client.paginate.iterator(client.rest.issues.listForRepo, {
    owner, repo, state: 'all', since: period.start.toISOString(), per_page: 100,
  })) {
    for (const issue of response.data) {
      if (issue.pull_request) continue;
      if (issue.user && inPeriod(issue.created_at, period)) {
        contributions.push({ login: issue.user.login, type: issue.user.type, metric: 'issuesCreated' });
      }
      if (issue.state === 'closed' && issue.state_reason === 'completed' && inPeriod(issue.closed_at, period)) {
        const { data: detail } = await client.rest.issues.get({ owner, repo, issue_number: issue.number });
        if (detail.state === 'closed' && detail.state_reason === 'completed' && detail.closed_at && inPeriod(detail.closed_at, period)
          && detail.closed_by?.type === 'User' && !detail.closed_by.login.toLowerCase().endsWith('[bot]')
          && await wasManuallyCompleted(client, owner, repo, issue.number, detail.closed_at)) {
          contributions.push({ login: detail.closed_by.login, type: detail.closed_by.type, metric: 'issues' });
        }
      }
    }
  }
  return contributions;
}
