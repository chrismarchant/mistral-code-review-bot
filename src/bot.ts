import { Context, Probot } from 'probot';
import { minimatch } from 'minimatch';

import { MistralChat } from './mistral.js';
import type { Review } from './mistral.js';
import log from './log.js';

const MISTRAL_API_KEY = 'MISTRAL_API_KEY';
const COMPARE_FILES_LIMIT = 300;
const REVIEW_MARKER = '<!-- mistral-code-review -->';
const MAX_PATCH_COUNT = process.env.MAX_PATCH_LENGTH
  ? +process.env.MAX_PATCH_LENGTH
  : Infinity;

type PullRequestContext = Context<
  'pull_request.opened' | 'pull_request.synchronize'
>;

export const parseHunkHeader = (hunkHeader?: string) => {
  if (!hunkHeader) {
    return null;
  }

  const match = hunkHeader
    .trim()
    .match(/^@@\s+-\s*(\d+)(?:,(\d+))?\s+\+\s*(\d+)(?:,(\d+))?\s+@@/);
  if (!match) {
    return null;
  }

  const [, oldStartValue, oldCountValue, newStartValue, newCountValue] = match;
  const oldStart = Number(oldStartValue);
  const oldCount = oldCountValue === undefined ? 1 : Number(oldCountValue);
  const newStart = Number(newStartValue);
  const newCount = newCountValue === undefined ? 1 : Number(newCountValue);

  return { oldStart, oldCount, newStart, newCount };
};

export const getReviewCommentLocation = (hunkHeader?: string) => {
  const range = parseHunkHeader(hunkHeader);
  if (!range) {
    return null;
  }

  const { oldStart, oldCount, newStart, newCount } = range;

  if (newCount > 0) {
    return {
      line: newStart + newCount - 1,
      side: 'RIGHT' as const,
    };
  }

  if (oldCount > 0) {
    return {
      line: oldStart + oldCount - 1,
      side: 'LEFT' as const,
    };
  }

  return null;
};

export const isHunkHeaderInPatch = (
  hunkHeader: string | undefined,
  patch: string
) => {
  const expectedRange = parseHunkHeader(hunkHeader);
  if (!expectedRange) {
    return false;
  }

  return patch.split('\n').some((line) => {
    if (!line.startsWith('@@')) {
      return false;
    }
    const actualRange = parseHunkHeader(line);
    return (
      actualRange?.oldStart === expectedRange.oldStart &&
      actualRange?.oldCount === expectedRange.oldCount &&
      actualRange?.newStart === expectedRange.newStart &&
      actualRange?.newCount === expectedRange.newCount
    );
  });
};

export const createInlineReviewComment = (
  path: string,
  body: string,
  hunkHeader: string | undefined,
  patch: string
) => {
  const location = getReviewCommentLocation(hunkHeader);
  if (!location || !isHunkHeaderInPatch(hunkHeader, patch)) {
    return null;
  }

  return {
    path,
    body,
    line: location.line,
    side: location.side,
  };
};

export const createReviewBody = (
  hasInlineComments: boolean,
  bodyComments: string[]
) => {
  const heading =
    hasInlineComments || bodyComments.length
      ? 'Code review by Mistral'
      : 'LGTM 👍';
  return [heading, ...bodyComments, REVIEW_MARKER].join('\n\n');
};

export const getChangedFiles = async (context: PullRequestContext) => {
  const repo = context.repo();
  const pullRequestFiles = await context.octokit.paginate(
    context.octokit.pulls.listFiles,
    {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: context.pullRequest().pull_number,
      per_page: 100,
    }
  );

  if (context.payload.action !== 'synchronize') {
    return pullRequestFiles;
  }

  let comparisonBase: string | undefined;

  try {
    const reviews = await context.octokit.paginate(
      context.octokit.pulls.listReviews,
      {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: context.pullRequest().pull_number,
        per_page: 100,
      }
    );
    const botReview = reviews
      .slice()
      .reverse()
      .find(
        (r) => r.user?.type === 'Bot' && r.body?.includes(REVIEW_MARKER)
      );

    if (botReview) {
      if (!botReview.commit_id) {
        return pullRequestFiles;
      }
      comparisonBase = botReview.commit_id;
    } else {
      const hasLegacyReview = reviews.some(
        (r) =>
          r.user?.type === 'Bot' &&
          r.body &&
          (r.body.startsWith('Code review by Mistral') ||
            r.body.startsWith('LGTM'))
      );
      if (hasLegacyReview) {
        return pullRequestFiles;
      }
    }
  } catch (err) {
    log.debug('failed to detect previous bot review', err);
    return pullRequestFiles;
  }

  if (!comparisonBase) {
    comparisonBase = context.payload.before;
  }

  if (!comparisonBase) {
    return pullRequestFiles;
  }

  try {
    const { data } = await context.octokit.repos.compareCommits({
      owner: repo.owner,
      repo: repo.repo,
      base: comparisonBase,
      head: context.payload.pull_request.head.sha,
    });

    if (data.status === 'identical') {
      return [];
    }

    if (data.status === 'ahead') {
      if (!data.files) {
        log.debug(
          'commit comparison omitted files; using the full pull request diff'
        );
        return pullRequestFiles;
      }

      const comparisonFiles = data.files;
      if (comparisonFiles.length >= COMPARE_FILES_LIMIT) {
        log.debug(
          'commit comparison reached the GitHub file limit; using the full pull request diff'
        );
        return pullRequestFiles;
      }

      const changedFilenames = new Set(
        comparisonFiles.map((file) => file.filename)
      );
      return pullRequestFiles.filter((file) =>
        changedFilenames.has(file.filename)
      );
    }

    log.debug(
      `commit comparison from ${comparisonBase} is ${data.status}; using the full pull request diff`
    );
  } catch (err) {
    log.debug(`failed to compare commits from ${comparisonBase}`, err);
  }

  return pullRequestFiles;
};

export const matchPatterns = (patterns: string[], path: string) => {
  return patterns.some((pattern) => {
    const p = pattern.trim();
    if (!p) return false;
    try {
      return minimatch(
        path,
        p.startsWith('/')
          ? '**' + p
          : p.startsWith('**')
            ? p
            : '**/' + p
      );
    } catch {
      // if the pattern is not a valid glob pattern, try to match it as a regular expression
      try {
        return new RegExp(p).test(path);
      } catch {
        return false;
      }
    }
  });
};

/**
 * Limits how many async tasks run at once (used to cap concurrent
 * Mistral API calls across all files/chunks of a PR).
 */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {
    this.limit = Math.max(1, limit);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * Splits a unified diff into chunks that each keep the file header
 * (diff --git / index / --- / +++ lines) followed by one or more whole
 * hunks, so every chunk is a valid self-contained patch and hunk headers
 * stay verbatim. Chunks are capped at maxLinesPerChunk hunk lines.
 */
export const splitPatchIntoChunks = (
  patch: string,
  maxLinesPerChunk = Math.max(1, +(process.env.CHUNK_MAX_LINES || 200))
): string[] => {
  const lines = patch.split('\n');
  const header: string[] = [];
  const hunkGroups: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = [line];
      hunkGroups.push(current);
    } else if (current) {
      current.push(line);
    } else {
      header.push(line);
    }
  }

  if (!hunkGroups.length) {
    return [patch];
  }

  const chunks: string[] = [];
  let buf = [...header];
  for (const group of hunkGroups) {
    if (
      buf.length > header.length &&
      buf.length - header.length >= maxLinesPerChunk
    ) {
      chunks.push(buf.join('\n'));
      buf = [...header];
    }
    buf.push(...group);
  }
  if (buf.length > header.length) {
    chunks.push(buf.join('\n'));
  }

  return chunks.length ? chunks : [patch];
};

export interface FileReviewResult {
  inline: Array<{
    path: string;
    body: string;
    line: number;
    side: 'RIGHT' | 'LEFT';
  }>;
  body: string[];
}

/**
 * Reviews a single file's patch: splits it into hunk chunks, sends each
 * chunk to the model under the shared concurrency limit, and maps the
 * returned reviews to inline comments (falling back to body comments).
 */
export const reviewFilePatch = async (
  chat: { codeReview: (patch: string) => Promise<Review[] | Review> },
  filename: string,
  patch: string,
  semaphore: Semaphore,
  maxLinesPerChunk?: number
): Promise<FileReviewResult> => {
  const chunks = splitPatchIntoChunks(patch, maxLinesPerChunk);
  const chunkResults = await Promise.all(
    chunks.map((chunk) => semaphore.run(() => chat.codeReview(chunk)))
  );
  const reviews = chunkResults.flatMap((r) => (Array.isArray(r) ? r : [r]));

  const inline: FileReviewResult['inline'] = [];
  const body: string[] = [];

  for (const review of reviews) {
    if (!review.lgtm && !!review.review_comment) {
      const inlineComment = createInlineReviewComment(
        filename,
        review.review_comment,
        review.hunk_header,
        patch
      );
      if (!inlineComment) {
        const safeName = filename.replace(/`/g, '\\`');
        body.push(`**File:** \`${safeName}\`\n\n${review.review_comment}`);
        log.error(
          `Failed to locate inline review comment: ${review.hunk_header || 'missing hunk header'}`
        );
        continue;
      }
      inline.push(inlineComment);
    }
  }

  return { inline, body };
};

export const robot = (app: Probot) => {
  if (process.env.GITHUB_ACTIONS === 'true') {
    app.onError(() => {
      process.exitCode = 1;
    });
  }

  const loadChat = async (context: Context) => {
    if (process.env.MISTRAL_API_KEY) {
      return new MistralChat(process.env.MISTRAL_API_KEY);
    }

    const repo = context.repo();

    try {
      const { data } = (await context.octokit.request(
        'GET /repos/{owner}/{repo}/actions/variables/{name}',
        {
          owner: repo.owner,
          repo: repo.repo,
          name: MISTRAL_API_KEY,
        }
      )) as { data: { value?: string } };

      if (!data?.value) {
        return null;
      }

      return new MistralChat(data.value);
    } catch {
      await context.octokit.issues.createComment({
        repo: repo.repo,
        owner: repo.owner,
        issue_number: context.pullRequest().pull_number,
        body: `Seems you are using me but didn't get MISTRAL_API_KEY set in Variables/Secrets for this repo. You could follow the [readme](https://github.com/chrismarchant/mistral-code-review-bot) for more information`,
      });
      return null;
    }
  };

  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async (context) => {
      const repo = context.repo();
      const chat = await loadChat(context);

      if (!chat) {
        log.info('Mistral chat initialized failed');
        return 'no chat';
      }

      const pull_request = context.payload.pull_request;

      log.debug('pull_request:', pull_request);

      if (pull_request.state === 'closed' || pull_request.locked) {
        log.info('invalid event payload');
        return 'invalid event payload';
      }

      const target_label = process.env.TARGET_LABEL;
      if (
        target_label &&
        (!pull_request.labels?.length ||
          pull_request.labels.every((label) => label.name !== target_label))
      ) {
        log.info('no target label attached');
        return 'no target label attached';
      }

      let changedFiles = await getChangedFiles(context);

      log.debug('changedFiles:', changedFiles);

      const ignoreList = (process.env.IGNORE || process.env.ignore || '')
        .split('\n')
        .filter((v) => v !== '');
      const ignorePatterns = (process.env.IGNORE_PATTERNS || '')
        .split(',')
        .filter((v) => Boolean(v.trim()));
      const includePatterns = (process.env.INCLUDE_PATTERNS || '')
        .split(',')
        .filter((v) => Boolean(v.trim()));

      log.debug('ignoreList:', ignoreList);
      log.debug('ignorePatterns:', ignorePatterns);
      log.debug('includePatterns:', includePatterns);

      changedFiles = changedFiles?.filter((file) => {
        const url = new URL(file.contents_url);
        const pathname = decodeURIComponent(url.pathname);
        // if includePatterns is not empty, only include files that match the pattern
        if (includePatterns.length) {
          return matchPatterns(includePatterns, pathname);
        }

        if (ignoreList.includes(file.filename)) {
          return false;
        }

        // if ignorePatterns is not empty, ignore files that match the pattern
        if (ignorePatterns.length) {
          return !matchPatterns(ignorePatterns, pathname);
        }

        return true;
      });

      if (!changedFiles?.length) {
        log.info('no change found');
        return 'no change';
      }

      console.time('mistral cost');

      const semaphore = new Semaphore(
        Math.max(1, +(process.env.MAX_CONCURRENCY || 5))
      );

      const reviewTasks = changedFiles
        .filter((file) => {
          const patch = file.patch || '';
          if (file.status !== 'modified' && file.status !== 'added') {
            return false;
          }
          if (!patch) {
            return false;
          }
          if (patch.length > MAX_PATCH_COUNT) {
            log.info(
              `${file.filename} skipped caused by its diff is too large`
            );
            return false;
          }
          return true;
        })
        .map((file) => async (): Promise<FileReviewResult> => {
          try {
            return await reviewFilePatch(
              chat,
              file.filename,
              file.patch || '',
              semaphore
            );
          } catch (e) {
            // one file failing must not fail the whole review
            log.info(`review ${file.filename} failed`, e);
            const safeName = file.filename.replace(/`/g, '\\`');
            return {
              inline: [],
              body: [
                `**File:** \`${safeName}\`\n\n⚠️ review failed: ${(e as Error).message}`,
              ],
            };
          }
        });

      // review all files concurrently (bounded by the semaphore)
      const results = await Promise.all(reviewTasks.map((task) => task()));
      const ress = results.flatMap((r) => r.inline);
      const bodyComments = results.flatMap((r) => r.body);
      try {
        await context.octokit.pulls.createReview({
          repo: repo.repo,
          owner: repo.owner,
          pull_number: context.pullRequest().pull_number,
          body: createReviewBody(ress.length > 0, bodyComments),
          event: 'COMMENT',
          commit_id: context.payload.pull_request.head.sha,
          comments: ress,
        });
      } catch (e) {
        log.info(`Failed to create review`, e);
        throw e;
      }

      console.timeEnd('mistral cost');
      log.info(
        'successfully reviewed',
        context.payload.pull_request.html_url
      );

      return 'success';
    }
  );
};
