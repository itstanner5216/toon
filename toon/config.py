"""TOON configuration dataclasses.

This module defines the complete configurability surface for the TOON
compression pipeline.  Every class is a plain dataclass with sensible
defaults so that ``ToonConfig()`` works with zero arguments.

No runtime dependencies on pipeline internals (bmx_plus, sagerank, etc.).
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any


# ════════════════════════════════════════════════════════════════════════
#  Leaf / building-block configs
# ════════════════════════════════════════════════════════════════════════

@dataclass
class BudgetTier:
    """A single tier boundary used by BMX scoring to bucket entries.

    Entries whose normalised score is ≥ *percentile* (computed over the
    sorted score distribution) are assigned *tier_name*.  Tiers are
    evaluated top-down; the first match wins.
    """

    percentile: float
    """Score percentile threshold (0.0–1.0). Entries at or above this
    quantile of the score distribution receive this tier."""

    tier_name: str
    """Label forwarded to the budget allocator (e.g. "high", "medium")."""


@dataclass
class FieldMatcher:
    """Predicate that decides whether a (field_path, value) pair matches.

    All specified (non-``None``) conditions are AND-ed together.
    A matcher with every field left at ``None`` matches everything.
    """

    field_path: str | None = None
    """Dot-notation path (e.g. ``"payload.output"``).  Matches if the
    actual field path equals this value **or** starts with it as a prefix
    segment (``"payload"`` matches ``"payload.output"``)."""

    field_pattern: str | None = None
    """Regex applied via ``re.search`` against the **last** segment of the
    field path (i.e. the immediate field name)."""

    min_length: int | None = None
    """Only checked when the value is a ``str``.  Passes if
    ``len(value) >= min_length``."""

    max_length: int | None = None
    """Only checked when the value is a ``str``.  Passes if
    ``len(value) <= max_length``."""

    # Matching logic lives in router.py to keep this file pure data.


@dataclass
class CodecConfig:
    """Describes *how* a matched field should be compressed.

    ``strategy`` is one of:
    ``"truncate"`` | ``"dedup"`` | ``"parse_json"`` | ``"drop"``
    | ``"array"`` | ``"passthrough"``
    """

    strategy: str
    """Compression strategy name."""

    budget: int | None = None
    """Optional token/char budget hint forwarded to the codec."""


@dataclass
class EncoderRule:
    """Pairs a *matcher* with the *codec* to apply when it fires.

    Rules are evaluated in list order; the **first** match wins.
    """

    matcher: FieldMatcher
    codec: CodecConfig


# ════════════════════════════════════════════════════════════════════════
#  Sub-system configs
# ════════════════════════════════════════════════════════════════════════

@dataclass
class ArrayCodecConfig:
    """Controls threshold-based array folding (TOON v1 behaviour)."""

    enabled: bool = True
    """Set ``False`` to skip array compression entirely."""

    threshold: int = 5
    """Arrays longer than this are replaced with a TOON metadata summary."""

    sample_size: int = 3
    """Number of leading items to keep in the ``sample`` field."""


@dataclass
class StringCodecConfig:
    """Controls string-level compression (truncation, JSON parsing, stack
    trace collapsing)."""

    enabled: bool = True

    default_budget: int = 500
    """Fallback character budget when no per-rule budget is specified."""

    min_length: int = 200
    """Strings shorter than this are never compressed."""

    parse_json: bool = True
    """Attempt to detect and parse JSON-in-string values."""

    stack_trace_max_user_frames: int = 10
    """Max user-code frames retained by the stack-trace compressor.
    Based on FaST heuristic (ICSE 2022)."""


@dataclass
class DedupConfig:
    """Controls the deduplication stage."""

    enabled: bool = True

    scope: str = "session"
    """``"session"`` — LRU-bounded across calls.
    ``"turn"``    — reset every call.
    ``"none"``    — skip dedup entirely."""

    maxsize: int = 5000
    """LRU cache capacity for fingerprint storage (~500 KB at 5 000)."""


@dataclass
class BMXConfig:
    """Controls the BMX+ / SageRank scoring stage (opt-in)."""

    enabled: bool = False
    """BMX scoring is off by default; set ``True`` to activate."""

    mode: str = "self"
    """``"self"`` — corpus scores itself (centrality).
    ``"query"`` — score against an explicit query string."""

    query: str | None = None
    """User-supplied query (only used when ``mode="query"``)."""

    core_fraction: float = 0.15
    """Fraction of top-scoring entries that form the "core".
    Engineering heuristic — not empirically validated."""

    gini_threshold: float = 0.2
    """Gini coefficient below which self-scoring is abandoned.
    Derived from T-Retrievability (Ganguly 2025)."""

    tiers: list[BudgetTier] = field(default_factory=lambda: [
        BudgetTier(0.75, "high"),
        BudgetTier(0.25, "medium"),
        BudgetTier(0.0, "low"),
    ])
    """Tier boundaries evaluated top-down (first match wins)."""


# ════════════════════════════════════════════════════════════════════════
#  Top-level config
# ════════════════════════════════════════════════════════════════════════

@dataclass
class ToonConfig:
    """Master configuration for the TOON compression pipeline.

    Every field has a default, so ``ToonConfig()`` is always valid.

    Routing priority (evaluated by :func:`toon.router.route_field`):

    1. *preserve_rules* — if **any** matcher hits → ``"preserve"``
    2. *encode_rules* — first match wins → that rule's codec strategy
    3. *default_codec* — fallback codec if nothing else matched
    4. → ``"passthrough"``
    """

    enabled: bool = True
    """Global kill-switch.  When ``False``, all data passes through
    unchanged."""

    preserve_rules: list[FieldMatcher] = field(default_factory=list)
    """Fields matching any of these are never compressed."""

    encode_rules: list[EncoderRule] = field(default_factory=list)
    """Ordered list; first matching rule determines the codec."""

    default_codec: CodecConfig | None = None
    """Fallback codec when no rule matches.  ``None`` → passthrough."""

    array: ArrayCodecConfig = field(default_factory=ArrayCodecConfig)
    """Array folding settings."""

    string: StringCodecConfig = field(default_factory=StringCodecConfig)
    """String compression settings."""

    dedup: DedupConfig = field(default_factory=DedupConfig)
    """Deduplication settings."""

    bmx: BMXConfig = field(default_factory=BMXConfig)
    """BMX+ / SageRank scoring settings."""

    emit_markers: bool = True
    """When ``True``, compressed arrays include the ``__toon`` marker."""

    emit_stats: bool = False
    """When ``True``, attach compression statistics to the output."""

    # ── Factory helpers ────────────────────────────────────────────────

    @classmethod
    def preset(cls, name: str) -> ToonConfig:
        """Return a deep-copied preset config by *name*.

        Raises ``ValueError`` for unknown presets, listing the valid ones.
        """
        from .presets import PRESETS  # lazy to avoid circular import

        if name not in PRESETS:
            raise ValueError(
                f"Unknown preset: {name!r}. "
                f"Available: {sorted(PRESETS.keys())}"
            )
        return copy.deepcopy(PRESETS[name])

    @classmethod
    def from_compress_config(cls, cc: Any) -> ToonConfig:
        """Convert a legacy :class:`toon.pipeline.CompressConfig` into a
        :class:`ToonConfig`.

        This is the backward-compatibility bridge: existing code that
        builds a ``CompressConfig`` and passes it to :func:`compress` can
        be migrated incrementally.

        Args:
            cc: A ``CompressConfig`` instance (imported dynamically to
                avoid a hard dependency on :mod:`toon.pipeline`).

        Returns:
            Equivalent ``ToonConfig``.
        """
        # ── Preserve rules from cc.preserve_fields ──
        preserve_rules: list[FieldMatcher] = [
            FieldMatcher(field_pattern=rf"^{fname}$")
            for fname in sorted(cc.preserve_fields)
        ]

        # ── Encode rules from cc.encode_fields ──
        encode_rules: list[EncoderRule] = [
            EncoderRule(
                matcher=FieldMatcher(field_pattern=rf"^{fname}$"),
                codec=CodecConfig(strategy="array"),
            )
            for fname in sorted(cc.encode_fields)
        ]

        # ── Map tier_ratios → BudgetTier list ──
        # CompressConfig stores {"high": 0.60, "medium": 0.30, "low": 0.10}
        # We convert to percentile thresholds: high ≥ 0.75, medium ≥ 0.25, low ≥ 0.0
        tier_map: dict[str, float] = {
            "high": 0.75,
            "medium": 0.25,
            "low": 0.0,
        }
        budget_tiers: list[BudgetTier] = [
            BudgetTier(percentile=tier_map.get(name, 0.0), tier_name=name)
            for name in cc.tier_ratios
        ]
        # Sort descending by percentile so top-down evaluation works
        budget_tiers.sort(key=lambda t: t.percentile, reverse=True)

        # ── Determine BMX mode ──
        bmx_mode = "self"
        # If core_fraction_method is "fixed", keep self mode but set fraction
        core_frac = cc.core_fraction_fixed

        return cls(
            preserve_rules=preserve_rules,
            encode_rules=encode_rules,
            array=ArrayCodecConfig(
                enabled=True,
                threshold=5,
                sample_size=3,
            ),
            string=StringCodecConfig(
                enabled=True,
                stack_trace_max_user_frames=cc.stack_trace_max_user_frames,
            ),
            dedup=DedupConfig(
                enabled=cc.dedup_scope != "none",
                scope=cc.dedup_scope,
                maxsize=cc.dedup_maxsize,
            ),
            bmx=BMXConfig(
                enabled=False,  # CompressConfig doesn't have an explicit toggle
                mode=bmx_mode,
                core_fraction=core_frac,
                gini_threshold=cc.gini_threshold,
                tiers=budget_tiers,
            ),
            emit_markers=True,
            emit_stats=False,
        )

