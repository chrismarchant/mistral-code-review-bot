#!/usr/bin/env node
/**
 * MCRB Gate Review CLI (Mode B).
 *
 * Read-only comprehensive review of a PR. Writes report.md + manifest.json
 * to the output directory. Publication to GitHub requires the explicit
 * --publish flag and is always a COMMENT review (never APPROVE).
 *
 * Exit codes:
 *   0  review completed (check disposition in manifest)
 *   1  unexpected error
 *   2  usage error
 *   3  candidate SHA does not match PR head
 *   4  GitHub/Mistral authentication or API failure
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { GitHubEvidence } from '../gate/github.js';
import { loadProfile } from '../gate/profile.js';
import { publishGateReview } from '../gate/publish.js';
import { runGateReview } from '../gate/review.js';
import { REVIEWER_VERSION } from '../gate/report.js';
import { ShaMismatchError } from '../gate/types.js';
import { MistralChat } from '../mistral.js';

interface Args {
  owner?: string;
  repo?: string;
  pr?: number;
  base?: string;
  head?: string;
  profile?: string;
  out?: string;
  publish?: boolean;
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--owner': args.owner = next(); break;
      case '--repo': args.repo = next(); break;
      case '--pr': args.pr = Number(next()); break;
      case '--base': args.base = next(); break;
      case '--head': args.head = next(); break;
      case '--profile': args.profile = next(); break;
      case '--out': args.out = next(); break;
      case '--publish': args.publish = true; break;
      case '--help':
        console.log(
          'Usage: gate-review --owner O --repo R --pr N --base SHA --head SHA [--profile PATH] [--out DIR] [--publish]'
        );
        process.exit(0);
      default:
        console.error(`unknown argument: ${a}`);
        process.exit(2);
    }
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const {
    owner = process.env.GATE_OWNER,
    repo = process.env.GATE_REPO,
    pr = process.env.GATE_PR ? Number(process.env.GATE_PR) : undefined,
    base = process.env.GATE_BASE,
    head = process.env.GATE_HEAD,
  } = args;

  const missing = [
    ['--owner', owner],
    ['--repo', repo],
    ['--pr', pr],
    ['--base', base],
    ['--head', head],
  ].filter(([, v]) => v === undefined || v === '');
  const token = process.env.GITHUB_TOKEN;
  const mistralKey = process.env.MISTRAL_API_KEY;
  if (missing.length || !token || !mistralKey) {
    console.error(
      'Missing required inputs. Provide --owner --repo --pr --base --head and env GITHUB_TOKEN + MISTRAL_API_KEY.'
    );
    process.exit(2);
  }

  const profile = loadProfile(args.profile);
  process.env.REQUEST_TIMEOUT_MS = String(profile.limits.requestTimeoutMs);
  process.env.RETRY_ATTEMPTS = String(profile.limits.retryAttempts);

  const execId = randomUUID();
  const outDir = args.out ?? join('gate-review-output', execId);
  mkdirSync(outDir, { recursive: true });

  const github = new GitHubEvidence({
    owner: owner!,
    repo: repo!,
    pr: pr!,
    base: base!,
    head: head!,
    token: token!,
    profile,
  });
  const chat = new MistralChat(mistralKey!);

  // establish the ACTUAL GitHub identity behind the token (User vs App Bot)
  const reviewerIdentity = await github.getViewerIdentity();
  const provenance = {
    reviewerIdentity,
    githubAppSlug:
      reviewerIdentity.type === 'Bot' ? reviewerIdentity.slug : process.env.GITHUB_APP_SLUG ?? null,
    tokenType:
      reviewerIdentity.type === 'Bot' ? 'github-app-installation' : 'oauth-or-PAT',
    invokedVia: 'cli',
    independenceNote:
      'Review executed by mistral-code-review-bot; the bot implementation session is not the independent reviewer.',
  };

  try {
    const result = await runGateReview({
      github,
      chat,
      profile,
      owner: owner!,
      repo: repo!,
      execId,
      now: () => new Date(),
      modelName: process.env.MODEL || 'mistral-large-latest',
      reviewerVersion: REVIEWER_VERSION,
      provenance,
      logger: (m) => console.log(`[gate-review] ${m}`),
    });

    const reportPath = join(outDir, 'report.md');
    const manifestPath = join(outDir, 'manifest.json');
    writeFileSync(reportPath, result.report, 'utf8');
    writeFileSync(manifestPath, JSON.stringify(result.manifest, null, 2) + '\n', 'utf8');

    console.log(`[gate-review] disposition: ${result.disposition}`);
    console.log(`[gate-review] report: ${reportPath}`);
    console.log(`[gate-review] manifest: ${manifestPath}`);
    console.log(`[gate-review] report sha256: ${result.reportSha256}`);
    console.log(
      `[gate-review] model calls: ${result.budget.calls}, tokens: ${result.budget.totalTokens}, est. cost $${result.budget.estimatedCostUsd.toFixed(4)}`
    );

    if (args.publish) {
      const pub = await publishGateReview({
        github,
        pr: pr!,
        head: head!,
        execId,
        reportSha256: result.reportSha256,
        disposition: result.disposition,
        summary:
          `Gate review of ${owner}/${repo}#${pr} (${base!.slice(0, 12)}...${head!.slice(0, 12)}): ` +
          `${result.findings.length} finding(s), ${result.evidence.filter((e) => e.kind === 'unresolved').length} unresolved evidence item(s).`,
      });
      console.log(
        pub.published
          ? `[gate-review] published review id=${pub.reviewId}`
          : `[gate-review] publish skipped: ${pub.reason}`
      );
    } else {
      console.log('[gate-review] read-only mode: nothing published to GitHub (use --publish to publish a COMMENT review)');
    }
    process.exit(0);
  } catch (e) {
    if (e instanceof ShaMismatchError) {
      console.error(`[gate-review] ${e.message}`);
      process.exit(3);
    }
    console.error('[gate-review] failed:', e);
    process.exit(1);
  }
};

main();
