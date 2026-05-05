// Ported from: toon/budget.py
// Python line count: 122
// Port verification:
//   - TIER_RATIOS: {"high": 0.60, "medium": 0.30, "low": 0.10} preserved exactly
//   - OVERHEAD_RESERVE: 0.05 (5%) preserved exactly
//   - reserve = int(total_budget * OVERHEAD_RESERVE) -> Math.floor equivalent via int()
//   - preserve_tokens: sum of estimate_tokens_obj for each "preserve" tier entry
//   - remaining = max(0, usable - preserve_tokens)
//   - tier_budgets[tier_name] = int(remaining * ratio) -> Math.floor via int()
//   - tier_budgets["cut"] = 0
//   - tier iteration order: ["preserve", "high", "medium", "low", "cut"]
//   - tier_scores: max(scores[i], 1e-10) for each index in tier
//   - share formula: tier_scores[idx] / score_sum if score_sum > 0 else 1.0 / len(tier_indices)
//   - entry_budgets[i] = max(10, int(tier_budget * share))
//   - "preserve" tier: entry_budgets[i] = estimate_tokens_obj(entries[i]["content"])
//   - "cut" tier: entry_budgets[i] stays 0
//   - BudgetAllocation: entry_budgets, tier_budgets, total_budget, reserve

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
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i] === 'preserve') {
        preserve_tokens += estimateTokensObj(entries[i].content);
      }
    }

    const remaining = Math.max(0, usable - preserve_tokens);

    // Allocate to tiers
    const tier_budgets: Record<string, number> = {
      preserve: preserve_tokens,
    };
    for (const tier_name of Object.keys(BudgetAllocator.TIER_RATIOS)) {
      tier_budgets[tier_name] = Math.trunc(
        remaining * BudgetAllocator.TIER_RATIOS[tier_name]
      );
    }
    tier_budgets['cut'] = 0;

    // Distribute within each tier proportional to score
    const entry_budgets: number[] = new Array<number>(entries.length).fill(0);

    for (const tier_name of ['preserve', 'high', 'medium', 'low', 'cut']) {
      const tier_indices: number[] = [];
      for (let i = 0; i < tiers.length; i++) {
        if (tiers[i] === tier_name) {
          tier_indices.push(i);
        }
      }
      if (tier_indices.length === 0) {
        continue;
      }

      if (tier_name === 'preserve') {
        for (const i of tier_indices) {
          entry_budgets[i] = estimateTokensObj(entries[i].content);
        }
        continue;
      }

      if (tier_name === 'cut') {
        continue;
      }

      const tier_budget = tier_budgets[tier_name];
      const tier_scores: number[] = tier_indices.map((i) =>
        Math.max(scores[i], 1e-10)
      );
      const score_sum = tier_scores.reduce((a, b) => a + b, 0);

      for (let idx = 0; idx < tier_indices.length; idx++) {
        const i = tier_indices[idx];
        const share =
          score_sum > 0
            ? tier_scores[idx] / score_sum
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
