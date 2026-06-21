import { estimateTokensObj } from './utils.js';
import { EntryMeta } from './types.js';

// ---------------------------------------------------------------------------
// BudgetAllocation
// ---------------------------------------------------------------------------

/** Per-entry budget allocation result. */
export interface BudgetAllocation {
  entry_budgets: number[];
  tier_budgets: Record<string, number>;
  total_budget: number;
  reserve: number;
}

// ---------------------------------------------------------------------------
// BudgetAllocator
// ---------------------------------------------------------------------------

/**
 * Allocate token budgets across entries based on tier and score.
 *
 * Two-phase allocation:
 *   1. Compute per-tier budgets from the tier ratios
 *   2. Distribute within each tier proportional to entry scores
 *
 * The "preserve" tier receives its exact original token count.
 * The remaining budget is split 60/30/10 across high/medium/low.
 * Each entry within a tier receives a share proportional to its score.
 */
export class BudgetAllocator {
  static readonly TIER_RATIOS: Record<string, number> = {
    high: 0.60,
    medium: 0.30,
    low: 0.10,
  };

  static readonly OVERHEAD_RESERVE: number = 0.05; // 5% for structural markers

  /**
   * Allocate budget across entries.
   *
   * @param entries Entry metadata dicts with "content" key.
   * @param scores Normalized [0,1] scores per entry.
   * @param tiers Tier assignment per entry ("preserve"|"high"|"medium"|"low"|"cut").
   * @param total_budget Total available token budget.
   * @returns BudgetAllocation with per-entry budgets.
   */
  static allocate(
    entries: EntryMeta[],
    scores: number[],
    tiers: string[],
    total_budget: number
  ): BudgetAllocation {
    const reserve = Math.trunc(total_budget * BudgetAllocator.OVERHEAD_RESERVE);
    const usable = total_budget - reserve;

    // Calculate preserve tier consumption
    let preserve_tokens = 0;
    for (const [i, tier] of tiers.entries()) {
      if (tier === 'preserve') {
        const entry = entries[i];
        if (entry === undefined) {
          throw new Error(
            `invariant: entries[${i}] missing for tier index in preserve loop`
          );
        }
        preserve_tokens += estimateTokensObj(entry.content);
      }
    }

    const remaining = Math.max(0, usable - preserve_tokens);

    // Allocate to tiers
    const tier_budgets: Record<string, number> = {
      preserve: preserve_tokens,
    };
    for (const tier_name of Object.keys(BudgetAllocator.TIER_RATIOS)) {
      const ratio = BudgetAllocator.TIER_RATIOS[tier_name];
      if (ratio === undefined) {
        throw new Error(
          `invariant: TIER_RATIOS missing entry for tier '${tier_name}'`
        );
      }
      tier_budgets[tier_name] = Math.trunc(remaining * ratio);
    }
    tier_budgets['cut'] = 0;

    // Distribute within each tier proportional to score
    const entry_budgets: number[] = new Array<number>(entries.length).fill(0);

    for (const tier_name of ['preserve', 'high', 'medium', 'low', 'cut']) {
      const tier_indices: number[] = [];
      for (const [i, tier] of tiers.entries()) {
        if (tier === tier_name) {
          tier_indices.push(i);
        }
      }
      if (tier_indices.length === 0) {
        continue;
      }

      if (tier_name === 'preserve') {
        for (const i of tier_indices) {
          const entry = entries[i];
          if (entry === undefined) {
            throw new Error(
              `invariant: entries[${i}] missing for preserve tier index`
            );
          }
          entry_budgets[i] = estimateTokensObj(entry.content);
        }
        continue;
      }

      if (tier_name === 'cut') {
        continue;
      }

      const tier_budget = tier_budgets[tier_name];
      if (tier_budget === undefined) {
        throw new Error(
          `invariant: no budget for tier '${tier_name}'`
        );
      }
      const tier_scores: number[] = tier_indices.map((i) => {
        const s = scores[i];
        if (s === undefined) {
          throw new Error(
            `invariant: scores[${i}] missing for tier index in '${tier_name}'`
          );
        }
        return Math.max(s, 1e-10);
      });
      const score_sum = tier_scores.reduce((a, b) => a + b, 0);

      for (const [idx, i] of tier_indices.entries()) {
        const tier_score = tier_scores[idx];
        if (tier_score === undefined) {
          throw new Error(
            `invariant: tier_scores[${idx}] missing in tier '${tier_name}'`
          );
        }
        const share =
          score_sum > 0
            ? tier_score / score_sum
            : 1.0 / tier_indices.length;
        entry_budgets[i] = Math.max(10, Math.trunc(tier_budget * share));
      }
    }

    return {
      entry_budgets,
      tier_budgets,
      total_budget,
      reserve,
    };
  }
}
