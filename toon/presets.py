"""Pre-built TOON configurations for common use-cases.

Each preset is a fully-specified :class:`~toon.config.ToonConfig` that can
be used directly or deep-copied and tweaked::

    from toon.config import ToonConfig

    cfg = ToonConfig.preset("codex_logs")
    cfg.string.default_budget = 600  # customise after copy
"""

from __future__ import annotations

from .config import (
    BMXConfig,
    CodecConfig,
    DedupConfig,
    EncoderRule,
    FieldMatcher,
    ToonConfig,
)

# ════════════════════════════════════════════════════════════════════════
#  Preset definitions
# ════════════════════════════════════════════════════════════════════════

PRESETS: dict[str, ToonConfig] = {

    # ── generic ────────────────────────────────────────────────────────
    # Safe default: only compresses long strings.  Good starting point
    # when you don't know the shape of the tool output.
    "generic": ToonConfig(
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(min_length=500),
                codec=CodecConfig("truncate", budget=400),
            ),
        ],
    ),

    # ── codex_logs ─────────────────────────────────────────────────────
    # Tuned for Codex-style agent traces where ``payload.output`` and
    # ``payload.arguments`` carry the bulk of the tokens, and
    # ``message`` / ``reasoning`` must be kept verbatim.
    "codex_logs": ToonConfig(
        preserve_rules=[
            FieldMatcher(field_pattern=r"(message|reasoning)$"),
        ],
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(field_path="payload.output"),
                codec=CodecConfig("truncate", budget=400),
            ),
            EncoderRule(
                matcher=FieldMatcher(field_path="payload.arguments"),
                codec=CodecConfig("parse_json"),
            ),
            EncoderRule(
                matcher=FieldMatcher(
                    field_pattern=r"(output|stdout|stderr)$",
                ),
                codec=CodecConfig("truncate", budget=300),
            ),
        ],
    ),

    # ── mcp_responses ──────────────────────────────────────────────────
    # MCP (Model Context Protocol) tool responses: preserve structural
    # metadata fields, compress only genuinely large payloads.
    "mcp_responses": ToonConfig(
        preserve_rules=[
            FieldMatcher(
                field_pattern=r"(error|status|message|id|type)$",
            ),
        ],
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(min_length=1000),
                codec=CodecConfig("truncate", budget=500),
            ),
        ],
    ),

    # ── aggressive ─────────────────────────────────────────────────────
    # Maximum compression: enables BMX+ scoring and applies tight
    # truncation to anything ≥ 200 characters.
    "aggressive": ToonConfig(
        bmx=BMXConfig(enabled=True),
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(min_length=200),
                codec=CodecConfig("truncate", budget=200),
            ),
        ],
    ),
}

