# Toon.ts Symbol Structure Integration — Wave-Based Execution Plan

> **Goal**: Integrate AST-derived symbol structure metadata into toon.ts's compression priority scoring, replacing name-only heuristics with richer structural signals while enforcing zero regressions on existing tests.
>
> **Total Waves:** 3
> **Total Tasks:** 5
> **Max Parallel Tasks in Single Wave:** 3

---

## Project Context

**toon.ts** is a standalone TypeScript code compression library for LLM context windows. It compresses source code files to ~70% of their original size while retaining semantic understanding.

### Tech Stack
- Language: TypeScript (strict mode, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`)
- Module system: ESM with Node16 resolution (imports use `.js` extensions pointing at `.ts` source files)
- Build: `npx tsc` (outputs to `dist/`)
- Test: `npx tsx tests/toon/parity.test.ts` (custom harness — NOT vitest/jest — outputs pass/fail counts)
- Tree-sitter: `web-tree-sitter` WASM for AST parsing
- tsconfig: `"strict": true`, `"types": ["node"]`, target ES2022

### Project Structure
```
src/
├── toon/                  # Core compression library (13 files, ~5k lines)
│   ├── string-codec.ts    # String-level compressors (1059 lines) — EDIT TARGET
│   ├── types.ts           # Shared type interfaces (232 lines) — EDIT TARGET
│   ├── sagerank.ts        # Sentence ranking (882 lines) — read only
│   ├── pipeline.ts        # Multi-entry pipeline (741 lines) — read only
│   ├── bmx-plus.ts        # BM25 scoring (574 lines) — read only
│   ├── dedup.ts           # Deduplication (345 lines) — read only
│   ├── utils.ts           # Shared utilities (358 lines) — read only
│   ├── config.ts          # Configuration (313 lines) — read only
│   ├── budget.ts          # Budget allocation (145 lines) — read only
│   ├── router.ts          # Field routing (129 lines) — read only
│   ├── encoder.ts         # Output encoding (107 lines) — read only
│   ├── index.ts           # Public API barrel (103 lines) — read only
│   └── presets.ts         # Preset configs (98 lines) — read only
├── engines/
│   └── treesitter/
│       ├── tree-sitter.ts # Tree-sitter engine (952 lines) — EDIT TARGET
│       ├── toon-bridge.ts # Bridge: tree-sitter → toon codec (67 lines) — EDIT TARGET
│       └── web-tree-sitter.d.ts # WASM type declarations — read only
├── cli.ts                 # CLI entry point — read only
tests/
└── toon/
    └── parity.test.ts     # Existing parity tests (674 lines, 116 passing) — EDIT TARGET (append only)
```

### Critical Constraints

1. **All 116 existing tests must pass unchanged** — no modifications to existing test code
2. **`npx tsc --noEmit` must pass clean** — zero errors in `src/toon/` and `src/engines/`
3. **Test runner**: `npx tsx tests/toon/parity.test.ts` — must output `FAILED: 0`
4. **Import convention**: all `.ts` files import with `.js` extensions (ESM NodeNext)

---

## Current Architecture (What Exists Today)

### Priority Scoring (`string-codec.ts:688-704`)

The current logic assigns compression priority based ONLY on the block name:

```typescript
// string-codec.ts:688-704 — CURRENT scoring
const workingStructure: Array<StructureBlock & { priority: number }> = structure.map((block) => {
    const name = (block.name ?? '').trim();
    const exported = block.exported ?? false;
    let priority: number;

    if (name === '__main__' || name.startsWith('test_') || name.startsWith('Test')) {
      priority = 10;      // test/main → lowest
    } else if (_ENTRY_POINT_NAMES.has(name.toLowerCase()) || _DUNDER_KEEPERS.has(name) || exported) {
      priority = 300;     // entry points + exported → highest
    } else if (name.startsWith('_')) {
      priority = 100;     // private → low
    } else {
      priority = 200;     // default → medium
    }

    return { ...block, priority };
});
```

Blocks are sorted `priority desc` at line 762, then budget is allocated highest-first.

### Tree-sitter Pipeline (`tree-sitter.ts`)

The current flow for compression:
1. `toon-bridge.ts:39` calls `getDefinitions(content, langName)`
2. `getDefinitions()` (line 606) delegates to `getSymbols()` (line 493)
3. `getSymbols()` parses with tree-sitter, runs tag queries, returns `ToonSymbol[]`
4. `getSymbols()` deletes the tree and parser before returning (lines 573-574)
5. Bridge maps `ToonSymbol[]` → `StructureBlock[]` (converting 1-based to 0-based lines)

**Key limitation**: `getSymbols()` discards the parse tree, so structural metadata (params, types, modifiers) is lost. The only data preserved is `name`, `kind`, `type`, `line`, `endLine`, `column`.

### ToonSymbol Interface (`tree-sitter.ts:171-179`)

```typescript
export interface ToonSymbol {
  kind: 'def' | 'ref';
  type: string;        // e.g., 'function', 'class', 'method'
  name: string;        // symbol name
  line: number;        // 1-based start line
  endLine: number;     // 1-based end line
  column: number;      // 0-based column
  exported?: boolean;
}
```

### StructureBlock Interface (`types.ts:16-25`)

```typescript
export interface StructureBlock {
  name: string;
  kind: string;
  type: string;
  startLine: number;     // 0-based
  endLine: number;       // 0-based inclusive
  exported: boolean;
  anchors: Anchor[];
  priority?: number;
}
```

### Anchor Interface (`types.ts:27-32`)

```typescript
export interface Anchor {
  startLine: number;
  endLine: number;
  kind: string;
  priority: number;
}
```

### Bridge Mapping (`toon-bridge.ts:45-54`)

```typescript
structure = defs.map((d) => ({
  name: d.name,
  kind: d.kind,
  type: d.type,
  startLine: d.line - 1,     // 1-based → 0-based
  endLine: d.endLine - 1,
  exported: false,            // NOT populated from ToonSymbol
  anchors: [],                // NOT populated (no anchor extraction yet)
}));
```

### Helper Constants (`string-codec.ts:35-56`)

```typescript
// string-codec.ts:35-50 — entry point names that get priority 300
const _ENTRY_POINT_NAMES: ReadonlySet<string> = new Set([
  '__init__', '__call__', '__enter__', '__exit__',
  'main', 'run', 'start', 'stop', 'close', 'open', 'setup', 'teardown', 'reset',
  'compress', 'decompress', 'encode', 'decode',
  'search', 'query', 'find', 'get', 'fetch',
  'handle', 'execute', 'process', 'dispatch', 'call', 'invoke',
  'create', 'insert', 'save', 'load', 'read', 'write',
  'connect', 'disconnect', 'send', 'receive', 'listen',
  'validate', 'parse', 'serialize', 'deserialize',
  // ... (full list in file)
]);

// string-codec.ts:52-56 — dunder methods that get priority 300
const _DUNDER_KEEPERS: ReadonlySet<string> = new Set([
  '__init__', '__call__', '__enter__', '__exit__', '__aenter__', '__aexit__',
  '__str__', '__repr__', '__len__', '__iter__', '__next__',
  '__getitem__', '__setitem__', '__contains__',
]);
```

---

## Feature Specification

### SymbolStructure: Normalized Structural Metadata

Add a new interface for AST-derived metadata, normalized to semantic fields (NOT raw AST node types) for cross-language portability:

```typescript
export interface SymbolStructure {
  paramCount: number;          // number of function/method parameters
  hasTypedParams: boolean;     // at least one param has a type annotation
  hasReturnType: boolean;      // function has a return type annotation
  isAsync: boolean;            // async modifier present
  visibility: 'public' | 'private' | 'protected' | null;  // access modifier (null = not specified)
  decoratorCount: number;      // number of attached decorators
  parentKind: string | null;   // enclosing scope: 'class_declaration', 'program', etc.
}
```

### New Function: `getDefinitionsWithStructure()`

A new export in `tree-sitter.ts` that combines `getDefinitions()` symbol extraction with structural metadata extraction in a **single parse pass**. This is NOT a wrapper around `getDefinitions()` — it must do its own parse to keep the tree alive for structure extraction.

Returns: `ToonSymbol` array where each symbol has an additional `structure?: SymbolStructure` field.

### Enhanced Priority Scoring

Replace inline scoring with a pure exported function `scoreStructureBlock()`.

**Scoring design — tier-weighted to prevent cross-tier violations:**

```
score = baseTier * 1000 + structureBonus

Base tiers (from name/exported status):
  10  — test/main blocks
  100 — private (name starts with _)
  200 — default
  300 — exported / entry points / dunder keepers

Structure bonuses (additive, 0-160 range, only when structure data is present):
  +50 — has typed parameters
  +40 — has return type annotation
  +30 — async modifier
  +20 — explicit public visibility
  +10 — has any decorators (boolean, not per-decorator)
  +10 — complex signature (paramCount >= 3)

Examples:
  exported entry point, no structure: 300 * 1000 + 0 = 300000
  default name, fully enriched:       200 * 1000 + 160 = 200160
  private, no structure:              100 * 1000 + 0 = 100000

This guarantees exported ALWAYS outranks non-exported, and test ALWAYS stays bottom,
regardless of how many structure bonuses accumulate.
```

**Missing structure = neutral**: When `block.structure` is undefined, bonus is 0, producing `baseTier * 1000` — which preserves the exact same RELATIVE ordering as today's name-based logic.

### Ordering Invariants (MUST be tested)

1. `exported with no structure` > `non-exported with max structure` (tier separation)
2. `default with rich structure` > `default with no structure` (bonuses help within tier)
3. `test with max structure` < `private with no structure` (test stays bottom)
4. `block with structure` ≥ `same block without structure` (bonuses never negative)
5. Equal-score blocks sort by `startLine` ascending (deterministic tiebreaker)

---

## Reference: Zenith-MCP's `getSymbolStructure()` Pattern

From `/home/tanner/Projects/Zenith-MCP/src/core/tree-sitter.ts:957-1077`. This function extracts structural metadata from an AST definition node. **Use this as the extraction pattern but normalize the outputs:**

```typescript
// Key extraction patterns to adapt:

// 1. Definition node types to look for:
const DEF_TYPES = new Set([
    'function_declaration', 'function_definition', 'method_definition',
    'arrow_function', 'function', 'method',
    'class_declaration', 'class_definition',
    'function_signature', 'method_signature',
    'lexical_declaration', 'variable_declaration',
]);

// 2. Parameter extraction — find child matching /parameters?$/ or 'formal_parameters':
//    Count non-punctuation children for paramCount
//    Check if any param child has type containing 'typed' or has 'type_annotation' child → hasTypedParams

// 3. Return type — check children for fieldName === 'return_type' or type matching /type_annotation|return_type/ → hasReturnType

// 4. Modifiers — look for child nodes with types: 'async', 'static', 'public', 'private', 'protected', 'readonly'
//    → isAsync (from 'async'), visibility (from 'public'/'private'/'protected')

// 5. Decorators — check preceding siblings for 'decorator' type nodes, AND children of the def node itself
//    → decoratorCount

// 6. Parent context — walk up .parent chain looking for DEF_TYPES or 'program'/'module'/'source_file'
//    → parentKind
```

**Critical difference from Zenith**: Zenith's `getSymbolStructure()` creates a new Parser for each call. In toon.ts, `getDefinitionsWithStructure()` must extract structure from the SAME parse tree used for symbol extraction. Never create an additional Parser.

---

## Wave-Based Execution Plan

### FILE INVENTORY
```
├── Files to MODIFY:
│   ├── src/toon/types.ts — Add SymbolStructure interface + structure field to StructureBlock
│   ├── src/engines/treesitter/tree-sitter.ts — Add getDefinitionsWithStructure(), extractSymbolStructure()
│   ├── src/toon/string-codec.ts — Add scoreStructureBlock(), update _compressSourceStructured()
│   ├── src/engines/treesitter/toon-bridge.ts — Switch from getDefinitions to getDefinitionsWithStructure
│   └── tests/toon/parity.test.ts — Append new test blocks (APPEND ONLY — do not touch existing tests)
├── Files to READ (no modifications):
│   ├── src/engines/treesitter/web-tree-sitter.d.ts — Node type interface
│   └── tsconfig.json — Compiler configuration
```

### DEPENDENCY PROOF TABLE

| Task | Claims to depend on | Proof | Verdict |
|------|-------------------|-------|---------|
| B | A | Needs `SymbolStructure` type to type the return value — interface doesn't exist on disk without A | REAL |
| C | A | Needs `SymbolStructure` type for `block.structure?` access — interface doesn't exist without A | REAL |
| C | B | Does NOT need B on disk — `scoreStructureBlock` takes a `StructureBlock` regardless of who populates `.structure` | FALSE |
| D | A | Needs `StructureBlock` with `structure?` field for the type annotation in the mapping | REAL |
| D | B | Needs B — bridge switches to `getDefinitionsWithStructure()` which Task B creates. That function doesn't exist on disk without B | REAL |
| E | A,B,C,D | Integration tests need all pieces wired together to verify end-to-end behavior | REAL |

---

## Wave 1: Type Foundation (Sequential)

> **1 task.** Creates the shared type that all other tasks depend on.

### Task 1.1: Add SymbolStructure Interface + Extend StructureBlock

**File:** `src/toon/types.ts`

**Implementation Details:**

1. Add the `SymbolStructure` interface AFTER the `Anchor` interface (after line 32):

```typescript
/**
 * Normalized structural metadata for a symbol, extracted from AST.
 * All fields are semantic (not raw AST node types) for cross-language portability.
 * Missing/unsupported fields use neutral defaults (0, false, null).
 */
export interface SymbolStructure {
  paramCount: number;
  hasTypedParams: boolean;
  hasReturnType: boolean;
  isAsync: boolean;
  visibility: 'public' | 'private' | 'protected' | null;
  decoratorCount: number;
  parentKind: string | null;
}
```

2. Add optional `structure` field to `StructureBlock` interface (after line 24, after `priority?`):

```typescript
  structure?: SymbolStructure;
```

**DO NOT** modify any existing fields or their types.

**Acceptance Criteria:**
- [ ] `SymbolStructure` interface exported from types.ts
- [ ] `StructureBlock.structure` is optional (`structure?: SymbolStructure`)
- [ ] All existing fields in `StructureBlock` unchanged
- [ ] `npx tsc --noEmit` passes with zero errors in `src/toon/`

**Verification:**
```bash
npx tsc --noEmit 2>&1 | grep -c 'src/toon/'
# Expected: 0
```

---

## Wave 2: Parallel Implementation (3 tasks)

> **PARALLEL EXECUTION:** All 3 tasks run simultaneously.
>
> **Dependencies:** Wave 1 must complete (`SymbolStructure` type must exist on disk)
> **File Safety:**
> - `src/engines/treesitter/tree-sitter.ts`: only Task 2.1 ✓
> - `src/toon/string-codec.ts`: only Task 2.2 ✓
> - `src/engines/treesitter/toon-bridge.ts`: only Task 2.3 ✓

### Task 2.1: Add `getDefinitionsWithStructure()` to tree-sitter.ts

**File:** `src/engines/treesitter/tree-sitter.ts`

**Codebase References:**
- `getSymbols()` at line 493 — current parsing + symbol extraction logic (USE AS TEMPLATE)
- `getDefinitions()` at line 606 — thin wrapper over getSymbols with `kindFilter: 'def'`
- `ToonSymbol` interface at line 171 — current symbol shape
- `loadLanguage()` at line 263 — language WASM loading
- `Parser`, `Node` from `web-tree-sitter` — imported at line 30

**Implementation Details:**

1. Add import of `SymbolStructure` at top of file:
```typescript
import type { SymbolStructure } from '../../toon/types.js';
```

2. Extend `ToonSymbol` — add optional structure field to the interface (line 171):
```typescript
export interface ToonSymbol {
  kind: 'def' | 'ref';
  type: string;
  name: string;
  line: number;
  endLine: number;
  column: number;
  exported?: boolean;
  structure?: SymbolStructure;  // ← ADD THIS
}
```

3. Add a pure helper function `extractSymbolStructure(defNode: Node): SymbolStructure`:
   - **paramCount**: Find first child matching `/parameters?$/` or `formal_parameters`. Count its non-punctuation children (exclude `(`, `)`, `,`).
   - **hasTypedParams**: Check if any parameter child has `.type` containing `'typed'` (e.g., `typed_parameter`, `typed_default_parameter`), OR has a child with `.type === 'type_annotation'`.
   - **hasReturnType**: Check if any direct child of `defNode` has `fieldNameForChild` returning `'return_type'`, or `.type` matching `/^type_annotation$|^return_type$/`.
   - **isAsync**: Check if any direct child of `defNode` has `.type === 'async'`.
   - **visibility**: Check direct children for `.type` in `{'public', 'private', 'protected'}`. Use the first match; null if none.
   - **decoratorCount**: Check preceding siblings of `defNode` in `defNode.parent` for `.type === 'decorator'`. Also check `defNode`'s own children for `decorator` type. Count total.
   - **parentKind**: Walk up `defNode.parent` chain. Return `.type` of first ancestor that is a def type (`function_declaration`, `class_declaration`, etc.), `program`, `module`, or `source_file`. Null if root reached without match.

4. Add the main function `getDefinitionsWithStructure()`:

```typescript
/**
 * Get definition symbols with structural metadata, extracted in a single parse pass.
 * Unlike getDefinitions() which discards the tree, this keeps it alive to extract
 * params, types, modifiers, decorators for each definition node.
 */
export async function getDefinitionsWithStructure(
  source: string,
  langName: string,
): Promise<ToonSymbol[] | null> {
  const language = await loadLanguage(langName);
  if (!language) return null;

  const query = await getCompiledQuery(langName);
  if (!query) return null;

  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    return null;
  }

  try {
    // Step 1: Extract symbols using same query logic as getSymbols()
    //         (copy the match extraction loop from getSymbols lines 521-570)
    //         Filter to kind === 'def' only (like getDefinitions does)
    const matches = query.matches(tree.rootNode);
    const symbols: ToonSymbol[] = [];
    const seen = new Set<string>();
    // ... (same extraction logic as getSymbols, filtered to definitions only)

    // Step 2: For each definition symbol, find its AST node and extract structure
    const DEF_TYPES = new Set([
        'function_declaration', 'function_definition', 'method_definition',
        'arrow_function', 'function', 'method',
        'class_declaration', 'class_definition',
        'function_signature', 'method_signature',
        'lexical_declaration', 'variable_declaration',
    ]);

    for (const sym of symbols) {
      // Find the smallest DEF_TYPE node containing this symbol's line range
      const targetStartRow = sym.line - 1;  // ToonSymbol uses 1-based lines
      const targetEndRow = sym.endLine - 1;

      let bestNode: Node | null = null;

      function findSmallestDef(node: Node): void {
        if (DEF_TYPES.has(node.type) &&
            node.startPosition.row <= targetStartRow + 1 &&
            node.endPosition.row >= targetEndRow - 1) {
          // This node contains the symbol — check if it's smaller than current best
          if (!bestNode ||
              (node.endPosition.row - node.startPosition.row) <
              (bestNode.endPosition.row - bestNode.startPosition.row)) {
            bestNode = node;
          }
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) findSmallestDef(child);
        }
      }
      findSmallestDef(tree.rootNode);

      if (bestNode) {
        sym.structure = extractSymbolStructure(bestNode);
      }
      // If no def node found, sym.structure stays undefined → neutral scoring
    }

    symbols.sort((a, b) => a.line - b.line);
    return symbols;
  } finally {
    tree.delete();
    parser.delete();
  }
}
```

**CRITICAL CONSTRAINTS:**
- Do NOT call `getSymbols()` or `getDefinitions()` — they delete the tree before returning
- Create exactly ONE `new Parser()` and call `parser.parse()` exactly once
- Delete tree and parser in `finally` block
- The `extractSymbolStructure()` helper must be a pure function (takes `Node`, returns `SymbolStructure`)
- When a def node isn't found, `sym.structure` stays `undefined` — never throw, never set to a default structure
- Use **smallest-containing-node** matching, not strict line equality (handles decorators, multi-line signatures)

**Acceptance Criteria:**
- [ ] `extractSymbolStructure()` is a pure helper function
- [ ] `getDefinitionsWithStructure()` is exported
- [ ] Single parse pass — exactly one `new Parser()` and one `parser.parse()` call
- [ ] Tree and parser cleaned up in `finally` block
- [ ] `ToonSymbol` interface extended with optional `structure` field
- [ ] `npx tsc --noEmit 2>&1 | grep -c 'tree-sitter'` returns `0`

---

### Task 2.2: Add Pure Scoring Function + Update Priority Assignment

**File:** `src/toon/string-codec.ts`

**Codebase References:**
- Current scoring at line 688-704 — to be replaced
- `_ENTRY_POINT_NAMES` at line 35-50 — keep using
- `_DUNDER_KEEPERS` at line 52-56 — keep using
- Block sorting at line 762 — add secondary sort by `startLine`
- Import `StructureBlock` already at line 6

**Implementation Details:**

1. Add `SymbolStructure` to the existing import from `./types.js` (line 6):
```typescript
import type { StructureBlock, Anchor, SymbolStructure } from './types.js';
```
Note: `SymbolStructure` may be unused at import time since the scoring function only accesses `block.structure` through the `StructureBlock` type. If `noUnusedLocals` flags it, remove the explicit import and access `.structure` through the optional chain on `StructureBlock` — the type is already embedded via the `structure?: SymbolStructure` field.

2. Add the pure scoring function BEFORE `_compressSourceStructured` (before line 670):

```typescript
/**
 * Compute compression priority for a structure block.
 * Pure function — deterministic, no side effects.
 *
 * Uses tier-weighted scoring: score = baseTier * 1000 + structureBonus
 * This guarantees tier separation — exported always outranks non-exported.
 */
export function scoreStructureBlock(block: StructureBlock): number {
    const name = (block.name ?? '').trim();
    const exported = block.exported ?? false;
    let baseTier: number;

    if (name === '__main__' || name.startsWith('test_') || name.startsWith('Test')) {
        baseTier = 10;
    } else if (_ENTRY_POINT_NAMES.has(name.toLowerCase()) || _DUNDER_KEEPERS.has(name) || exported) {
        baseTier = 300;
    } else if (name.startsWith('_')) {
        baseTier = 100;
    } else {
        baseTier = 200;
    }

    let bonus = 0;
    const structure = block.structure;
    if (structure) {
        if (structure.hasTypedParams)    bonus += 50;
        if (structure.hasReturnType)     bonus += 40;
        if (structure.isAsync)           bonus += 30;
        if (structure.visibility === 'public') bonus += 20;
        if (structure.decoratorCount > 0) bonus += 10;
        if (structure.paramCount >= 3)   bonus += 10;
    }

    return baseTier * 1000 + bonus;
}
```

3. Replace the inline scoring in `_compressSourceStructured` (lines 688-704) with:

```typescript
const workingStructure: Array<StructureBlock & { priority: number }> = structure.map((block) => ({
    ...block,
    priority: scoreStructureBlock(block),
}));
```

4. Update the block sort at line 762 to add deterministic tiebreaker:

```typescript
// BEFORE (line 762):
const sortedBlocks = [...workingStructure].sort((a, b) => b.priority - a.priority);

// AFTER:
const sortedBlocks = [...workingStructure].sort((a, b) =>
    b.priority - a.priority || a.startLine - b.startLine
);
```

**CRITICAL CONSTRAINTS:**
- `scoreStructureBlock` must be `export`ed (tests import it directly)
- When `block.structure` is `undefined`, bonus is 0 → score is `baseTier * 1000`
- The RELATIVE ordering of blocks without structure is identical to today: `300000 > 200000 > 100000 > 10000`
- No negative bonuses — structure data can only help, never hurt

**Acceptance Criteria:**
- [ ] `scoreStructureBlock` is exported and pure
- [ ] When `block.structure` is undefined, scoring matches tier-weighted version of current logic
- [ ] Bonuses only add to base tier (never subtract)
- [ ] Sort includes `startLine` ascending tiebreaker
- [ ] `npx tsc --noEmit 2>&1 | grep -c 'string-codec'` returns `0`

---

### Task 2.3: Update Bridge to Use `getDefinitionsWithStructure()`

**File:** `src/engines/treesitter/toon-bridge.ts`

**Codebase References:**
- Current import at line 12: `import { getDefinitions, getLangForFile } from './tree-sitter.js'`
- Current mapping at lines 45-54 — add `structure` pass-through

**Implementation Details:**

1. Change the import (line 12):
```typescript
// BEFORE:
import { getDefinitions, getLangForFile } from './tree-sitter.js';

// AFTER:
import { getDefinitionsWithStructure, getLangForFile } from './tree-sitter.js';
```

2. Change the call site (line 39):
```typescript
// BEFORE:
const defs = await getDefinitions(content, langName);

// AFTER:
const defs = await getDefinitionsWithStructure(content, langName);
```

3. Add `structure` to the block mapping (around line 45-54):
```typescript
structure = defs.map((d) => ({
  name: d.name,
  kind: d.kind,
  type: d.type,
  startLine: d.line - 1,
  endLine: d.endLine - 1,
  exported: d.exported ?? false,  // NOTE: also pass through exported if present
  anchors: [],
  structure: d.structure,         // ← ADD: pass through structure if present
}));
```

**Acceptance Criteria:**
- [ ] Import changed from `getDefinitions` to `getDefinitionsWithStructure`
- [ ] Call site updated
- [ ] `structure` field passed through in block mapping
- [ ] `exported` now passed through from `d.exported` (was hardcoded `false`)
- [ ] `npx tsc --noEmit 2>&1 | grep -c 'toon-bridge'` returns `0`

> **BEFORE reporting Wave 2 complete:**
> ```bash
> npx tsc --noEmit 2>&1 | grep -E 'src/toon/|src/engines/' | head -20
> ```
> Expected: zero errors. Fix any that appear before proceeding.

---

## Wave 3: Testing (Sequential)

> **1 task.**
> **Dependencies:** Wave 2 must complete (all implementation in place)

### Task 3.1: Append Tests to parity.test.ts

**File:** `tests/toon/parity.test.ts`

**Codebase References:**
- Test helpers at lines 35-62: `record()`, `assertEq()`, `assertTrue()`, `assertCloseTo()`
- Results section starts at line 658 — insert ALL new tests BEFORE this line
- Existing imports at top of file — add new imports there

**CRITICAL: Do NOT modify any existing test code. ONLY:**
1. Add new imports at the top (after existing imports, before line 33)
2. Append new test blocks before the results section (before line 658)

**Implementation Details:**

1. Add new imports after the existing imports (around line 31):
```typescript
import { scoreStructureBlock } from '../../src/toon/string-codec.js';
import type { SymbolStructure } from '../../src/toon/types.js';
```

2. Append the following test blocks BEFORE the `// Print results` section:

**Test Group A: scoreStructureBlock — fallback compatibility (no structure = same as old logic)**
```typescript
// ============================================================
// scoreStructureBlock: fallback compatibility
// ============================================================
{
  const score = (name: string, exported: boolean) =>
      scoreStructureBlock({ name, kind: 'function', type: 'function', startLine: 0, endLine: 10, exported, anchors: [] });

  // These must match tier * 1000 for the old tiers (10, 100, 200, 300)
  assertEq(score('__main__', false), 10000, 'score: __main__ no structure');
  assertEq(score('test_foo', false), 10000, 'score: test_ no structure');
  assertEq(score('TestSuite', false), 10000, 'score: Test* no structure');
  assertEq(score('main', false), 300000, 'score: entry point no structure');
  assertEq(score('run', true), 300000, 'score: exported entry no structure');
  assertEq(score('_helper', false), 100000, 'score: private no structure');
  assertEq(score('doWork', false), 200000, 'score: default no structure');
  assertEq(score('doWork', true), 300000, 'score: exported no structure');
}
```

**Test Group B: scoreStructureBlock — ordering invariants**
```typescript
// ============================================================
// scoreStructureBlock: ordering invariants
// ============================================================
{
  const richStructure: SymbolStructure = {
      paramCount: 5, hasTypedParams: true, hasReturnType: true,
      isAsync: true, visibility: 'public', decoratorCount: 2, parentKind: 'class_declaration',
  };
  const neutralStructure: SymbolStructure = {
      paramCount: 0, hasTypedParams: false, hasReturnType: false,
      isAsync: false, visibility: null, decoratorCount: 0, parentKind: null,
  };

  const score = (name: string, exported: boolean, structure?: SymbolStructure) =>
      scoreStructureBlock({ name, kind: 'function', type: 'function', startLine: 0, endLine: 10, exported, anchors: [], structure });

  // Invariant 1: exported with no structure > non-exported with MAX structure (tier separation)
  assertTrue(
      score('doWork', true) > score('doWork', false, richStructure),
      'ordering: exported no-struct > non-exported rich-struct'
  );

  // Invariant 2: same tier, rich structure > neutral structure
  assertTrue(
      score('doWork', false, richStructure) > score('doWork', false, neutralStructure),
      'ordering: rich > neutral within same tier'
  );

  // Invariant 3: test with max structure < private with no structure (test stays bottom)
  assertTrue(
      score('test_foo', false, richStructure) < score('_helper', false),
      'ordering: test+rich < private+none'
  );

  // Invariant 4: structure never decreases score below no-structure baseline
  assertTrue(
      score('doWork', false, neutralStructure) >= score('doWork', false),
      'ordering: neutral structure >= no structure'
  );
  assertTrue(
      score('doWork', false, richStructure) >= score('doWork', false),
      'ordering: rich structure >= no structure'
  );

  // Invariant 5: structure bonuses are additive within a tier
  const asyncOnly: SymbolStructure = { ...neutralStructure, isAsync: true };
  const typedOnly: SymbolStructure = { ...neutralStructure, hasTypedParams: true };
  assertTrue(
      score('doWork', false, asyncOnly) > score('doWork', false, neutralStructure),
      'ordering: async bonus > neutral'
  );
  assertTrue(
      score('doWork', false, typedOnly) > score('doWork', false, asyncOnly),
      'ordering: typed params bonus > async bonus'
  );
}
```

**Test Group C: Deterministic tiebreaker**
```typescript
// ============================================================
// Deterministic tiebreaker: equal priority → startLine ascending
// ============================================================
{
  const blocks: StructureBlock[] = [
      { name: 'bbb', kind: 'function', type: 'function', startLine: 20, endLine: 25, exported: false, anchors: [] },
      { name: 'aaa', kind: 'function', type: 'function', startLine: 5, endLine: 10, exported: false, anchors: [] },
      { name: 'ccc', kind: 'function', type: 'function', startLine: 12, endLine: 18, exported: false, anchors: [] },
  ];
  // All have same base tier (200) and no structure → same score
  const scored = blocks.map(b => ({ ...b, priority: scoreStructureBlock(b) }));
  scored.sort((a, b) => b.priority - a.priority || a.startLine - b.startLine);
  assertEq(scored[0].name, 'aaa', 'tiebreaker: lowest startLine first');
  assertEq(scored[1].name, 'ccc', 'tiebreaker: middle startLine second');
  assertEq(scored[2].name, 'bbb', 'tiebreaker: highest startLine last');
}
```

**Test Group D: compressSourceStructured — regression (existing behavior preserved)**
```typescript
// ============================================================
// compressSourceStructured: regression — no-structure blocks still work
// ============================================================
{
  const code = [
      'import os',
      '',
      'def main():',
      '    print("hello")',
      '',
      'def helper():',
      '    return 42',
      '',
      'def _private():',
      '    pass',
  ].join('\n');

  const blocks: StructureBlock[] = [
      { name: 'main', kind: 'function', type: 'function_definition', startLine: 2, endLine: 3, exported: false, anchors: [] },
      { name: 'helper', kind: 'function', type: 'function_definition', startLine: 5, endLine: 6, exported: false, anchors: [] },
      { name: '_private', kind: 'function', type: 'function_definition', startLine: 8, endLine: 9, exported: false, anchors: [] },
  ];

  const budget = Math.floor(code.length * 0.7);
  const result = compressSourceStructured(code, budget, blocks);
  assertTrue(result.length <= budget + 5, 'regression: respects budget', `got ${result.length}, budget ${budget}`);
  assertTrue(result.length > 0, 'regression: produces output');
  assertTrue(result.includes('main'), 'regression: entry point main retained');
}
```

**Test Group E: compressSourceStructured with structure-enriched blocks**
```typescript
// ============================================================
// compressSourceStructured: structure-enriched blocks get priority
// ============================================================
{
  const code = [
      'export async function importantApi(req: Request, res: Response, next: NextFunction): Promise<void> {',
      '    const data = await fetchData(req);',
      '    res.json(data);',
      '}',
      '',
      'function trivialHelper() {',
      '    return 1;',
      '}',
  ].join('\n');

  const richStructure: SymbolStructure = {
      paramCount: 3, hasTypedParams: true, hasReturnType: true,
      isAsync: true, visibility: 'public', decoratorCount: 0, parentKind: 'program',
  };

  const blocks: StructureBlock[] = [
      { name: 'importantApi', kind: 'function', type: 'function_declaration', startLine: 0, endLine: 3, exported: true, anchors: [], structure: richStructure },
      { name: 'trivialHelper', kind: 'function', type: 'function_declaration', startLine: 5, endLine: 7, exported: false, anchors: [] },
  ];

  const budget = Math.floor(code.length * 0.5);
  const result = compressSourceStructured(code, budget, blocks);
  assertTrue(result.includes('importantApi'), 'enriched: high-priority block retained');
}
```

**Test Group F: extractSymbolStructure — end-to-end via getDefinitionsWithStructure**
```typescript
// ============================================================
// getDefinitionsWithStructure: end-to-end extraction
// ============================================================
{
  // This test requires tree-sitter to be available — wrap in try/catch
  // so it doesn't fail in environments without WASM grammars
  let skipReason = '';
  try {
    const { getDefinitionsWithStructure } = await import('../../src/engines/treesitter/tree-sitter.js');

    const tsCode = [
        'export async function fetchUser(id: string, options?: Options): Promise<User> {',
        '    const user = await db.get(id);',
        '    return user;',
        '}',
        '',
        'function _helper() {',
        '    return 42;',
        '}',
    ].join('\n');

    const defs = await getDefinitionsWithStructure(tsCode, 'typescript');
    if (!defs || defs.length === 0) {
      skipReason = 'tree-sitter returned no definitions (grammar may not be loaded)';
    } else {
      // Should find at least fetchUser
      const fetchUser = defs.find(d => d.name === 'fetchUser');
      assertTrue(fetchUser !== undefined, 'e2e: found fetchUser definition');
      if (fetchUser?.structure) {
        assertTrue(fetchUser.structure.isAsync, 'e2e: fetchUser detected as async');
        assertTrue(fetchUser.structure.paramCount >= 2, 'e2e: fetchUser has >= 2 params');
        assertTrue(fetchUser.structure.hasReturnType, 'e2e: fetchUser has return type');
      } else {
        skipReason = 'structure extraction returned undefined for fetchUser';
      }

      // _helper should have simpler structure
      const helper = defs.find(d => d.name === '_helper');
      if (helper?.structure) {
        assertTrue(helper.structure.paramCount === 0, 'e2e: _helper has 0 params');
        assertTrue(!helper.structure.isAsync, 'e2e: _helper is not async');
      }
    }
  } catch (e: unknown) {
    skipReason = `tree-sitter not available: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (skipReason) {
    console.log(`  [SKIP] getDefinitionsWithStructure e2e: ${skipReason}`);
  }
}
```

**Acceptance Criteria:**
- [ ] ALL 116 existing tests still pass (zero modifications to existing code)
- [ ] Test Group A: 8 assertions — fallback compatibility with exact score values
- [ ] Test Group B: 7 assertions — ordering invariants verified
- [ ] Test Group C: 3 assertions — tiebreaker determinism verified
- [ ] Test Group D: 3 assertions — regression test for structure-free compression
- [ ] Test Group E: 1 assertion — structure-enriched blocks get priority
- [ ] Test Group F: end-to-end tree-sitter extraction (gracefully skipped if grammars unavailable)

**Verification:**
```bash
npx tsc --noEmit 2>&1 | grep -E 'src/toon/|src/engines/' | head -5
# Expected: 0 errors

npx tsx tests/toon/parity.test.ts
# Expected: FAILED: 0, PASSED count increased from 116
```

> **BEFORE reporting Wave 3 complete:**
> 1. Run `npx tsx tests/toon/parity.test.ts` — ALL tests must pass
> 2. Run `npx tsc --noEmit` — zero new type errors
> 3. If ANY test fails, fix the IMPLEMENTATION (not the test) and re-run
> 4. Re-run tests after every fix to confirm no cascading breakage

---

## Final Verification Checklist

After all waves complete, execute this full verification:

```bash
# 1. Type check
npx tsc --noEmit 2>&1 | grep -E 'src/toon/|src/engines/'
# Expected: empty (0 errors)

# 2. Full test suite
npx tsx tests/toon/parity.test.ts
# Expected: FAILED: 0, TOTAL > 116

# 3. Verify no additional Parser creation
grep -c 'new Parser' src/engines/treesitter/tree-sitter.ts
# Expected: same count as before + exactly 1 more (in getDefinitionsWithStructure)
```

Confirm:
- [ ] All existing 116 tests still pass
- [ ] All new tests pass
- [ ] `scoreStructureBlock()` with no structure produces tier-weighted scores matching old tier ordering
- [ ] `getDefinitionsWithStructure()` creates exactly one Parser per call
- [ ] Tree-sitter tree is parsed exactly once per `getDefinitionsWithStructure()` call
- [ ] No regressions: `compressSourceStructured` with structure-free blocks works identically

---

## Summary of Changes

| File | Change | Approx Lines |
|------|--------|-------------|
| `src/toon/types.ts` | Add `SymbolStructure` interface + `structure?` field on `StructureBlock` | +15 |
| `src/engines/treesitter/tree-sitter.ts` | Add `extractSymbolStructure()` + `getDefinitionsWithStructure()`, extend `ToonSymbol` | +100 |
| `src/toon/string-codec.ts` | Add `scoreStructureBlock()`, replace inline scoring, add sort tiebreaker | +40, -15 |
| `src/engines/treesitter/toon-bridge.ts` | Switch to `getDefinitionsWithStructure()`, pass through `structure` + `exported` | +3, -3 |
| `tests/toon/parity.test.ts` | Append 6 test groups (A-F) | +120 |
