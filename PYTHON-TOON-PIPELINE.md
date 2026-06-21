## The Flow (in execution order, for the v2 `compress` entry point)

### Step 1: Input normalization

**File:** `toon/toon/pipeline.py:198`-205 (inside `compress`)
**What happens:** The function records whether the input was a single
object or a list. If it's not a list, wraps it in a one-element list. If
the resulting list is empty (only possible when the caller passed `[]`),
returns `data` unchanged (`toon/toon/pipeline.py:204`-205).
**Why:** The pipeline internals only operate on lists of entries, but the
public API must preserve top-level type ("`compress()` always returns the
same top-level type as input" — invariant 2 in `ARCHITECTURE.md:364`).
**Input shape:** `Any` — dict, list, str, primitive.
**Output shape:** `entries: list[Any]` + `is_single: bool`. Only an empty
input *list* short-circuits here; non-list inputs (including `None`)
become a one-element list and continue to Step 2. (A *second*
short-circuit at `toon/toon/pipeline.py:216`-217 handles the case where
dedup empties the corpus and returns `[]` for list input or `None` for
single-object input.)
**Connects to:** Step 2 (budget defaulting).

---

### Step 2: Default budget calculation

**File:** `toon/toon/pipeline.py:208`-210
**What happens:** If `budget is None`, computes
`budget = max(100, sum(estimate_tokens_obj(e) for e in entries) // 2)`.
**Why:** Without an explicit target, the pipeline aims for ~50%
compression. The 100-token floor prevents the budget from collapsing on
tiny inputs.
**Key logic:** `estimate_tokens_obj` (`toon/toon/_utils.py:91`-93)
serializes via `canonical_json` (`toon/toon/_utils.py:71`-77 — sorted keys,
no whitespace, `default=str`) then calls `estimate_tokens`
(`toon/toon/_utils.py:80`-88): `chars // 2` if the text starts with `{` or
`[`, else `chars // 4`, with a floor of 1.
**Input shape:** `entries: list[Any]`, `budget: int | None`.
**Output shape:** `budget: int`.
**Connects to:** Step 3 (Stage 1).

---

### Step 3 — Stage 1, Tier 1: Exact dedup

**File:** `toon/toon/dedup.py:99`-105 (inside `Deduplicator.deduplicate`)
The deduplicator is constructed at `toon/toon/pipeline.py:213` with
`maxsize=cfg.dedup_maxsize` (default 5000 from
`toon/toon/pipeline.py:72`-74), then `deduplicate(entries)` is invoked at
`toon/toon/pipeline.py:214`.

**What happens:** For each input entry the deduplicator computes
`exact_h = blake2b_hash(canonical_json(entry))`
(`toon/toon/dedup.py:100`). `blake2b_hash` uses `digest_size=8` →
64-bit hex (`toon/toon/_utils.py:60`-68). If the hash is already in
`self._exact_seen` (an `OrderedDict` LRU), the entry is skipped
(`stats.exact += 1`). Otherwise it's recorded and the LRU is evicted
(`toon/toon/dedup.py:104`-105, `toon/toon/dedup.py:172`-174).
**Why:** Identical entries — same canonical JSON byte for byte — never
need to appear twice.
**Key logic:**
- `canonical_json` sorts keys and uses tight separators
  (`toon/toon/_utils.py:77`), so insertion-order differences and
  whitespace don't break dedup.
- Collision probability: <2.7×10⁻⁶ at 100K entries (docstring at
  `toon/toon/_utils.py:62`-65 and `ARCHITECTURE.md:245`).
- LRU eviction pops oldest first (`toon/toon/dedup.py:173`).
**Input shape:** raw entries (`list[Any]`).
**Output shape:** continues to Tier 2 only for entries that survive.
**Connects to:** Step 4 (Tier 2).

---

### Step 4 — Stage 1, Tier 2: Near-duplicate dedup (dicts and strings)

**File:** `toon/toon/dedup.py:108`-131
**What happens:** Only entries that passed Tier 1 are checked.

- **Dict path** (`toon/toon/dedup.py:108`-123):
  - `normalized = normalize_value(entry)` — recursively replaces
    timestamps, UUIDs, IPs, big numbers, base64 blobs with placeholder
    tokens, and replaces every int/float with the literal string
    `<NUM>` (`toon/toon/_utils.py:40`-57).
  - `content_h = blake2b_hash(canonical_json(normalized))`.
  - Skip if seen; otherwise record + evict.
  - Also computes `schema_h = blake2b_hash(canonical_json(sorted(entry.keys())), digest_size=4)`
    (32-bit) and appends `len(unique)` (the next position in the
    survivors list) into `self._schema_groups[schema_h]` for Tier 3
    (`toon/toon/dedup.py:118`-123). `entry_meta["template_id"] = schema_h`
    is set.
- **String path** (`toon/toon/dedup.py:125`-131):
  - `content_h = blake2b_hash(self._normalize_string(entry))`.
  - `_normalize_string` (`toon/toon/dedup.py:165`-170) applies each of
    the five `NORMALIZERS` regex/token pairs from
    `toon/toon/_utils.py:31`-37: `<TS>`, `<UUID>`, `<IP>`, `<NUM>`,
    `<B64>`.
  - Skip if seen; otherwise record + evict.

Lists/tuples/primitives bypass Tier 2 (no `elif` branch matches at
`toon/toon/dedup.py:108`/`125`).

**Why:** Entries that differ only in volatile fields (timestamps, request
IDs, IPs, large numeric IDs, base64-encoded payloads) collapse to the
same fingerprint.
**Input shape:** entries that survived Tier 1.
**Output shape:** survivors are pushed onto `unique` list with metadata
dict `{content, type, index, template_id}` (`toon/toon/dedup.py:92`-97,
`133`). `_detect_type` (`toon/toon/dedup.py:155`-163) returns "dict",
"list", "string", or "primitive".
**Connects to:** Step 5 (Tier 3).

---

### Step 5 — Stage 1, Tier 3: Template detection and collapse

**File:** `toon/toon/dedup.py:135`-144 (post-loop), with detection at
`toon/toon/dedup.py:176`-200 and collapsing at
`toon/toon/dedup.py:232`-278.

**What happens:** After the per-entry loop:
1. `_detect_templates(unique)` walks each `schema_h → indices` group.
   Skips any group with fewer than 3 members
   (`toon/toon/dedup.py:184`, then re-checked at `187`).
2. For groups of ≥3, `_compute_template_key(group)`
   (`toon/toon/dedup.py:202`-230) computes a template key:
   - For each key in the first entry's dict, gather string-cast values
     across the group.
   - The mode value's frequency must be `> 0.8` (80%) — that key is
     declared "static" (`toon/toon/dedup.py:225`).
   - The group qualifies as a template only if static keys comprise
     `> 30%` of all keys (`toon/toon/dedup.py:227`).
   - Returns `blake2b_hash(canonical_json(static_values))` as the
     template key, else `None`.
3. Qualifying groups are recorded as `TemplateInfo(first_content,
   last_content, count, first_index, last_index)` keyed by the template
   hash (`toon/toon/dedup.py:193`-199).
4. `_collapse_templates(unique, templates)`
   (`toon/toon/dedup.py:232`-278) walks each `TemplateInfo`:
   - Marks every entry whose original index is **strictly between**
     `first_index` and `last_index` AND whose `template_id` field is
     truthy (any entry that came through the dict path of Tier 2 — the
     code only checks `e.get("template_id")` for truthiness, NOT that
     it matches `info`'s template hash key) for removal
     (`toon/toon/dedup.py:255`-263).
   - The first entry is annotated in-place with `__toon_template: True`,
     `template_count`, `template_first` (= info.first_content),
     `template_last` (= info.last_content)
     (`toon/toon/dedup.py:269`-275).

**Why:** When the same tool emits dozens of structurally identical rows
with slight value drift (e.g. paginated API responses), Tier 3 keeps
only the first and last, plus a count, to represent the entire run.

**Returns:** `DedupResult(entries=collapsed, dedup_stats=DedupStats(...),
templates={...})` (`toon/toon/dedup.py:140`-144).
**Connects to:** Step 6 (Stage 2 — Phase 0 entry count check). If the
deduplicated entries list is empty, `compress` returns `[]` or `None`
(`toon/toon/pipeline.py:216`-217).

---

### Step 6 — Stage 2, Phase 0: Entry-count pre-check

**File:** `toon/toon/pipeline.py:253`-263 (inside `_score_entries`)
**What happens:** If `n < config.min_entries_for_scoring` (default 5,
`toon/toon/pipeline.py:95`), the function bypasses all scoring and
returns `ScoredEntries(entries, scores=[1.0]*n, tiers=["preserve"]*n,
core_indices=list(range(n)), scoring_stats={"method": "bypass",
"reason": f"n={n} < min={...}"})`.
**Why:** With too few entries there's no signal for centrality or
relevance ranking.
**Input shape:** `DedupResult` from Step 5.
**Output shape:** Either a ScoredEntries object that goes straight to
Stage 3, or the function continues to Phase 1. All entries get tier
"preserve", which causes Stage 3 to grant each its full original token
budget.
**Connects to:** Step 7 (Phase 1) if `n >= 5`; else Step 14 (budget
allocation).

---

### Step 7 — Stage 2, Phase 1: Text extraction + BMX+ index build

**File:** `toon/toon/pipeline.py:265`-271
**What happens:**
1. `texts = [flatten_to_text(e["content"]) for e in entries]`.
   `flatten_to_text` (`toon/toon/_utils.py:96`-112) emits strings
   verbatim, dicts as space-separated `"key value"` pairs (recursing on
   the value), lists as space-joined recursed children, and primitives
   via `str()` (or empty string for `None`).
2. `chunks = [{"chunk_id": str(i), "text": texts[i]} for i in range(n)]`.
3. `index = BMXPlusIndex(); index.build_index(chunks)`.

**Why:** BMX+ needs string text and chunk IDs. The flattening preserves
both field names and values, which is important for BM25-family scoring
where field names contain signal (e.g. "error", "status").
**Input shape:** survivors of dedup (list of entry-metadata dicts).
**Output shape:** populated `BMXPlusIndex` (see Engines section below)
plus the parallel `texts: list[str]`.
**Connects to:** Step 8 (Phase 2 centrality).

---

### Step 8 — Stage 2, Phase 2: Centrality scoring (full graph or hybrid)

**File:** `toon/toon/pipeline.py:273`-330
**What happens:** Branches on corpus size.

**Branch A — `n <= 1000` (constant `_GRAPH_LIMIT = 1000` at
`toon/toon/pipeline.py:277`):**
- `sage = SageRank(); sage_result = sage.rank_sentences(texts,
  top_k=n)` (`toon/toon/pipeline.py:280`-281).
- `self_scores = sage_result.scores` — the normalized PageRank score per
  entry (`toon/toon/pipeline.py:282`).
- See Engines section for what `rank_sentences` does end-to-end.

**Branch B — `n > 1000` (hybrid):**
- Seed an RNG deterministically: `rng =
  random.Random(hashlib.md5(seed_text.encode()).hexdigest())` where
  `seed_text = texts[0][:100]` (`toon/toon/pipeline.py:286`-287). This
  ensures reproducibility on the same corpus.
- `sample_size = min(500, n)`; pick `sample_indices` via `rng.sample`,
  then sort (`toon/toon/pipeline.py:288`-289).
- Run SageRank on the sample only:
  `sage.rank_sentences([texts[i] for i in sample_indices],
  top_k=sample_size)` (`toon/toon/pipeline.py:292`-295).
- Build `sample_scores: dict[int, float]` mapping original index →
  SageRank score for sampled entries (`toon/toon/pipeline.py:296`-299).
- **Core extraction from the sample:** sort sample by score descending,
  take `max(3, sample_size // 5)` top entries
  (`toon/toon/pipeline.py:302`-305). Their leading 200 chars are
  concatenated to form `core_query`. If a user `query` was provided, it
  is prepended (`query + " " + core_query[:500]`); otherwise
  `core_query[:2000]` (`toon/toon/pipeline.py:309`-312).
- `bmx_results = index.search(core_query, top_k=n)` — BMX+ scores
  **every** entry against the graph-derived core
  (`toon/toon/pipeline.py:315`-316).
- **Merge:** normalize both scales by their respective maxima. For
  sampled indices, `self_scores[i] = 0.5*sage_norm + 0.5*bmx_norm`. For
  non-sampled, `self_scores[i] = bmx_norm` only
  (`toon/toon/pipeline.py:319`-330).

**Why the split:** Full SageRank graph construction grows roughly with
`V × avg_posting²` (see `ARCHITECTURE.md:260`-262); at n > 1000 it
exceeds ~2s (comment at `toon/toon/pipeline.py:276`). The hybrid path
keeps graph-quality centrality on a sample and uses fast BMX+ TAAT to
score the rest.

**Input shape:** `texts: list[str]` of length n, plus `index`.
**Output shape:** `self_scores: list[float]` of length n.
**Connects to:** Step 9 (Gini guard).

---

### Step 9 — Stage 2, Gini coefficient guard

**File:** `toon/toon/pipeline.py:332`-352
**What happens:** Compute `gini = compute_gini(self_scores)`
(`toon/toon/_utils.py:115`-134 — 0 = uniform, 1 = max inequality).

If `gini < config.gini_threshold` (default 0.2,
`toon/toon/pipeline.py:54`):
- Log a warning, return early with `ScoredEntries(entries,
  scores=[1.0/n]*n, tiers=["medium"]*n, core_indices=[],
  scoring_stats={"method": "uniform_fallback", "gini": <rounded>,
  "reason": "degenerate corpus"})`
  (`toon/toon/pipeline.py:337`-352).

**Why:** Below 0.2 the score distribution is too flat to distinguish
useful entries from noise (citing T-Retrievability, Ganguly 2025,
arXiv:2508.21704 — `toon/toon/pipeline.py:55`-57). Bypass scoring and
let budget allocation distribute uniformly across the "medium" tier.

**Connects to:** Step 14 (budget allocation) on fallback; otherwise
Step 10.

---

### Step 10 — Stage 2, Hubness detection (median/MAD)

**File:** `toon/toon/pipeline.py:354`-371
**What happens:**
- `sorted_ss = sorted(self_scores); median_ss = sorted_ss[n // 2]`.
- `abs_devs = sorted(abs(s - median_ss) for s in self_scores);
  mad = abs_devs[n // 2] * 1.4826` — the 1.4826 factor converts MAD to a
  std-deviation equivalent for normal distributions
  (`toon/toon/pipeline.py:357`-360).
- For each score `s`, `z = (s - median_ss) / mad`. If
  `z > config.hubness_z_threshold` (default 3.0,
  `toon/toon/pipeline.py:59`), set
  `self_scores[i] = median_ss + 2 * mad` and record `i` in `hubs`,
  emitting an info log line.
- Skipped entirely if `mad == 0` (guarded by `if mad > 0:` at
  `toon/toon/pipeline.py:363`).

**Why:** "Hubs" — entries unrelated to the document but lexically
similar to many others — distort centrality (citing Radovanović et al.,
JMLR 2010, and Cisco 2026 — `toon/toon/pipeline.py:355`-356).
Median/MAD z-score is more robust to outliers than mean/std-based
z-scores.
**Connects to:** Step 11 (Kneedle core).

---

### Step 11 — Stage 2, Phase 3: Kneedle adaptive core identification

**File:** `toon/toon/pipeline.py:373`-386
**What happens:**
- Sort indices by score descending: `sorted_indices`.
- `sorted_scores = [self_scores[i] for i in sorted_indices]`.
- If `config.core_fraction_method == "kneedle"` (default,
  `toon/toon/pipeline.py:45`-48):
  - `knee = find_kneedle(sorted_scores, sensitivity=1.0)`
    (`toon/toon/_utils.py:137`-185 — Satopää et al. 2011, IEEE ICDCS).
    The algorithm normalizes scores to [0,1], computes deviation from
    the diagonal `y = 1 - x`, locates the global max of that deviation,
    then walks forward until the deviation drops below
    `best_val - sensitivity * s_range / n`.
  - `core_size = max(1, min(knee + 1, n // 2))` — clamp upper bound at
    50% of n.
  - `core_size = max(core_size, max(1, n // 20))` — clamp lower bound
    at 5% of n.
- Else (`"fixed"`): `core_size = max(1, int(n * config.core_fraction_fixed))`
  (default 0.15, `toon/toon/pipeline.py:50`-52).
- `core_indices = sorted_indices[:core_size]`.

**Why:** The core is the seed for relevance scoring in Phase 4. Kneedle
finds the natural boundary between high-centrality "important" entries
and the long tail.
**Connects to:** Step 12 (Phase 4 relevance).

---

### Step 12 — Stage 2, Phase 4: BMX+ relevance scoring against the core

**File:** `toon/toon/pipeline.py:388`-416
**What happens:**
1. Build `core_text = " ".join(texts[i][:200] for i in core_indices)`.
   First 200 chars of each core entry (`toon/toon/pipeline.py:389`).
2. If a user `query` is provided, `combined_query = query + " " +
   core_text[:500]`; else `combined_query = core_text[:2000]`
   (`toon/toon/pipeline.py:390`-393).
3. `relevance_results = index.search(combined_query, top_k=n)` —
   BMX+ TAAT scoring of every entry against this combined query
   (`toon/toon/pipeline.py:395`).
4. Build `relevance_map: dict[str_chunk_id, float]` and
   `relevance_scores = [relevance_map.get(str(i), 0.0) for i in
   range(n)]` (`toon/toon/pipeline.py:396`-397).
5. Compute `r = pearson_r(self_scores, relevance_scores)`
   (`toon/toon/_utils.py:188`-204).
   - If `r > config.redundancy_r_threshold` (default 0.95,
     `toon/toon/pipeline.py:64`), the two signals are redundant:
     `final_scores = list(self_scores)` (use centrality only) and an
     info log is emitted (`toon/toon/pipeline.py:401`-406).
   - Else `final_scores = [0.4*ss + 0.6*rs for ss, rs in
     zip(self_scores, relevance_scores)]`
     (`toon/toon/pipeline.py:408`-411). The 0.4/0.6 blend is an
     engineering heuristic (`ARCHITECTURE.md:346`).
6. Normalize to [0,1]: `final_scores = [s / max_fs for s in final_scores]`
   if `max_fs > 0` (`toon/toon/pipeline.py:414`-416).

**Why:** Centrality says "what the corpus emphasizes." Relevance against
core (plus optional user query) says "what's similar to what the corpus
emphasizes." Blending them surfaces both globally important and
locally-anchored entries. The Pearson check avoids double-counting when
the two signals already agree.
**Connects to:** Step 13 (tier assignment).

---

### Step 13 — Stage 2, Phase 5: Tier assignment

**File:** `toon/toon/pipeline.py:418`-447
**What happens:**
- `sorted_final = sorted(final_scores)`.
- `p75 = sorted_final[int(n * 0.75)] if n > 3 else sorted_final[-1]`.
- `p25 = sorted_final[int(n * 0.25)] if n > 3 else sorted_final[0]`
  (`toon/toon/pipeline.py:419`-421).
- For each `score`:
  - `score >= p75` → "high"
  - `score >= p25` → "medium"
  - `score > 0`    → "low"
  - `score == 0`   → "cut"
  (`toon/toon/pipeline.py:423`-432)

Returns `ScoredEntries(entries, scores=final_scores, tiers=tiers,
core_indices=core_indices, scoring_stats={method, gini, core_size,
hubs_detected, phase2_phase4_r, kneedle_threshold})`
(`toon/toon/pipeline.py:434`-447).

**Note:** `"preserve"` is **not** produced by Phase 5. The only path that
yields `"preserve"` is the Phase 0 bypass (`toon/toon/pipeline.py:257`).
This is the v2-`compress`'s field-routing model: "preserve" means "skip
scoring/budgeting entirely."

**Connects to:** Step 14 (Stage 3).

---

### Step 14 — Stage 3: Budget allocation

**File:** `toon/toon/pipeline.py:223`-225, calling
`toon/toon/budget.py:53`-122 (`BudgetAllocator.allocate`).

**What happens:**
1. `reserve = int(total_budget * 0.05)` (5% structural overhead reserve,
   constant `OVERHEAD_RESERVE = 0.05` at `toon/toon/budget.py:51`).
2. `usable = total_budget - reserve` (`toon/toon/budget.py:72`-73).
3. Sum the token cost of every "preserve"-tier entry: loop accumulates
   `preserve_tokens += estimate_tokens_obj(entries[i]["content"])` for
   each tier equal to "preserve" (`toon/toon/budget.py:75`-79).
4. `remaining = max(0, usable - preserve_tokens)`
   (`toon/toon/budget.py:81`).
5. Per-tier budgets:
   - `tier_budgets["preserve"] = preserve_tokens`
   - For each tier in `TIER_RATIOS = {"high": 0.60, "medium": 0.30,
     "low": 0.10}` (`toon/toon/budget.py:46`-50):
     `tier_budgets[tier] = int(remaining * ratio)`
   - `tier_budgets["cut"] = 0`
   (`toon/toon/budget.py:84`-87)
6. Within-tier distribution (`toon/toon/budget.py:92`-115):
   - "preserve" — each entry's budget = its own
     `estimate_tokens_obj(content)` (`toon/toon/budget.py:97`-100).
   - "cut" — every entry gets 0 (`toon/toon/budget.py:102`-103).
   - "high"/"medium"/"low": floor each score to `max(score, 1e-10)`,
     sum to `score_sum`, then for each entry in the tier:
     `share = tier_score / score_sum` (or `1/len(tier_indices)` if
     `score_sum == 0`); `entry_budgets[i] = max(10, int(tier_budget *
     share))` — minimum 10 tokens per surviving entry
     (`toon/toon/budget.py:105`-115).

Returns `BudgetAllocation(entry_budgets, tier_budgets, total_budget,
reserve)`.

**Important:** `BudgetAllocator.allocate` reads its class constant
`cls.TIER_RATIOS` at `toon/toon/budget.py:85`. It does **not** read
`config.tier_ratios` from the caller's `CompressConfig`. The
`CompressConfig.tier_ratios` field declared at
`toon/toon/pipeline.py:87`-89 is unused by the v2 pipeline.

**Note on caveat:** Budget is a *target*, not a hard cap (invariant 10
in `ARCHITECTURE.md:372`). Structural markers may push real output
slightly above `total_budget`.

**Connects to:** Step 15 (per-entry compression).

---

### Step 15 — Stage 3: Per-entry dispatch in `_compress_entries`

**File:** `toon/toon/pipeline.py:454`-502 (`_compress_entries`);
delegates to `_compress_entry` at `toon/toon/pipeline.py:509`-559.

**What happens (outer loop):**
- For each scored entry:
  - If `tier == "cut"`: increment `entries_cut`, skip
    (`toon/toon/pipeline.py:471`-473).
  - Otherwise call `_compress_entry(content, entry_budget, config,
    entry_meta=entry)` (`toon/toon/pipeline.py:476`).
  - Push `(entry["index"], result)` into `indexed_results`
    (`toon/toon/pipeline.py:477`).
  - Accumulate `total_tokens += estimate_tokens_obj(result)`.
- After the loop, sort `indexed_results` by original index and emit
  values only (`toon/toon/pipeline.py:481`-482). **This preserves input
  ordering** — invariant 6.
- Build `CompressedOutput(entries, budget_used, stats={
  compression_ratio, entries_kept, entries_cut, tier_distribution,
  scoring_stats})` (`toon/toon/pipeline.py:488`-502).

**Connects to:** Step 16 (entry-level dispatch in `_compress_entry`).

---

### Step 16 — Per-entry compression dispatch (`_compress_entry`)

**File:** `toon/toon/pipeline.py:509`-559
**What happens:** Five-way dispatch.

#### 16a. Template-annotated entry

**Lines:** `toon/toon/pipeline.py:521`-532
**Trigger:** `entry_meta and entry_meta.get("__toon_template")` (set by
the dedup Tier-3 collapse at `toon/toon/dedup.py:272`).
**Action:**
```
half = budget // 2 if budget else None
return {
    "__toon_template": True,
    "count":  entry_meta["template_count"],
    "first":  _compress_entry(entry_meta["template_first"], half, config),
    "last":   _compress_entry(entry_meta["template_last"], half, config),
}
```
Note: `_compress_entry` is recursed without `entry_meta`, so the
recursive calls treat `first`/`last` as plain content (no template flag).

#### 16b. `isinstance(content, str)`

**Lines:** `toon/toon/pipeline.py:534`-547
- If `budget is None`, set `budget = len(content)` so `compress_string`
  receives a sane character budget.
- **Optional within-entry SageRank ranking**
  (`toon/toon/pipeline.py:539`-545):
  - Only if `config.sagerank_top_k > 0` AND `len(content) > budget` AND
    `len(content) > 500`.
  - `sr = SageRank(); sr_result = sr.rank(content,
    top_k=config.sagerank_top_k)` — note this uses `rank` (which
    auto-segments via `_segment_sentences`,
    `toon/engines/sagerank.py:79`-115), not `rank_sentences`.
  - If `sr_result.selected_sentences` is non-empty, joined output
    replaces `content`; if it now fits the budget, return it as-is
    (`toon/toon/pipeline.py:543`-545). Otherwise fall through to
    `compress_string`.
- Otherwise (or if it still doesn't fit), call
  `compress_string(content, budget, config.stack_trace_max_user_frames)`
  (`toon/toon/pipeline.py:547`). See Step 17.
- **Note:** `config.sagerank_top_k` defaults to 0
  (`toon/toon/pipeline.py:98`-100), so this within-entry SageRank is
  off by default.

#### 16c. `isinstance(content, dict)`

**Lines:** `toon/toon/pipeline.py:549`-550
- `return _compress_dict(content, budget, config)`. See Step 18.

#### 16d. `isinstance(content, (list, tuple))`

**Lines:** `toon/toon/pipeline.py:552`-557
- Compute `threshold = max(3, budget // 50)` if a budget exists, else 5.
- `return _encode_recursive(content, threshold)` — directly calls the
  legacy v1 array-folder (`toon/toon/encoder.py:57`).

#### 16e. Primitive fallthrough

**Lines:** `toon/toon/pipeline.py:559`
- `return content` — primitives passthrough.

**Connects to:** Step 17 (string codec) or Step 18 (dict routing), or
back to caller.

---

### Step 17 — String-codec content-type dispatch (`compress_string`)

**File:** `toon/toon/string_codec.py:47`-77
**Pre-check:** `if len(text) <= budget: return text`
(`toon/toon/string_codec.py:61`-62). The codec only runs when text
exceeds budget.

**Detection priority (in order):**

#### 17a. Stack trace (`_is_stack_trace`)
- `toon/toon/string_codec.py:84`-86, regex
  `_STACK_TRACE_RE = r'(Traceback|Exception|Error|Caused by:|^\s+at\s+|^\s+File\s+")'`
  with `re.MULTILINE` (`toon/toon/string_codec.py:24`-27).
- Searches only the first 2000 chars.
- → `_compress_stack_trace`.

**`_compress_stack_trace`** (`toon/toon/string_codec.py:107`-169):
1. Line-by-line classification with priority scoring:
   - **Exception headers** (`'exception'`, `'error:'`, `'caused by:'` in
     lowered line): priority `1000.0 - i * 0.01`
     (`toon/toon/string_codec.py:122`-124).
   - **Stack frames** (`_FRAME_RE.match(line)` = leading whitespace
     followed by `at ` or `File "`, `toon/toon/string_codec.py:40`):
     - **User-code frame** (NOT matching `_USER_FRAME_EXCLUDES`
       regex at `toon/toon/string_codec.py:41`-44, which covers
       `java.`, `javax.`, `sun.`, `org.springframework.`,
       `org.python.`, `importlib.`, `_bootstrap`, `site-packages`):
       priority `100.0 / max(1, i)` — earlier frames score higher
       (`toon/toon/string_codec.py:130`-132).
     - **Library frame**: priority `1.0 / max(1, i)`
       (`toon/toon/string_codec.py:134`-135).
   - **Other content**: priority 0.1
     (`toon/toon/string_codec.py:139`).
2. Sort lines by priority descending, then greedy-fill within budget:
   - User frames are capped at `max_user_frames` (default 10 from
     `toon/toon/pipeline.py:81`). Lines with priority in
     `[100.0, 1000.0)` are counted as user frames; once
     `user_frame_count >= max_user_frames`, subsequent user-frame lines
     are skipped (`toon/toon/string_codec.py:152`-159).
   - Each `selected.append((idx, line))`, `used += len(line) + 1` (the
     `+1` accounts for the newline at `toon/toon/string_codec.py:148`).
3. Restore original line ordering by sorting on `idx` ascending
   (`toon/toon/string_codec.py:164`).
4. Append `\n... [N frames omitted]` if any lines were dropped
   (`toon/toon/string_codec.py:166`-168).

#### 17b. JSON-in-string (`_is_json_string`)
- `toon/toon/string_codec.py:89`-92: `stripped.startswith('{') or
  stripped.startswith('[')` and length > 2.
- Wraps `json.loads(text)` in try/except `(JSONDecodeError,
  RecursionError)` (`toon/toon/string_codec.py:68`-71). On parse
  failure, falls through.
- → `_compress_json(parsed, budget, depth=0)`.

**`_compress_json`** (`toon/toon/string_codec.py:176`-263):
- Returns a string literal `"...(<typename> at depth N)"` if
  `budget <= 0` (`toon/toon/string_codec.py:187`-188).
- `depth_budget = int(budget * (0.5 ** depth)) if depth > 0 else
  budget` — budget halves per depth level
  (`toon/toon/string_codec.py:190`).
- **Dict path** (`toon/toon/string_codec.py:192`-230):
  - If `depth >= 3`, return a JSON stub `{"__keys": <sorted keys>,
    "__depth": depth, "__omitted": len(obj)}`
    (`toon/toon/string_codec.py:193`-198).
  - Otherwise sort keys with priority order: keys in `{'error',
    'message', 'status', 'code', 'type', 'id', 'name', 'result',
    'output'}` (lower-case match) come first
    (`toon/toon/string_codec.py:204`-211).
  - Iterate sorted keys, recursing each value with
    `_compress_json(val, remaining // 2, depth + 1)`. If
    `remaining <= 20`, abort and append `"...": "(N more keys)"`
    (`toon/toon/string_codec.py:214`-218).
  - If `remaining < depth_budget * 0.5` AND the value is `None`/empty
    list/empty dict, skip the entry
    (`toon/toon/string_codec.py:220`-223).
  - Output `{\n` + comma-newline-joined entries + `\n}`.
- **List path** (`toon/toon/string_codec.py:232`-257):
  - `[]` → returns `'[]'`.
  - Length ≤ 5: recurse each item with `depth_budget // max(1, len(obj))`
    budget (`toon/toon/string_codec.py:235`-240).
  - Length > 5: check homogeneity via
    `set(type(item).__name__ for item in obj[:5])`. If single type
    (homogeneous): `[<first item compressed>, "... (N-1 more similar
    items)"]` (`toon/toon/string_codec.py:243`-246).
  - Else heterogeneous: first 3 items + `"... (N-5 more items)"` +
    last 2 items, each at `depth_budget // 8`
    (`toon/toon/string_codec.py:247`-257).
- **Primitive path** (`toon/toon/string_codec.py:259`-263):
  - `s = json.dumps(obj, default=str)`. If `len(s) > depth_budget`,
    return `json.dumps(str(obj)[:depth_budget - 10] + '...')`.

#### 17c. Log output (`_is_log_output`)
- `toon/toon/string_codec.py:95`-100: looks at the first 20 lines
  (uses `text.split('\n', 20)`); triggers if either ≥3 lines match the
  timestamp regex (start with `\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}`,
  `toon/toon/string_codec.py:32`-35) or ≥3 lines contain a severity
  keyword (`DEBUG`, `INFO`, `WARN(ING)?`, `ERROR`, `FATAL`, `CRITICAL`,
  case-insensitive, `toon/toon/string_codec.py:28`-31).
- → `_compress_log`.

**`_compress_log`** (`toon/toon/string_codec.py:270`-360):
1. For each line: normalize via the same `NORMALIZERS` list as the
   deduplicator (`toon/toon/_utils.py:31`-37), then
   `norm_hash = blake2b_hash(normalized)`
   (`toon/toon/string_codec.py:294`-298).
2. Track `seen_normalized: dict[hash, list[int]]`. After appending the
   current index to the group, if `len(group) > 2 and i != group[0]`,
   skip the line entirely (`toon/toon/string_codec.py:300`-309). In
   effect, only the first two occurrences of any repeating normalized
   line are ever classified; the third and later occurrences are
   dropped completely (the inline comment about "the *last* line of each
   group" being updated is misleading — once `len(group) > 2`, no
   further occurrences are added).
3. **Severity classification** (`toon/toon/string_codec.py:311`-320):
   - HIGH: line contains any keyword from `_ERROR_KEYWORDS` =
     `{'error', 'fatal', 'critical', 'exception', 'traceback',
     'caused by', 'failed', 'killed', 'oom', 'panic', 'crash',
     'abort'}` (`toon/toon/string_codec.py:36`-39).
   - MEDIUM: matches `_LOG_SEVERITY_RE` AND contains one of
     `('warn', 'timeout', 'retry', 'refused', 'denied')`.
   - LOW: everything else.
4. Greedily fill budget HIGH → MEDIUM → LOW
   (`toon/toon/string_codec.py:332`-338). Each entry costs
   `len(line) + 1`.
5. Sort selected lines back to original order; for each, recompute
   `norm_hash`; if `seen_normalized[norm_hash]` had >2 entries, append
   `  [repeated N times]` to the line
   (`toon/toon/string_codec.py:342`-354).
6. Append `\n... [N log lines omitted]` if any lines were dropped
   (`toon/toon/string_codec.py:356`-359).

#### 17d. Default — adaptive head/tail truncation
- `_content_aware_truncate` (`toon/toon/string_codec.py:367`-400).
- **Adaptive ratio selection:**
  - `tail_20pct = text[int(len(text) * 0.8):]`. If any
    `_ERROR_KEYWORDS` (`toon/toon/string_codec.py:36`-39) appears in
    the lowered tail → 40% head / 60% tail
    (`toon/toon/string_codec.py:380`-381`, ratio applied at
    `toon/toon/string_codec.py:386`-387).
  - Else `head_10pct = text[:max(1, int(len(text) * 0.1))]`. If it has
    fewer than 3 newlines AND contains a `:` (structured header
    heuristic) → 80% head / 20% tail
    (`toon/toon/string_codec.py:383`-384`, ratio applied at
    `toon/toon/string_codec.py:388`-389).
  - Else 50% head / 50% tail (`toon/toon/string_codec.py:390`-391).
- `marker = '\n...[content truncated]...\n'`;
  `usable = budget - len(marker)`. If `usable <= 0`, return `text[:budget]`.
- Output: `text[:head_budget] + marker + text[-tail_budget:]`
  (`toon/toon/string_codec.py:397`-400).
- Cited as supported by MiddleSum (ACL 2024) — LLMs attend less to the
  middle (`toon/toon/string_codec.py:376`-377).

**Connects to:** Back to `_compress_entry` caller.

---

### Step 18 — Dict field routing (`_compress_dict`)

**File:** `toon/toon/pipeline.py:562`-582
**What happens:** Iterate keys/values. Each key is lower-cased and
matched against two frozensets on the CompressConfig:
- `config.preserve_fields` (default
  `{'error', 'exception', 'message', 'status', 'code', 'id', 'type',
  'name'}` — `toon/toon/pipeline.py:103`-105) → copy value verbatim
  (`toon/toon/pipeline.py:568`-569).
- `config.encode_fields` (default
  `{'data', 'results', 'items', 'records', 'rows', 'entries',
  'payload'}` — `toon/toon/pipeline.py:108`-110):
  - If value is list/tuple with `len > 5` →
    `_encode_recursive(value, threshold=5)`
    (`toon/toon/pipeline.py:571`-572).
  - Elif value is str AND `budget` is truthy → `field_budget = budget //
    max(1, len(obj))`; `compress_string(value, field_budget,
    config.stack_trace_max_user_frames)`
    (`toon/toon/pipeline.py:573`-577).
  - Otherwise verbatim (`toon/toon/pipeline.py:578`-579).
- Anything else → copy verbatim (`toon/toon/pipeline.py:580`-581).

**Note:** This routing is `CompressConfig`-style (frozensets of literal
key names). The separate `ToonConfig` (in `config.py`) and
`router.route_field` (`toon/toon/router.py:79`) are **not used by the
v2 `compress` pipeline** — the pipeline always uses `CompressConfig`
and `_compress_dict`. `ToonConfig` is a parallel, currently
unintegrated configuration surface (see Configuration section below).

**Connects to:** Back to `_compress_entries`.

---

### Step 19 — Output unwrapping

**File:** `toon/toon/pipeline.py:229`-231
**What happens:** If the original input was a single object AND
`compressed.entries` is non-empty, return `compressed.entries[0]`;
otherwise return the list `compressed.entries`.
**Why:** Preserves invariant 2 — same top-level type as input.
**Connects to:** Pipeline returns to caller.

---

## Engines (referenced by Steps 8, 12, 16b)

### BMX+ (`toon/engines/bmx_plus.py`)

**Purpose:** Entropy-weighted lexical search; BM25 successor. Provides
query→document relevance scores. Used in Phase 2 (hybrid branch, score
all entries against graph-derived core), Phase 4 (relevance vs. core +
optional user query), and indirectly by SageRank as the kernel for
similarity weighting and query personalization.

**Public API:**
- `BMXPlusIndex()` — constructor, no required params
  (`toon/engines/bmx_plus.py:51`-106; the dataclass body declares
  optional overrides at lines 68-70 and field defaults below). Optional
  overrides: `alpha_override`, `beta_override`, `normalize_scores`.
- `build_index(chunks)` — `chunks: list[{"chunk_id": str, "text": str}]`
  (`toon/engines/bmx_plus.py:247`-285).
- `search(query, top_k=10)` → `list[tuple[chunk_id, score]]`
  (`toon/engines/bmx_plus.py:291`-384).
- `update_index(chunk_id, text)` / `remove_from_index(chunk_id)` —
  incremental ops with lazy entropy recomputation
  (`toon/engines/bmx_plus.py:390`-460).
- `document_count`, `vocabulary_size`, `get_stats()` — introspection
  (`toon/engines/bmx_plus.py:466`-482).

**What `build_index` does step by step
(`toon/engines/bmx_plus.py:247`-285):**
1. `_reset()` clears prior state.
2. For each chunk, `tokens = _tokenize(text)` =
   `_WORD_RE.findall(text.lower())` where `_WORD_RE = re.compile(r"\b\w+\b")`.
   Stores `_documents[cid] = tokens`, `_doc_lengths[cid] = len(tokens)`.
3. `_total_docs = N`, `_avg_doc_length = sum(_doc_lengths) / N`.
4. Build posting lists: for each cid → `term_counts = Counter(tokens)`,
   then for each `(term, count)` append to
   `_posting_lists[term][cid] = count`, increment `_doc_freqs[term]`,
   accumulate `_term_total_freqs[term]`.
5. `_compute_term_entropies()` — see below.
6. `_compute_parameters()` — derives `_alpha`, `_beta`, `_idf_max`.
7. `_is_built = True`.

**`_compute_term_entropies(terms=None)`
(`toon/engines/bmx_plus.py:151`-217):**
- Iterates all terms (or a subset if provided).
- For each term: `_idf_cache[term] = _compute_idf(term)`. IDF formula
  is the Lucene-variant always-non-negative form:
  `math.log((N - df + 0.5) / (df + 0.5) + 1.0)` if `df > 0 and N > 0`,
  else `0.0` (`toon/engines/bmx_plus.py:143`-149).
- If `df < 2`: `_term_entropy[term] = 0.0; _term_info[term] = 1.0`
  (rare → maximally informative, `toon/engines/bmx_plus.py:166`-168).
- Otherwise compute **variance-blended informativeness**:
  - `idf_info = 1.0 - df / N` (always available).
  - `tf_vals = list(_posting_lists[term].values())`.
  - `variance = sum((v - mean_tf)^2) / n_post`; `blend_alpha =
    variance / (variance + 1.0)`.
  - If `blend_alpha < 0.001`: pure IDF info path
    (`_term_info[term] = idf_info`).
  - Else: compute Shannon entropy on `_fast_sigmoid(tf)`-mapped values
    normalized to a probability distribution; convert to
    `shannon_info = max(1.0 - norm_ent, 0.0)`; blend:
    `blended = blend_alpha * shannon_info + (1 - blend_alpha) * idf_info`.

**`_compute_parameters()`
(`toon/engines/bmx_plus.py:120`-137):**
- `_alpha`: `alpha_override` if set, else `max(0.5, min(1.5, avg_dl /
  100.0))`.
- `_beta`: `beta_override` if set, else `1.0 / math.log(1.0 + N)`
  (or 0.01 if `N == 0`).
- `_idf_max = max(_idf_cache.values())` (or 1.0 if empty).

**Vestigial `_alpha`/`_beta`:** `_alpha` and `_beta` are computed by
`_compute_parameters` (`toon/engines/bmx_plus.py:120`-137) and re-derived
on every `update_index` / `remove_from_index` call
(`toon/engines/bmx_plus.py:415`, `459`). They are also reported via
`get_stats()` (`toon/engines/bmx_plus.py:479`-480) and the
`build_index` debug log (`toon/engines/bmx_plus.py:283`-285). However,
the `search` hot loop (`toon/engines/bmx_plus.py:291`-384) reads neither
attribute — instead it uses hardcoded `k1 = 1.5` and `b = 0.75`
(`toon/engines/bmx_plus.py:311`-312). A search across the repository
finds no other reader; the only references to `self._alpha`/`self._beta`
in `bmx_plus.py` are at lines 93, 94 (defaults), 124, 129 (assignment),
284 (log), 479, 480 (`get_stats`). The fields are computed and reported
state, not parameters that influence scoring.

**What `search` does
(`toon/engines/bmx_plus.py:291`-384):**
1. Tokenize query; if empty, return `[]`.
2. Lazily flush any dirty term entropies that intersect the query
   (`_flush_dirty_entropies` at
   `toon/engines/bmx_plus.py:219`-226).
3. Cache local references for the hot loop (locals are faster than
   attribute lookup in CPython).
4. Compute per-query `info_weights[t] = _term_info[t]`.
5. **TAAT accumulation** (`toon/engines/bmx_plus.py:331`-366):
   For each unique query term:
   - `idf = _idf_cache[term]`, `gamma_t = idf / idf_max`,
     `info_x_q = gamma_t * info_qi * q_tf`.
   - If `idf <= 0`: every posting just contributes
     `tanh_coverage += 1.0` and `info_accum += info_x_q`.
   - Else:
     `eidf = idf * (1.0 + gamma_t * info_qi)`.
     For each (cid, tf) in this term's posting:
     - `tf_sat = tf*(k1+1)/(tf + k1*(1-b+b*dl/avgdl))` — standard BM25 TF
       saturation.
     - `term_score = eidf * tf_sat * q_tf`.
     - `scores[cid] += term_score`, `info_accum[cid] += info_x_q`,
       `tanh_coverage[cid] += tanh(term_score)`.
6. **Soft-AND coverage bonus** (`toon/engines/bmx_plus.py:371`-375):
   `soft_and = tanh_coverage[cid] / |Q|` (where |Q| = number of unique
   query terms); `final[cid] = base + soft_and * info_accum[cid]`.
7. Sort descending; optional normalize-to-1 if `normalize_scores=True`
   (default False); return top-k.

### SageRank (`toon/engines/sagerank.py`)

**Purpose:** Entropy-weighted graph-based passage ranker; TextRank/LexRank
successor. Provides corpus-wide centrality scores in Stage 2 Phase 2.
Also used optionally for within-string ranking in Step 16b.

**Public API:**
- `SageRank(k1=1.5, b=0.75, damping=0.85, max_iter=50, epsilon=1e-6,
  coverage_weight=0.5, min_sentence_length=10, normalize=True)` —
  constructor (`toon/engines/sagerank.py:187`-205).
- `rank_sentences(sentences, top_k=5, query=None)` →
  `SageResult(sentences, scores, selected_indices, keywords, stats)`
  (`toon/engines/sagerank.py:683`-785).
- `rank_passages` — alias for `rank_sentences`
  (`toon/engines/sagerank.py:788`).
- `rank(text, top_k=5, query=None)` — auto-segments text via
  `_segment_sentences` then calls `rank_sentences`
  (`toon/engines/sagerank.py:790`-802).
- `summarize(text, ratio=0.3, query=None)` — convenience wrapper
  returning `result.summary` (`toon/engines/sagerank.py:804`-825).
- `extract_keywords(text, top_k=10)` — returns `[(term, score), ...]`
  (`toon/engines/sagerank.py:827`-845).

**`SageResult` properties (`toon/engines/sagerank.py:123`-163):**
- `.summary` — `" ".join(sentences[i] for i in
  sorted(selected_indices))`.
- `.selected_sentences` — list of those sentences (in document order).
- `.top(k=None)` — `(index, sentence, score)` tuples sorted by score
  descending.

**Pipeline call patterns:**
- Stage 2 Phase 2 (branch A): `sage = SageRank(); sage_result =
  sage.rank_sentences(texts, top_k=n)` —
  `toon/toon/pipeline.py:280`-281.
- Stage 2 Phase 2 (branch B): `sage.rank_sentences([texts[i] for i in
  sample_indices], top_k=sample_size)` —
  `toon/toon/pipeline.py:293`-295.
- Step 16b (optional within-string): `sr = SageRank(); sr_result =
  sr.rank(content, top_k=config.sagerank_top_k)` —
  `toon/toon/pipeline.py:541`. Note this uses `rank` (auto-segments)
  not `rank_sentences`.

**End-to-end of `rank_sentences`
(`toon/engines/sagerank.py:683`-785):**
1. n=0 returns empty `SageResult`. n=1 returns `SageResult(sentences,
   [1.0], [0], [], {"sentences": 1})`. `top_k = min(top_k, n)`.
2. Tokenize: `sent_tokens = [_tokenize(s) for s in sentences]` —
   identical `_WORD_RE` to BMX+ (`toon/engines/sagerank.py:60`).
3. Inverted index: `_build_posting_lists` returns
   `(posting_lists, doc_freqs, doc_lengths, avg_dl)`
   (`toon/engines/sagerank.py:219`-245).
4. `_compute_eidf(posting_lists, doc_freqs, n)` returns
   `(idf, eidf, info, idf_max)` —
   identical entropy-blended formulation to BMX+
   (`toon/engines/sagerank.py:251`-329). Phase 3 inside that fn:
   `eidf[t] = idf[t] * (1 + (idf[t]/idf_max) * info[t])`.
5. `_build_graph(posting_lists, eidf, doc_lengths, avg_dl, n)`
   (`toon/engines/sagerank.py:335`-435). Adaptive scaling thresholds:
   - `n > 5000`: `min_eidf = 5% of max_eidf`, `max_posting = n // 10`.
   - `n > 1000`: `min_eidf = 2% of max_eidf`, `max_posting = n // 5`.
   - Else: `min_eidf = 0.5% of max_eidf`, `max_posting = max(n // 2, 10)`.
   Three phases:
   - Phase 1: per-node squared norms `norm_sq[idx] += (eidf*tf_sat)^2`
     for cosine normalization.
   - Phase 2: per-term posting-list intersection. For each pair of
     posting entries (i, j), accumulate
     `raw[(min(i,j), max(i,j))] += w_a * w_b`. Skip terms with
     posting length < 2 or > `max_posting`.
   - Phase 3: cosine-normalize, then threshold at `1% of max_sim`
     (self-tuning) (`toon/engines/sagerank.py:425`-433). Edges
     symmetric `adjacency[i][j] = adjacency[j][i] = sim`.
6. `centrality[i] = sum(adjacency[i].values())` for each i
   (`toon/engines/sagerank.py:725`-727).
7. `_position_prior(centrality, n)`
   (`toon/engines/sagerank.py:441`-478):
   - `lead_k = max(3, n // 10)`; `lead_c = mean of centrality[:lead_k]`.
   - If `lead_c / avg_c > 1.0`: linear ramp to 1.0 at ratio ≥ 1.4
     (`lead_strength = max(0, min(1, (lead_ratio - 1) * 2.5))`).
   - `trail_strength = 0.3` fixed.
   - Weight per sentence: `1 + lead_strength * exp(-i * inv_lead_scale)
     + trail_strength * exp(-(n-1-i) * inv_trail_scale)` where
     `inv_lead_scale = 1 / max(n * 0.1, 1)` and
     `inv_trail_scale = 1 / max(n * 0.05, 1)`.
8. Optional query scoring: `_score_query` runs a BMX+ TAAT pass over
   `query_tokens` (`toon/engines/sagerank.py:484`-515). Returns
   `{sentence_idx: score}`.
9. Personalization vector: `p[i] = position[i]`. If query scores,
   `p[i] *= query_scores[i] + 0.01`
   (`toon/engines/sagerank.py:743`-747).
10. `_pagerank(adjacency, personalization, n)`
    (`toon/engines/sagerank.py:521`-587): topic-sensitive PageRank with
    sparse iteration. Damping default 0.85, max_iter 50, epsilon 1e-6
    L1 convergence. Dangling-node mass is redistributed via the
    personalization vector, not uniformly
    (`toon/engines/sagerank.py:565`-572).
11. `_extract_with_coverage(pr_scores, sent_tokens, eidf, top_k, n)`
    (`toon/engines/sagerank.py:593`-660): greedy. For each sentence
    precompute `weights[t] = eidf[t]` for unique terms in that
    sentence and `total = sum(weights.values())`. Iterate top_k
    selections; at each step, the unselected sentence with the highest
    `pr * (cw + (1-cw) * novel_w / total)` wins, where
    `cw = coverage_weight = 0.5` by default and `novel_w` sums eIDF
    weight of terms not yet in the `covered` set.
12. `keywords = _get_keywords(eidf, doc_freqs, top_k=10)` —
    `eidf[t] * sqrt(doc_freqs[t])` sorted descending
    (`toon/engines/sagerank.py:666`-677).
13. Normalize scores to [0, 1] if `normalize=True` (default)
    (`toon/engines/sagerank.py:761`-765). `scores[i] = pr_scores[i] /
    max_s`.
14. Returns `SageResult` with stats: `sentences, vocabulary, edges,
    pagerank_iters, idf_max, lead_bias, query_biased`.

**`_segment_sentences` (used by `rank` only)
(`toon/engines/sagerank.py:79`-115):**
- Split on blank lines → blocks.
- Each block split into lines.
- Each line split on `(?<=[.!?])\s+(?=[A-Z\"])`.
- Merge any sentence shorter than `min_length=10` chars into the
  previous one (`toon/engines/sagerank.py:108`-114).

---
