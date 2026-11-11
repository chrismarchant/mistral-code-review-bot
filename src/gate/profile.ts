import { readFileSync } from 'node:fs';

import { GateProfile, PROFILE_SCHEMA } from './types.js';

export const DEFAULT_PROFILE: GateProfile = {
  schema: PROFILE_SCHEMA,
  description: 'built-in default gate-review profile',
  limits: {
    maxFiles: 50,
    maxContextCharsPerFile: 20000,
    maxContextCharsTotal: 200000,
    maxModelCalls: 8,
    maxPromptCharsPerCall: 120000,
    tokenBudget: 400000,
    requestTimeoutMs: 120000,
    retryAttempts: 3,
    chunkMaxLines: 200,
  },
  pricesPerMillionTokens: { input: 2.0, output: 8.0 },
};

/** Load a versioned review profile from disk, merged over defaults. */
export const loadProfile = (path?: string): GateProfile => {
  if (!path) return DEFAULT_PROFILE;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GateProfile>;
  if (raw.schema !== PROFILE_SCHEMA) {
    throw new Error(
      `unsupported profile schema "${raw.schema}" (expected ${PROFILE_SCHEMA})`
    );
  }
  return {
    ...DEFAULT_PROFILE,
    ...raw,
    limits: { ...DEFAULT_PROFILE.limits, ...(raw.limits ?? {}) },
    pricesPerMillionTokens: {
      ...DEFAULT_PROFILE.pricesPerMillionTokens,
      ...(raw.pricesPerMillionTokens ?? {}),
    },
  };
};
