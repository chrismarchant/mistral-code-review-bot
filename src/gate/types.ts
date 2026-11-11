export const REPORT_SCHEMA = 'mcrb.gate.report.v1';
export const MANIFEST_SCHEMA = 'mcrb.gate.manifest.v1';
export const PROFILE_SCHEMA = 'mcrb.gate.profile.v1';

export type Disposition = 'ACCEPT' | 'ACCEPT WITH CONDITIONS' | 'REJECT';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type EvidenceKind = 'verified' | 'model' | 'unresolved';

export interface EvidenceItem {
  id: string;
  category: 'pr' | 'diff' | 'source' | 'ci' | 'dependency' | 'security' | 'config' | 'process';
  kind: EvidenceKind;
  ref: string;
  summary: string;
  /** present for verified source/diff content (may be truncated; truncation is recorded) */
  content?: string;
  truncated?: boolean;
}

export interface Finding {
  id: string;
  severity: Severity;
  category: 'security' | 'dependency' | 'compatibility' | 'regression' | 'quality' | 'process';
  title: string;
  detail: string;
  evidenceRefs: string[];
}

export interface GateProfile {
  schema: typeof PROFILE_SCHEMA;
  description?: string;
  limits: {
    maxFiles: number;
    maxContextCharsPerFile: number;
    maxContextCharsTotal: number;
    maxModelCalls: number;
    maxPromptCharsPerCall: number;
    tokenBudget: number;
    requestTimeoutMs: number;
    retryAttempts: number;
    chunkMaxLines: number;
  };
  pricesPerMillionTokens: { input: number; output: number };
}

export class ShaMismatchError extends Error {
  constructor(
    public expected: string,
    public actual: string
  ) {
    super(`candidate SHA ${actual} does not match PR head ${expected}`);
    this.name = 'ShaMismatchError';
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}
