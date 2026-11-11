/**
 * Prompt-injection protections for untrusted content (PR bodies, comments,
 * source files, docs). All untrusted material is wrapped in delimiters that
 * are themselves escaped inside the content, and the reviewer system prompt
 * instructs the model to treat everything inside the delimiters as data.
 */
export const EVIDENCE_BEGIN = '----- BEGIN UNTRUSTED EVIDENCE -----';
export const EVIDENCE_END = '----- END UNTRUSTED EVIDENCE -----';

/** Escape delimiter breakout attempts inside untrusted content. */
export const escapeDelimiters = (content: string): string =>
  content
    .split(EVIDENCE_BEGIN)
    .join(`${EVIDENCE_BEGIN} [escaped by mcrb sanitizer]`)
    .split(EVIDENCE_END)
    .join(`${EVIDENCE_END} [escaped by mcrb sanitizer]`);

export interface WrappedEvidence {
  label: string;
  text: string;
}

export const wrapUntrusted = (label: string, content: string): string => {
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return [
    `${EVIDENCE_BEGIN} label=${safeLabel}`,
    escapeDelimiters(content),
    EVIDENCE_END,
  ].join('\n');
};

export const buildUntrustedBlock = (items: WrappedEvidence[]): string =>
  items.map((i) => wrapUntrusted(i.label, i.text)).join('\n\n');
