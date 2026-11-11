export interface Review {
  lgtm: boolean;
  review_comment: string;
  hunk_header?: string;
  /** Set when the model text was not valid JSON and is passed through as-is. */
  raw?: boolean;
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
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/** The model returned no usable text (e.g. only a thinking block). */
export class MistralNoTextError extends Error {
  constructor(public readonly finishReason: string) {
    super(
      `Mistral returned no review text for this file (finish_reason=${finishReason})`
    );
    this.name = 'MistralNoTextError';
  }
}

export class MistralTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Mistral request timed out after ${timeoutMs} ms`);
    this.name = 'MistralTimeoutError';
  }
}

export class MistralHttpError extends Error {
  constructor(public readonly status: number, detail: string) {
    super(`Mistral API request failed with status ${status}: ${detail}`);
    this.name = 'MistralHttpError';
  }
}

export const getRequestTimeoutMs = (): number => {
  const value = Number(process.env.REQUEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_REQUEST_TIMEOUT_MS;
};

/**
 * Returns the answer text of a chat completion message. `content` is either a
 * string or (for reasoning models such as mistral-large-4-0) an array of
 * blocks; only `text` blocks are kept, `thinking` and unknown blocks are
 * ignored so model internals are never posted.
 */
export const extractMessageText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('');
};

/**
 * Parses model output as JSON, tolerating ```json fences and surrounding
 * prose by extracting the first top-level JSON object. Returns undefined if
 * nothing parses.
 */
export const parseModelJson = (text: string): unknown => {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }
  const object = extractFirstJsonObject(trimmed);
  if (object) {
    candidates.push(object);
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
};

const extractFirstJsonObject = (text: string): string | undefined => {
  const start = text.indexOf('{');
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
};

/**
 * Minimal client for the Mistral chat completions API
 * (OpenAI-compatible: POST {endpoint}/chat/completions).
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

  public get model(): string {
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

    const prompt = this.generatePrompt(patch);

    const temperature =
      process.env.temperature !== undefined ? +process.env.temperature : 1;
    const topP = process.env.top_p !== undefined ? +process.env.top_p : 1;

    const timeoutMs = getRequestTimeoutMs();
    let data: {
      choices?: Array<{
        message?: { content?: unknown };
        finish_reason?: string | null;
      }>;
    };

    console.time('code-review cost');
    try {
      const res = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          top_p: topP,
          ...(process.env.max_tokens
            ? { max_tokens: +process.env.max_tokens }
            : {}),
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new MistralHttpError(res.status, await res.text());
      }

      data = (await res.json()) as typeof data;
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new MistralTimeoutError(timeoutMs);
      }
      throw err;
    } finally {
      console.timeEnd('code-review cost');
    }

    const choice = data?.choices?.[0];
    const content = extractMessageText(choice?.message?.content);

    if (!content.trim()) {
      throw new MistralNoTextError(choice?.finish_reason || 'unknown');
    }

    const json = parseModelJson(content) as
      | { reviews?: unknown }
      | null
      | undefined;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      if (Array.isArray(json.reviews)) {
        return json.reviews as Review[];
      }
      return json as Review;
    }

    // Model did not return valid JSON: keep the text as a single raw review,
    // which the bot posts as a general (non-inline) comment.
    const firstLine = patch.split('\n')[0];
    return {
      lgtm: false,
      hunk_header: firstLine.startsWith('@@') ? firstLine : undefined,
      review_comment: content,
      raw: true,
    };
  };
}
