# Mistral Code Review Bot

🦙 A code review bot for GitHub pull requests, powered by [Mistral AI](https://mistral.ai) models.

This is a Mistral-powered re-implementation of [anc95/ChatGPT-CodeReview](https://github.com/anc95/ChatGPT-CodeReview), benchmarked against it. The workflow is the same: when a PR is opened or updated, each changed file's diff is sent to a Mistral model, and the review is posted back as inline comments on the changed lines (plus an overall review body).

## How it works

1. On `pull_request` `opened` / `synchronize`, the bot lists the PR's changed files (on `synchronize` it compares against the commit of its previous review, so only newly pushed changes are re-reviewed).
2. Files are filtered by `IGNORE_PATTERNS` / `INCLUDE_PATTERNS` (glob or regex) and `MAX_PATCH_LENGTH`.
3. Each file's patch is sent to the Mistral API (`POST https://api.mistral.ai/v1/chat/completions`, JSON mode) with a prompt asking for per-hunk feedback in a strict JSON format:
   ```json
   { "reviews": [{ "hunk_header": "@@ -10,5 +10,7 @@", "lgtm": false, "review_comment": "..." }] }
   ```
4. Each `hunk_header` is mapped to a line in the diff and posted as an inline review comment via `pulls.createReview`. Reviews whose hunk can't be located fall back to the PR review body. If nothing is found, the bot posts `LGTM 👍`.

## Using the GitHub Action

1. Create a Mistral API key at <https://console.mistral.ai> and add it to your repo's **Actions secrets** as `MISTRAL_API_KEY` (or as a repo **variable** named `MISTRAL_API_KEY`).
2. Create `.github/workflows/cr.yml`:

```yaml
name: Code Review

permissions:
  contents: read
  pull-requests: write

on:
  pull_request:
    types: [opened, reopened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: chrismarchant/mistral-code-review-bot@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
          MODEL: mistral-large-latest   # optional; e.g. codestral-latest, devstral-latest, mistral-small-latest
          # LANGUAGE: English            # optional; language of the review comments
          # PROMPT: ...                  # optional; custom review instructions
          # MAX_PATCH_LENGTH: 10000      # optional; skip files whose diff exceeds this
          # IGNORE_PATTERNS: /node_modules/**/*,*.md
          # INCLUDE_PATTERNS: *.js,*.ts
          # TARGET_LABEL: ai-review      # optional; only run when this label is attached
```

After a `git push` that updates the PR, the bot re-reviews only the newly changed files.

## Self-hosting (GitHub App)

1. Create a GitHub App (see <https://probot.github.io/docs/github-app/>), subscribe it to `pull_request` events, and install it on your repos.
2. Copy `.env.example` to `.env` and fill in `MISTRAL_API_KEY`, `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`.
3. Install deps and run:

```bash
npm install
npm run build
npm start
```

### Docker

```bash
docker build -t mistral-cr-bot .
docker run --env-file .env mistral-cr-bot
```

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `MISTRAL_API_KEY` | — | Mistral API key (required) |
| `MODEL` | `mistral-large-latest` | Any Mistral model (`codestral-latest`, `devstral-latest`, `mistral-small-latest`, ...) |
| `MISTRAL_API_ENDPOINT` | `https://api.mistral.ai/v1` | Override for proxies / OpenAI-compatible gateways |
| `LANGUAGE` | — | Language for the review comments |
| `PROMPT` | built-in | Custom review instructions prepended to the diff |
| `temperature` / `top_p` / `max_tokens` | `1` / `1` / — | Sampling parameters |
| `MAX_PATCH_LENGTH` | unlimited | Skip files whose diff is larger than this |
| `IGNORE_PATTERNS` / `INCLUDE_PATTERNS` | — | Comma-separated glob/regex file filters |
| `TARGET_LABEL` | — | Only review PRs with this label |

## Development

```bash
npm install
npm test    # type-checks, builds, and runs unit tests (node --test)
npm run build:action   # bundles the GitHub Action into action/
```

## License

ISC
