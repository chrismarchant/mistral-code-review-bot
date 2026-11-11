import { GitHubEvidence } from './github.js';

export const publicationMarker = (
  execId: string,
  head: string,
  sha256: string
): string => `<!-- mcrb-gate-review exec:${execId} head:${head} sha256:${sha256} -->`;

export interface PublishResult {
  published: boolean;
  reason?: string;
  reviewId?: number;
}

/**
 * Optional, explicitly invoked publication of a completed gate review.
 * - revalidates the PR head SHA before publishing
 * - never issues APPROVE (event is always COMMENT)
 * - binds the review to the exact candidate commit
 * - skips if a review with the same execution marker already exists (retry-safe)
 */
export const publishGateReview = async (deps: {
  github: GitHubEvidence;
  pr: number;
  head: string;
  execId: string;
  reportSha256: string;
  disposition: string;
  summary: string;
}): Promise<PublishResult> => {
  const { github, head, execId, reportSha256 } = deps;

  // revalidate head SHA immediately before publishing
  await github.verifyHead();

  const marker = publicationMarker(execId, head, reportSha256);

  // duplicate prevention: same execution marker already on the PR
  const existing = await github.listReviews();
  if (existing.some((r) => r.body?.includes(`mcrb-gate-review exec:${execId}`))) {
    return { published: false, reason: 'duplicate: a review for this execution id already exists' };
  }

  const body = [
    `## Gate Review — ${deps.disposition}`,
    '',
    deps.summary,
    '',
    `- execution id: \`${execId}\``,
    `- candidate commit: \`${head}\` (revalidated at publish time)`,
    `- report SHA256: \`${reportSha256}\``,
    '',
    'Full report and machine-readable evidence manifest are local artifacts of the review execution (see repository `examples/` for schema).',
    'Published as COMMENT only; this bot never issues APPROVE.',
    marker,
  ].join('\n');

  const { id } = await github.postReview(body, head);
  return { published: true, reviewId: id };
};
