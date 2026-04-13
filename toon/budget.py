"""Token budget allocation across tiers and entries.

Budget distribution:
  - "preserve" tier: full original size (no compression)
  - "high" tier: 60% of remaining budget (proportional to scores)
  - "medium" tier: 30% of remaining budget
  - "low" tier: 10% of remaining budget
  - "cut" tier: 0 tokens (excluded)

These ratios are engineering heuristics informed by LLMLingua's finding that
dynamic per-component allocation (EM 79.08) outperforms uniform (73.62).
Source: https://aclanthology.org/2024.acl-long.91/

Performance: O(n) for n entries. Budget calculation is pure arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ._utils import estimate_tokens_obj


@dataclass
class BudgetAllocation:
    """Per-entry budget allocation result."""
    entry_budgets: list[int]
    tier_budgets: dict[str, int]
    total_budget: int
    reserve: int


class BudgetAllocator:
    """Allocate token budgets across entries based on tier and score.

    Two-phase allocation:
      1. Compute per-tier budgets from the tier ratios
      2. Distribute within each tier proportional to entry scores

    The "preserve" tier receives its exact original token count.
    The remaining budget is split 60/30/10 across high/medium/low.
    Each entry within a tier receives a share proportional to its score.
    """

    TIER_RATIOS: dict[str, float] = {
        "high": 0.60,
        "medium": 0.30,
        "low": 0.10,
    }
    OVERHEAD_RESERVE: float = 0.05  # 5% for structural markers

    @classmethod
    def allocate(
        cls,
        entries: list[dict],
        scores: list[float],
        tiers: list[str],
        total_budget: int,
    ) -> BudgetAllocation:
        """Allocate budget across entries.

        Args:
            entries: Entry metadata dicts with "content" key.
            scores: Normalized [0,1] scores per entry.
            tiers: Tier assignment per entry ("preserve"|"high"|"medium"|"low"|"cut").
            total_budget: Total available token budget.

        Returns:
            BudgetAllocation with per-entry budgets.
        """
        reserve = int(total_budget * cls.OVERHEAD_RESERVE)
        usable = total_budget - reserve

        # Calculate preserve tier consumption
        preserve_tokens = 0
        for i, tier in enumerate(tiers):
            if tier == "preserve":
                preserve_tokens += estimate_tokens_obj(entries[i]["content"])

        remaining = max(0, usable - preserve_tokens)

        # Allocate to tiers
        tier_budgets: dict[str, int] = {"preserve": preserve_tokens}
        for tier_name, ratio in cls.TIER_RATIOS.items():
            tier_budgets[tier_name] = int(remaining * ratio)
        tier_budgets["cut"] = 0

        # Distribute within each tier proportional to score
        entry_budgets: list[int] = [0] * len(entries)

        for tier_name in ["preserve", "high", "medium", "low", "cut"]:
            tier_indices = [i for i, t in enumerate(tiers) if t == tier_name]
            if not tier_indices:
                continue

            if tier_name == "preserve":
                for i in tier_indices:
                    entry_budgets[i] = estimate_tokens_obj(entries[i]["content"])
                continue

            if tier_name == "cut":
                continue

            tier_budget = tier_budgets[tier_name]
            tier_scores = [max(scores[i], 1e-10) for i in tier_indices]
            score_sum = sum(tier_scores)

            for idx, i in enumerate(tier_indices):
                share = (
                    tier_scores[idx] / score_sum
                    if score_sum > 0
                    else 1.0 / len(tier_indices)
                )
                entry_budgets[i] = max(10, int(tier_budget * share))

        return BudgetAllocation(
            entry_budgets=entry_budgets,
            tier_budgets=tier_budgets,
            total_budget=total_budget,
            reserve=reserve,
        )
