import * as core from '@actions/core';
import { context } from '@actions/github';
import { getReportingPeriod, type Cadence, type ReportingPeriod } from './period.js';
import { collect, rank } from './leaderboard.js';
import { createMessage, postMessage, validateWebhook } from './discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function integer(name: string, min: number, max: number): number {
  const raw = core.getInput(name);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

async function run(): Promise<void> {
  const webhook = core.getInput('discord-webhook-url');
  const token = core.getInput('github-token', { required: true });
  if (webhook) core.setSecret(webhook);
  core.setSecret(token);
  core.setOutput('posted', false);
  core.setOutput('skipped', false);
  const repository = core.getInput('repository', { required: true });
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error('repository must use owner/repo format.');
  const cadence = core.getInput('cadence') as Cadence;
  if (!['daily', 'weekly', 'monthly', 'quarterly', 'custom'].includes(cadence)) throw new Error('Unsupported cadence.');
  const periodKind = core.getInput('period') as ReportingPeriod;
  const period = getReportingPeriod(new Date(), cadence, periodKind, integer('interval-months', 1, 120), core.getInput('anchor-month'),
    periodKind === 'weeks-to-date' ? integer('interval-weeks', 1, 520) : undefined,
    periodKind === 'weeks-to-date' ? core.getInput('anchor-week', { required: true }) : undefined);
  const top = integer('top', 1, 25);
  const options = {
    prWeight: integer('pr-weight', 0, 1000), issueWeight: integer('issue-weight', 0, 1000),
    issueCreatedWeight: integer('issue-created-weight', 0, 1000),
    includeBots: core.getBooleanInput('include-bots'),
    excluded: new Set(core.getInput('exclude-users').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)),
  };
  if (options.prWeight + options.issueWeight + options.issueCreatedWeight === 0) throw new Error('At least one scoring weight must be positive.');
  const dryRun = core.getBooleanInput('dry-run');
  core.setOutput('period-start', period.start.toISOString());
  core.setOutput('period-end', period.end.toISOString());
  if (context.eventName === 'schedule' && !period.due) {
    core.setOutput('skipped', true);
    core.info('No reporting boundary today (UTC). Skipping.');
    await core.summary.addHeading('Contribution Leaderboard').addRaw('Skipped: no reporting boundary today (UTC).').write();
    return;
  }
  if (!dryRun) validateWebhook(webhook);
  const entries = rank(await collect(token, repository, period), options);
  core.setOutput('leaderboard', JSON.stringify(entries));
  await core.summary.addHeading('Contribution Leaderboard')
    .addRaw(`${repository} · ${period.start.toISOString()} → ${period.end.toISOString()} (end exclusive)\n\n`)
    .addTable([
      ['Rank', 'Contributor', 'Points', 'Merged PRs', 'Issues opened', 'Issues manually completed'],
      ...entries.slice(0, top).map((entry, index) => [String(index + 1), entry.login, String(entry.score), String(entry.pullRequests), String(entry.issuesCreated), String(entry.issues)]),
    ])
    .addRaw(`\n${dryRun ? 'Dry run: Discord posting disabled.' : 'Discord delivery pending; see the posted output and step result.'}\n`).write();
  if (!dryRun) {
    const icon = readFileSync(join(__dirname, '../assets/images/contribution-leaderboard-logo.png'));
    await postMessage(webhook, createMessage(repository, period, entries, top), icon);
    core.setOutput('posted', true);
    await core.summary.addRaw('\nDiscord message posted successfully.\n').write();
  }
}

run().catch(error => core.setFailed(error instanceof Error ? error.message : 'Action failed.'));
