# TOON

**Smart compression for LLM context windows** — available in Python and TypeScript.

[![Python](https://img.shields.io/badge/python-3.10%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/status-beta-orange)](https://pypi.org/project/toon-plus/)
[![Zero Runtime Dependencies](https://img.shields.io/badge/dependencies-zero%20runtime-brightgreen)](toon.py/pyproject.toml)

---

## What is TOON?

When you're working with LLMs, context windows fill up fast — especially when tools are producing logs, JSON payloads, stack traces, or repetitive output. The easy fix is to just chop off the end, but that often throws away exactly what the model needs.

TOON is smarter about it. Given a pile of tool output and a token budget, it:

1. **Removes duplicates first** — exact copies, near-duplicates (same data but different timestamps/IDs), and repetitive log patterns are collapsed before anything else.
2. **Scores what's left** — it figures out which entries are most important by looking at how central and relevant each one is to the rest of the corpus.
3. **Compresses intelligently** — high-scoring content gets more budget; low-scoring content gets trimmed or dropped. Stack traces, JSON, logs, and plain text each get their own specialized compressor.

The result is a context that fits in your budget while keeping the signal and cutting the noise.

---

## Quick Start

### Python

```bash
git clone https://github.com/itstanner5216/toon.git
cd toon/toon.py

# Install (no external runtime dependencies)
pip install -e .
```

```python
from toon import compress, encode_output

# One-liner: compress any tool output to a token budget
result = compress(my_tool_output, budget=4000)

# If you just want large arrays summarized (v1 behavior, unchanged):
result = encode_output(my_tool_output, threshold=5)
```

### TypeScript

```bash
cd toon/toon.ts
npm install
npm run build
```

```typescript
import { compress, encodeOutput } from 'toon';

// Compress to a character budget
const result = compress(myToolOutput, 4000);

// Or just fold large arrays (v1 behavior):
const result = encodeOutput(myToolOutput, 5);
```

---

## How It Works

TOON runs three stages on your data:

**Stage 1 — Deduplication**
Before scoring a single entry, TOON removes the noise:
- *Exact duplicates*: identical entries are dropped immediately.
- *Near-duplicates*: entries that differ only in timestamps, UUIDs, IP addresses, or numbers are recognized as the same thing and collapsed.
- *Repetitive templates*: if you have 50 log lines that are all the same shape, they get folded into a "first + last + count" summary.

**Stage 2 — Scoring**
The remaining entries are scored for importance. TOON builds a similarity graph across your data (using SageRank, a graph-ranking algorithm) and assigns relevance scores using BMX+, a lexical search engine. The highest-scoring entries are marked `high`; the lowest are marked `cut`.

**Stage 3 — Compression**
Budget is divided by tier: high-importance entries get 60% of the space, medium gets 30%, low gets 10%, and anything marked `cut` is dropped entirely. Each entry is then compressed using the right strategy for its content type:

| Content type | What happens |
|---|---|
| Stack trace | Keeps the exception header + the most important frames; drops redundant library frames |
| JSON string | Traverses depth-first, keeping the most important keys first |
| Log output | Deduplicates repeated lines by pattern, fills space by severity (ERRORs first) |
| Plain text | Adapts head/tail split based on where the interesting content tends to be |

---

## Features

- ✅ Works on any JSON-serializable data — dicts, lists, strings, mixed structures
- ✅ Zero runtime dependencies in Python (just the standard library)
- ✅ Backward-compatible: existing `encode_output()` call sites work without changes
- ✅ Streaming mode for processing entries one at a time
- ✅ Source-code compression using tree-sitter AST (40+ languages)
- ✅ Four ready-to-use presets for common scenarios
- ✅ Fully configurable routing rules for per-field behavior
- ✅ CLI for piping JSON through from the command line
- ✅ Identical implementation in both Python and TypeScript, with parity tests

---

## Presets

Don't want to configure anything? Pick a preset that fits your use case:

| Preset | Best for | What it does |
|---|---|---|
| `generic` | Unknown/mixed payloads | Trims any string over 500 characters |
| `codex_logs` | AI agent tool traces | Keeps `message` and `reasoning` untouched; trims `stdout`, `stderr`, and payload output |
| `mcp_responses` | MCP tool responses | Preserves status, error, and ID fields; compresses large payloads |
| `aggressive` | Maximum compression | Enables full scoring pipeline; trims all strings over 200 characters |

```python
# Python
from toon.config import ToonConfig

cfg = ToonConfig.preset("codex_logs")
result = compress(tool_output, budget=4000, config=cfg)
```

```typescript
// TypeScript
import { toonConfigPreset, compress } from 'toon';

const cfg = toonConfigPreset('codex_logs');
const result = compress(toolOutput, 4000, cfg);
```

---

## Streaming Mode

If you're processing entries one at a time (e.g. as tool calls come in), use the streaming compressor so deduplication state is maintained across entries:

```python
from toon import TOONCompressor

compressor = TOONCompressor()

for entry in tool_call_stream:
    out = compressor.feed(entry)
    if out is not None:          # None means it was a duplicate
        context.append(out)

compressor.reset()               # call this at the start of a new session
```

---

## Source Code Compression

TOON can compress source code files intelligently by using the file's AST structure — instead of truncating blindly, it keeps exported functions and important entry points and trims private helpers and test functions first.

This requires the tree-sitter bridge, which supports 40+ languages including Python, TypeScript, JavaScript, Go, Rust, Java, C, C++, C#, Ruby, Swift, Kotlin, and more.

```bash
# TypeScript: compress a file to a character budget
toon-bridge path/to/file.py 8000

# Python version (calls toon --structured as a subprocess)
node engines/treesitter/toon_bridge.js path/to/file.py 8000
```

---

## CLI

Both implementations expose a `toon` command that reads from stdin and writes to stdout:

```bash
# Compress JSON piped in
echo '{"logs": [...]}' | python -m toon --budget 2000

# TypeScript (after npm run build)
echo '{"logs": [...]}' | toon --budget 2000

# Source-structured mode (pass content + structure as JSON)
echo '{"content": "...", "budget": 1500}' | python -m toon --structured
```

**Flags:**

| Flag | What it does |
|---|---|
| `--budget N` | Set a character/token budget |
| `--structured` | Expect `{content, budget, structure}` JSON on stdin |
| `-h` / `--help` | Show usage |

---

## Installation & Setup

### Python

**Requirements:** Python 3.10, 3.11, 3.12, or 3.13. No external runtime packages.

```bash
cd toon/toon.py

# Recommended (using uv)
uv sync

# Or with pip
pip install -e .

# Install dev tools (linter + test runner)
uv sync --extra dev

# Run tests
uv run pytest

# Lint
uv run ruff check .
```

### TypeScript

**Requirements:** Node.js 18+. Only runtime dependency: `web-tree-sitter`.

```bash
cd toon/toon.ts

npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm test             # run parity tests
npx tsc --noEmit     # type-check without compiling
```

---

## Project Layout

```
toon/
├── toon.py/               Python package (toon-plus v2.0.0)
│   ├── toon/              Core library: pipeline, dedup, scoring, codecs, config
│   ├── engines/           Standalone scoring engines: BMX+ and SageRank
│   │   └── treesitter/    Tree-sitter bridge (calls Python toon --structured)
│   └── tests/
│
└── toon.ts/               TypeScript port (v1.0.0)
    ├── src/toon/          Core library (full port of toon.py)
    ├── src/engines/       Engines barrel + tree-sitter wrapper
    ├── src/cli.ts         CLI entry point
    ├── grammars/          40+ language WASM grammars and query files
    └── tests/             Parity tests (Python ↔ TypeScript output matching)
```

For a deeper dive into the internals — algorithm details, configuration reference, and the parameter evidence table — see [ARCHITECTURE.md](toon.py/ARCHITECTURE.md).

---

## Project Status

**Beta.** The core pipeline, both scoring engines, all string codec strategies, and the tree-sitter integration are fully implemented in Python and TypeScript, with a parity test suite ensuring the two implementations stay in sync.

Real-world compression results from the tree-sitter bridge:

| File | Original size | Compressed | Retained |
|---|---|---|---|
| `pipeline.py` | 28,927 B | 20,299 B | 70% |
| `shared.js` | 16,400 B | 11,589 B | 71% |
| `test-dcp-cache.sh` | 13,441 B | 8,384 B | 62% |
| `package.json` | 2,268 B | 1,583 B | 70% |

All runs respected their character budgets to within ±1%.

**What's being actively worked on:** replacing the name-based symbol priority heuristic in the source-code compressor with richer signals derived directly from the AST — so the compressor can make smarter decisions about what to keep based on structure, not just function names.

