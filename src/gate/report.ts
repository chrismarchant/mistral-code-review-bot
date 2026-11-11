import { createHash } from 'node:crypto';

import { Budget } from './budget.js';
import { CompareResult, PrInfo } from './github.js';
import {
  Disposition,
  EvidenceItem,
  Finding,
  GateProfile,
  MANIFEST_SCHEMA,
  REPORT_SCHEMA,
} from './types.js';

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export const REVIEWER_VERSION = '1.0.0';

interface ReportInput {
  execId: string;
  now: Date;
  owner: string;
  repo: string;
  pr: PrInfo;
  base: string;
  head: string;
  modelName: string;
  reviewerVersion: string;
  provenance: Record<string, unknown>;
  profile: GateProfile;
  compare: CompareResult;
  evidence: EvidenceItem[];
  modelAssessments: Array<{ step: string; output: unknown }>;
  findings: Finding[];
  assessments: Record<string, unknown>;
  coverageLimitations: string[];
  residualRisks: string[];
  disposition: Disposition;
  rationale: string;
  budget: Budget;
}

export const renderReport = (in_: ReportInput): string => {
  const sev = (s: string) => `**${s.toUpperCase()}**`;
  const lines: string[] = [];

  lines.push(`# Gate Review Report — ${in_.owner}/${in_.repo} PR #${in_.pr.number}`);
  lines.push('');
  lines.push(`- schema: \`${REPORT_SCHEMA}\``);
  lines.push(`- execution id: \`${in_.execId}\``);
  lines.push(`- generated at (UTC): ${in_.now.toISOString()}`);
  lines.push(`- repository: ${in_.owner}/${in_.repo}`);
  lines.push(`- PR: #${in_.pr.number} "${in_.pr.title}" (${in_.pr.htmlUrl}) — state=${in_.pr.state}, draft=${in_.pr.draft}`);
  lines.push(`- baseline SHA: \`${in_.base}\``);
  lines.push(`- candidate SHA: \`${in_.head}\` (verified equal to PR head)`);
  lines.push(`- model: \`${in_.modelName}\``);
  lines.push(`- reviewer implementation: mistral-code-review-bot gate-review v${in_.reviewerVersion}`);
  lines.push(`- provenance: ${JSON.stringify(in_.provenance)}`);
  lines.push(`- profile: \`${in_.profile.schema}\` — ${JSON.stringify(in_.profile.limits)}`);
  lines.push('');
  lines.push('## Scope and evidence inventory');
  lines.push('');
  lines.push(`Compare ${in_.base.slice(0, 12)}...${in_.head.slice(0, 12)}: status=${in_.compare.status}, commits=${in_.compare.totalCommits}, files=${in_.compare.files.length}${in_.compare.filesTruncated ? ' (TRUNCATED at GitHub 300-file cap)' : ''}.`);
  lines.push('');
  lines.push('| id | category | kind | reference | summary |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const e of in_.evidence) {
    const ref = e.ref.replace(/\|/g, '\\|');
    const summary = e.summary.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${e.id} | ${e.category} | ${e.kind} | ${ref} | ${summary} |`);
  }
  lines.push('');
  lines.push(`Model calls used: ${in_.budget.calls}/${in_.profile.limits.maxModelCalls}; tokens: ${in_.budget.totalTokens}/${in_.profile.limits.tokenBudget} (est. cost $${in_.budget.estimatedCostUsd.toFixed(4)}); files inspected: ${in_.budget.filesInspected}; context chars: ${in_.budget.contextChars}.`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (!in_.findings.length) {
    lines.push('No findings were produced by the model synthesis.');
  }
  for (const f of in_.findings) {
    lines.push(`### ${f.id} — ${sev(f.severity)} ${f.title}`);
    lines.push(`- category: ${f.category}`);
    lines.push(`- detail: ${f.detail}`);
    lines.push(`- evidence: ${f.evidenceRefs.length ? f.evidenceRefs.join(', ') : '(none cited)'}`);
    lines.push('');
  }
  lines.push('## Assessments');
  lines.push('');
  for (const [k, v] of Object.entries(in_.assessments)) {
    lines.push(`- ${k}: ${v || '(no assessment produced)'}`);
  }
  lines.push('');
  lines.push('## Coverage limitations');
  lines.push('');
  if (!in_.coverageLimitations.length) lines.push('- none recorded');
  for (const g of in_.coverageLimitations) lines.push(`- ${g}`);
  lines.push('');
  lines.push('## Residual risks');
  lines.push('');
  for (const r of in_.residualRisks) lines.push(`- ${r}`);
  lines.push('');
  lines.push('## Disposition');
  lines.push('');
  lines.push(`**${in_.disposition}**`);
  lines.push('');
  lines.push(in_.rationale || '(no rationale provided)');
  lines.push('');
  lines.push('---');
  lines.push('This report was generated locally by the Mistral Code Review Bot in read-only mode. It is not a formally published GitHub review unless published via the explicit `--publish` operation.');
  lines.push('');
  return lines.join('\n');
};

interface ManifestInput {
  execId: string;
  now: Date;
  owner: string;
  repo: string;
  pr: PrInfo;
  base: string;
  head: string;
  modelName: string;
  reviewerVersion: string;
  provenance: Record<string, unknown>;
  profile: GateProfile;
  evidence: EvidenceItem[];
  findings: Finding[];
  coverageLimitations: string[];
  disposition: Disposition;
  rationale: string;
  budget: Budget;
  report: string;
}

export const buildManifest = (in_: ManifestInput): Record<string, unknown> => {
  const reportSha256 = sha256(in_.report);
  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: in_.now.toISOString(),
    execution: {
      id: in_.execId,
      reviewer: 'mistral-code-review-bot/gate-review',
      reviewerVersion: in_.reviewerVersion,
      mode: 'gate-review (read-only)',
      provenance: in_.provenance,
    },
    repository: { owner: in_.owner, repo: in_.repo, pr: in_.pr.number, htmlUrl: in_.pr.htmlUrl },
    commits: { baseline: in_.base, candidate: in_.head, candidateVerifiedAgainstPrHead: true },
    model: {
      provider: 'mistral',
      model: in_.modelName,
      callsUsed: in_.budget.calls,
      tokenUsage: {
        prompt: in_.budget.promptTokens,
        completion: in_.budget.completionTokens,
        total: in_.budget.totalTokens,
        budget: in_.profile.limits.tokenBudget,
      },
      estimatedCostUsd: Number(in_.budget.estimatedCostUsd.toFixed(6)),
    },
    profile: in_.profile,
    evidence: in_.evidence.map((e) => ({
      id: e.id,
      category: e.category,
      kind: e.kind,
      ref: e.ref,
      summary: e.summary,
      truncated: e.truncated ?? false,
    })),
    checks: {
      filesInspected: in_.budget.filesInspected,
      readOnly: true,
    },
    findings: in_.findings,
    missingEvidence: in_.evidence.filter((e) => e.kind === 'unresolved').map((e) => e.id),
    coverageLimitations: in_.coverageLimitations,
    disposition: in_.disposition,
    rationale: in_.rationale,
    reportFile: 'report.md',
    reportSha256,
  };
};

/** Structural validation used by tests and by consumers to verify a manifest. */
export const validateManifest = (
  manifest: Record<string, unknown>,
  reportBytes: string
): string[] => {
  const errors: string[] = [];
  if (manifest.schema !== MANIFEST_SCHEMA) errors.push(`bad schema: ${manifest.schema}`);
  const exec = manifest.execution as Record<string, unknown> | undefined;
  if (!exec?.id) errors.push('missing execution.id');
  const commits = manifest.commits as Record<string, unknown> | undefined;
  if (!commits?.baseline || !commits?.candidate) errors.push('missing commits');
  if (!Array.isArray(manifest.findings)) errors.push('missing findings array');
  if (!Array.isArray(manifest.evidence)) errors.push('missing evidence array');
  const disp = manifest.disposition;
  if (!['ACCEPT', 'ACCEPT WITH CONDITIONS', 'REJECT'].includes(disp as string))
    errors.push(`bad disposition: ${disp}`);
  if (manifest.reportSha256 !== sha256(reportBytes)) {
    errors.push('reportSha256 does not match the supplied report bytes');
  }
  const blob = JSON.stringify(manifest) + reportBytes;
  for (const secret of ['MISTRAL_API_KEY', 'GITHUB_TOKEN', 'PRIVATE_KEY']) {
    if (blob.includes(secret) && (manifest as any).execution?.[secret]) {
      errors.push(`possible secret in artifacts: ${secret}`);
    }
  }
  return errors;
};
