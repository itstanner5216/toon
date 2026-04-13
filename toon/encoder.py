"""TOON encoder for compressing large tool outputs.

TOON (Threshold-Optimized Output Notation) replaces large arrays with
metadata summaries to reduce token consumption while preserving structure
information.

Backward-compatible API: ``encode_output(obj, threshold=5)`` continues to
work exactly as before.  The new ``compress()`` delegate provides access to
the full three-stage pipeline (dedup → self-scoring → budget-aware
compression) introduced in TOON v2.
"""

from typing import Any


# ════════════════════════════════════════════════════════════════════════
#  Original API — preserved exactly
# ════════════════════════════════════════════════════════════════════════

def encode_output(result: Any, threshold: int = 5) -> Any:
    """
    Encode tool output by compressing arrays exceeding threshold.

    Arrays with length > threshold are replaced with metadata:
    {
        "__toon": true,
        "count": N,
        "sample": [first 3 items]
    }

    Non-array data and arrays <= threshold are preserved unchanged.
    Recursively handles nested structures (dicts, lists).

    Args:
        result: Tool output to encode (any JSON-serializable type)
        threshold: Maximum array length before compression (default: 5)

    Returns:
        Encoded output with large arrays compressed

    Examples:
        >>> encode_output({"files": ["a", "b", "c"]}, threshold=5)
        {"files": ["a", "b", "c"]}  # Unchanged (length <= threshold)

        >>> encode_output({"files": ["a", "b", "c", "d", "e", "f"]}, threshold=5)
        {"files": {"__toon": true, "count": 6, "sample": ["a", "b", "c"]}}

        >>> encode_output({"nested": {"data": [1, 2, 3, 4, 5, 6]}}, threshold=5)
        {"nested": {"data": {"__toon": true, "count": 6, "sample": [1, 2, 3]}}}
    """
    if threshold <= 0:
        raise ValueError(f"threshold must be > 0, got {threshold}")

    return _encode_recursive(result, threshold)


def _encode_recursive(value: Any, threshold: int) -> Any:
    """
    Recursively encode a value, compressing arrays > threshold.

    Args:
        value: Value to encode
        threshold: Array length threshold

    Returns:
        Encoded value
    """
    # Handle None
    if value is None:
        return None

    # Handle lists/arrays
    if isinstance(value, list):
        # Check if array exceeds threshold
        if len(value) > threshold:
            # Compress to TOON metadata
            return {
                "__toon": True,
                "count": len(value),
                "sample": [_encode_recursive(item, threshold) for item in value[:3]],
            }
        # Preserve array, but recursively encode items
        return [_encode_recursive(item, threshold) for item in value]

    # Handle dictionaries
    if isinstance(value, dict):
        # Recursively encode all values in dict
        return {key: _encode_recursive(val, threshold) for key, val in value.items()}

    # Handle tuples (convert to list for JSON compatibility)
    if isinstance(value, tuple):
        # Treat tuples like lists
        as_list = list(value)
        if len(as_list) > threshold:
            return {
                "__toon": True,
                "count": len(as_list),
                "sample": [_encode_recursive(item, threshold) for item in as_list[:3]],
            }
        return [_encode_recursive(item, threshold) for item in as_list]

    # Primitive types (str, int, float, bool) - return unchanged
    return value


# ════════════════════════════════════════════════════════════════════════
#  New Pipeline Delegate
# ════════════════════════════════════════════════════════════════════════

def compress(
    data: Any,
    budget: int | None = None,
    query: str | None = None,
    config: Any | None = None,
) -> Any:
    """Full TOON compression via the three-stage pipeline.

    This is a thin delegate that imports and calls
    :func:`toon.pipeline.compress` so callers can access the advanced
    pipeline from either ``toon.encoder`` or ``toon.pipeline``.

    Lazy import avoids circular dependency (pipeline imports
    ``_encode_recursive`` from this module).

    Args:
        data: Tool output data. Can be a single object or list of objects.
        budget: Target token budget. ``None`` = auto (50% of original).
        query: Optional query to bias relevance scoring toward.
        config: :class:`toon.pipeline.CompressConfig` instance, or ``None``
                for defaults.

    Returns:
        Compressed data (same top-level type as input).
    """
    from .pipeline import compress as _pipeline_compress  # lazy to avoid circular
    return _pipeline_compress(data, budget=budget, query=query, config=config)
