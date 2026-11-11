# Gate Review Report — octo/demo PR #7

- schema: `mcrb.gate.report.v1`
- execution id: `example-exec-0001`
- generated at (UTC): 2026-01-01T00:00:00.000Z
- repository: octo/demo
- PR: #7 "Refactor auth module" (https://github.com/octo/demo/pull/7) — state=open, draft=false
- baseline SHA: `1111111111111111111111111111111111111111`
- candidate SHA: `2222222222222222222222222222222222222222` (verified equal to PR head)
- model: `mistral-large-latest`
- reviewer implementation: mistral-code-review-bot gate-review v1.0.0
- provenance: {"tokenType":"GITHUB_TOKEN","invokedVia":"cli (example, mocked APIs)"}
- profile: `mcrb.gate.profile.v1` — {"maxFiles":50,"maxContextCharsPerFile":20000,"maxContextCharsTotal":200000,"maxModelCalls":8,"maxPromptCharsPerCall":120000,"tokenBudget":400000,"requestTimeoutMs":120000,"retryAttempts":3,"chunkMaxLines":200}

## Scope and evidence inventory

Compare 111111111111...222222222222: status=ahead, commits=3, files=1.

| id | category | kind | reference | summary |
| --- | --- | --- | --- | --- |
| pr-meta | pr | verified | GET /repos/{owner}/{repo}/pulls/7 | PR #7 "Refactor auth module" by dev1; state=open; draft=false; head=2222222222222222222222222222222222222222; base=1111111111111111111111111111111111111111 |
| diff-summary | diff | verified | GET /repos/octo/demo/compare/1111111111111111111111111111111111111111...2222222222222222222222222222222222222222 | compare 1111111111111111111111111111111111111111...2222222222222222222222222222222222222222: status=ahead, ahead_by=3, commits=3, files=1 |
| src:src/auth.ts | source | verified | GET /repos/{owner}/{repo}/contents/src/auth.ts?ref=2222222222222222222222222222222222222222 | src/auth.ts at 2222222222222222222222222222222222222222 (120 bytes) |
| ci-check-runs | ci | verified | GET /repos/{owner}/{repo}/commits/2222222222222222222222222222222222222222/check-runs | 2 check run(s) for 2222222222222222222222222222222222222222: build: completed/success; test: completed/failure |
| ci-workflow-runs | ci | verified | GET /repos/{owner}/{repo}/actions/runs?head_sha=2222222222222222222222222222222222222222 | 1 workflow run(s) for 2222222222222222222222222222222222222222: CI (1): completed/failure |
| dep-sbom | dependency | unresolved | GET /repos/{owner}/{repo}/dependency-graph/sbom | SBOM unavailable (needs dependency-graph read): GitHub API /repos/octo/demo/dependency-graph/sbom -> 404: {"message":"Not Found"} |
| dep-lock-package-lock.json | dependency | verified | GET /repos/{owner}/{repo}/contents/package-lock.json?ref=2222222222222222222222222222222222222222 | package-lock.json (120 bytes) at 2222222222222222222222222222222222222222 |
| sec-dependabot-open | security | verified | GET /repos/{owner}/{repo}/dependabot/alerts?state=open | 1 open Dependabot alert(s) |
| sec-vulnerability-alerts-enabled | security | verified | GET /repos/{owner}/{repo}/vulnerability-alerts | repository vulnerability alerts are ENABLED |

Model calls used: 5/8; tokens: 24500/400000 (est. cost $0.0700); files inspected: 1; context chars: 37.

## Findings

### F-1 — **HIGH** Open high-severity dependency advisory (lodash)
- category: security
- detail: Upgrade lodash to a patched version before merge.
- evidence: sec-dependabot-open

### F-2 — **MEDIUM** CI failing on candidate head
- category: regression
- detail: check-runs report test failure for the candidate SHA.
- evidence: ci-check-runs

## Assessments

- security: One open high-severity Dependabot advisory affecting a direct dependency.
- dependency: package-lock.json present; SBOM endpoint unavailable (permission).
- compatibility: Internal refactor; no public API changes detected in the diff.
- regression: CI red on candidate head (test check failed).

## Coverage limitations

- SBOM unavailable; lockfile used instead

## Residual risks

- Manual verification of token edge cases recommended

## Disposition

**ACCEPT WITH CONDITIONS**

Acceptable once the lodash advisory is addressed and CI is green.

---
This report was generated locally by the Mistral Code Review Bot in read-only mode. It is not a formally published GitHub review unless published via the explicit `--publish` operation.
