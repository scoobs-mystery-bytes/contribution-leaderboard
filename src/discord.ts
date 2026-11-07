import type { Entry } from './leaderboard.js';
import type { Period } from './period.js';

export function createMessage(repository: string, period: Period, entries: Entry[], top: number) {
  const formatTimestamp = (date: Date) => date.toISOString().endsWith('T00:00:00.000Z')
    ? date.toISOString().slice(0, 10) : date.toISOString();
  const periodStart = period.kind === 'all-time' ? 'All time' : formatTimestamp(period.start);
  const rows: string[] = [];
  for (const [index, entry] of entries.slice(0, top).entries()) {
    const label = entry.login.replace(/[\\[\]_*`]/g, '\\$&');
    const medal = ['🥇', '🥈', '🥉'][index] ?? '✨';
    const row = `${medal} **${index + 1}.** [${label}](https://github.com/${encodeURIComponent(entry.login)}) — **${entry.score} pts** · ${entry.pullRequests} PRs · ${entry.issuesCreated} issues opened · ${entry.issues} manually completed`;
    if ([...rows, row].join('\n').length > 4096) break;
    rows.push(row);
  }
  return {
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: 'contribution-leaderboard-logo.png', description: 'Contribution Leaderboard green block logo' }],
    embeds: [{
      title: 'Contribution Leaderboard',
      thumbnail: { url: 'attachment://contribution-leaderboard-logo.png' },
      description: rows.join('\n') || 'No qualifying contributions this period.',
      color: 0x7c3aed,
      fields: [
        { name: 'Repository', value: repository },
        { name: 'Period (UTC)', value: `${periodStart} → ${formatTimestamp(period.end)} (end exclusive)` },
      ],
      footer: { text: `Top ${rows.length} of ${entries.length} contributors\n💚 Thanks to everyone who pitched in! Every bug report, idea, and helping hand makes this project better. We appreciate you!` },
    }],
  };
}

export function validateWebhook(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('A valid Discord webhook URL is required.'); }
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname)
    || url.port || url.username || url.password || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('Expected an HTTPS Discord channel webhook URL.');
  }
  return url;
}

export async function postMessage(webhook: string, message: ReturnType<typeof createMessage>, icon: Uint8Array, request = fetch): Promise<void> {
  const url = validateWebhook(webhook);
  url.search = '';
  url.searchParams.set('wait', 'true');
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = new FormData();
    body.set('payload_json', JSON.stringify(message));
    body.set('files[0]', new Blob([new Uint8Array(icon)], { type: 'image/png' }), 'contribution-leaderboard-logo.png');
    let response: Response;
    try {
      response = await request(url, {
        method: 'POST', body, signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Discord delivery failed or timed out. Check the channel before retrying; delivery may have succeeded.');
    }
    if (response.ok) return;
    if (response.status === 429 && attempt < 2) {
      const body = await response.json() as { retry_after?: unknown };
      if (typeof body.retry_after !== 'number' || !Number.isFinite(body.retry_after) || body.retry_after < 0 || body.retry_after > 30) {
        throw new Error('Discord rate limit exceeded. Retry later.');
      }
      await new Promise(resolve => setTimeout(resolve, Math.ceil(body.retry_after as number * 1000)));
      continue;
    }
    throw new Error(`Discord returned HTTP ${response.status}. Check webhook access before retrying.`);
  }
}
