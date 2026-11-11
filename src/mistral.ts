export interface Review {
  lgtm: boolean;
  review_comment: string;
  hunk_header?: string;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const DEFAULT_ENDPOINT = 'https://api.mistral.ai/v1';
const DEFAULT_MODEL = 'mistral-large-latest';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal client for the Mistral chat completions API
 * (OpenAI-compatible: POST {endpoint}/chat/completions).
 *
 * Each request gets its own timeout and is retried with exponential
 * backoff + jitter on 429/5xx and network errors.
 */
export class MistralChat {
  private apiKey: string;
  private endpoint: string;
  private fetchImpl: FetchLike;

  constructor(apiKey: string, fetchImpl?: FetchLike) {
    if (!apiKey) {
      throw new Error('Mistral API key is required');
    }
    this.apiKey = apiKey;
    this.endpoint = (
      process.env.MISTRAL_API_ENDPOINT || DEFAULT_ENDPOINT
    ).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private get model(): string {
    return process.env.MODEL || DEFAULT_MODEL;
  }

  private generatePrompt = (patch: string): string => {
    const answerLanguage = process.env.LANGUAGE
      ? `Answer me in ${process.env.LANGUAGE},`
      : '';

    const userPrompt = process.env.PROMPT ||
      'Please review the following code patch. Focus on potential bugs, risks, and improvement suggestions.';

    const jsonFormatRequirement =
      '\nProvide your feedback in a strict JSON format with the following structure:\n' +
      '{\n' +
      '  "reviews": [\n' +
      '    {\n' +
      '      "hunk_header": string, // The @@ hunk header (e.g., "@@ -10,5 +10,7 @@"), copied verbatim from the patch, optional\n' +
      '      "lgtm": boolean, // true if this hunk looks good, false if there are concerns\n' +
      '      "review_comment": string // Your detailed review comments for this hunk. Can use markdown syntax. Empty string if lgtm is true.\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      'Review each hunk (marked by @@) separately and provide feedback for hunks that need improvement.\n' +
      'Copy each hunk_header exactly as it appears in the patch.\n' +
      'Ensure your response is a valid JSON object with a reviews array.\n';

    return `${userPrompt}${jsonFormatRequirement} ${answerLanguage}:\n    ${patch}\n    `;
  };

  public codeReview = async (
    patch: string
  ): Promise<Review[] | Review> => {
    if (!patch) {
      return { lgtm: true, review_comment: '' };
    }

    console.time('code-review cost');
    const prompt = this.generatePrompt(patch);

    const temperature =
      process.env.temperature !== undefined ? +process.env.temperature : 1;
    const topP = process.env.top_p !== undefined ? +process.env.top_p : 1;
    const timeoutMs = +(process.env.REQUEST_TIMEOUT_MS || 120_000);
    const maxAttempts = Math.max(1, +(process.env.RETRY_ATTEMPTS || 3));
    const baseDelayMs = +(process.env.RETRY_BASE_DELAY_MS || 500);

    const body = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      top_p: topP,
      ...(process.env.max_tokens ? { max_tokens: +process.env.max_tokens } : {}),
      response_format: { type: 'json_object' },
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new ApiError(
            res.status,
            `Mistral API request failed with status ${res.status}: ${text}`
          );
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const content = data.choices?.[0]?.message?.content || '';

        console.timeEnd('code-review cost');

        if (content) {
          try {
            const json = JSON.parse(content);
            if (json.reviews && Array.isArray(json.reviews)) {
              return json.reviews as Review[];
            }
            return json as Review;
          } catch {
            // Model did not return valid JSON: keep the raw text as a single review.
            const firstLine = patch.split('\n')[0];
            return {
              lgtm: false,
              hunk_header: firstLine.startsWith('@@') ? firstLine : undefined,
              review_comment: content,
            };
          }
        }

        return { lgtm: true, review_comment: '' };
      } catch (e) {
        lastError = e;
        const retryable =
          !(e instanceof ApiError) || e.status === 429 || e.status >= 500;
        if (retryable && attempt < maxAttempts) {
          await sleep(
            baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs
          );
          continue;
        }
        break;
      }
    }

    console.timeEnd('code-review cost');
    throw lastError;
  };
}
