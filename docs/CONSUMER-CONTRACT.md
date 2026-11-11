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
| `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | **preferred for production.** When both are set, the CLI mints an app JWT (RS256), resolves the app installation for the target repo, and exchanges it for an installation token — the review then runs as the App's Bot and the manifest records `reviewerIdentity: {type: "Bot", slug: …}`. |
| `MISTRAL_API_KEY` | Mistral API key (`https://console.mistral.ai`) |
| `MODEL` | optional, default `mistral-large-latest` |
| `GITHUB_APP_SLUG` | optional fallback label for provenance when the token cannot self-describe |

**GitHub App setup (one-time, manual):** GitHub no longer supports headless App *creation* via the REST API (`POST /user/apps` removed; the app-manifest flow is scoped to a browser session — verified: both return 404 with an OAuth token). Register the app once at `https://github.com/settings/apps/new` (or `https://github.com/organizations/<org>/settings/apps/new`), grant read-only permissions (`contents`, `pull-requests`, `checks`, `actions`, `metadata`; add `security-events`/`dependency-graph` optionally; `pull-requests: write` only if you intend to `--publish`), install it on the target repo, then set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the PEM) in the environment. The bot mints short-lived JWTs itself; the private key never enters any artifact.

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
5. Makes up to `maxModelCalls` Mistral calls (diff overview → per-category → synthesis) under the token budget with per-request timeout and retries. One call and its estimated tokens are always reserved for synthesis, which receives the earlier assessments as delimited data; when the budget is too tight, the preliminary steps are skipped and listed as coverage limitations (so ACCEPT is not possible) rather than starving synthesis. When `maxFiles` is smaller than the diff, source context is fetched for source/config files first, then docs/examples, then generated bundles and lockfiles.
6. Writes report + manifest; prints disposition, SHA256, call/token/cost usage.

**Disposition guards (deterministic, applied after model synthesis):**
- any `critical` finding ⇒ REJECT (overrides the model)
- synthesis missing/malformed ⇒ REJECT (incomplete reviews never pass)
- any unresolved evidence item or coverage gap (omitted patches, GitHub 300-file cap, context-budget skips, non-`ahead` compare status) ⇒ ACCEPT is downgraded to ACCEPT WITH CONDITIONS, never unconditional

**Reviewer identity:** the CLI resolves the token's identity live (`GET /user` → User; `GET /app` with app JWT → App Bot; `GET /installation` fallback for installation tokens) and records it in `manifest.execution.reviewerIdentity` with an independence note: the bot — not its implementation session — is the reviewer. With `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` set, the slug is taken from the app-auth flow itself.

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
