# MCRB Gate Review — Consumer Integration Contract

Everything a read-only consumer session needs to invoke the enhanced Mistral Code Review Bot.

- **Repository:** `chrismarchant/mistral-code-review-bot`
- **Branch (enhancement):** `feature/mcrb-01-gate-review`
- **Deployed/exact version for this contract:** commit SHA on that branch at PR creation (see PR); report/manifest schemas are versioned independently (`mcrb.gate.report.v1`, `mcrb.gate.manifest.v1`, `mcrb.gate.profile.v1`).

## 1. Invocation

Build once, then run the CLI:

```bash
npm ci
npm run build
npm run gate-review -- \
  --owner ORG --repo REPO --pr 123 \
  --base <baseline-sha> --head <candidate-sha> \
  [--profile profiles/gate-review.v1.json] \
  [--out gate-review-output/<exec-id>] \
  [--publish]
```

Parameters may also come from env: `GATE_OWNER`, `GATE_REPO`, `GATE_PR`, `GATE_BASE`, `GATE_HEAD`.

## 2. Required parameters

| Param | Meaning |
| --- | --- |
| `--owner`, `--repo` | target repository |
| `--pr` | pull request number |
| `--base` | baseline SHA (PR base) |
| `--head` | candidate SHA; **must equal the current PR head** or the run aborts (exit 3) |
| `--profile` | optional versioned review profile JSON (default: built-in `profiles/gate-review.v1.json`) |
| `--out` | output directory (default `gate-review-output/<exec-id>/`) |
| `--publish` | optional second operation: publish the report summary to GitHub as a COMMENT review |

## 3. Authentication prerequisites

| Env var | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | GitHub token (PAT fine-grained or Actions token). Read-only scopes for review: `contents: read`, `pull-requests: read`, `checks: read`, `actions: read`, `security-events: read` (optional), `dependency-graph: read` (optional), `metadata: read`. Publication additionally needs `pull-requests: write`. |
| `MISTRAL_API_KEY` | Mistral API key (`https://console.mistral.ai`) |
| `MODEL` | optional, default `mistral-large-latest` |
| `GITHUB_APP_SLUG` | optional, recorded in provenance when running as a GitHub App |

Never place tokens in artifacts; the bot writes none of them into report/manifest.

## 4. Review profile

Location: `profiles/gate-review.v1.json` (override with `--profile`). Schema `mcrb.gate.profile.v1`. Fields: `limits.maxFiles`, `maxContextCharsPerFile`, `maxContextCharsTotal`, `maxModelCalls`, `maxPromptCharsPerCall`, `tokenBudget`, `requestTimeoutMs`, `retryAttempts`, `chunkMaxLines`, plus `pricesPerMillionTokens` for cost estimation.

## 5. Outputs

- `<out>/report.md` — Markdown report, schema `mcrb.gate.report.v1`
- `<out>/manifest.json` — machine-readable evidence manifest, schema `mcrb.gate.manifest.v1`, includes `reportSha256` (SHA256 of the exact report bytes) and `reportFile`

Verify independently: `sha256sum report.md` must equal `manifest.reportSha256`.

## 6. Expected execution behaviour

1. Verifies candidate SHA == PR head (draft PRs supported, never modified).
2. GETs the full `base...head` compare diff (records GitHub's 300-file truncation as a coverage gap).
3. GETs source context at the candidate SHA, bounded by the profile; classifies binary/deleted/renamed/truncated-patch files explicitly.
4. GETs CI check-runs + workflow runs, dependency SBOM/lockfile, Dependabot/vulnerability-alert evidence; failures become `unresolved` evidence, never a pass.
5. Makes up to `maxModelCalls` Mistral calls (diff overview → per-category → synthesis) under the token budget with per-request timeout and retries.
6. Writes report + manifest; prints disposition, SHA256, call/token/cost usage.

## 7. Failure / exit codes

| Code | Meaning |
| --- | --- |
| 0 | review completed (check `disposition` in manifest: ACCEPT / ACCEPT WITH CONDITIONS / REJECT) |
| 1 | unexpected error (incl. Mistral API failure after retries) |
| 2 | usage error / missing inputs |
| 3 | candidate SHA ≠ PR head (`ShaMismatchError`) |
| 4 | reserved for auth failures |

Budget exhaustion is **not** an error: it is recorded as a coverage gap and the disposition is forced away from ACCEPT (REJECT when synthesis could not run).

## 8. Publication procedure (optional, explicit)

`--publish` (or calling `publishGateReview`) revalidates the PR head SHA, checks for an existing review containing the execution marker `<!-- mcrb-gate-review exec:<id> head:<sha> sha256:<digest> -->` (retry-safe, no duplicates), then creates a review with `event: COMMENT` bound to `commit_id = candidate SHA`. It **never** issues APPROVE. The body embeds the disposition, execution id, commit and report SHA256.

## 9. Mode A compatibility

Inline event-driven review (GitHub Action / Probot app on `pull_request` opened/synchronize) is unchanged: same env vars, same behaviour, all pre-existing tests still pass.
