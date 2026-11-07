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
  repository: Record<string, {
      closedAt: string | null;
      state: string;
      stateReason: string | null;
      timelineItems: { nodes: ({
        createdAt: string;
        closer: { __typename: string } | null;
        actor: { login: string; __typename: string } | null;
      } | null)[] | null };
    } | null> | null;
}

async function collectClosures(client: ReturnType<typeof getOctokit>, owner: string, repo: string, candidates: { number: number; closedAt: string }[]): Promise<Contribution[]> {
  const contributions: Contribution[] = [];
  for (let offset = 0; offset < candidates.length; offset += 25) {
    const batch = candidates.slice(offset, offset + 25);
    const selections = batch.map(({ number }) => {
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid issue number returned by GitHub.');
      return `i${number}: issue(number: ${number}) { state stateReason closedAt timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { createdAt closer { __typename } actor { login __typename } } } } }`;
    }).join('\n');
    const result = await client.graphql<ClosureResponse>(`
      query ClosureSources($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) { ${selections} }
      }
    `, { owner, repo });
    for (const candidate of batch) {
      const issue = result.repository?.[`i${candidate.number}`];
      const event = issue?.timelineItems.nodes?.[0];
      const actor = event?.actor;
      if (issue?.state === 'CLOSED' && issue.stateReason === 'COMPLETED'
        && issue.closedAt && Date.parse(issue.closedAt) === Date.parse(candidate.closedAt)
        && event && Math.abs(Date.parse(event.createdAt) - Date.parse(candidate.closedAt)) <= 5000
        && event.closer === null && actor?.__typename === 'User' && !actor.login.toLowerCase().endsWith('[bot]')) {
        contributions.push({ login: actor.login, type: 'User', metric: 'issues' });
      }
    }
  }
  return contributions;
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
    owner, repo, state: 'all', since: period.start.getTime() <= 0 ? undefined : new Date(period.start.getTime() - 1000).toISOString(), per_page: 100,
  })) {
    const candidates: { number: number; closedAt: string }[] = [];
    for (const issue of response.data) {
      if (issue.pull_request) continue;
      if (issue.user && inPeriod(issue.created_at, period)) {
        contributions.push({ login: issue.user.login, type: issue.user.type, metric: 'issuesCreated' });
      }
      if (issue.state === 'closed' && issue.state_reason === 'completed' && issue.closed_at && inPeriod(issue.closed_at, period)) {
        candidates.push({ number: issue.number, closedAt: issue.closed_at });
      }
    }
    contributions.push(...await collectClosures(client, owner, repo, candidates));
  }
  return contributions;
}
