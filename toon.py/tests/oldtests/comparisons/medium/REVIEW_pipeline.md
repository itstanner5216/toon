# Review: pipeline_py (v2 — source codec)

## File Summary
`pipeline.py` is the core TOON compression pipeline: a 3-stage orchestrator (dedup → 5-phase centrality/relevance scoring → budget-aware compression) with a public `compress()` API, a streaming `TOONCompressor` class, a heavily-documented `CompressConfig` dataclass, and a substantial `if __name__ == "__main__"` integration test block (~250 lines of synthetic test data and assertions).

---

## 70% — USEFUL WITH CAVEATS

Genuinely readable. All imports survive. `CompressConfig` is fully intact — every field and its inline docstring. Both dataclasses. `TOONCompressor` with full `__init__`, `feed`, and `reset` bodies. `compress()` body in full. The section banners (`# ════...`) are preserved, so the file structure is navigable.

Where it falls down: `_score_entries` is cut mid-function after Phase 2. You see the BMX+ index construction, the SageRank path, the large-corpus hybrid, but then `# ... [106 lines omitted]` swallows the Gini check, hubness capping, Kneedle knee-detection, Phase 4 relevance, and the full tier assignment logic — the back half of the algorithm. The remaining three private functions (`_compress_entries`, `_compress_entry`, `_compress_dict`) show only `def name(\n    # ... [N lines omitted]` with no parameter list visible. That's not a signature, it's a stub.

Meanwhile the entire `if __name__ == "__main__"` test block is fully intact — five integration tests including the 10K entry performance loop, all synthetic data literals, all assertions. It's 250+ lines of test harness. The codec spent most of the freed budget keeping this verbatim. That's backwards.

Two correctness bugs: (1) The `# ... [3 docstring lines omitted]` marker is placed *inside* the triple-quoted module docstring, which is never closed — invalid Python. The omitted lines include "Zero external dependencies. Pure Python.", the most useful summary sentence. (2) The `if __name__ == "__main__":` guard line itself is dropped, so `import json` and `import time` appear floating after `_compress_dict`'s omit marker with no enclosing `if` block — the output looks like those imports live inside `_compress_dict`.

**Net**: You can orient yourself, understand the public API, and read the config surface. You cannot fully trace the scoring algorithm, and the private function stubs are useless for implementation work.

---

## 50% — MARGINAL

`compress()` body survives intact (correctly prioritized). `TOONCompressor` methods survive. That's the good news. `CompressConfig` truncates mid-field at `string_budget_ratio` — you lose `stack_trace_max_user_frames`, `tier_ratios`, `min_entries_for_scoring`, `sagerank_top_k`, `preserve_fields`, `encode_fields`. The last two are especially important; they control what fields get preserved vs encoded. `ScoredEntries` and `CompressedOutput` both show `# ... [N lines omitted]` for their field lists — you can't see what the data contracts contain.

`_score_entries`, `_compress_entries`, `_compress_entry`, `_compress_dict` — all completely gutted, just `def name(\n    # ... [N lines omitted]`. No parameter lists, no return types, no bodies.

The entire `__main__` test block is still fully preserved, identical to the 70% version. It is the single largest surviving section, bigger than `compress()` and `TOONCompressor` combined. This is the wrong trade.

**Net**: Useful for "what does this module expose?" but not for "how does any of this work". The missing half of `CompressConfig` and the missing data-contract field lists are practical gaps even for read-only tasks.

---

## 30% — USELESS

Target 30%, floor hits at 36% (10,764 chars). Every function body is gone: `compress()`, `_score_entries`, `_compress_entries`, `_compress_entry`, `_compress_dict` — all show only `def name(\n    # ... [N lines omitted]`. `CompressConfig` is one docstring line + `# ... [61 lines omitted]`. `TOONCompressor` shows method signatures but `# ... [2-7 lines omitted]` for every body.

The `if __name__ == "__main__"` test block: **fully preserved, line for line identical to the 50% version.** All five tests. All synthetic data literals. All assertion chains. The test block alone accounts for the bulk of the surviving content.

This is a direct inversion of what matters. The budget has been spent keeping test scaffolding that demonstrates the API, while stripping the implementation that defines it. You cannot answer a single question about how scoring, compression, dedup, or field routing works from this output.

---

## 15% — USELESS (and identical to 30%)

Budget target: 4,372 chars. Actual: 10,764 chars — identical to 30%, no further compression occurred. The codec has hit a hard floor: the test block alone exceeds the 15% budget, so the output cannot shrink. This means any request under roughly 36% produces the same useless artifact regardless of how small a target you specify.

The 15% output is byte-for-byte the same file as 30%. If a caller passes `budget=15` expecting aggressive compression, they get 36%. There is no feedback that this happened.

---

## Overall Verdict

**Compressed is good enough as the default at 70%; below that, reach for `compression: false`.**

At 70% this is a real improvement — you can navigate the file, read the public API, understand the config surface, and see what the module exports. For quick orientation or answering "does this file have what I need?", 70% works. For deep algorithm work you'll still want the full file, but it's not the constant frustration the old codec was.

At 50% it's marginal but not worthless — you still have all signatures and the main `compress()` body. Whether it's good enough depends on your task.

At 30% and 15% it's broken, and the fact that they're identical is its own problem: a caller who asks for 15% compression doesn't know they got 36%.

**The root cause**: the codec is misclassifying `if __name__ == "__main__"` blocks as high-priority content. Test harness code densely references the module's own identifiers (`compress`, `TOONCompressor`, `encode_output`, etc.), which likely scores high for relevance. But it's the lowest-value section in the file for anyone trying to understand, use, or modify the implementation. Until that's fixed, source files with large `__main__` blocks will always compress poorly — the test body holds the floor hostage.

---

## What's Better vs Old Codec

- **All function/class signatures survive** at every level. Old head/tail at 50% on an 816-line file would give you ~lines 1–204 and lines 612–816, losing all class definitions and function signatures in the middle. New codec preserves the skeleton regardless of budget.
- **`compress()` body prioritized correctly** — the main public entry point is intact at 70% and 50%.
- **Clean omit markers** — `# ... [N lines omitted]` with accurate line counts instead of mid-word cuts. You know exactly what you're missing.
- **Section banners preserved** — the `# ════...` structural markers survive, giving file-level navigation even at 30%.
- **No mid-token cuts** — every retained line is syntactically intact.

## What Still Needs Work

- **`if __name__ == "__main__"` classification**: The guard line is dropped but the body is kept, and it eats the entire budget at 30%/15%. The codec needs to treat `__main__` blocks as low-priority epilogues, not first-class content.
- **Docstring omit marker inside the open triple-quote**: `# ... [N lines omitted]` inside a `"""` that was never closed is invalid Python. The closing `"""` must be emitted before the marker.
- **`__main__` guard line itself must be preserved if any body is kept**: Floating `import json` with no `if __name__` guard is confusing and syntactically misleading.
- **Function signatures are missing from stubs**: `def _compress_entries(\n    # ... [44 lines omitted]` doesn't tell you what parameters the function takes. At minimum the parameter list should survive even when the body is dropped.
- **The 36% hard floor**: 30% and 15% produce identical output. The codec needs to either be able to reach lower targets by aggressively pruning the test block, or it should emit a warning/indicator that the target was not achieved.
- **`CompressConfig` field-level truncation at 50%**: The last 6 fields (`tier_ratios`, `preserve_fields`, `encode_fields`, etc.) are cut at 50%. These are behaviorally important — they control what the pipeline actually does. They should survive until at least 30%.
