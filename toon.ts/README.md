# TOON Python→TypeScript Port — Final Output

This zip contains the complete port of the Python `toon` library into TypeScript for Zenith-MCP.

## Drop-in instructions

Files are laid out to mirror Zenith-MCP's source tree. To apply:

```
# from your Zenith-MCP repo root
cp -r src/toon                 <Zenith-MCP>/src/toon
cp src/core/compression.ts     <Zenith-MCP>/src/core/compression.ts
cp -r tests/toon               <Zenith-MCP>/tests/toon
cp TOON_PORT_VERIFICATION.md   <Zenith-MCP>/TOON_PORT_VERIFICATION.md
```

## What's inside

- `src/toon/` — 13 TypeScript files (5,091 lines), full port of Python toon
  - `types.ts` — shared interfaces
  - `utils.ts` — port of `_utils.py` (regex constants, hash, gini, kneedle, pearson, etc.)
  - `encoder.ts` — port of `encoder.py` (encodeOutput + re-export of compress from pipeline)
  - `config.ts` — port of `config.py` (all dataclasses + factory functions)
  - `bmx-plus.ts` — port of `engines/bmx_plus.py` (BMXPlusIndex)
  - `sagerank.ts` — port of `engines/sagerank.py` (SageRank, SageResult)
  - `dedup.ts` — port of `dedup.py` (Deduplicator)
  - `budget.ts` — port of `budget.py` (BudgetAllocator)
  - `string-codec.ts` — port of `string_codec.py` (compressString, compressSourceStructured + 6 internal compressors)
  - `router.ts` — port of `router.py` (self-test stripped)
  - `presets.ts` — port of `presets.py`
  - `pipeline.ts` — port of `pipeline.py` (CompressConfig, TOONCompressor, compress, deterministic seeding via Mulberry32)
  - `index.ts` — barrel re-exports

- `src/core/compression.ts` — modified. Now imports `compressSourceStructured`/`compressString` directly from `../toon/string-codec.js`. `runToonBridge` is preserved in-file for A/B reference but no longer called by `compressTextFile`. Failure semantics preserved (returns `null` on any error).

- `tests/toon/parity.test.ts` — 674 lines, 116 vanilla-Node assertions across all modules. All 116 passed when run with Node's built-in TS-strip preprocessing.

- `TOON_PORT_VERIFICATION.md` — 371-line verification report documenting all 17 completion criteria, banned-pattern audits, and deviations.

- `proofs/` — per-wave per-agent proof markdowns (8 files) showing what each subagent did, line counts, and self-audit results.

## Verification at a glance

- **Banned patterns**: ZERO matches across all files for `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `Array<any>`, `Promise<any>`, `Record<string, any>`, `Map<string, any>`, `as never`, or `: any` annotations
- **Parity tests**: 116/116 passed
- **toon_bridge.ts**: MD5-verified UNTOUCHED (`1ba6f3a508601966dd0b8cdf7a1e5f4c`)
- **No circular imports**: encoder → pipeline is one-way (encoder only re-exports `compress`, never imports a value from pipeline)
- **Self-test code stripped**: from both router.ts and pipeline.ts

## Documented deviations (acceptable per project guidance)

1. **`blake2bHash`** — Node's `crypto.createHash('blake2b512')` does not support variable digest size. The TS impl computes a full blake2b-512 hash and slices `digestSize * 2` hex chars. This is NOT bit-identical to Python's `hashlib.blake2b(data, digest_size=N)` (which produces a different hash for different N). Acceptable because the TS port replaces Python entirely — cross-implementation hash matching is not required, only TS↔TS determinism.

2. **Deterministic seeding for n>1000 sampling** — Python uses `random.Random(hashlib.md5(seed_text).hexdigest())`. The TS impl uses Mulberry32 PRNG seeded from MD5(seed). Deterministic on a per-input basis, but the exact random sequence does NOT match Python's. Sampling distribution is statistically equivalent.

3. **`NORMALIZERS` regex factory** — utils.ts wraps each `/g` regex in a factory function that returns a fresh regex per call. This avoids the JavaScript `lastIndex` statefulness footgun where `/g` regexes stored as constants and used with `.test()` advance their match position across calls.

## Budget

Port completed using ~$6.44 across 9 sonnet subagents in 4 waves.
