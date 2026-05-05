# Review: bmx_index_py (v2 — source codec)

## File Summary

Single-class Python module, 791 lines / ~29,600 chars. Implements the BMX entropy-weighted lexical search algorithm as a `@dataclass`. Structure: an 80-line module-level docstring (with math formulas, benchmarks, and usage examples), imports, then the `BMXIndex` class containing: field declarations, `__post_init__`, tokenization, core math primitives (`_sigmoid`, `_shannon_entropy`, `_compute_alpha/beta`, `_compute_term_entropies`, `_flush_dirty_entropies`), the scoring engine (`_score_document`, `_compute_score_max`), the two primary entry points (`build_index`, `search`), incremental updates (`update_index`, `remove_from_index`), diagnostics (`get_index_stats`, `clear`), and BMXF field-weighted variants (`build_field_index`, `search_fields`).

---

## 70% — BROKEN

**Functions present:** `__post_init__`, `_tokenize`, `_sigmoid`, `_shannon_entropy`, `_compute_alpha`, `_compute_beta`, `_compute_term_entropies`, `_flush_dirty_entropies`, `_compute_score_max`, `update_index`, `remove_from_index`, `get_index_stats`, `clear`, `build_field_index`, `search_fields`.

**Functions missing: `build_index`, `search`, `_score_document`.**

This is a hard fail. At 70% budget you have dropped the two functions explicitly named as top priority in the codec spec — `build_index` and `search` — plus `_score_document`, which contains the actual BMX scoring formula in code. These three are the entire reason this file exists. An AI asked "how does search work?" or "what does build_index do step by step?" would have to answer "I don't know — that code isn't here."

The module-level docstring is preserved in **full** — all 79 lines — which contradicts the stated "cap to 5 lines" behaviour. It is approximately 3,000 chars of math notation, benchmark numbers, and a usage example. At 70% that is ~14% of the total budget consumed by the module docstring alone. The docstring preservation is a legitimate call in isolation, but the budget that should have gone to `build_index` and `search` clearly did not.

The output is usable for understanding internal helper methods and the incremental-update machinery. It is not usable for understanding, testing, or modifying what this class actually does for callers. You would need `compression: false` for any task involving `build_index` or `search`.

---

## 50% — STILL BROKEN, MORE SO

**Functions present:** `__post_init__`, `_tokenize`, `_sigmoid`, `_shannon_entropy`, `remove_from_index`, `get_index_stats`, `clear`, `build_field_index`, `search_fields`.

**Functions missing: `build_index`, `search`, `_score_document`, `_compute_alpha`, `_compute_beta`, `_compute_term_entropies`, `_flush_dirty_entropies`, `_compute_score_max`, `update_index`.**

The module-level docstring is still fully intact. The entire BMX scoring math — the thing the paper, the docstring, and the module comment are all describing — is gone from the actual code. The lazy entropy machinery is invisible. `update_index` is gone too.

What is left: Shannon entropy and sigmoid helpers (pointless without the scorer that calls them), the remove/stats/clear housekeeping methods, and the BMXF field-weighted wrapper. The selection makes no coherent sense. Someone reading this would understand that BMX uses entropy-weighted scoring from the docstring, but could not tell you how that scoring is implemented, how you build an index, or how you run a query.

Not useful for working with this code. `compression: false` required for anything real.

---

## 30% — DOCSTRING ANCHOR, HUSK OF A CLASS

**Functions present:** `get_index_stats`, `clear`, `build_field_index`, `search_fields`.

The module docstring is still largely intact — approximately 3,000 chars out of an 8,896-char budget, meaning **34% of the entire budget is consumed by the module docstring alone**. The class declaration and all field annotations are gone. `__post_init__` is gone. Every math primitive, every index-building function, every scoring function — gone. `search` is absent. `build_index` is absent.

What remains: the BMX algorithm description in docstring form, a diagnostics dict, a `clear()` that resets fields you cannot see were ever declared, and the BMXF wrapper — which internally calls `build_index` and `search` methods that do not exist in this output.

Useless for code work. The docstring tells you what the algorithm is, but there is no way to understand the implementation, debug it, or modify it from this output.

---

## 15% — DOCSTRING WITH ONE METHOD DANGLING AT THE END

The 4,448-char budget holds: the full 79-line module docstring (~2,900 chars — **65% of the budget**), a partial class docstring truncated mid-sentence, and then one method: `search_fields`. There is no `@dataclass` decorator, no class field declarations, no `__init__` of any kind. The class definition apparently did not fit. You get the algorithm theory and a method that references `self._field_indexes` which does not exist anywhere in this output.

This is not useful. The best you can say is that the module docstring explains what BMX is — but the old head/tail approach at 15% would have given you the same docstring plus actual import statements and the class declaration.

---

## Overall Verdict

**You would reach for `compression: false` constantly.** The two most important functions in this file — `build_index` and `search` — are absent from every single compressed level. A default-compressed read at 70%, 50%, 30%, or 15% will never show you how the index is built or how queries are executed. For any practical task — debugging, extending, reviewing, understanding the public API — you need the full file.

The codec has a narrow use case: if you only need to understand the algorithm's math and see which methods exist (the skeleton), 70% gives you that. But that is a thin slice of real use cases, and even there you are missing the two most important methods.

The right answer for this file, at any compression level that matters, is `compression: false`.

---

## What's Better vs Old Codec

- **No mid-word cuts.** The old head/tail truncator would slice sentences in the middle; the new codec produces syntactically coherent output.
- **Section headers survive.** The `# --- Tokenization ---` dividers and similar landmarks give a readable table of contents.
- **Full module docstring with math formulas.** The old codec at 30% or 15% would have cut the docstring mid-paragraph; here you get the complete algorithm description.
- **Full function bodies where present.** Every function that makes it through is complete, not truncated.
- **Dataclass field block is intact** at 70% and 50%. All internal state is visible in one place.

---

## What Still Needs Work

1. **`build_index` and `search` are missing from ALL compression levels.** These are explicitly the top-priority entry points per the codec spec. Their absence is not a tradeoff — it is a bug. Whether it is a priority scoring error, a budget allocation issue, or an ordering artifact where these functions happen to sit in a region the ranker skips, it must be fixed. A codec that claims to prioritize `build_index` and `search` and then drops both at 70% has failed its primary mandate.

2. **The module-level docstring is not capped to 5 lines.** The spec says "Caps module-level docstrings to 5 lines." This file's module docstring is 79 lines / ~2,900 chars. It is preserved in full at 70%, 50%, 30%, and 15%. At 15% it consumes 65% of the budget. The cap is either not implemented or not triggering on this file. Fixing this alone would free up massive budget for actual code at all compression levels.

3. **Prioritization is inverted in practice.** Private helpers (`_compute_alpha`, `_compute_beta`) appear in 70% and 50% while the public API methods (`build_index`, `search`) do not appear at any level. The output priority order is backwards from what was specified.

4. **At 15%, there is no class declaration.** The output starts with `from __future__ import annotations`, the module docstring, and then `def search_fields(...)` floating free with no enclosing class. Syntactically broken and semantically confusing.

5. **`_score_document` — the BMX formula in code — is absent everywhere.** The docstring describes the formula in math notation; the code that implements it is never shown at any compression level. You get the theory but never the implementation.
