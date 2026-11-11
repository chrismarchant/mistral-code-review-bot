import { BudgetExceededError, GateProfile } from './types.js';

/**
 * Tracks bounded execution for a gate review: model calls, token usage,
 * context volume and estimated cost. Exceeding a hard limit throws
 * BudgetExceededError; soft limits are recorded as coverage gaps.
 */
export class Budget {
  calls = 0;
  promptTokens = 0;
  completionTokens = 0;
  contextChars = 0;
  filesInspected = 0;
  gaps: string[] = [];
  exhausted = false;

  constructor(private profile: GateProfile) {}

  get totalTokens(): number {
    return this.promptTokens + this.completionTokens;
  }

  get estimatedCostUsd(): number {
    const p = this.profile.pricesPerMillionTokens;
    return (
      (this.promptTokens / 1_000_000) * p.input +
      (this.completionTokens / 1_000_000) * p.output
    );
  }

  /** rough pre-call estimate: ~4 chars per token */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  canMakeCall(promptText: string): void {
    if (this.exhausted) {
      throw new BudgetExceededError('model-call budget already exhausted');
    }
    if (this.calls >= this.profile.limits.maxModelCalls) {
      this.exhausted = true;
      this.gaps.push(
        `maxModelCalls (${this.profile.limits.maxModelCalls}) reached; remaining analysis skipped`
      );
      throw new BudgetExceededError(
        `maxModelCalls limit (${this.profile.limits.maxModelCalls}) reached`
      );
    }
    const est = this.estimateTokens(promptText);
    if (this.totalTokens + est > this.profile.limits.tokenBudget) {
      this.exhausted = true;
      this.gaps.push(
        `tokenBudget (${this.profile.limits.tokenBudget}) would be exceeded (used ${this.totalTokens} + est ${est}); call skipped`
      );
      throw new BudgetExceededError('token budget would be exceeded');
    }
  }

  /**
   * Non-throwing check: can a call with `promptText` be made while still
   * leaving `reserveCalls` calls and `reserveTokens` tokens for later
   * mandatory steps (i.e. the final synthesis)?
   */
  canAfford(promptText: string, reserveCalls = 0, reserveTokens = 0): boolean {
    if (this.exhausted) return false;
    const { maxModelCalls, tokenBudget } = this.profile.limits;
    if (this.calls + 1 + reserveCalls > maxModelCalls) return false;
    return this.totalTokens + this.estimateTokens(promptText) + reserveTokens <= tokenBudget;
  }

  recordCall(promptText: string, usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }): void {
    this.calls++;
    if (usage) {
      this.promptTokens += usage.prompt_tokens ?? 0;
      this.completionTokens += usage.completion_tokens ?? 0;
    } else {
      // no usage reported: fall back to estimates so the budget still bounds execution
      this.promptTokens += this.estimateTokens(promptText);
      this.completionTokens += 512;
    }
    if (this.totalTokens > this.profile.limits.tokenBudget) {
      this.exhausted = true;
      this.gaps.push(
        `tokenBudget (${this.profile.limits.tokenBudget}) exceeded after call ${this.calls} (used ${this.totalTokens})`
      );
    }
  }

  addContextChars(n: number): void {
    this.contextChars += n;
    if (this.contextChars > this.profile.limits.maxContextCharsTotal) {
      this.gaps.push(
        `maxContextCharsTotal (${this.profile.limits.maxContextCharsTotal}) exceeded (${this.contextChars}); further source context skipped`
      );
    }
  }

  gap(message: string): void {
    if (!this.gaps.includes(message)) {
      this.gaps.push(message);
    }
  }
}
