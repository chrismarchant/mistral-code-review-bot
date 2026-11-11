import { EvidenceItem, GateProfile, ShaMismatchError } from './types.js';

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  state: string;
  headSha: string;
  baseSha: string;
  htmlUrl: string;
  user: string;
}

export interface CompareFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CompareResult {
  status: string;
  aheadBy: number;
  totalCommits: number;
  files: CompareFile[];
  /** true when GitHub truncated the file list (>300 files) */
  filesTruncated: boolean;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const GITHUB_API = 'https://api.github.com';
const COMPARE_FILES_LIMIT = 300; // GitHub compare API hard limit

/**
 * Read-only GitHub evidence collector. Every request is a GET; the class
 * exposes no mutating operation. Inject `fetchImpl` for deterministic tests.
 */
export class GitHubEvidence {
  private calls: Array<{ method: string; url: string }> = [];

  constructor(
    private opts: {
      owner: string;
      repo: string;
      pr: number;
      base: string;
      head: string;
      token: string;
      profile: GateProfile;
      fetchImpl?: FetchLike;
    }
  ) {}

  /** test/inspection hook: every API call made so far */
  get requestLog(): ReadonlyArray<{ method: string; url: string }> {
    return this.calls;
  }

  private api = async (path: string, method = 'GET'): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }> => {
    const url = `${GITHUB_API}${path}`;
    this.calls.push({ method, url });
    const f =
      this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    return f(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(this.opts.profile.limits.requestTimeoutMs),
    });
  };

  private getJson = async (path: string): Promise<unknown> => {
    const res = await this.api(path);
    if (!res.ok) {
      throw new Error(`GitHub API ${path} -> ${res.status}: ${await res.text()}`);
    }
    return res.json();
  };

  getPr = async (): Promise<PrInfo> => {
    const d = (await this.getJson(
      `/repos/${this.opts.owner}/${this.opts.repo}/pulls/${this.opts.pr}`
    )) as Record<string, any>;
    return {
      number: d.number,
      title: d.title ?? '',
      body: d.body ?? '',
      draft: Boolean(d.draft),
      state: d.state,
      headSha: d.head?.sha,
      baseSha: d.base?.sha,
      htmlUrl: d.html_url,
      user: d.user?.login ?? 'unknown',
    };
  };

  /** Verify the supplied candidate SHA matches the current PR head. */
  verifyHead = async (): Promise<PrInfo> => {
    const pr = await this.getPr();
    if (pr.headSha !== this.opts.head) {
      throw new ShaMismatchError(this.opts.head, pr.headSha);
    }
    return pr;
  };

  /** Complete baseline..candidate diff. Handles GitHub's 300-file cap. */
  getCompare = async (): Promise<CompareResult> => {
    const d = (await this.getJson(
      `/repos/${this.opts.owner}/${this.opts.repo}/compare/${this.opts.base}...${this.opts.head}`
    )) as Record<string, any>;
    const files: CompareFile[] = (d.files ?? []).map((f: Record<string, any>) => ({
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch,
    }));
    return {
      status: d.status,
      aheadBy: d.ahead_by ?? 0,
      totalCommits: d.total_commits ?? 0,
      files,
      filesTruncated: files.length >= COMPARE_FILES_LIMIT,
    };
  };

  /** Raw file content at a ref (base64 decoded). Throws on error. */
  getFileContent = async (
    path: string,
    ref: string
  ): Promise<{ content: string; size: number; encoding: string }> => {
    const res = await this.api(
      `/repos/${this.opts.owner}/${this.opts.repo}/contents/${encodeURIComponent(
        path
      )}?ref=${ref}`,
      'GET'
    );
    if (!res.ok) {
      throw new Error(`contents ${path}@${ref} -> ${res.status}`);
    }
    const d = (await res.json()) as Record<string, any>;
    if (d.type !== 'file' || d.encoding !== 'base64') {
      throw new Error(`contents ${path}@${ref} is not a base64 file`);
    }
    const content = Buffer.from(d.content ?? '', 'base64').toString('utf8');
    return { content, size: d.size ?? content.length, encoding: d.encoding };
  };

  /** CI evidence for the candidate head: check-runs + workflow runs. */
  getCiEvidence = async (): Promise<EvidenceItem[]> => {
    const out: EvidenceItem[] = [];
    const head = this.opts.head;
    try {
      const d = (await this.getJson(
        `/repos/${this.opts.owner}/${this.opts.repo}/commits/${head}/check-runs?per_page=100`
      )) as Record<string, any>;
      const runs = d.check_runs ?? [];
      const summary = runs
        .map(
          (r: Record<string, any>) =>
            `${r.name}: ${r.status}/${r.conclusion ?? 'pending'}`
        )
        .join('; ');
      out.push({
        id: 'ci-check-runs',
        category: 'ci',
        kind: 'verified',
        ref: `GET /repos/{owner}/{repo}/commits/${head}/check-runs`,
        summary: `${runs.length} check run(s) for ${head}: ${summary || 'none'}`,
      });
    } catch (e) {
      out.push({
        id: 'ci-check-runs',
        category: 'ci',
        kind: 'unresolved',
        ref: `GET /repos/{owner}/{repo}/commits/${head}/check-runs`,
        summary: `check-runs unavailable: ${(e as Error).message}`,
      });
    }
    try {
      const d = (await this.getJson(
        `/repos/${this.opts.owner}/${this.opts.repo}/actions/runs?head_sha=${head}&per_page=20`
      )) as Record<string, any>;
      const runs = d.workflow_runs ?? [];
      const summary = runs
        .map(
          (r: Record<string, any>) =>
            `${r.name} (${r.workflow_id}): ${r.status}/${r.conclusion ?? 'pending'}`
        )
        .join('; ');
      out.push({
        id: 'ci-workflow-runs',
        category: 'ci',
        kind: 'verified',
        ref: `GET /repos/{owner}/{repo}/actions/runs?head_sha=${head}`,
        summary: `${runs.length} workflow run(s) for ${head}: ${summary || 'none'}`,
      });
    } catch (e) {
      out.push({
        id: 'ci-workflow-runs',
        category: 'ci',
        kind: 'unresolved',
        ref: `GET /repos/{owner}/{repo}/actions/runs?head_sha=${head}`,
        summary: `workflow runs unavailable: ${(e as Error).message}`,
      });
    }
    return out;
  };

  /** Dependency evidence: SBOM if available, else lockfile inventory. */
  getDependencyEvidence = async (): Promise<EvidenceItem[]> => {
    const out: EvidenceItem[] = [];
    const { owner, repo } = this.opts;
    try {
      const d = (await this.getJson(
        `/repos/${owner}/${repo}/dependency-graph/sbom`
      )) as Record<string, any>;
      const pkgs: Array<Record<string, any>> = d.sbom?.packages ?? [];
      out.push({
        id: 'dep-sbom',
        category: 'dependency',
        kind: 'verified',
        ref: `GET /repos/{owner}/{repo}/dependency-graph/sbom`,
        summary: `SBOM lists ${pkgs.length} package(s)`,
        content: JSON.stringify(
          pkgs.map((p) => ({ name: p.name, version: p.versionInfo })).slice(0, 500)
        ),
      });
    } catch (e) {
      out.push({
        id: 'dep-sbom',
        category: 'dependency',
        kind: 'unresolved',
        ref: `GET /repos/{owner}/{repo}/dependency-graph/sbom`,
        summary: `SBOM unavailable (needs dependency-graph read): ${(e as Error).message}`,
      });
      // fallback: lockfiles at head
      for (const lock of [
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'requirements.txt',
        'go.mod',
        'Cargo.lock',
      ]) {
        try {
          const f = await this.getFileContent(lock, this.opts.head);
          out.push({
            id: `dep-lock-${lock}`,
            category: 'dependency',
            kind: 'verified',
            ref: `GET /repos/{owner}/{repo}/contents/${lock}?ref=${this.opts.head}`,
            summary: `${lock} (${f.size} bytes) at ${this.opts.head}`,
            content: f.content.slice(0, 20000),
            truncated: f.content.length > 20000,
          });
          break; // one lockfile is enough for the initial implementation
        } catch {
          // try next lockfile
        }
      }
    }
    return out;
  };

  /** Security evidence: Dependabot alerts + vulnerability-alerts flag. */
  getSecurityEvidence = async (): Promise<EvidenceItem[]> => {
    const out: EvidenceItem[] = [];
    const { owner, repo } = this.opts;
    try {
      const res = await this.api(
        `/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=100`
      );
      if (res.ok) {
        const alerts = (await res.json()) as Array<Record<string, any>>;
        out.push({
          id: 'sec-dependabot-open',
          category: 'security',
          kind: 'verified',
          ref: `GET /repos/{owner}/{repo}/dependabot/alerts?state=open`,
          summary: `${alerts.length} open Dependabot alert(s)`,
          content: JSON.stringify(
            alerts.map((a) => ({
              package: a.dependency?.package?.name,
              severity: a.security_advisory?.severity,
              summary: a.security_advisory?.summary,
            }))
          ),
        });
      } else {
        throw new Error(`status ${res.status}`);
      }
    } catch (e) {
      out.push({
        id: 'sec-dependabot-open',
        category: 'security',
        kind: 'unresolved',
        ref: `GET /repos/{owner}/{repo}/dependabot/alerts`,
        summary: `Dependabot alerts unavailable (needs security-events read): ${(e as Error).message}`,
      });
    }
    try {
      const res = await this.api(`/repos/${owner}/${repo}/vulnerability-alerts`);
      out.push({
        id: 'sec-vulnerability-alerts-enabled',
        category: 'security',
        kind: 'verified',
        ref: `GET /repos/{owner}/{repo}/vulnerability-alerts`,
        summary:
          res.status === 204
            ? 'repository vulnerability alerts are ENABLED'
            : `vulnerability alerts not enabled (status ${res.status})`,
      });
    } catch (e) {
      out.push({
        id: 'sec-vulnerability-alerts-enabled',
        category: 'security',
        kind: 'unresolved',
        ref: `GET /repos/{owner}/{repo}/vulnerability-alerts`,
        summary: `could not check vulnerability-alerts: ${(e as Error).message}`,
      });
    }
    return out;
  };

  /** Existing reviews (used for duplicate-publication prevention). */
  listReviews = async (): Promise<Array<{ id: number; body?: string; user?: string }>> => {
    const d = (await this.getJson(
      `/repos/${this.opts.owner}/${this.opts.repo}/pulls/${this.opts.pr}/reviews?per_page=100`
    )) as Array<Record<string, any>>;
    return d.map((r) => ({ id: r.id, body: r.body, user: r.user?.login }));
  };

  /** Publication (only invoked explicitly by --publish). Always event=COMMENT, never APPROVE. */
  postReview = async (
    body: string,
    commitId: string
  ): Promise<{ id: number }> => {
    const url = `${GITHUB_API}/repos/${this.opts.owner}/${this.opts.repo}/pulls/${this.opts.pr}/reviews`;
    this.calls.push({ method: 'POST', url });
    const f = this.opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const res = await f(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: 'COMMENT', // never APPROVE
        commit_id: commitId,
        body,
      }),
      signal: AbortSignal.timeout(this.opts.profile.limits.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`createReview -> ${res.status}: ${await res.text()}`);
    }
    const d = (await res.json()) as Record<string, any>;
    return { id: d.id };
  };
}
