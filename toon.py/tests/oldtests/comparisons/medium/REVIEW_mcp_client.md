# Review: mcp_client_py (v2 — source codec)

## File Summary

`mcp_client.py` — 807 lines, 33K chars. A single class `MCPClientManager` that manages the full lifecycle of async MCP connections across stdio, SSE, and Streamable HTTP transports. Key subsystems: concurrent discovery, lazy on-demand loading with double-checked locking, exponential-backoff watchdog for always-on servers, unified transport negotiation (Streamable HTTP → SSE fallback), security layer (command allowlist, SSRF protection, env filtering), and structured shutdown. Rich module docstring lists 5 explicit design improvements over the prior version.

---

## 70% — SOLID

This is genuinely impressive. At 575 lines you get:

**Fully intact:** all imports, all module-level constants (`DEFAULT_ALLOWED_COMMANDS`, `PROTECTED_ENV_VARS`, `_BACKOFF_BASE`, `_BACKOFF_CAP`, `_PRIVATE_RANGES`), all five module-level helper functions including full bodies (`_get_allowed_commands`, `_validate_command`, `_validate_url`, `_filter_env`, `_is_transient_error`), the full `__init__` with all 14 instance variables, `cleanup_server_state`, the entire 52-line `_negotiate_http_transport` implementation (including the Streamable HTTP → SSE fallback logic with nested stack isolation), `_discover_server`, `_discover_http`, `add_pending_server`, the complete `get_or_create_client` with double-checked locking, `record_usage`, `start_idle_checker`, the entire 70-line `start_always_on_watchdog` backoff implementation, `create_clients`, and `close`.

**Elided with markers:** the inner `_lifecycle` task body (64 lines — the actual connection setup coroutine), `_discover_one` inner body (22 lines), `_discover_stdio` partial (always_on branch, 22 lines), `_parse_tool_filter` (8 lines), `_stop_server_lifecycle` (17 lines), `_disconnect_idle_servers` (25 lines), `_start_supervision` and `_supervise` (38 lines total).

**One real loss:** the module docstring is capped at 4 lines then `# ... [23 docstring lines omitted]`. The 5-point numbered improvement summary — concurrent discovery, dedup transport negotiation, backoff watchdog, error classification, per-server stack isolation — is exactly what you'd want context for when reading this file. Losing it at every compression level is a miss.

**Verdict:** For 80–85% of "read this file" tasks this is more than sufficient. You can answer: what does this class do, what's its API, how does lazy loading work, how does the watchdog backoff work, how does transport fallback work, what's the security model, how does shutdown sequence. What you can't answer: exactly how the `_lifecycle` coroutine wires up the connection and registers it with the manager. That's the one genuinely important gap.

---

## 50% — GOOD (with one notable regression)

At 423 lines (actual 51%) the picture shifts. The algorithm has to cut more aggressively and the prioritization gets uneven.

**Still fully intact:** all imports, all constants, `__init__`, `cleanup_server_state`, `add_pending_server`, `get_or_create_client` (complete double-checked locking pattern), `record_usage`, `start_idle_checker`, `start_always_on_watchdog` (complete, all 70 lines), `create_clients`, `close`.

**Now elided:** `_validate_url` body (gone — you know it validates scheme/DNS/SSRF from the docstring but can't see the IP check logic), `_negotiate_http_transport` body (the full 52-line fallback logic is gone — only signature remains), `_get_creation_lock` body (1 line, trivial loss), and all discovery method bodies (`_discover_server`, `_discover_http`, `_discover_stdio`).

**The loss that stings:** `_negotiate_http_transport` was a star at 70% — the entire cleanly-structured fallback logic visible. At 50% it becomes a stub. This is the one method the module docstring explicitly calls out as a key design improvement, and you lose it one notch below the default sweet spot.

**Verdict:** Still very usable. You understand the full API, full data model, reconnection strategy, shutdown sequence, and lazy loading pattern. The 50% version could answer a code review question, help you extend the class, or help you write integration tests for the public API. You just can't see transport negotiation internals or the exact connection-creation flow.

---

## 30% — BORDERLINE (architecture reference, not implementation guide)

At 274 lines (actual 32%) the codec is stretching thin. Interestingly, `__init__` is still fully preserved — all 14 instance variables — which anchors your understanding of what state this object holds. `cleanup_server_state` is fully preserved. `close` is fully preserved (35 lines of careful shutdown sequencing). All signatures and docstrings for every method.

**What's newly gone:** `start_always_on_watchdog` body (the complex backoff algorithm, 64 lines), `create_clients` body (25 lines), `get_or_create_client` partial (fast path preserved, slow path cut at `# ... [17 lines omitted]`), `start_idle_checker` body.

**One actual bug:** `_negotiate_http_transport` loses its parameter list — the cut happens mid-signature: `async def _negotiate_http_transport(` → immediately `# ... [53 lines omitted]`. You don't even know what arguments it takes. Every other method preserves its full signature. This is inconsistent and fixable.

**Odd priority call:** `close` (35 lines, the teardown) is fully preserved while `create_clients` (25 lines, the primary entry point) is a stub. For someone trying to use or understand the class, `create_clients` is more important.

**Verdict:** Good for orientation — "what's in this file, what methods exist, what state does the class hold." Not good for "how do I use this" or "how does X work internally." You'd reach for `compression: false` anytime you need to actually work with the code.

---

## 15% — MARGINAL (better than nothing, barely)

At 171 lines (actual 19% — already overshooting the 15% budget) you have: all constants fully preserved, all method signatures and first docstring lines, nothing else.

**`__init__` is gone** — reduced to `# ... [25 lines omitted]`. You can't see the constructor signature. Constructing `MCPClientManager` from this output requires guessing at params (though the signature `def __init__(self, max_concurrent_connections, connection_timeout, on_server_disconnected)` is in the original — losing it at 15% is a real problem).

**The constants budget problem:** `PROTECTED_ENV_VARS` alone is ~20 lines with inline comments, `_PRIVATE_RANGES` is 5 lines. Together they eat ~25 of your 171 lines to preserve a security blocklist. That's a lot of budget for something that doesn't help you understand the class API. At extreme compression, these constants are arguably less valuable than the `__init__` signature.

**What's genuinely useful:** a complete method roster with single-line docstrings. You can see every method name, its signature (with the one exception noted above), and what it does. That's enough to know where to look if you then ask for the file uncompressed. It's a reliable table of contents.

**Verdict:** Useful as a fast "what's in here?" scan. Not useful for any actual work. Better than nothing, but not by much. The `_negotiate_http_transport` mid-signature cut still appears here, which is the codec's most visible rough edge.

---

## Overall Verdict

**Default compression (70%) is good enough most of the time.** This is a meaningful claim — for this 807-line file with real complexity, the 70% version preserves the full data model, all security logic, the complete watchdog implementation, the complete transport negotiation, the complete lazy-loading pattern with its double-checked lock, and the full shutdown sequence. The previous codec would have given you a head/tail slice that almost certainly cut mid-class and showed you none of the key methods.

**How often would I reach for `compression: false`?** At 70%: maybe 10–15% of the time — specifically when I need to see the `_lifecycle` inner coroutine body (how connections are actually established and registered). At 50%: more like 35% — whenever transport negotiation details or discovery internals matter. At 30%+: majority of the time for any real work.

**For use as MCP middleware default:** 70% works as a default. 50% is acceptable for orientation tasks. Below 50%, you'd want to encourage override for any file with meaningful implementation logic.

---

## What's Better vs Old Codec

The old head/tail truncator on an 807-line file at 70% budget (~24K chars) would have given you a contiguous slice — probably the module docstring, imports, constants, and maybe the first 2–3 methods, then nothing. You'd have no idea `MCPClientManager` existed or what it looked like. At 15%, you'd get the first ~5K chars (everything before the class definition) and the last ~500 chars (end of `close`).

The new codec at every level gives you:
1. A complete structural map — every method is present, either with body or a clean `# ... [N lines omitted]` marker
2. The `__init__` fully preserved through 30% — anchoring your understanding of class state
3. Docstrings for everything, so omitted bodies aren't mysteries
4. Intelligent body selection — the watchdog and transport negotiation code survives at 70–50% because it's genuinely the interesting part, not just because it happens to be at the top of the file

This is a real, substantive improvement. The difference between "the file is incomprehensible" and "the file is readable with gaps" is the whole ballgame for an AI reading code.

---

## What Still Needs Work

1. **Mid-signature cut on `_negotiate_http_transport` at 30%+:** `async def _negotiate_http_transport(` then immediately `# ... [53 lines omitted]`. Every other method preserves its full signature. This should be fixable — signatures should be atomic units.

2. **Module docstring cap cuts the design rationale:** The 5-line cap chops the numbered improvement list at line 4. These numbered points aren't filler — they explain *why* the code is structured the way it is. Consider treating the module-level docstring differently from function docstrings, or raising the cap to ~10 lines for module docs.

3. **`create_clients` deprioritized vs `close` at 30%:** `create_clients` is the primary public entry point for using this class. At 30%, it's a stub while `close` is fully preserved. Priority scoring should weight primary entry points above teardown helpers.

4. **Constants eating budget at 15%:** `PROTECTED_ENV_VARS` (~20 lines) and `_PRIVATE_RANGES` (~5 lines) consume 15% of the 15%-budget output. At extreme compression, preserving the `__init__` signature matters more than the full env-var blocklist. The codec might consider abbreviating large constant values (not their names) at ≤20% budgets.
