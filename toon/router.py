"""TOON field router — predicate matching and action dispatch.

Two public entry-points:

*   ``field_matcher_matches(matcher, field_path, value)`` — evaluate a
    single :class:`~toon.config.FieldMatcher`.
*   ``route_field(field_path, value, config)`` — walk the full priority
    chain and return an action string.

No imports from pipeline internals (bmx_plus, sagerank, etc.).
"""

from __future__ import annotations

import re
from typing import Any

from .config import FieldMatcher, ToonConfig


# ════════════════════════════════════════════════════════════════════════
#  Matcher evaluation
# ════════════════════════════════════════════════════════════════════════

def field_matcher_matches(
    matcher: FieldMatcher,
    field_path: str,
    value: Any,
) -> bool:
    """Evaluate whether *matcher* accepts the given field.

    All specified (non-``None``) conditions are AND-ed.  A matcher whose
    every attribute is ``None`` matches unconditionally.

    Args:
        matcher: The predicate to test.
        field_path: Dot-delimited path to the field, e.g.
            ``"payload.output"``.
        value: The runtime value stored at *field_path*.

    Returns:
        ``True`` if **all** specified conditions pass.
    """
    # ── field_path: exact match OR dot-prefix match ──
    if matcher.field_path is not None:
        if field_path != matcher.field_path:
            # Prefix check: matcher "payload" should match "payload.output"
            # but NOT "payload_extra".  We require the candidate to start
            # with "<matcher.field_path>." so segment boundaries are respected.
            if not field_path.startswith(matcher.field_path + "."):
                return False

    # ── field_pattern: regex against the last path segment ──
    if matcher.field_pattern is not None:
        last_segment = field_path.rsplit(".", maxsplit=1)[-1]
        if not re.search(matcher.field_pattern, last_segment):
            return False

    # ── min_length / max_length: only evaluated for str values ──
    if matcher.min_length is not None:
        if isinstance(value, str):
            if len(value) < matcher.min_length:
                return False
        # Non-string values silently skip the length check so that
        # a min_length rule doesn't accidentally block dict/list fields.

    if matcher.max_length is not None:
        if isinstance(value, str):
            if len(value) > matcher.max_length:
                return False

    return True


# ════════════════════════════════════════════════════════════════════════
#  Route dispatch
# ════════════════════════════════════════════════════════════════════════

def route_field(
    field_path: str,
    value: Any,
    config: ToonConfig,
) -> str:
    """Determine the compression action for a field.

    Priority (highest → lowest):

    1. **preserve_rules** — if *any* matcher hits → ``"preserve"``.
    2. **encode_rules** — first match wins → that rule's ``codec.strategy``.
    3. **default_codec** — if set → its ``strategy``.
    4. → ``"passthrough"``.

    Args:
        field_path: Dot-delimited path to the field.
        value: Runtime value at *field_path*.
        config: The active :class:`ToonConfig`.

    Returns:
        Action string: one of ``"preserve"`` | ``"truncate"`` |
        ``"dedup"`` | ``"parse_json"`` | ``"drop"`` | ``"array"`` |
        ``"passthrough"``.
    """
    # ── 0. Global kill-switch ──
    if not config.enabled:
        return "passthrough"

    # ── 1. Preserve rules (any match → preserve) ──
    for matcher in config.preserve_rules:
        if field_matcher_matches(matcher, field_path, value):
            return "preserve"

    # ── 2. Encode rules (first match wins) ──
    for rule in config.encode_rules:
        if field_matcher_matches(rule.matcher, field_path, value):
            return rule.codec.strategy

    # ── 3. Default codec ──
    if config.default_codec is not None:
        return config.default_codec.strategy

    # ── 4. Fallback ──
    return "passthrough"


# ════════════════════════════════════════════════════════════════════════
#  Self-test
# ════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    from .config import CodecConfig, EncoderRule

    print("=" * 64)
    print("toon.router — self-test")
    print("=" * 64)

    # ── Test 1: preserve_rules beat encode_rules ──
    print("\n── Test 1: preserve_rules beat encode_rules ──")

    cfg = ToonConfig(
        preserve_rules=[
            # Preserve anything whose last segment is "message"
            FieldMatcher(field_pattern=r"^message$"),
        ],
        encode_rules=[
            # Truncate long strings (would match "message" values too)
            EncoderRule(
                matcher=FieldMatcher(min_length=10),
                codec=CodecConfig("truncate", budget=50),
            ),
        ],
    )

    long_message = "A" * 200  # long string that matches both rules

    action = route_field("error.message", long_message, cfg)
    assert action == "preserve", f"Expected 'preserve', got {action!r}"
    print(f"  route_field('error.message', <200 chars>) → {action!r}  ✓")

    # Same long string under a different field name → hits encode_rule
    action2 = route_field("error.details", long_message, cfg)
    assert action2 == "truncate", f"Expected 'truncate', got {action2!r}"
    print(f"  route_field('error.details', <200 chars>) → {action2!r}  ✓")

    # ── Test 2: field_path prefix matching ──
    print("\n── Test 2: field_path prefix matching ──")

    cfg2 = ToonConfig(
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(field_path="payload"),
                codec=CodecConfig("truncate", budget=300),
            ),
        ],
    )

    action3 = route_field("payload.output", "data", cfg2)
    assert action3 == "truncate", f"Expected 'truncate', got {action3!r}"
    print(f"  route_field('payload.output', ...) → {action3!r}  ✓  (prefix)")

    action4 = route_field("payload", "data", cfg2)
    assert action4 == "truncate", f"Expected 'truncate', got {action4!r}"
    print(f"  route_field('payload', ...) → {action4!r}  ✓  (exact)")

    # "payload_extra" must NOT match "payload" prefix
    action5 = route_field("payload_extra", "data", cfg2)
    assert action5 == "passthrough", f"Expected 'passthrough', got {action5!r}"
    print(f"  route_field('payload_extra', ...) → {action5!r}  ✓  (no false prefix)")

    # ── Test 3: min_length / max_length gating ──
    print("\n── Test 3: min_length / max_length gating ──")

    cfg3 = ToonConfig(
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(min_length=100, max_length=1000),
                codec=CodecConfig("truncate", budget=80),
            ),
        ],
    )

    short_val = "short"
    action6 = route_field("field", short_val, cfg3)
    assert action6 == "passthrough", f"Expected 'passthrough', got {action6!r}"
    print(f"  route_field('field', {short_val!r}) → {action6!r}  ✓  (too short)")

    medium_val = "x" * 500
    action7 = route_field("field", medium_val, cfg3)
    assert action7 == "truncate", f"Expected 'truncate', got {action7!r}"
    print(f"  route_field('field', <500 chars>) → {action7!r}  ✓  (in range)")

    huge_val = "y" * 2000
    action8 = route_field("field", huge_val, cfg3)
    assert action8 == "passthrough", f"Expected 'passthrough', got {action8!r}"
    print(f"  route_field('field', <2000 chars>) → {action8!r}  ✓  (too long)")

    # Non-string value: length checks silently pass (not applicable)
    action9 = route_field("field", 42, cfg3)
    assert action9 == "truncate", f"Expected 'truncate', got {action9!r}"
    print(f"  route_field('field', 42) → {action9!r}  ✓  (non-str skips length)")

    # ── Test 4: default_codec fallback ──
    print("\n── Test 4: default_codec fallback ──")

    cfg4 = ToonConfig(
        default_codec=CodecConfig("array"),
    )

    action10 = route_field("anything", [1, 2, 3], cfg4)
    assert action10 == "array", f"Expected 'array', got {action10!r}"
    print(f"  route_field('anything', ...) → {action10!r}  ✓  (default_codec)")

    # ── Test 5: enabled=False kill-switch ──
    print("\n── Test 5: enabled=False kill-switch ──")

    cfg5 = ToonConfig(
        enabled=False,
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(),  # matches everything
                codec=CodecConfig("drop"),
            ),
        ],
    )

    action11 = route_field("any.field", "value", cfg5)
    assert action11 == "passthrough", f"Expected 'passthrough', got {action11!r}"
    print(f"  route_field(..., enabled=False) → {action11!r}  ✓  (kill-switch)")

    # ── Test 6: AND logic — multiple conditions ──
    print("\n── Test 6: AND logic — multiple matcher conditions ──")

    cfg6 = ToonConfig(
        encode_rules=[
            EncoderRule(
                matcher=FieldMatcher(
                    field_pattern=r"output$",
                    min_length=50,
                ),
                codec=CodecConfig("truncate", budget=40),
            ),
        ],
    )

    # Pattern matches, but string is too short → no match
    action12 = route_field("payload.output", "tiny", cfg6)
    assert action12 == "passthrough", f"Expected 'passthrough', got {action12!r}"
    print(f"  route_field('payload.output', 'tiny') → {action12!r}  ✓  (AND: length fails)")

    # Pattern matches AND string is long enough → match
    action13 = route_field("payload.output", "x" * 100, cfg6)
    assert action13 == "truncate", f"Expected 'truncate', got {action13!r}"
    print(f"  route_field('payload.output', <100 chars>) → {action13!r}  ✓  (AND: both pass)")

    # String is long enough but pattern doesn't match → no match
    action14 = route_field("payload.input", "x" * 100, cfg6)
    assert action14 == "passthrough", f"Expected 'passthrough', got {action14!r}"
    print(f"  route_field('payload.input', <100 chars>) → {action14!r}  ✓  (AND: pattern fails)")

    # ── Test 7: Zero-arg ToonConfig works ──
    print("\n── Test 7: ToonConfig() with no arguments ──")

    bare = ToonConfig()
    action15 = route_field("foo", "bar", bare)
    assert action15 == "passthrough", f"Expected 'passthrough', got {action15!r}"
    print(f"  ToonConfig() → route_field → {action15!r}  ✓")

    # ── Done ──
    print()
    print("=" * 64)
    print("All tests passed.")
    print("=" * 64)

