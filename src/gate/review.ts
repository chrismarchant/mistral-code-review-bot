import { Budget } from './budget.js';
import { GitHubEvidence, CompareFile } from './github.js';
import { renderReport, buildManifest } from './report.js';
import {
  CATEGORY_ASSESSMENT_PROMPT,
  DIFF_ASSESSMENT_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  SYNTHESIS_PROMPT,
  buildUserPrompt,
} from './prompts.js';
import { wrapUntrusted } from './sanitize.js';
import {
  BudgetExceededError,
  Disposition,
  EvidenceItem,
  Finding,
  GateProfile,
  Severity,
} from './types.js';

export interface ChatClient {
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts?: { json?: boolean }
  ): Promise<{ content: string; usage?: { total_tokens?: number } }>;
}

export interface GateReviewResult {
  report: string;
  manifest: Record<string, unknown>;
  reportSha256: string;
  disposition: Disposition;
  budget: Budget;
  evidence: EvidenceItem[];
  findings: Finding[];
}

const BINARY_EXT = /\.(png|jpe?g|gif|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mov|exe|dll|so|dylib|class|jar)$/i;

export const isBinaryFile = (filename: string): boolean => BINARY_EXT.test(filename);

const truncate = (s: string, max: number): { text: string; truncated: boolean } =>
  s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };

/**
 * Mode B — Gate Review orchestration. Read-only: the GitHub client is only
 * ever called with GET during this function (publication is a separate,
 * explicitly invoked operation in publish.ts).
 */
export const runGateReview = async (deps: {
  github: GitHubEvidence;
  chat: ChatClient;
  profile: GateProfile;
  owner: string;
  repo: string;
  execId: string;
  now: () => Date;
  modelName: string;
  reviewerVersion: string;
  provenance: Record<string, unknown>;
  logger?: (msg: string) => void;
}): Promise<GateReviewResult> => {
  const { github, chat, profile, execId, owner, repo } = deps;
  const log = deps.logger ?? (() => {});
  const budget = new Budget(profile);

  const evidence: EvidenceItem[] = [];
  const modelAssessments: Array<{ step: string; output: unknown }> = [];

  // 1-3. PR identity, head verification, draft support (draft PRs are reviewed as-is)
  const pr = await github.verifyHead();
  evidence.push({
    id: 'pr-meta',
    category: 'pr',
    kind: 'verified',
    ref: `GET /repos/{owner}/{repo}/pulls/${pr.number}`,
    summary: `PR #${pr.number} "${pr.title}" by ${pr.user}; state=${pr.state}; draft=${pr.draft}; head=${pr.headSha}; base=${pr.baseSha}`,
    content: `PR title: ${pr.title}\nPR body:\n${pr.body}`,
  });

  // 4. complete baseline..candidate diff
  const compare = await github.getCompare();
  if (compare.filesTruncated) {
    budget.gap(
      `diff file list truncated by GitHub at ${compare.files.length} files; some changed files were not reviewed`
    );
  }
  const diffFiles: CompareFile[] = compare.files;
  const fileSummary = diffFiles
    .map(
      (f) =>
        `${f.status} ${f.filename}${f.previousFilename ? ` (renamed from ${f.previousFilename})` : ''} +${f.additions}/-${f.deletions}${f.patch ? '' : ' [patch omitted by GitHub]'}`
    )
    .join('\n');
  evidence.push({
    id: 'diff-summary',
    category: 'diff',
    kind: 'verified',
    ref: `GET /repos/${owner}/${repo}/compare/${pr.baseSha}...${pr.headSha}`,
    summary: `compare ${pr.baseSha}...${pr.headSha}: status=${compare.status}, ahead_by=${compare.aheadBy}, commits=${compare.totalCommits}, files=${diffFiles.length}${compare.filesTruncated ? ' (TRUNCATED at GitHub 300-file cap)' : ''}`,
  });

  // classify files explicitly: binary / deleted / renamed / missing patch
  const reviewable: CompareFile[] = [];
  for (const f of diffFiles) {
    if (f.status === 'removed') {
      evidence.push({
        id: `file:${f.filename}`,
        category: 'diff',
        kind: 'verified',
        ref: 'compare.files',
        summary: `deleted file ${f.filename} (-${f.deletions})`,
      });
      continue;
    }
    if (isBinaryFile(f.filename)) {
      evidence.push({
        id: `file:${f.filename}`,
        category: 'diff',
        kind: 'verified',
        ref: 'compare.files',
        summary: `binary file ${f.filename} changed (${f.status}); content not reviewed`,
      });
      continue;
    }
    if (!f.patch) {
      evidence.push({
        id: `file:${f.filename}`,
        category: 'diff',
        kind: 'unresolved',
        ref: 'compare.files',
        summary: `patch for ${f.filename} omitted/truncated by GitHub (large diff); not reviewed`,
      });
      budget.gap(`patch omitted by GitHub for ${f.filename}`);
      continue;
    }
    reviewable.push(f);
  }

  // 5. surrounding source + config at candidate head, bounded by profile
  const selected = reviewable.slice(0, profile.limits.maxFiles);
  if (reviewable.length > selected.length) {
    budget.gap(
      `maxFiles (${profile.limits.maxFiles}) reached; ${reviewable.length - selected.length} changed file(s) not inspected`
    );
  }
  for (const f of selected) {
    budget.filesInspected++;
    try {
      const file = await github.getFileContent(f.filename, pr.headSha);
      budget.addContextChars(file.content.length);
      if (budget.contextChars > profile.limits.maxContextCharsTotal) {
        budget.gap(`source context for ${f.filename} skipped: total context cap reached`);
        evidence.push({
          id: `src:${f.filename}`,
          category: 'source',
          kind: 'unresolved',
          ref: `contents ${f.filename}@${pr.headSha}`,
          summary: `${f.filename}: skipped, total context budget exhausted`,
        });
        continue;
      }
      const t = truncate(file.content, profile.limits.maxContextCharsPerFile);
      if (t.truncated) {
        budget.gap(`${f.filename} source truncated to ${profile.limits.maxContextCharsPerFile} chars`);
      }
      evidence.push({
        id: `src:${f.filename}`,
        category: 'source',
        kind: 'verified',
        ref: `GET /repos/{owner}/{repo}/contents/${f.filename}?ref=${pr.headSha}`,
        summary: `${f.filename} at ${pr.headSha} (${file.size} bytes${t.truncated ? ', TRUNCATED' : ''})`,
        content: t.text,
        truncated: t.truncated,
      });
    } catch (e) {
      evidence.push({
        id: `src:${f.filename}`,
        category: 'source',
        kind: 'unresolved',
        ref: `contents ${f.filename}@${pr.headSha}`,
        summary: `could not retrieve ${f.filename} at ${pr.headSha}: ${(e as Error).message}`,
      });
    }
  }

  // 6. CI / dependency / security evidence (authenticated retrieval only)
  evidence.push(...(await github.getCiEvidence()));
  evidence.push(...(await github.getDependencyEvidence()));
  evidence.push(...(await github.getSecurityEvidence()));

  // 7. bounded model assessment: diff overview, then per-category, then synthesis
  const callModel = async (
    step: string,
    instruction: string,
    items: Array<{ label: string; text: string }>
  ): Promise<unknown> => {
    const userPrompt = buildUserPrompt(instruction, items);
    if (userPrompt.length > profile.limits.maxPromptCharsPerCall) {
      budget.gap(
        `${step}: prompt truncated to maxPromptCharsPerCall (${profile.limits.maxPromptCharsPerCall})`
      );
    }
    const safePrompt =
      userPrompt.length > profile.limits.maxPromptCharsPerCall
        ? userPrompt.slice(0, profile.limits.maxPromptCharsPerCall)
        : userPrompt;
    budget.canMakeCall(safePrompt);
    const res = await chat.chat(
      [
        { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
        { role: 'user', content: safePrompt },
      ],
      { json: true }
    );
    budget.recordCall(safePrompt, res.usage);
    log(`${step}: ok (call ${budget.calls}, total tokens ${budget.totalTokens})`);
    try {
      return JSON.parse(res.content);
    } catch {
      budget.gap(`${step}: model returned malformed JSON; treated as unresolved`);
      return { parse_error: true, raw: res.content.slice(0, 2000) };
    }
  };

  const evidenceForModel = (categories: EvidenceItem['category'][]) =>
    evidence
      .filter((e) => categories.includes(e.category))
      .map((e) => ({
        label: `${e.id} [${e.kind}]`,
        text: `${e.ref}\n${e.summary}${e.content ? `\n${e.content}` : ''}`,
      }));

  try {
    const diffItems = [
      ...evidenceForModel(['pr', 'diff']),
      {
        label: 'diff-file-list',
        text: fileSummary || '(no files)',
      },
      ...reviewable.map((f) => ({
        label: `patch:${f.filename}`,
        text: f.patch ?? '',
      })),
    ];
    modelAssessments.push({
      step: 'diff-overview',
      output: await callModel('diff-overview', DIFF_ASSESSMENT_PROMPT, diffItems),
    });

    for (const cat of ['security', 'dependency', 'ci'] as const) {
      modelAssessments.push({
        step: `assessment-${cat}`,
        output: await callModel(
          `assessment-${cat}`,
          CATEGORY_ASSESSMENT_PROMPT(cat),
          evidenceForModel([cat === 'ci' ? 'ci' : cat, 'diff', 'source'])
        ),
      });
    }

    modelAssessments.push({
      step: 'synthesis',
      output: await callModel(
        'synthesis',
        SYNTHESIS_PROMPT,
        evidenceForModel(['pr', 'diff', 'source', 'ci', 'dependency', 'security'])
      ),
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      log(`budget exhausted: ${e.message}`);
      evidence.push({
        id: 'budget',
        category: 'process',
        kind: 'unresolved',
        ref: 'budget',
        summary: `model-call budget exhausted: ${e.message}`,
      });
    } else {
      throw e;
    }
  }

  // 8-12. findings + disposition from synthesis, with deterministic guards
  const synthesis = modelAssessments.find((m) => m.step === 'synthesis')
    ?.output as Record<string, any> | undefined;

  let findings: Finding[] = [];
  let disposition: Disposition = 'REJECT';
  let rationale = 'synthesis did not run or returned malformed output; incomplete reviews never pass';
  let assessments: Record<string, unknown> = {};

  if (synthesis && !synthesis.parse_error) {
    const rawFindings = Array.isArray(synthesis.findings) ? synthesis.findings : [];
    findings = rawFindings.map((f: Record<string, any>, i: number) => ({
      id: typeof f.id === 'string' ? f.id : `F-${i + 1}`,
      severity: (['critical', 'high', 'medium', 'low', 'info'] as Severity[]).includes(f.severity)
        ? f.severity
        : 'info',
      category: f.category ?? 'quality',
      title: String(f.title ?? 'untitled finding'),
      detail: String(f.detail ?? ''),
      evidenceRefs: Array.isArray(f.evidenceRefs) ? f.evidenceRefs.map(String) : [],
    }));
    assessments = {
      security: synthesis.security_assessment ?? '',
      dependency: synthesis.dependency_assessment ?? '',
      compatibility: synthesis.compatibility_assessment ?? '',
      regression: synthesis.regression_assessment ?? '',
    };
    const d = String(synthesis.disposition ?? '').toUpperCase();
    disposition = (['ACCEPT', 'ACCEPT WITH CONDITIONS', 'REJECT'] as Disposition[]).includes(d as Disposition)
      ? (d as Disposition)
      : 'REJECT';
    rationale = String(synthesis.rationale ?? '');
    // deterministic guard: a critical finding can never be ACCEPT
    if (findings.some((f) => f.severity === 'critical') && disposition === 'ACCEPT') {
      disposition = 'REJECT';
      rationale = `overridden to REJECT: critical finding present. ${rationale}`;
    }
    // incomplete synthesis -> never ACCEPT
    if (!synthesis) {
      disposition = 'REJECT';
    }
  }

  const coverageLimitations = [
    ...budget.gaps,
    ...(Array.isArray(synthesis?.coverage_limitations) ? synthesis.coverage_limitations.map(String) : []),
  ];
  const residualRisks = Array.isArray(synthesis?.residual_risks)
    ? synthesis.residual_risks.map(String)
    : ['review incomplete or evidence missing; see coverage limitations'];

  const report = renderReport({
    execId,
    now: deps.now(),
    owner,
    repo,
    pr,
    base: pr.baseSha,
    head: pr.headSha,
    modelName: deps.modelName,
    reviewerVersion: deps.reviewerVersion,
    provenance: deps.provenance,
    profile,
    compare,
    evidence,
    modelAssessments,
    findings,
    assessments,
    coverageLimitations,
    residualRisks,
    disposition,
    rationale,
    budget,
  });

  const manifest = buildManifest({
    execId,
    now: deps.now(),
    owner,
    repo,
    pr,
    base: pr.baseSha,
    head: pr.headSha,
    modelName: deps.modelName,
    reviewerVersion: deps.reviewerVersion,
    provenance: deps.provenance,
    profile,
    evidence,
    findings,
    coverageLimitations,
    disposition,
    rationale,
    budget,
    report,
  });

  return { report, manifest, reportSha256: manifest.reportSha256 as string, disposition, budget, evidence, findings };
};
