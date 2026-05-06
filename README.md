# TOON — Threshold-Optimized Output Notation

> **Intelligent LLM context compression** — entropy-weighted scoring meets structural encoding.

[![Python](https://img.shields.io/badge/python-3.10%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/status-beta-orange)](https://pypi.org/project/toon-plus/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-zero%20runtime-brightgreen)](toon.py/pyproject.toml)

TOON is a dual-implementation (Python + TypeScript) LLM context compression system. Instead of blind truncation, it uses a three-stage pipeline — **deduplication → entropy-weighted scoring → budget-aware compression** — to make principled decisions about what to keep, what to cut, and how much space each piece of content deserves.

Two standalone scoring engines (BMX+ and SageRank) power the pipeline with no external runtime dependencies.

---

## Table of Contents

- [What TOON Does](#what-toon-does)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Architecture Overview](#architecture-overview)
  - [The Three-Stage Pipeline](#the-three-stage-pipeline)
  - [Scoring Engines](#scoring-engines)
  - [String Codec](#string-codec)
  - [Tree-sitter Integration](#tree-sitter-integration)
  - [Configuration System](#configuration-system)
- [Features](#features)
- [Getting Started](#getting-started)
  - [Python](#python)
  - [TypeScript](#typescript)
- [API Reference](#api-reference)
  - [Python API](#python-api)
  - [TypeScript API](#typescript-api)
- [CLI](#cli)
- [Configuration &amp; Presets](#configuration--presets)
- [Scripts &amp; Commands](#scripts--commands)
- [Project Status](#project-status)

---

## What TOON Does

When LLM context windows fill up with tool output, logs, or code, naive truncation discards the most useful information. TOON solves this by:

1. **Deduplicating** exact duplicates, near-duplicates (normalized UUIDs/timestamps/IPs), and repetitive template entries before any scoring begins.
2. **Scoring** the remaining entries for centrality and relevance using graph-based (SageRank) and lexical (BMX+) algorithms — both custom successors to TextRank and BM25.
3. **Compressing** each entry within a tiered token budget (`high`/`medium`/`low`/`cut`), applying content-aware strategies for stack traces, JSON blobs, log streams, and plain text.
4. **Optionally using tree-sitter AST** structure to compress source-code files while preserving the most important symbol definitions.

---

## Tech Stack

| Layer | Python (`toon.py/`) | TypeScript (`toon.ts/`) |
|---|---|---|
| Language | Python 3.10+ | TypeScript 5.x, strict mode, ES2022 |
| Build | [Hatchling](https://hatch.pypa.io/) (`pyproject.toml`) | `tsc` → `dist/` |
| Module system | Package (`toon`, `engines`) | ESM, Node16 resolution |
| Linting | [Ruff](https://docs.astral.sh/ruff/) | TypeScript compiler (`noUnusedLocals`, `noUnusedParameters`) |
| Testing | [pytest](https://pytest.org/) + [rouge-score](https://pypi.org/project/rouge-score/) | Custom Node.js test harness (`--test`) |
| Tree-sitter | `web-tree-sitter` WASM (via JS bridge) | `web-tree-sitter` (npm) |
| Runtime deps | **Zero** | `web-tree-sitter` only |
| Supported Python | 3.10, 3.11, 3.12, 3.13 | N/A |

---

## Repository Structure

```
toon/
├── README.md                   ← This file
├── SYMBOL_STRUCTURE_PLAN.md    ← Wave-based integration plan for AST scoring
├── .gitignore
│
├── toon.py/                    ← Python implementation (v2.0.0, package: toon-plus)
│   ├── pyproject.toml
│   ├── ARCHITECTURE.md         ← Detailed Python architecture reference
│   ├── toon/                   ← Core Python package
│   │   ├── __init__.py         ← Public API: encode_output, compress, CompressConfig, TOONCompressor
│   │   ├── __main__.py         ← CLI entry point (python -m toon)
│   │   ├── pipeline.py         ← Three-stage orchestrator
│   │   ├── config.py           ← ToonConfig dataclass hierarchy
│   │   ├── presets.py          ← Pre-built configs (generic, codex_logs, mcp_responses, aggressive)
│   │   ├── router.py           ← FieldMatcher predicate + route_field() dispatch
│   │   ├── dedup.py            ← Three-tier deduplication
│   │   ├── budget.py           ← Per-tier token budget allocation (60/30/10)
│   │   ├── string_codec.py     ← Content-aware string compression (4 strategies)
│   │   ├── encoder.py          ← v1 backward-compatible API + v2 pipeline delegate
│   │   └── _utils.py           ← Pure functions (hashing, entropy, Gini, Kneedle, Pearson)
│   ├── engines/                ← Standalone scoring engines
│   │   ├── __init__.py
│   │   ├── bmx_plus.py         ← BMX+ (entropy-weighted BM25 successor)
│   │   ├── sagerank.py         ← SageRank (entropy-weighted TextRank successor)
│   │   └── treesitter/         ← Tree-sitter bridge (JS, calls Python toon --structured)
│   └── tests/
│
└── toon.ts/                    ← TypeScript implementation (v1.0.0)
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── cli.ts              ← CLI entry point (toon binary)
    │   ├── toon/               ← Core library (full port of toon.py)
    │   │   ├── index.ts        ← Public API barrel
    │   │   ├── pipeline.ts     ← Three-stage orchestrator
    │   │   ├── config.ts       ← ToonConfig factories + defaults
    │   │   ├── presets.ts      ← Pre-built configs
    │   │   ├── router.ts       ← Field routing
    │   │   ├── dedup.ts        ← Deduplication
    │   │   ├── budget.ts       ← Budget allocation
    │   │   ├── string-codec.ts ← Content-aware string compression
    │   │   ├── bmx-plus.ts     ← BMX+ engine
    │   │   ├── sagerank.ts     ← SageRank engine
    │   │   ├── encoder.ts      ← v1 backward-compatible API
    │   │   ├── utils.ts        ← Shared utilities
    │   │   └── types.ts        ← TypeScript interfaces and type guards
    │   └── engines/
    │       ├── index.ts        ← Engines barrel
    │       └── treesitter/
    │           ├── tree-sitter.ts      ← Full tree-sitter wrapper (40+ languages)
    │           ├── toon-bridge.ts      ← File → AST → compress (single binary)
    │           └── web-tree-sitter.d.ts
    ├── grammars/               ← 40+ language WASM grammars + query files (.scm)
    └── tests/toon/
        └── parity.test.ts      ← Python/TypeScript output parity tests
```

---

## Architecture Overview

### The Three-Stage Pipeline

Both implementations share the same three-stage pipeline:

```
Input (any JSON-serializable data or list of entries)
        │
        ▼
┌─────────────────────────────────────────────────┐
│  Stage 1 — Structural Deduplication             │
│                                                 │
│  Tier 1 (Exact):     blake2b(canonical_json)    │
│  Tier 2 (Near-dup):  normalize volatile fields  │
│                      (timestamps, UUIDs, IPs,   │
│                       numbers, base64) → hash   │
│  Tier 3 (Template):  entries sharing schema     │
│                      with >80% static values    │
│                      → first + last + count     │
│                                                 │
│  LRU-bounded (5000), session or turn scoped     │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Stage 2 — Self-Scoring & Relevance Ranking     │
│                                                 │
│  n < 5:    bypass (preserve all)                │
│  n ≤ 1000: SageRank full-graph centrality       │
│            + BMX+ relevance against core        │
│  n > 1000: SageRank on 500-entry sample         │
│            + BMX+ scores all against core       │
│                                                 │
│  Gini guard (< 0.2) → uniform fallback          │
│  Hubness detection (z > 3.0) → cap hub scores   │
│  Kneedle knee-finding → adaptive core size      │
│  Pearson r > 0.95 → drop redundant scores       │
│                                                 │
│  Tier assignment: high ≥ p75, medium ≥ p25,     │
│                   low > 0, cut = 0              │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Stage 3 — Budget-Aware Compression             │
│                                                 │
│  5% reserved for structural overhead            │
│  Remaining: 60% high / 30% medium / 10% low     │
│  Within each tier: proportional to score        │
│  "cut" tier: 0 tokens — excluded from output    │
│                                                 │
│  Per-entry dispatch:                            │
│    template marker → structured annotation      │
│    string  → content-aware codec                │
│    dict    → field routing (preserve/encode)    │
│    list    → TOON v1 array folding              │
│    primitive → passthrough                      │
└─────────────────────────────────────────────────┘
```

### Scoring Engines

#### BMX+ (`bmx_plus.py` / `bmx-plus.ts`)

Entropy-weighted lexical search — BM25 successor used for query→document relevance in Stage 2.

**Core formula:**
```
score(q, d) = Σₜ∈q [ eIDF(t) · tf_sat(t,d) · qtf(t) · softAND ]

eIDF(t) = IDF(t) · (1 + γₜ · info(t))
γₜ      = IDF(t) / IDF_max          ← term-adaptive scaling
info(t) = blend(shannon_info, idf_info, variance_weight)
```

**Key property:** Self-tuning. Rare terms receive maximum entropy boost; common terms receive minimal boost. No manual parameter tuning required.

#### SageRank (`sagerank.py` / `sagerank.ts`)

Entropy-weighted graph-based passage ranker — TextRank/LexRank successor for corpus centrality in Stage 2.

**Five improvements over LexRank:**
1. **Similarity kernel**: eIDF-weighted BM25-TF cosine (not plain TF-IDF)
2. **Graph construction**: posting-list intersection O(V·posting²) — not O(N²·V)
3. **Position prior**: self-tuning lead/trail bias from centrality distribution
4. **Extraction**: coverage-optimized greedy (eIDF term coverage, not MMR)
5. **Query mode**: optional BMX+ TAAT scoring biases PageRank personalization

### String Codec

Content-type detection dispatches to one of four specialized strategies:

| Priority | Detected Type | Strategy |
|---|---|---|
| 1 | Stack trace | FaST-inspired frame scoring (ICSE 2022) — ranks by position × rarity |
| 2 | JSON string | Depth-limited traversal — budget halves per level, key priority ordering |
| 3 | Log output | Template-based dedup with severity priority (ERROR → WARN → INFO) |
| 4 | Default | Adaptive head/tail truncation — 40/60 (error at tail), 80/20 (structure at head), or 50/50 |

### Tree-sitter Integration

The tree-sitter bridge enables **structure-aware source code compression**:

- **40+ language grammars** (WASM): Python, JavaScript, TypeScript, Go, Rust, Java, C, C++, C#, Ruby, Swift, Kotlin, Dart, Lua, Elixir, PHP, and more.
- **Query files** (`.scm` patterns): per-language symbol definitions extracted by AST queries.
- **Symbol extraction**: definitions, references, scopes, language injection regions.
- **`compressSourceStructured()`**: allocates character budget to symbol blocks by priority — exported symbols and entry points are preserved; test/private helpers are cut first.

**Bridge flow:**
```
file + budget
    → tree-sitter AST parse (WASM)
    → extract StructureBlock[] (name, kind, type, startLine, endLine)
    → compressSourceStructured(content, budget, structure)
    → compressed source output
```

The TypeScript `toon-bridge` binary is a self-contained single process. The Python version (`toon_bridge.js`) calls `python3 -m toon --structured` as a subprocess.

### Configuration System

```
ToonConfig (master config — all fields have defaults)
├── preserve_rules: FieldMatcher[]    ← never compress these fields
├── encode_rules:   EncoderRule[]     ← first match wins
│   └── EncoderRule = FieldMatcher + CodecConfig
├── default_codec:  CodecConfig|None  ← fallback if no rule matches
├── array:          ArrayCodecConfig  ← threshold, sample_size
├── string:         StringCodecConfig ← budget, min_length, parse_json
├── dedup:          DedupConfig       ← scope, maxsize
└── bmx:            BMXConfig         ← enabled, mode, tiers
```

**Routing priority** (evaluated by `route_field`):
1. `preserve_rules` — any match → `"preserve"` (never modified)
2. `encode_rules` — first match → that rule's codec strategy
3. `default_codec` — fallback
4. → `"passthrough"`

---

## Features

- **Three-stage pipeline** — dedup → scoring → budget-aware compression
- **Zero runtime dependencies** (Python); only `web-tree-sitter` (TypeScript)
- **Backward-compatible v1 API** — `encode_output(obj, threshold=5)` works unchanged
- **Streaming mode** — `TOONCompressor.feed()` for real-time entry processing
- **Configurable routing rules** — per-field compression strategies via `FieldMatcher`
- **Four pre-built presets** — `generic`, `codex_logs`, `mcp_responses`, `aggressive`
- **Content-aware string compression** — stack traces, JSON blobs, logs, plain text each get purpose-built codecs
- **Structure-aware code compression** — AST-guided budget allocation via tree-sitter (40+ languages)
- **Session-scoped deduplication** — LRU-bounded fingerprint cache across multiple calls
- **Adaptive scoring** — Gini guard, hubness capping, Kneedle knee-finding all self-tune from corpus
- **CLI** — stdin/stdout pipeline and structured (`--structured`) mode for both Python and TypeScript

---

## Getting Started

### Python

**Requirements:** Python 3.10+, [`uv`](https://docs.astral.sh/uv/) or pip.

```bash
# Clone the repository
git clone https://github.com/itstanner5216/toon.git
cd toon/toon.py

# Install with uv (recommended)
uv sync

# Or with pip
pip install -e .

# Run tests
uv run pytest
# or: python -m pytest
```

**Install dev dependencies** (linting + benchmarks):

```bash
uv sync --extra dev
```

### TypeScript

**Requirements:** Node.js 18+, npm.

```bash
cd toon/toon.ts

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

The compiled output lands in `dist/`. The `toon` and `toon-bridge` binaries are registered via the `bin` field in `package.json`.

---

## API Reference

### Python API

```python
# ── Legacy v1 API (unchanged) ──────────────────────────────────────────────
from toon import encode_output

# Arrays > threshold are replaced with {__toon: true, count, sample}
encoded = encode_output(tool_result, threshold=5)


# ── Full pipeline v2 ────────────────────────────────────────────────────────
from toon import compress

# Budget in tokens; query biases relevance scoring
compressed = compress(data, budget=4000, query="error timeout")


# ── Full pipeline with config ───────────────────────────────────────────────
from toon import compress, CompressConfig

cfg = CompressConfig(gini_threshold=0.3, dedup_scope="turn")
compressed = compress(data, budget=4000, config=cfg)


# ── New config system (presets) ─────────────────────────────────────────────
from toon.config import ToonConfig

cfg = ToonConfig.preset("codex_logs")
cfg.string.default_budget = 600   # tweak after deep copy


# ── Streaming mode ───────────────────────────────────────────────────────────
from toon import TOONCompressor

compressor = TOONCompressor()
for entry in stream:
    out = compressor.feed(entry)   # returns None if deduped
    if out is not None:
        context.append(out)
compressor.reset()                 # reset at session boundary


# ── Standalone engines ───────────────────────────────────────────────────────
from engines import BMXPlusIndex, SageRank

# BMX+ lexical search
index = BMXPlusIndex()
index.build_index([{"chunk_id": "0", "text": "..."}, ...])
results = index.search("query", top_k=10)   # → [(chunk_id, score), ...]

# SageRank graph ranking
sage = SageRank()
result = sage.rank("long text", top_k=5, query="optional bias")
result.summary           # selected sentences in document order
result.scores            # PageRank scores per sentence
result.selected_indices  # coverage-optimized selection
result.keywords          # top terms by eIDF · √df
```

### TypeScript API

```typescript
import {
  encodeOutput,          // v1 backward-compatible API
  compress,              // v2 full pipeline
  CompressConfig,
  TOONCompressor,
  BMXPlusIndex,
  SageRank,
  compressString,
  compressSourceStructured,
} from 'toon';

// v1 array folding
const encoded = encodeOutput(toolResult, 5);

// v2 full pipeline
const compressed = compress(data, 4000);

// Structure-aware source compression (requires StructureBlock[])
import type { StructureBlock } from 'toon';
const result = compressSourceStructured(sourceCode, budgetChars, blocks);

// Tree-sitter integration (engines barrel)
import { getDefinitions, getLangForFile, isSupported } from 'toon/engines';
```

---

## CLI

### Python

```bash
# Default mode — reads JSON from stdin, outputs compressed JSON
echo '{"data": [...]}' | python -m toon

# With budget override
echo '{"data": [...]}' | python -m toon --budget 2000

# Structured mode — reads {content, budget, structure} from stdin
echo '{"content": "...", "budget": 1500}' | python -m toon --structured
```

### TypeScript (after `npm run build`)

```bash
# Default mode
echo '{"data": [...]}' | node dist/cli.js

# Or via npm bin
echo '{"data": [...]}' | toon --budget 2000

# Structured mode
echo '{"content": "...", "budget": 1500, "structure": [...]}' | toon --structured

# Tree-sitter bridge — compress a source file to a character budget
node dist/engines/treesitter/toon-bridge.js path/to/file.py 8000
# or
toon-bridge path/to/file.ts 4000
```

**CLI flags:**

| Flag | Description |
|---|---|
| `-h`, `--help` | Show help |
| `--budget N` | Character/token budget override |
| `--structured` | Structured mode: reads `{content, budget, structure}` JSON |

---

## Configuration & Presets

### Pre-built Presets

| Preset | Use case | Key settings |
|---|---|---|
| `generic` | Safe default for unknown payloads | Truncates strings ≥ 500 chars to 400 |
| `codex_logs` | Codex/agent tool traces | Preserves `message`/`reasoning`; compresses `payload.output`, `stdout`, `stderr` |
| `mcp_responses` | MCP tool responses | Preserves `error`, `status`, `id`, `type`; compresses payloads ≥ 1000 chars |
| `aggressive` | Maximum compression | BMX+ scoring enabled; truncates all strings ≥ 200 chars to 200 |

```python
# Python
from toon.config import ToonConfig
cfg = ToonConfig.preset("codex_logs")

# TypeScript
import { toonConfigPreset } from 'toon';
const cfg = toonConfigPreset('codex_logs');
```

### Key Parameters

| Parameter | Default | Evidence Basis |
|---|---|---|
| Gini threshold | `0.2` | T-Retrievability, Ganguly 2025 (arXiv:2508.21704) |
| Hubness z-threshold | `3.0` | Adversarial hubness, Cisco 2026 |
| Redundancy r threshold | `0.95` | Engineering heuristic |
| Kneedle sensitivity | `1.0` | Satopää et al. 2011, IEEE ICDCS |
| Budget split | `60/30/10` | LLMLingua, ACL 2024 |
| Overhead reserve | `5%` | Engineering heuristic |
| Self/relevance blend | `0.4/0.6` | Engineering heuristic |
| LRU maxsize | `5000` | ~500 KB, covers typical sessions |

---

## Scripts & Commands

### Python (`toon.py/`)

```bash
# Install
uv sync                    # production deps
uv sync --extra dev        # + ruff, pytest, rouge-score

# Test
uv run pytest              # run all tests
python -m pytest tests/    # equivalent

# Lint
uv run ruff check .
uv run ruff format .

# Run pipeline smoke test
python -m toon.pipeline

# Run SageRank standalone
python test_sagerank.py

# Run router self-test
python -m toon.router
```

### TypeScript (`toon.ts/`)

```bash
# Install
npm install

# Build (TypeScript → dist/)
npm run build

# Test
npm test

# Typecheck only (no emit)
npx tsc --noEmit
```

---

## Deployment

TOON is a **library and CLI tool**, not a server. There is no Docker, CI/CD, or hosting configuration in the repository.

**Python distribution:**
- Package name: `toon-plus`
- Build backend: [Hatchling](https://hatch.pypa.io/)
- Packages included in wheel: `toon`, `engines`
- `pyproject.toml` is configured for PyPI publication

**TypeScript distribution:**
- Configured as a private package (`"private": true`) — not published to npm
- Binaries: `toon` (CLI), `toon-bridge` (tree-sitter bridge)

---

## Project Status

**Beta** — the core pipeline, both scoring engines, all four string codec strategies, and the tree-sitter integration are fully implemented in both Python and TypeScript. The TypeScript port mirrors the Python implementation and passes a cross-implementation parity test suite.

Benchmark results from the tree-sitter bridge integration:

| File | Language | Original | Compressed | Retained |
|---|---|---|---|---|
| `pipeline.py` | Python | 28 927 B | 20 299 B | 70.1% |
| `shared.js` | JavaScript | 16 400 B | 11 589 B | 70.6% |
| `test-dcp-cache.sh` | Shell | 13 441 B | 8 384 B | 62.3% |
| `index.ts` | TypeScript | 2 164 B | 2 163 B | 99.9% |
| `package.json` | JSON | 2 268 B | 1 583 B | 69.7% |

All runs exited with code 0, respecting character budgets to within ±1%.

**Active development area:** Symbol-structure integration (SYMBOL_STRUCTURE_PLAN.md) — a planned wave of changes to replace name-only heuristics in the priority scorer with richer AST-derived structural signals from tree-sitter.

**Invariants** (must hold across any refactoring):
- `encode_output(obj, threshold=5)` produces identical output to v1
- `compress()` always returns the same top-level type as input
- `"preserve"` tier entries are never modified
- `"cut"` tier entries are never included in output
- Entry ordering in output matches input ordering
- Zero external runtime dependencies (Python stdlib only + the three engines)
- Empty input returns empty output (`[]` or `None`)

