"""Shared utilities: hashing, normalization, token estimation, Gini, Kneedle, Pearson.

All functions are pure (no persistent state). Used by dedup.py, pipeline.py,
string_codec.py, and budget.py.

Performance: All functions are O(n) or O(n log n).
blake2b_hash processes ~100K entries/sec on CPython 3.11.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

# ── Regex patterns for normalization ──
# Order matters: timestamps before big-numbers to avoid partial matches.
TIMESTAMP_RE = re.compile(
    r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?'
)
UUID_RE = re.compile(
    r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',
    re.IGNORECASE,
)
IP_RE = re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b')
BIGNUM_RE = re.compile(r'\b\d{10,}\b')
B64_RE = re.compile(r'\b[A-Za-z0-9+/]{20,}={0,2}\b')

NORMALIZERS: list[tuple[re.Pattern, str]] = [
    (TIMESTAMP_RE, '<TS>'),
    (UUID_RE, '<UUID>'),
    (IP_RE, '<IP>'),
    (BIGNUM_RE, '<NUM>'),
    (B64_RE, '<B64>'),
]


def normalize_value(v: Any) -> Any:
    """Recursively normalize variable fields in a JSON-like structure.

    Replaces timestamps, UUIDs, IPs, large numbers, and base64 blobs with
    placeholder tokens so that structurally identical entries with different
    volatile values hash to the same fingerprint.
    """
    if isinstance(v, str):
        for pattern, token in NORMALIZERS:
            v = pattern.sub(token, v)
        return v
    elif isinstance(v, (int, float)):
        return '<NUM>'
    elif isinstance(v, dict):
        return {k: normalize_value(val) for k, val in sorted(v.items())}
    elif isinstance(v, list):
        return [normalize_value(item) for item in v]
    return v


def blake2b_hash(data: str, digest_size: int = 8) -> str:
    """Fast 64-bit blake2b hash for dedup. Returns hex string.

    At 64 bits with 100K entries, collision probability is <2.7×10⁻⁶
    (birthday problem). Acceptable for non-adversarial dedup.
    """
    return hashlib.blake2b(
        data.encode('utf-8', errors='replace'), digest_size=digest_size
    ).hexdigest()


def canonical_json(obj: Any) -> str:
    """Deterministic JSON serialization for hashing.

    Sorted keys + minimal separators guarantee identical output for
    semantically identical objects regardless of insertion order.
    """
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), default=str)


def estimate_tokens(text: str) -> int:
    """Conservative token estimation. JSON: chars/2, text: chars/4.

    Heuristic from Anthropic cookbook analysis: JSON markup inflates
    token counts relative to plain text.
    """
    if text.startswith('{') or text.startswith('['):
        return max(1, len(text) // 2)
    return max(1, len(text) // 4)


def estimate_tokens_obj(obj: Any) -> int:
    """Estimate tokens for an arbitrary Python object via canonical JSON."""
    return estimate_tokens(canonical_json(obj))


def flatten_to_text(obj: Any) -> str:
    """Convert any object to a flat text string for BMX+ indexing.

    Dicts emit 'key value' pairs, lists emit space-joined children,
    primitives emit str(). This produces indexable text that preserves
    both field names and values for BM25-family scoring.
    """
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        parts = []
        for k, v in obj.items():
            parts.append(f"{k} {flatten_to_text(v)}")
        return ' '.join(parts)
    if isinstance(obj, (list, tuple)):
        return ' '.join(flatten_to_text(item) for item in obj)
    return str(obj) if obj is not None else ''


def compute_gini(values: list[float]) -> float:
    """Gini coefficient of a distribution. 0 = perfect equality, 1 = max inequality.

    Derived from T-Retrievability (Ganguly et al. 2025, arXiv:2508.21704):
    Gini < 0.2 indicates near-uniform document exposure, meaning BM25-family
    self-scoring is uninformative on this corpus.
    """
    n = len(values)
    if n < 2:
        return 0.0
    sorted_v = sorted(values)
    total = sum(sorted_v)
    if total == 0:
        return 0.0
    cumulative = 0.0
    gini_sum = 0.0
    for i, v in enumerate(sorted_v):
        cumulative += v
        gini_sum += cumulative
    return 1.0 - 2.0 * gini_sum / (n * total) + 1.0 / n


def find_kneedle(scores: list[float], sensitivity: float = 1.0) -> int:
    """Find knee point in a sorted-descending score curve.

    Returns index of the knee (boundary between core and periphery).
    Implements Satopää et al. 2011 (IEEE ICDCS) simplified for 1D sorted data.

    The algorithm normalises scores to [0,1], computes the difference from
    the diagonal y = 1 - x, finds the global maximum of that difference
    curve, then walks forward until the curve drops below a sensitivity-
    adjusted threshold.

    Args:
        scores: Descending-sorted list of scores.
        sensitivity: Kneedle S parameter. S=1.0 recommended for online settings.

    Returns:
        Index of the knee point.
    """
    n = len(scores)
    if n < 3:
        return n - 1

    # Normalize to [0,1]
    s_min, s_max = min(scores), max(scores)
    s_range = s_max - s_min
    if s_range < 1e-10:
        return n - 1  # flat distribution — no knee

    x_norm = [i / (n - 1) for i in range(n)]
    y_norm = [(s - s_min) / s_range for s in scores]

    # Difference from diagonal y = 1 - x
    diff = [y_norm[i] - (1.0 - x_norm[i]) for i in range(n)]

    # Find global maximum of difference curve
    best_idx = 0
    best_val = diff[0]
    for i in range(1, n - 1):
        if diff[i] > best_val:
            best_val = diff[i]
            best_idx = i

    # Walk forward: first point where diff drops below threshold
    threshold = best_val - sensitivity * s_range / n
    for i in range(best_idx + 1, n):
        if diff[i] < threshold:
            return i

    return best_idx


def pearson_r(x: list[float], y: list[float]) -> float:
    """Pearson correlation coefficient between two equal-length lists.

    Returns 0.0 for degenerate inputs (n < 3 or zero variance).
    Used in the pipeline to detect Phase 2/4 redundancy.
    """
    n = len(x)
    if n < 3:
        return 0.0
    mx = sum(x) / n
    my = sum(y) / n
    cov = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y))
    sx = math.sqrt(sum((xi - mx) ** 2 for xi in x))
    sy = math.sqrt(sum((yi - my) ** 2 for yi in y))
    if sx < 1e-10 or sy < 1e-10:
        return 0.0
    return cov / (sx * sy)
