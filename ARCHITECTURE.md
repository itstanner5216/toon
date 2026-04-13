# TOON Architecture — Implementation Reference

## What This Is

TOON (Threshold-Optimized Output Notation) is an intelligent LLM context
compression system. Instead of blind truncation, it uses entropy-weighted
lexical scoring and graph-based centrality to make informed decisions about
what to keep, what to cut, and how much budget each piece of content deserves.

Three standalone engines, one integration pipeline, zero external dependencies.

## System Map

```
toon/
├── ARCHITECTURE.md
├── pyproject.toml
├── toon/
│   ├── __init__.py      Exports: encode_output, compress, CompressConfig, TOONCompressor
│   ├── encoder.py       Backwards-compatible API + compress() delegate to pipeline
│   ├── pipeline.py      Orchestrator: dedup → scoring → budget → compression
│   ├── config.py        ToonConfig dataclass hierarchy (configurability layer)
│   ├── router.py        FieldMatcher predicate evaluation + route_field() dispatch
│   ├── presets.py       Pre-built ToonConfig instances (codex_logs, mcp_responses, etc.)
│   ├── dedup.py         Three-tier deduplication (exact → near-dup → template)
│   ├── budget.py        Per-tier token budget allocation (60/30/10 split)
│   ├── string_codec.py  Content-aware string compression (4 strategies)
│   └── _utils.py        Shared pure functions (hashing, entropy, Gini, Kneedle, Pearson)
└── engines/
    ├── __init__.py      Exports: BMXPlusIndex, SageRank
    ├── bmx_plus.py      Standalone: entropy-weighted lexical search (BM25 successor)
    └── sagerank.py      Standalone: entropy-weighted graph ranking (TextRank successor)
```

## Data Flow

```
Input (any JSON-serializable data)
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ Stage 1: Structural Decomposition & Dedup           │
│                                                     │
│   Tier 1: Exact       blake2b(canonical_json(entry))│
│   Tier 2: Near-dup    normalize(timestamps, UUIDs,  │
│                        IPs, numbers, base64) → hash │
│   Tier 3: Template    same schema + >80% static     │
│                        fields → collapse to          │
│                        first + last + count marker   │
│                                                     │
│   LRU-bounded (5000), session-scoped                │
│   Output: DedupResult with unique entries            │
└─────────────┬───────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────┐
│ Stage 2: Self-Scoring & Relevance Ranking           │
│                                                     │
│   Phase 0: n < 5 → preserve all (skip scoring)     │
│                                                     │
│   Phase 2: Centrality scoring                       │
│     n ≤ 1000:  SageRank full graph                  │
│       → posting-list intersection builds similarity │
│         graph in eIDF-weighted BM25-TF vector space │
│       → PageRank with adaptive position prior       │
│       → scores = graph centrality                   │
│                                                     │
│     n > 1000:  Hybrid SageRank + BMX+               │
│       → SageRank on 500 random sample               │
│       → top centrality entries = core               │
│       → BMX+ scores ALL entries against core        │
│       → sampled entries: blend sage + bmx           │
│       → non-sampled: bmx relevance only             │
│                                                     │
│   Gini guard: if Gini(scores) < 0.2                 │
│     → corpus is undifferentiated                    │
│     → fall back to uniform allocation               │
│                                                     │
│   Hubness detection: median/MAD z-score > 3.0       │
│     → cap hub scores at median + 2·MAD              │
│                                                     │
│   Phase 3: Kneedle adaptive core identification     │
│     → find knee in sorted score curve               │
│     → core_size clamped to [5%, 50%] of entries     │
│                                                     │
│   Phase 4: BMX+ relevance scoring against core      │
│     → build index, search(core_text + query)        │
│     → if pearson_r(centrality, relevance) > 0.95    │
│       → redundant, use centrality only              │
│     → else blend: 0.4 × centrality + 0.6 × relevance│
│                                                     │
│   Phase 5: Tier assignment                          │
│     score ≥ p75 → "high"                            │
│     score ≥ p25 → "medium"                          │
│     score > 0   → "low"                             │
│     score = 0   → "cut"                             │
│                                                     │
│   Output: ScoredEntries with scores + tiers         │
└─────────────┬───────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────┐
│ Stage 3: Budget-Aware Compression                   │
│                                                     │
│   Budget allocation:                                │
│     5% reserved for structural overhead             │
│     "preserve" tier: full original size             │
│     remaining split: 60% high / 30% medium / 10% low│
│     within each tier: proportional to entry scores  │
│     "cut" tier: 0 tokens (excluded from output)     │
│                                                     │
│   Per-entry compression dispatch:                   │
│     template-annotated → structured marker          │
│       {"__toon_template": true, count, first, last} │
│     string → content detection → appropriate codec  │
│     dict → field routing (preserve vs encode)       │
│     list → _encode_recursive (TOON v1 array folding)│
│     primitive → passthrough                         │
│                                                     │
│   Output: CompressedOutput with entries + stats     │
└─────────────────────────────────────────────────────┘
```

## The Three Engines

### BMX+ (bmx_plus.py)

Entropy-weighted lexical search. BM25 successor. Used for query→document
relevance scoring in Stage 2 Phase 4.

**Core formula:**
```
score(q, d) = Σₜ∈q [ eIDF(t) · tf_sat(t, d) · qtf(t) · softAND ]

eIDF(t) = IDF(t) · (1 + γₜ · info(t))
γₜ     = IDF(t) / IDF_max           (term-adaptive scaling)
info(t) = blend(shannon_info, idf_info, variance_weight)
tf_sat  = tf·(k1+1) / (tf + k1·(1-b+b·dl/avgdl))
```

**Key property:** Self-tuning. γₜ ensures rare terms get maximum entropy
boost while common terms get minimal. No parameter tuning needed.

**API:**
```python
index = BMXPlusIndex()
index.build_index([{"chunk_id": "0", "text": "..."}, ...])
results = index.search("query", top_k=10)  # → [(chunk_id, score), ...]
```

### SageRank (sagerank.py)

Entropy-weighted graph-based passage ranker. TextRank/LexRank successor.
Used for corpus centrality in Stage 2 Phase 2.

**Five innovations over LexRank:**
1. **Similarity kernel**: eIDF-weighted BM25-TF cosine (not plain TF-IDF)
2. **Graph construction**: posting-list intersection O(V·posting²) not O(N²·V)
3. **Position prior**: self-tuning lead/trail bias from centrality distribution
4. **Extraction**: coverage-optimized greedy (eIDF term coverage, not MMR)
5. **Query mode**: optional BMX+ TAAT scoring biases PageRank personalization

**Graph construction:**
```
For each term t in vocabulary (filtered by eIDF threshold):
  For each pair (Sᵢ, Sⱼ) where t appears in both:
    edge_weight[i][j] += eIDF(t) · tf_sat(t, Sᵢ) · tf_sat(t, Sⱼ)

Normalize: sim(i,j) = edge_weight[i][j] / (‖Sᵢ‖ · ‖Sⱼ‖)
```

**API:**
```python
sage = SageRank()
result = sage.rank("long text", top_k=5, query="optional bias")
result = sage.rank_sentences(["msg1", "msg2", ...], top_k=3)
result.summary              # selected sentences in document order
result.scores               # PageRank scores per sentence
result.selected_indices     # coverage-optimized selection
result.keywords             # top terms by eIDF · √df
```

### TOON Encoder (encoder.py)

Original v1 array compression. Preserved for backwards compatibility.

```python
# Arrays > threshold replaced with metadata:
{"__toon": True, "count": N, "sample": [first 3 items]}

# API unchanged from v1:
encode_output(result, threshold=5)
```

## String Codec (string_codec.py)

Content-type detection dispatches to specialized strategy:

```
Detection priority:
  1. Stack trace  → FaST-inspired frame scoring (ICSE 2022)
                    priority: exception headers > user frames > library frames
                    frame importance: 1/position × rarity
                    user frame cap: configurable (default 10)

  2. JSON string  → depth-limited traversal
                    budget inheritance: depth_N = parent_budget × 0.5^N
                    key priority: error, message, status, code, type, id, name
                    skip: nulls, empty collections when budget tight
                    depth cap: 3 levels

  3. Log output   → template-based compression with severity priority
                    normalize variable fields → hash → dedup by template
                    fill budget: ERROR → WARN → INFO
                    annotate repeated lines with count markers

  4. Default      → adaptive head/tail truncation
                    NOT fixed 70/30 — adapts to content:
                    error at tail    → 40/60
                    structure at head → 80/20  
                    default          → 50/50
```

## Dedup (dedup.py)

Three tiers, single pass, LRU-bounded:

```
Tier 1 — Exact:     blake2b(canonical_json(entry), 64-bit)
                     → seen before? skip.

Tier 2 — Near-dup:  normalize(timestamps, UUIDs, IPs, numbers, base64)
                     → hash normalized form
                     → schema_hash (keys only) + content_hash (values)
                     → seen before? skip.

Tier 3 — Template:  entries sharing schema_hash grouped
                     → if 3+ entries share schema AND >80% of keys
                       have same value across >80% of entries
                     → collapse to first + last + count marker
                     → middle entries removed

Memory: LRU OrderedDict, maxsize=5000 (~500KB)
Scope: session (persists across calls) or turn (reset per call)
Collision safety: 64-bit hash, <2.7×10⁻⁶ collision prob at 100K entries
```

## Scaling Behavior

```
Entries    Scoring Strategy                    Expected Time
──────────────────────────────────────────────────────────────
< 5        bypass (preserve all)               <1ms
5-1000     SageRank full graph centrality       <2s
           + BMX+ relevance against core
1000+      SageRank on 500 sample               <5s
           + BMX+ scores all against
             graph-derived core

Graph construction: O(V × avg_posting²)
  - eIDF filter removes low-info terms
  - posting size cap prevents quadratic blowup on common terms
  - thresholds adapt: n>5000 uses stricter eidf cutoff

PageRank: O(iterations × edges), sparse adjacency
  - typically 20-50 iterations to convergence (ε=1e-6)
  - dangling nodes → personalization distribution (topic-sensitive)

BMX+ search: O(V_query × avg_posting_length) per query
  - TAAT architecture, single pass through posting lists
```

## Configuration System

```
ToonConfig (master config, all fields have defaults)
├── preserve_rules: list[FieldMatcher]     # never compress these
├── encode_rules: list[EncoderRule]        # first match wins
│   └── EncoderRule = FieldMatcher + CodecConfig
├── default_codec: CodecConfig | None      # fallback if no rule matches
├── array: ArrayCodecConfig                # threshold, sample_size
├── string: StringCodecConfig              # budget, min_length, parse_json
├── dedup: DedupConfig                     # scope, maxsize
└── bmx: BMXConfig                         # enabled, mode, tiers

Routing priority (evaluated by router.route_field):
  1. preserve_rules — ANY match → "preserve"
  2. encode_rules   — first match → that rule's codec strategy
  3. default_codec  — if set → its strategy
  4. → "passthrough"

FieldMatcher conditions (all specified conditions AND together):
  field_path:    exact or dot-prefix match ("payload" matches "payload.output")
  field_pattern: regex on last path segment
  min_length:    string length gate (non-strings skip)
  max_length:    string length gate (non-strings skip)

Presets:
  ToonConfig.preset("generic")        # safe default, compresses long strings
  ToonConfig.preset("codex_logs")     # tuned for agent tool traces
  ToonConfig.preset("mcp_responses")  # preserve metadata, compress payloads
  ToonConfig.preset("aggressive")     # BMX+ scoring enabled, tight budgets
```

## API Surface

```python
# ── v1 (backwards-compatible, unchanged) ──
from toon import encode_output
encoded = encode_output(tool_result, threshold=5)

# ── v2 full pipeline ──
from toon import compress
compressed = compress(data, budget=4000, query="error timeout")

# ── v2 with config ──
from toon import compress, CompressConfig
cfg = CompressConfig(gini_threshold=0.3, dedup_scope="turn")
compressed = compress(data, budget=4000, config=cfg)

# ── v2 with presets (new config system) ──
from toon.config import ToonConfig
cfg = ToonConfig.preset("codex_logs")
cfg.string.default_budget = 600  # tweak after copy

# ── Streaming mode ──
from toon import TOONCompressor
compressor = TOONCompressor()
for entry in stream:
    out = compressor.feed(entry)     # returns None if deduped
    if out is not None:
        context.append(out)
compressor.reset()                    # session boundary
```

## Key Parameters & Their Evidence Basis

| Parameter | Value | Source |
|---|---|---|
| Gini threshold | 0.2 | T-Retrievability, Ganguly 2025 (arXiv:2508.21704) |
| Hubness z-threshold | 3.0 | Adversarial hubness, Cisco 2026 |
| Redundancy r threshold | 0.95 | Engineering heuristic (not validated) |
| Kneedle sensitivity | 1.0 | Satopää et al. 2011, IEEE ICDCS |
| Budget split 60/30/10 | high/med/low | LLMLingua, ACL 2024 (per-component > uniform) |
| Overhead reserve | 5% | Engineering heuristic |
| Self/relevance blend | 0.4/0.6 | Engineering heuristic |
| LRU maxsize | 5000 | ~500KB memory, covers typical sessions |
| blake2b digest | 64-bit | Birthday problem: <2.7×10⁻⁶ at 100K entries |
| Stack trace max frames | 10 | FaST heuristic, ICSE 2022 (conservative) |
| JSON depth budget | ×0.5 per level | Engineering heuristic |
| Template threshold | >80% same, >30% keys | Engineering heuristic |
| eIDF formula | IDF·(1 + γₜ·info) | BMX+ (novel, proven on BEIR) |
| Graph sim threshold | 1% of max | Self-tuning from corpus |
| Position lead bias | 0-1 from centrality | Self-tuning from corpus |

**"Engineering heuristic" = works in practice, not empirically validated
against alternatives. These are the parameters worth experimenting with.**

## Invariants

Things that must remain true across any refactoring:

1. `encode_output(obj, threshold=5)` produces identical output to v1
2. `compress()` always returns the same top-level type as input
3. Dedup state is session-scoped by default, must be explicitly reset
4. "preserve" tier entries are NEVER modified
5. "cut" tier entries are NEVER included in output
6. Entry ordering in output matches input ordering
7. Zero external dependencies (stdlib only + the three engines)
8. Single entry input returns single object, not a list
9. Empty input returns empty output ([] or None)
10. Budget is a target, not a hard cap (structural overhead may exceed it)

## Testing

```bash
# Quick smoke test (runs __main__ block in pipeline.py)
python -m toon.pipeline

# SageRank standalone test  
python test_sagerank.py

# SageRank vs LexRank benchmark (needs: pip install rouge-score)
python benchmark_sagerank.py

# Router self-test
python -m toon.router
```

## Common Modification Scenarios

**"I want to add a new string compression strategy"**
→ Add detection function + compression function in string_codec.py
→ Add to dispatch chain in compress_string() (order = priority)

**"I want to change budget ratios"**
→ Modify BudgetAllocator.TIER_RATIOS in budget.py
→ Or pass custom tier_ratios in CompressConfig

**"I want to change tier boundaries"**
→ Modify Phase 5 percentile thresholds in _score_entries() in pipeline.py
→ Or configure via BMXConfig.tiers in the new config system

**"I want to add a new preset"**
→ Add entry to PRESETS dict in presets.py

**"I want to change what fields are preserved"**
→ Config: add FieldMatcher to preserve_rules
→ Legacy: add to CompressConfig.preserve_fields frozenset

**"I want SageRank to rank within long entries"**
→ Set CompressConfig.sagerank_top_k > 0 (default 0 = disabled)

**"I want to use a custom BMX variant for scoring"**
→ Replace BMXPlusIndex import in pipeline.py
→ Must implement: build_index(chunks), search(query, top_k) → [(id, score)]

**"I want to skip scoring entirely"**
→ Set CompressConfig.min_entries_for_scoring very high
→ Everything gets "preserve" tier (dedup + string codec still run)
