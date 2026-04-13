"""TOON (Threshold-Optimized Output Notation) encoding and compression system.

This package provides two levels of tool-output compression:

1.  **Legacy API** — :func:`encode_output` replaces large arrays with TOON
    metadata summaries.  Unchanged from v1; existing call-sites continue to
    work without modification.

2.  **Full Pipeline** — :func:`compress` runs the three-stage pipeline
    (dedup → self-scoring → budget-aware compression) for deeper, content-
    aware reduction backed by BMX+ and SageRank.

Quick start::

    from toon import encode_output, compress

    # v1 behaviour (threshold-based array folding)
    encoded = encode_output(tool_result, threshold=5)

    # v2 full pipeline (BMX-guided, budget-aware)
    compressed = compress(tool_result, budget=4000, query="error timeout")

    # Streaming mode
    from toon import TOONCompressor
    compressor = TOONCompressor()
    for entry in stream:
        out = compressor.feed(entry)
        if out is not None:
            context.append(out)
"""

# ── Legacy API (backward-compatible) ──
from .encoder import encode_output

# ── Full Pipeline API ──
from .encoder import compress
from .pipeline import CompressConfig, TOONCompressor

__all__ = [
    "encode_output",
    "compress",
    "CompressConfig",
    "TOONCompressor",
]
