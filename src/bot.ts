import { Context, Probot } from 'probot';
import { minimatch } from 'minimatch';

import { MistralChat, MistralNoTextError, Review } from './mistral.js';
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
  if (!hunkHeader || typeof hunkHeader !== 'string') {
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
  bodyComments: string[],
  fileNotes: string[] = []
) => {
  const heading =
    hasInlineComments || bodyComments.length || fileNotes.length
      ? 'Code review by Mistral'
      : 'LGTM 👍';
  const notes = fileNotes.length
    ? [`**Files not reviewed:**\n${fileNotes.map((n) => `- ${n}`).join('\n')}`]
    : [];
  return [heading, ...bodyComments, ...notes, REVIEW_MARKER].join('\n\n');
};

export interface InlineReviewComment {
  path: string;
  body: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Final guard before createReview: drops any comment whose body (or location)
 * is not valid, so GitHub cannot reject the review with HTTP 422.
 */
export const sanitizeReviewComments = (
  comments: unknown[]
): InlineReviewComment[] =>
  comments.filter((c): c is InlineReviewComment => {
    const comment = c as Partial<InlineReviewComment> | null;
    const valid =
      !!comment &&
      isNonEmptyString(comment.body) &&
      isNonEmptyString(comment.path) &&
      Number.isInteger(comment.line) &&
      (comment.line as number) > 0 &&
      (comment.side === 'RIGHT' || comment.side === 'LEFT');
    if (!valid) {
      log.error('dropping invalid inline review comment');
    }
    return valid;
  });

export const sanitizeReviewBody = (body: unknown): string =>
  isNonEmptyString(body) ? body : `Code review by Mistral\n\n${REVIEW_MARKER}`;

const escapeFilename = (filename: string) => filename.replace(/`/g, '\\`');

const describeFailure = (err: unknown) => {
  if (err instanceof MistralNoTextError) {
    return err.message;
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'MistralTimeoutError') {
    return (err as Error).message;
  }
  if (name === 'MistralHttpError') {
    return `Mistral API request failed with status ${(err as { status?: number }).status}`;
  }
  return 'review failed (see the action log)';
};

export interface ReviewableFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface FileReviewResult {
  comments: InlineReviewComment[];
  bodyComments: string[];
  fileNotes: string[];
  attempted: number;
  failed: number;
}

/**
 * Reviews each file independently: a failure (HTTP error, timeout, no text,
 * parse error) is recorded as a note and does not lose the other files.
 */
export const reviewFiles = async (
  chat: { codeReview: (patch: string) => Promise<Review[] | Review> },
  files: ReviewableFile[],
  maxPatchLength: number = MAX_PATCH_COUNT
): Promise<FileReviewResult> => {
  const result: FileReviewResult = {
    comments: [],
    bodyComments: [],
    fileNotes: [],
    attempted: 0,
    failed: 0,
  };

  for (const file of files) {
    const patch = file.patch || '';

    if (file.status !== 'modified' && file.status !== 'added') {
      continue;
    }

    if (!patch || patch.length > maxPatchLength) {
      log.info(`${file.filename} skipped caused by its diff is too large`);
      continue;
    }

    result.attempted++;
    const filename = escapeFilename(file.filename);
    try {
      const res = await chat.codeReview(patch);
      // res can be a single review or an array of reviews (one for each hunk)
      const reviews = Array.isArray(res) ? res : [res];

      for (const review of reviews) {
        if (!review || typeof review !== 'object' || review.lgtm) {
          continue;
        }
        if (!isNonEmptyString(review.review_comment)) {
          if (review.review_comment) {
            log.error(`dropping non-string review comment for ${file.filename}`);
          }
          continue;
        }
        const inlineComment = review.raw
          ? null
          : createInlineReviewComment(
              file.filename,
              review.review_comment,
              review.hunk_header,
              patch
            );
        if (!inlineComment) {
          result.bodyComments.push(
            `**File:** \`${filename}\`\n\n${review.review_comment}`
          );
          if (!review.raw) {
            log.error(
              `Failed to locate inline review comment: ${review.hunk_header || 'missing hunk header'}`
            );
          }
          continue;
        }

        result.comments.push(inlineComment);
      }
    } catch (e) {
      result.failed++;
      result.fileNotes.push(`\`${filename}\`: ${describeFailure(e)}`);
      log.info(`review ${file.filename} failed`, e);
    }
  }

  return result;
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

      log.info(
        `reviewing ${changedFiles.length} file(s) with model ${chat.model} at head ${pull_request.head.sha}`
      );

      console.time('mistral cost');

      const result = await reviewFiles(chat, changedFiles);
      const comments = sanitizeReviewComments(result.comments);
      const body = sanitizeReviewBody(
        createReviewBody(
          comments.length > 0,
          result.bodyComments,
          result.fileNotes
        )
      );

      try {
        await context.octokit.pulls.createReview({
          repo: repo.repo,
          owner: repo.owner,
          pull_number: context.pullRequest().pull_number,
          body,
          event: 'COMMENT',
          commit_id: context.payload.pull_request.head.sha,
          comments,
        });
      } catch (e) {
        log.info(`Failed to create review`, e);
        throw e;
      }

      if (result.attempted > 0 && result.failed === result.attempted) {
        throw new Error(
          `All ${result.attempted} file review(s) failed; see the review body and log`
        );
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
