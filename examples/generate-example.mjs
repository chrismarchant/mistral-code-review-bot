// Generates example gate-review artifacts (report.md + manifest.json) using
// mocked GitHub/Mistral responses so the example is deterministic and offline.
// Run after `npm run build`:  node examples/generate-example.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GitHubEvidence } from '../dist/gate/github.js';
import { DEFAULT_PROFILE } from '../dist/gate/profile.js';
import { runGateReview } from '../dist/gate/review.js';
import { REVIEWER_VERSION } from '../dist/gate/report.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here);
mkdirSync(outDir, { recursive: true });

const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';

const ghFetch = async (url, init = { method: 'GET' }) => {
  const ok = (data, status = 200) => ({
    ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data),
  });
  if (url.includes('/pulls/7')) {
    return ok({
      number: 7, title: 'Refactor auth module', body: 'Replaces token parsing with a stricter implementation.',
      draft: false, state: 'open', head: { sha: HEAD }, base: { sha: BASE },
      html_url: 'https://github.com/octo/demo/pull/7', user: { login: 'dev1' },
    });
  }
  if (url.includes('/compare/')) {
    return ok({
      status: 'ahead', ahead_by: 3, total_commits: 3,
      files: [{
        filename: 'src/auth.ts', status: 'modified', additions: 12, deletions: 30,
        patch: '@@ -1,5 +1,5 @@\n-old parse\n+new parse\n',
      }],
    });
  }
  if (url.includes('/contents/')) {
    return ok({ type: 'file', encoding: 'base64', size: 120, content: Buffer.from('export function parse(t){ /* ... */ }').toString('base64') });
  }
  if (url.includes('/check-runs')) return ok({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure' }] });
  if (url.includes('/actions/runs')) return ok({ workflow_runs: [{ name: 'CI', workflow_id: 1, status: 'completed', conclusion: 'failure' }] });
  if (url.includes('/dependency-graph/sbom')) return ok({ message: 'Not Found' }, 404);
  if (url.includes('/contents/package-lock.json') || url.includes('package-lock.json')) {
    return ok({ type: 'file', encoding: 'base64', size: 80, content: Buffer.from('{"name":"demo","dependencies":{}}').toString('base64') });
  }
  if (url.includes('/dependabot/alerts')) return ok([{ dependency: { package: { name: 'lodash' } }, security_advisory: { severity: 'high', summary: 'Prototype pollution' } }]);
  if (url.includes('/vulnerability-alerts')) return ok({}, 204);
  return ok({ message: 'not found' }, 404);
};

const chatCalls = [];
const chat = {
  chat: async (messages) => {
    chatCalls.push(messages);
    const n = chatCalls.length;
    const content = n === 1
      ? JSON.stringify({ summary: 'auth parsing refactor', risk_areas: [{ file: 'src/auth.ts', risk: 'token edge cases', severity: 'medium' }] })
      : n <= 4
        ? JSON.stringify({ findings: n === 2 ? [{ id: 'S-1', severity: 'high', title: 'open lodash advisory', detail: 'upgrade required', evidenceRefs: ['sec-dependabot-open'] }] : [], notes: 'ok' })
        : JSON.stringify({
            findings: [{ id: 'F-1', severity: 'high', category: 'security', title: 'Open high-severity dependency advisory (lodash)', detail: 'Upgrade lodash to a patched version before merge.', evidenceRefs: ['sec-dependabot-open'] }, { id: 'F-2', severity: 'medium', category: 'regression', title: 'CI failing on candidate head', detail: 'check-runs report test failure for the candidate SHA.', evidenceRefs: ['ci-check-runs'] }],
            security_assessment: 'One open high-severity Dependabot advisory affecting a direct dependency.',
            dependency_assessment: 'package-lock.json present; SBOM endpoint unavailable (permission).',
            compatibility_assessment: 'Internal refactor; no public API changes detected in the diff.',
            regression_assessment: 'CI red on candidate head (test check failed).',
            coverage_limitations: ['SBOM unavailable; lockfile used instead'],
            residual_risks: ['Manual verification of token edge cases recommended'],
            disposition: 'ACCEPT WITH CONDITIONS',
            rationale: 'Acceptable once the lodash advisory is addressed and CI is green.',
          });
    return { content, usage: { prompt_tokens: 4200, completion_tokens: 700, total_tokens: 4900 } };
  },
};

const github = new GitHubEvidence({
  owner: 'octo', repo: 'demo', pr: 7, base: BASE, head: HEAD,
  token: 'example-token', profile: DEFAULT_PROFILE, fetchImpl: ghFetch,
});

const result = await runGateReview({
  github, chat, profile: DEFAULT_PROFILE,
  owner: 'octo', repo: 'demo', execId: 'example-exec-0001',
  now: () => new Date('2026-01-01T00:00:00Z'),
  modelName: 'mistral-large-latest', reviewerVersion: REVIEWER_VERSION,
  provenance: { tokenType: 'GITHUB_TOKEN', invokedVia: 'cli (example, mocked APIs)' },
});

writeFileSync(join(outDir, 'report.md'), result.report);
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
console.log('wrote examples/report.md and examples/manifest.json');
console.log('disposition:', result.disposition, '| report sha256:', result.reportSha256);
