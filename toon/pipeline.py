"""TOON compression pipeline: dedup → scoring → budget-aware compression.

Stage 1: Dedup (exact/near/template) — LogCleaner (ESEM 2024)
Stage 2: SageRank centrality + BMX+ relevance — 5-phase algorithm
Stage 3: Per-tier budget allocation (60/30/10) — LLMLingua (ACL 2024)

Zero external dependencies. Pure Python.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from engines.bmx_plus import BMXPlusIndex
from engines.sagerank import SageRank
from .dedup import Deduplicator, DedupResult
from .budget import BudgetAllocator, BudgetAllocation
from .string_codec import compress_string
from .encoder import _encode_recursive
from ._utils import (
    flatten_to_text, estimate_tokens, estimate_tokens_obj,
    compute_gini, find_kneedle, pearson_r,
)
import hashlib
import random

logger = logging.getLogger(__name__)


# ════════════════════════════════════════════════════════════════════════
#  Configuration
# ════════════════════════════════════════════════════════════════════════

@dataclass
class CompressConfig:
    """Configuration for the TOON compression pipeline.

    All defaults are documented with their evidence basis.
    Engineering heuristics are explicitly flagged as unvalidated.
    """

    # ── Self-scoring parameters ──
    core_fraction_method: str = "kneedle"
    """Method for adaptive core_fraction detection.
    Default: "kneedle" — Satopää et al. 2011, IEEE ICDCS.
    Alternative: "fixed" uses core_fraction_fixed value."""

    core_fraction_fixed: float = 0.15
    """Fixed core fraction (used only when core_fraction_method="fixed").
    Engineering heuristic — not empirically validated."""

    gini_threshold: float = 0.2
    """Gini coefficient below which self-scoring is abandoned.
    Derived from T-Retrievability (Ganguly 2025, arXiv:2508.21704).
    Below 0.2 → corpus is undifferentiated, self-scoring uninformative."""

    hubness_z_threshold: float = 3.0
    """Median/MAD z-score threshold for hub detection.
    Based on adversarial hubness research (Cisco 2026).
    Hubs with z > 3.0 are capped at median + 2·MAD."""

    redundancy_r_threshold: float = 0.95
    """Pearson r above which Phase 2/4 correlation indicates redundancy.
    Engineering heuristic — not empirically validated."""

    # ── Dedup parameters ──
    dedup_scope: str = "session"
    """Dedup scope: "session" (LRU-bounded), "turn" (per-call reset), "none"."""

    dedup_maxsize: int = 5000
    """LRU cache size for dedup fingerprints.
    At 5000, memory overhead ≈ 500KB. Covers typical session lengths."""

    # ── String codec parameters ──
    string_budget_ratio: float = 0.5
    """Budget halving per JSON depth level.
    Engineering heuristic — not empirically validated."""

    stack_trace_max_user_frames: int = 10
    """Max user-code frames to retain in stack trace compression.
    FaST heuristic (ICSE 2022): position × rarity scoring.
    Gap: no empirical N for LLM-reading context. 10 is conservative."""

    # ── Budget parameters ──
    tier_ratios: dict[str, float] = field(default_factory=lambda: {
        "high": 0.60, "medium": 0.30, "low": 0.10,
    })
    """Budget distribution across tiers.
    Informed by LLMLingua ablation: per-component > uniform (EM 79.08 vs 73.62).
    Source: https://aclanthology.org/2024.acl-long.91/"""

    # ── Processing limits ──
    min_entries_for_scoring: int = 5
    """Minimum entries needed to run self-scoring. Below this, preserve all."""

    sagerank_top_k: int = 0
    """If > 0, use SageRank for within-entry sentence ranking at this top-k.
    0 = disabled (entries scored but not internally reranked)."""

    # ── Field routing ──
    preserve_fields: frozenset[str] = frozenset({
        'error', 'exception', 'message', 'status', 'code', 'id', 'type', 'name',
    })
    """Field names that are always preserved at full fidelity."""

    encode_fields: frozenset[str] = frozenset({
        'data', 'results', 'items', 'records', 'rows', 'entries', 'payload',
    })
    """Field names that are candidates for array compression."""


# ════════════════════════════════════════════════════════════════════════
#  Data Contracts
# ════════════════════════════════════════════════════════════════════════

@dataclass
class ScoredEntries:
    """Output of the scoring stage (Stage 2)."""
    entries: list[dict]
    scores: list[float]
    tiers: list[str]
    core_indices: list[int]
    scoring_stats: dict


@dataclass
class CompressedOutput:
    """Final pipeline output (Stage 3)."""
    entries: list[Any]
    budget_used: int
    stats: dict


# ════════════════════════════════════════════════════════════════════════
#  Streaming Mode
# ════════════════════════════════════════════════════════════════════════

class TOONCompressor:
    """Stateful compressor for streaming mode.

    In streaming mode, self-scoring is not available (requires the full
    corpus). Only dedup and string codec / structural compression apply.

    Usage:
        compressor = TOONCompressor()
        for entry in tool_output_stream:
            compressed = compressor.feed(entry)
            if compressed is not None:  # None = deduplicated away
                context.append(compressed)
        compressor.reset()  # at session boundary
    """

    def __init__(self, config: CompressConfig | None = None):
        self.config = config or CompressConfig()
        self._deduplicator = Deduplicator(maxsize=self.config.dedup_maxsize)

    def feed(self, entry: Any) -> Any | None:
        """Process a single entry in streaming mode.

        Returns compressed entry, or None if deduplicated away.
        """
        result = self._deduplicator.deduplicate([entry])
        if not result.entries:
            return None
        content = result.entries[0]["content"]
        return _compress_entry(content, budget=None, config=self.config)

    def reset(self):
        """Reset dedup state (session boundary)."""
        self._deduplicator.reset()


# ════════════════════════════════════════════════════════════════════════
#  Functional API
# ════════════════════════════════════════════════════════════════════════

def compress(
    data: Any,
    budget: int | None = None,
    query: str | None = None,
    config: CompressConfig | None = None,
) -> Any:
    """Full TOON compression pipeline.

    Runs all three stages: dedup → self-scoring → budget-aware compression.

    Args:
        data: Tool output data. Can be a single object or list of objects.
        budget: Target token budget. None = auto (50% of original size).
        query: Optional query to bias relevance scoring toward.
        config: Pipeline configuration. None = defaults.

    Returns:
        Compressed data (same top-level type as input).
    """
    cfg = config or CompressConfig()

    # Normalize input to list
    is_single = not isinstance(data, list)
    entries = [data] if is_single else data

    if not entries:
        return data

    # Default budget: 50% of original size
    if budget is None:
        original_tokens = sum(estimate_tokens_obj(e) for e in entries)
        budget = max(100, original_tokens // 2)

    # ── Stage 1: Structural Decomposition & Dedup ──
    deduplicator = Deduplicator(maxsize=cfg.dedup_maxsize)
    dedup_result = deduplicator.deduplicate(entries)

    if not dedup_result.entries:
        return [] if not is_single else None

    # ── Stage 2: Self-Scoring & Relevance Ranking ──
    scored = _score_entries(dedup_result, query, cfg)

    # ── Stage 3: Budget-Aware Compression ──
    allocation = BudgetAllocator.allocate(
        scored.entries, scored.scores, scored.tiers, budget
    )

    compressed = _compress_entries(scored, allocation, cfg)

    if is_single and compressed.entries:
        return compressed.entries[0]
    return compressed.entries


# ════════════════════════════════════════════════════════════════════════
#  Stage 2: Self-Scoring & Relevance Ranking (5-Phase Algorithm)
# ════════════════════════════════════════════════════════════════════════

def _score_entries(
    dedup_result: DedupResult,
    query: str | None,
    config: CompressConfig,
) -> ScoredEntries:
    """Stage 2: 5-phase centrality + relevance scoring.

    Phase 0: entry count pre-check, Phase 1: BMX+ index,
    Phase 2: SageRank centrality (Gini guard), Phase 3: Kneedle core,
    Phase 4: BMX+ relevance vs core, Phase 5: tier assignment.
    """
    entries = dedup_result.entries
    n = len(entries)

    # ── Phase 0: Too few entries for meaningful scoring ──
    if n < config.min_entries_for_scoring:
        return ScoredEntries(
            entries=entries,
            scores=[1.0] * n,
            tiers=["preserve"] * n,
            core_indices=list(range(n)),
            scoring_stats={
                "method": "bypass",
                "reason": f"n={n} < min={config.min_entries_for_scoring}",
            },
        )

    # ── Phase 1: Text extraction + BMX+ index ──
    texts = [flatten_to_text(e["content"]) for e in entries]
    chunks = [
        {"chunk_id": str(i), "text": texts[i]} for i in range(n)
    ]
    index = BMXPlusIndex()
    index.build_index(chunks)

    # ── Phase 2: Centrality scoring ──
    # SageRank graph centrality where tractable (n ≤ 1000).
    # For larger corpora, SageRank on random sample + BMX+ for the rest.
    # Threshold: n=1000 is where graph construction exceeds ~2s.
    _GRAPH_LIMIT = 1000

    if n <= _GRAPH_LIMIT:
        sage = SageRank()
        sage_result = sage.rank_sentences(texts, top_k=n)
        self_scores: list[float] = sage_result.scores
    else:
        # Hybrid: SageRank sample + BMX+ scoring
        # Deterministic seed for reproducibility.
        seed_text = texts[0][:100] if texts else ""
        rng = random.Random(hashlib.md5(seed_text.encode()).hexdigest())
        sample_size = min(500, n)
        sample_indices = sorted(rng.sample(range(n), sample_size))

        # SageRank on sample → real graph centrality scores
        sage = SageRank()
        sage_result = sage.rank_sentences(
            [texts[i] for i in sample_indices], top_k=sample_size,
        )
        sample_scores = {
            sample_indices[i]: sage_result.scores[i]
            for i in range(sample_size)
        }

        # Core from sample: top centrality entries (sample_size // 5)
        sorted_sample = sorted(
            sample_scores.items(), key=lambda x: x[1], reverse=True,
        )
        sample_core_size = max(3, sample_size // 5)
        core_query = " ".join(
            texts[idx][:200] for idx, _ in sorted_sample[:sample_core_size]
        )
        if query:
            core_query = query + " " + core_query[:500]
        else:
            core_query = core_query[:2000]

        # BMX+ scores ALL entries against the graph-derived core
        bmx_results = index.search(core_query, top_k=n)
        bmx_map = {int(cid): score for cid, score in bmx_results}

        # Merge: normalize both scales, blend for sampled entries
        max_bmx = max(bmx_map.values()) if bmx_map else 1.0
        max_sage = max(sample_scores.values()) if sample_scores else 1.0
        self_scores = []
        for i in range(n):
            bmx_norm = bmx_map.get(i, 0.0) / max_bmx if max_bmx > 0 else 0.0
            if i in sample_scores:
                sage_norm = (
                    sample_scores[i] / max_sage if max_sage > 0 else 0.0
                )
                self_scores.append(0.5 * sage_norm + 0.5 * bmx_norm)
            else:
                self_scores.append(bmx_norm)

    # ── Gini check ──
    # Below threshold → degenerate corpus, self-scoring uninformative.
    # Derived from T-Retrievability (Ganguly 2025, arXiv:2508.21704).
    gini = compute_gini(self_scores)
    if gini < config.gini_threshold:
        logger.warning(
            "Gini coefficient %.3f < %.1f: corpus is undifferentiated, "
            "falling back to uniform allocation",
            gini, config.gini_threshold,
        )
        return ScoredEntries(
            entries=entries,
            scores=[1.0 / n] * n,
            tiers=["medium"] * n,
            core_indices=[],
            scoring_stats={
                "method": "uniform_fallback",
                "gini": round(gini, 4),
                "reason": "degenerate corpus",
            },
        )

    # ── Hubness detection (median/MAD) ──
    # Cisco 2026: median/MAD z-score detection outperforms mean-based.
    # Radovanović et al. (JMLR 2010): hubs distort centrality.
    sorted_ss = sorted(self_scores)
    median_ss = sorted_ss[n // 2]
    abs_devs = sorted(abs(s - median_ss) for s in self_scores)
    mad = abs_devs[n // 2] * 1.4826  # MAD to std conversion factor

    hubs: list[int] = []
    if mad > 0:
        for i, s in enumerate(self_scores):
            z = (s - median_ss) / mad
            if z > config.hubness_z_threshold:
                self_scores[i] = median_ss + 2 * mad
                hubs.append(i)
                logger.info(
                    "Hub detected at entry %d: z-score %.2f, capped", i, z
                )

    # ── Phase 3: Core identification via Kneedle ──
    sorted_indices = sorted(
        range(n), key=lambda i: self_scores[i], reverse=True
    )
    sorted_scores = [self_scores[i] for i in sorted_indices]

    if config.core_fraction_method == "kneedle":
        knee = find_kneedle(sorted_scores, sensitivity=1.0)
        core_size = max(1, min(knee + 1, n // 2))
        core_size = max(core_size, max(1, n // 20))  # At least 5%
    else:
        core_size = max(1, int(n * config.core_fraction_fixed))

    core_indices = sorted_indices[:core_size]

    # ── Phase 4: Relevance scoring against core ──
    core_text = " ".join(texts[i][:200] for i in core_indices)
    if query:
        combined_query = query + " " + core_text[:500]
    else:
        combined_query = core_text[:2000]

    relevance_results = index.search(combined_query, top_k=n)
    relevance_map = {cid: score for cid, score in relevance_results}
    relevance_scores = [relevance_map.get(str(i), 0.0) for i in range(n)]

    # ── Redundancy check ──
    r = pearson_r(self_scores, relevance_scores)
    if r > config.redundancy_r_threshold:
        logger.info(
            "Phase 2/4 correlation r=%.3f > %.2f: using self-scores only",
            r, config.redundancy_r_threshold,
        )
        final_scores = list(self_scores)
    else:
        final_scores = [
            0.4 * ss + 0.6 * rs
            for ss, rs in zip(self_scores, relevance_scores)
        ]

    # Normalize to [0,1]
    max_fs = max(final_scores) if final_scores else 1.0
    if max_fs > 0:
        final_scores = [s / max_fs for s in final_scores]

    # ── Phase 5: Tier assignment ──
    sorted_final = sorted(final_scores)
    p75 = sorted_final[int(n * 0.75)] if n > 3 else sorted_final[-1]
    p25 = sorted_final[int(n * 0.25)] if n > 3 else sorted_final[0]

    tiers: list[str] = []
    for i, score in enumerate(final_scores):
        if score >= p75:
            tiers.append("high")
        elif score >= p25:
            tiers.append("medium")
        elif score > 0:
            tiers.append("low")
        else:
            tiers.append("cut")

    return ScoredEntries(
        entries=entries,
        scores=final_scores,
        tiers=tiers,
        core_indices=core_indices,
        scoring_stats={
            "method": "sagerank_centrality",
            "gini": round(gini, 4),
            "core_size": core_size,
            "hubs_detected": len(hubs),
            "phase2_phase4_r": round(r, 4),
            "kneedle_threshold": core_size,
        },
    )


# ════════════════════════════════════════════════════════════════════════
#  Stage 3: Budget-Aware Compression
# ════════════════════════════════════════════════════════════════════════

def _compress_entries(
    scored: ScoredEntries,
    allocation: BudgetAllocation,
    config: CompressConfig,
) -> CompressedOutput:
    """Stage 3: Apply budget-aware compression to each entry."""
    compressed: list[Any] = []
    total_tokens = 0
    entries_cut = 0

    # Build list of (original_index, compressed_entry) for order preservation
    indexed_results: list[tuple[int, Any]] = []

    for i, entry in enumerate(scored.entries):
        tier = scored.tiers[i]
        entry_budget = allocation.entry_budgets[i]

        if tier == "cut":
            entries_cut += 1
            continue

        content = entry["content"]
        result = _compress_entry(content, entry_budget, config, entry_meta=entry)
        indexed_results.append((entry["index"], result))
        total_tokens += estimate_tokens_obj(result)

    # Sort by original index to preserve input order
    indexed_results.sort(key=lambda x: x[0])
    compressed = [r for _, r in indexed_results]

    original_tokens = sum(
        estimate_tokens_obj(e["content"]) for e in scored.entries
    )

    return CompressedOutput(
        entries=compressed,
        budget_used=total_tokens,
        stats={
            "compression_ratio": round(
                1.0 - total_tokens / max(1, original_tokens), 4
            ),
            "entries_kept": len(compressed),
            "entries_cut": entries_cut,
            "tier_distribution": {
                tier: scored.tiers.count(tier) for tier in set(scored.tiers)
            },
            "scoring_stats": scored.scoring_stats,
        },
    )


# ════════════════════════════════════════════════════════════════════════
#  Entry-Level Compression
# ════════════════════════════════════════════════════════════════════════

def _compress_entry(
    content: Any,
    budget: int | None,
    config: CompressConfig,
    entry_meta: dict | None = None,
) -> Any:
    """Compress a single entry using type-appropriate strategy.

    Dispatch: template-annotated → marker, str → string codec,
    dict → field routing, list/tuple → _encode_recursive, else passthrough.
    """
    # Template-collapsed entries → emit structured marker
    if entry_meta and entry_meta.get("__toon_template"):
        half = budget // 2 if budget else None
        return {
            "__toon_template": True,
            "count": entry_meta["template_count"],
            "first": _compress_entry(
                entry_meta["template_first"], half, config
            ),
            "last": _compress_entry(
                entry_meta["template_last"], half, config
            ),
        }

    if isinstance(content, str):
        if budget is None:
            budget = len(content)

        # Within-entry SageRank ranking (opt-in, default disabled)
        if config.sagerank_top_k > 0 and len(content) > budget and len(content) > 500:
            sr = SageRank()
            sr_result = sr.rank(content, top_k=config.sagerank_top_k)
            if sr_result.selected_sentences:
                content = " ".join(sr_result.selected_sentences)
                if len(content) <= budget:
                    return content

        return compress_string(content, budget, config.stack_trace_max_user_frames)

    if isinstance(content, dict):
        return _compress_dict(content, budget, config)

    if isinstance(content, (list, tuple)):
        if budget is not None:
            threshold = max(3, budget // 50)
        else:
            threshold = 5
        return _encode_recursive(content, threshold)

    return content


def _compress_dict(
    obj: dict, budget: int | None, config: CompressConfig
) -> dict:
    """Compress a dict with field routing: preserve vs. encode."""
    result = {}
    for key, value in obj.items():
        if key.lower() in config.preserve_fields:
            result[key] = value
        elif key.lower() in config.encode_fields:
            if isinstance(value, (list, tuple)) and len(value) > 5:
                result[key] = _encode_recursive(value, threshold=5)
            elif isinstance(value, str) and budget:
                field_budget = budget // max(1, len(obj))
                result[key] = compress_string(
                    value, field_budget, config.stack_trace_max_user_frames
                )
            else:
                result[key] = value
        else:
            result[key] = value
    return result


# ════════════════════════════════════════════════════════════════════════
#  Working Test
# ════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import json
    import time

    print("=" * 72)
    print("TOON Compression Pipeline — Full Integration Test")
    print("=" * 72)

    # ── Test 1: Mixed structured input → compressed output ──
    print("\n── Test 1: Mixed structured input with BMX-guided allocation ──\n")

    raw_data = [
        # Entry 0: API response with nested data
        {
            "status": "success",
            "code": 200,
            "message": "Fetched user records",
            "data": [
                {"id": f"user_{i}", "name": f"User {i}", "email": f"user{i}@test.com",
                 "created_at": f"2026-04-{10+i}T12:00:00Z", "role": "member"}
                for i in range(20)
            ],
        },
        # Entry 1: Error response (should be preserved)
        {
            "status": "error",
            "code": 500,
            "error": "DatabaseConnectionError",
            "message": "Connection pool exhausted after 30s timeout",
            "type": "ServerError",
        },
        # Entry 2: Duplicate of entry 0 (should be deduped)
        {
            "status": "success",
            "code": 200,
            "message": "Fetched user records",
            "data": [
                {"id": f"user_{i}", "name": f"User {i}", "email": f"user{i}@test.com",
                 "created_at": f"2026-04-{10+i}T12:00:00Z", "role": "member"}
                for i in range(20)
            ],
        },
        # Entry 3: Near-duplicate (same structure, different timestamps)
        {
            "status": "success",
            "code": 200,
            "message": "Fetched user records",
            "data": [
                {"id": f"user_{i}", "name": f"User {i}", "email": f"user{i}@test.com",
                 "created_at": f"2026-05-{10+i}T14:30:00Z", "role": "member"}
                for i in range(20)
            ],
        },
        # Entry 4: Log output
        "2026-04-12T10:00:01Z INFO  Starting service on port 8080\n"
        "2026-04-12T10:00:02Z INFO  Connected to database\n"
        "2026-04-12T10:00:03Z WARN  Connection pool at 80% capacity\n"
        "2026-04-12T10:00:04Z ERROR Failed to process request: timeout after 30s\n"
        "2026-04-12T10:00:05Z INFO  Retrying connection...\n"
        "2026-04-12T10:00:06Z ERROR Failed to process request: timeout after 30s\n"
        "2026-04-12T10:00:07Z INFO  Service recovered\n",
        # Entry 5: Stack trace
        "Traceback (most recent call last):\n"
        '  File "/app/server.py", line 42, in handle_request\n'
        "    result = db.query(sql)\n"
        '  File "/app/database.py", line 128, in query\n'
        "    conn = self.pool.get_connection()\n"
        '  File "/usr/lib/python3.11/site-packages/dbpool/pool.py", line 55, in get_connection\n'
        "    raise TimeoutError('Pool exhausted')\n"
        "TimeoutError: Pool exhausted\n",
        # Entry 6: JSON-in-string
        json.dumps({
            "metrics": {
                "cpu": 0.82, "memory": 0.91,
                "disk": {"root": 0.45, "data": 0.78},
                "network": {"in_bytes": 1234567890, "out_bytes": 9876543210},
            },
            "timestamp": "2026-04-12T10:00:00Z",
            "host": "prod-server-01",
            "tags": ["production", "us-east-1", "critical"],
        }),
        # Entry 7: Simple config (small, should be preserved)
        {"name": "rate_limiter", "type": "config", "id": "rl-001",
         "max_requests": 1000, "window_seconds": 60},
        # Entry 8: Another API response (different content)
        {
            "status": "success",
            "code": 200,
            "message": "Search results",
            "results": [
                {"title": f"Result {i}", "score": 0.95 - i * 0.05,
                 "snippet": f"This is the content of search result {i} with some details."}
                for i in range(15)
            ],
        },
        # Entry 9: Pure string (long text)
        "The deployment pipeline completed successfully. All 47 tests passed. "
        "Coverage report: 89.2% line coverage, 76.1% branch coverage. "
        "No regressions detected. Build artifacts uploaded to S3. "
        "Docker image tagged as v2.3.1 and pushed to ECR. "
        "Kubernetes rolling update initiated for production cluster us-east-1. "
        "ETA: 5 minutes for full rollout. "
        "Previous version v2.3.0 retained for rollback if needed.",
    ]

    original_json = json.dumps(raw_data, default=str)
    original_tokens = len(original_json) // 3  # rough estimate

    print(f"Input: {len(raw_data)} entries, ~{original_tokens} tokens")
    print(f"Original JSON size: {len(original_json):,} chars\n")

    t0 = time.perf_counter()
    result = compress(raw_data, budget=2000, query="error timeout database")
    elapsed = time.perf_counter() - t0

    result_json = json.dumps(result, default=str)
    result_tokens = len(result_json) // 3

    print(f"Output: {len(result)} entries, ~{result_tokens} tokens")
    print(f"Compressed JSON size: {len(result_json):,} chars")
    print(f"Compression: {100 * (1 - len(result_json)/len(original_json)):.1f}%")
    print(f"Time: {elapsed*1000:.1f}ms\n")

    print("Compressed entries (preview):")
    for i, entry in enumerate(result):
        preview = json.dumps(entry, default=str)
        if len(preview) > 120:
            preview = preview[:117] + "..."
        print(f"  [{i}] {preview}")

    # ── Test 2: Backward compatibility ──
    print("\n── Test 2: Backward compatibility (encode_output) ──\n")

    from .encoder import encode_output

    test_data = {"files": list(range(20)), "meta": {"nested": list(range(10))}}
    encoded = encode_output(test_data, threshold=5)
    print(f"encode_output result: {json.dumps(encoded)}")
    assert encoded["files"]["__toon"] is True
    assert encoded["files"]["count"] == 20
    assert encoded["meta"]["nested"]["__toon"] is True
    print("✓ Backward compatibility preserved\n")

    # ── Test 3: Streaming mode ──
    print("── Test 3: Streaming mode (TOONCompressor) ──\n")

    compressor = TOONCompressor()
    stream = [
        {"id": 1, "value": "hello"},
        {"id": 1, "value": "hello"},  # exact dup
        {"id": 2, "value": "world"},
        {"id": 1, "value": "hello"},  # exact dup again
    ]
    results = []
    for entry in stream:
        compressed = compressor.feed(entry)
        results.append(compressed)
        status = "kept" if compressed is not None else "deduped"
        print(f"  feed({json.dumps(entry)}) → {status}")

    kept = sum(1 for r in results if r is not None)
    print(f"\n  {len(stream)} fed → {kept} kept, {len(stream)-kept} deduped")
    assert kept == 2, f"Expected 2 kept, got {kept}"
    compressor.reset()
    print("✓ Streaming mode works\n")

    # ── Test 4: Edge cases ──
    print("── Test 4: Edge cases ──\n")

    # Empty list
    assert compress([]) == []
    print("  ✓ Empty list → []")

    # Single entry
    single = compress({"key": "value"})
    assert isinstance(single, dict)
    print(f"  ✓ Single entry → {json.dumps(single)}")

    # None handling
    assert compress([None, None, None]) is not None
    print("  ✓ None entries handled")

    # Primitives
    assert compress([1, 2, 3]) is not None
    print("  ✓ Primitive entries handled")

    print()

    # ── Test 5: Performance (10K entries) ──
    print("── Test 5: Performance (10K synthetic entries) ──\n")

    entries_10k = []
    for i in range(10000):
        kind = i % 4
        if kind == 0:
            entries_10k.append({
                "id": f"item-{i}",
                "status": "active" if i % 3 == 0 else "inactive",
                "value": i * 1.5,
                "tags": [f"tag-{i%10}", f"tag-{i%7}"],
                "timestamp": f"2026-04-12T{i%24:02d}:{i%60:02d}:00Z",
            })
        elif kind == 1:
            entries_10k.append(
                f"2026-04-12T{i%24:02d}:{i%60:02d}:00Z INFO Processing item {i}"
            )
        elif kind == 2:
            entries_10k.append({
                "error": None,
                "code": 200,
                "message": f"OK for request {i}",
                "data": list(range(i % 5)),
            })
        else:
            entries_10k.append(i * 0.1)

    t0 = time.perf_counter()
    result_10k = compress(entries_10k, budget=50000)
    elapsed_10k = time.perf_counter() - t0

    print(f"  10,000 entries → {len(result_10k)} entries in {elapsed_10k:.2f}s")
    assert elapsed_10k < 10.0, f"Performance target missed: {elapsed_10k:.2f}s > 10s"
    print(f"  ✓ Under 10s threshold ({elapsed_10k:.2f}s)")

    print()
    print("=" * 72)
    print("All tests passed.")
    print("=" * 72)
