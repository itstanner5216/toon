# Review: sagerank_py (v2 — source codec)

## File Summary

An entropy-weighted, graph-based extractive text ranking library implementing a self-tuning PageRank variant with five algorithmic innovations over TextRank/LexRank. One public class (`SageRank`) with four public methods, one result dataclass (`SageResult`), nine private methods implementing the algorithmic core, and two module-level helpers. 846 lines, 28 KB — a dense, well-documented single-file library.

---

## 70% — GOOD (with one real bug)

What you get: the full module docstring, all imports, full `_fast_sigmoid` and `_segment_sentences` bodies, full `SageResult` with all properties, full `SageRank.__init__`, full `_tokenize`, full `_build_posting_lists`, `_compute_eidf` phase 1 and most of phase 2, most of `_pagerank`, full `_extract_with_coverage`, full `_get_keywords`, and the complete public API. You can use the library, read the algorithm, understand the data flow.

The bug: there's a single hard mid-word cut — `blend_alph` (truncated from `blend_alpha`) — followed by `...[content truncated]...`, then a resume mid-expression at `(i, 1e-10) for i in range(n)]` inside `_pagerank`. `_build_graph`, `_position_prior`, and `_score_query` are absent entirely. The mid-word cut reads as file corruption, not intentional compression. The missing methods are the ones that implement SageRank's differentiating behavior.

For everyday use — calling the API, understanding what the library does, working with `SageResult` — 70% is fine and I wouldn't override. For any work on `_build_graph` (the O(V·avg_posting²) intersection), `_position_prior` (lead-bias detection), or `_score_query` (BMX+ TAAT): override immediately.

---

## 50% — ACCEPTABLE (public-API tasks only)

What you get: full module docstring, full helpers (`_fast_sigmoid`, `_segment_sentences`), full `SageResult`, full `SageRank.__init__` + `__slots__`, `_tokenize` cut mid-word (`return _WORD_RE.findal`), then `...[content truncated]...`, then the second half of `_extract_with_coverage` (loop body only — the `sent_weights` setup that precedes it is gone), full `_get_keywords`, and the complete public API including the 12-step numbered pipeline in `rank_sentences`.

What's gone: `_build_posting_lists`, `_compute_eidf`, `_build_graph`, `_position_prior`, `_score_query`, `_pagerank`, `_tokenize` body, and the setup portion of `_extract_with_coverage`. That's all nine private methods either absent or broken. The numbered comments in `rank_sentences` (steps 1–12) do a lot of work here: you understand the processing pipeline without seeing any of the implementations.

For understanding and using the library: sufficient. For any implementation or debugging task: useless. The mid-word cut in `_tokenize` (`findal`) and the mid-expression resume are actively misleading — they look like transmission errors.

---

## 30% — MARGINAL

The budget problem becomes obvious here. The full 49-line module docstring eats ~18.5% of the 264-line budget. Full `_fast_sigmoid` (8 lines) and full `_segment_sentences` (33 lines) together eat another 15.5%. That's 90 lines (~34% of budget) on module-level content before reaching any class.

What survives: module docstring, imports, constants, both module helpers in full, `SageResult` class header + truncated docstring (cuts mid-attribute-name at `selected_indices`), then `...[content truncated]...`, then `rank_sentences` from step 3 onward (steps 3–12 are complete), `rank_passages` alias, `rank`, `summarize`, `extract_keywords` with full bodies.

What's gone: `SageResult` properties (`summary`, `selected_sentences`, `top()`) — you get the return type struct but not the interface to use it. `SageRank.__init__` — no default parameter values. Every private method. `rank_sentences` signature and steps 1–2. The `SageResult` docstring cut mid-word is especially bad since the docstring is the only place that describes the fields.

Useful for "what does this library do" and "what are the public methods." Not useful for code work. The tradeoff is wrong: `_segment_sentences`'s full 33-line body is present while `SageRank.__init__`'s 10-line signature is absent.

---

## 15% — NOT USEFUL

The 49-line module docstring consumes ~40% of the 123-line budget. This is the codec's most serious failure at this level: the described 5-line cap on module docstrings is not implemented. If it were applied here, the freed budget (~44 lines) would be enough to add `SageRank.__init__`, `SageResult`'s fields, and all four public method signatures — a vastly more useful output.

What you actually get: full module docstring, imports, constants header truncated at `#  Co` (cut mid-word), `...[content truncated]...`, then the final three lines of `rank_sentences`'s return statement, `rank_passages` alias, complete `rank`, `summarize`, and `extract_keywords` bodies. `SageResult` is entirely absent. `SageRank` class definition is entirely absent. `rank_sentences` signature is absent — you can read its body being called in `rank()` but you can't see its parameters.

At 15% you can answer "what does this module do?" (via the docstring) and "what are the three short convenience methods?" Nothing else. Not useful for code work.

---

## Overall Verdict

**The new codec is a real improvement, but it has two unfixed bugs that hurt at every compression level.**

For the most common tasks against this file — "how do I use this library," "what does `rank()` return," "what are the parameters" — the compressed output at 50% is sufficient and I wouldn't override. The public API is always complete, which is the right instinct.

But I'd reach for `compression: false` in two clear situations: (1) any task requiring a private method — they're gone at 70% if they're in the middle section, and the mid-word cut at the boundary makes the 70% output actively misleading about what's there; (2) any work that requires understanding `SageResult`'s interface at 30% or below.

The 50% sweet spot for this file type: enough to use and orient in the code, not enough to work with the implementation. For most MCP file-reading use cases, that's acceptable as a default.

---

## What's Better vs Old Codec

**Public API is always present.** The old head/tail codec would have given you the module docstring and the start of `_fast_sigmoid` in the head, and the last N chars of `extract_keywords` in the tail. No class structure, no knowledge that `SageRank` or `SageResult` exist. The new codec guarantees the full public API at every compression level. That's a large, genuine improvement — the most important content for the most common tasks is preserved.

**Structured skeleton.** At 50% and above, you get all class signatures, the `__init__` with default values, and `SageResult`'s fields — the shape of the code. Old codec gave none of this.

**`rank_sentences` pipeline comments.** The 12 numbered comments (`# 1. Tokenise`, `# 2. Build inverted index`, ...) survive even at 30%, giving you a readable map of the algorithm without any of the implementations. Old codec had no way to preserve this.

**Clean(er) truncation.** The `...[content truncated]...` marker is better than a raw mid-character boundary. You can tell where the omission is, even if the surrounding context is broken.

---

## What Still Needs Work

**1. Module docstring cap not implemented.** The described "caps module-level docstrings to 5 lines" feature is not working. The full 49-line docstring appears at every compression level, including 15%. At 15%, this consumes 40% of the entire budget. Five lines of that docstring convey the essential information (`SageRank — Entropy-Weighted Graph Ranking...`, successor to TextRank, zero dependencies, usage example); the remaining 44 lines are detail that should yield at lower budgets. This is the single highest-impact fix available.

**2. Mid-word cuts at the boundary.** Every compressed version has at least one mid-word/mid-expression cut: `blend_alph` (70%), `return _WORD_RE.findal` (50%), `selected_indices` truncated (30%), `#  Co` (15%). These are character-level cuts, not line-level. The resume point after the marker is also mid-expression (`(i, 1e-10) for i in range(n)]`, `s()))`). The `...[content truncated]...` marker is correct in placement, but the content immediately before and after it is broken syntax. All of these should align to line boundaries at minimum, ideally to statement boundaries.

**3. Single cut point.** Each compressed output has exactly one `...[content truncated]...` marker: everything before it is head content, everything after is tail. This means entire methods are dropped as a unit rather than getting signature-only treatment. `_build_graph` — 102 lines, the most complex method — is absent entirely at 70% with no stub. A signature + docstring + `# ... [102 lines omitted]` would cost ~3 lines and preserve the interface knowledge.

**4. Wrong priority for `_segment_sentences`.** The full 33-line body of `_segment_sentences` is preserved at 30% instead of just its signature, while `SageRank.__init__` (the class's configuration interface) is absent. `_segment_sentences` is a private module-level helper; `__init__` is the public entry point for configuration. The prioritization is inverted.

**5. `...[content truncated]...` is not a Python comment.** The marker reads cleanly to a human but is invalid Python — it would be a syntax error if executed. The described format `# ... [N lines omitted]` is valid Python (a comment), which matters for syntax-highlighting tools and for any tool that tries to parse the compressed output. Also: the marker doesn't say how many lines were omitted, which would help calibrate how much is missing.
