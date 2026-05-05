# TOON Compression Review — refactorbatch

## File Info
- Original: refactor_batch.js — 54820 characters
- Level 1: batch.txt — 1968 characters (3.59% of original)
- Level 2: batch2.txt — 4942 characters (9.01% of original)
- Level 3: batch3.txt — 6943 characters (12.67% of original)

## Level 1 Review
**Compression ratio:** 3.59%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 2/10 | Imports and `register(server, ctx)` survive, but constants, caches, helpers, input schema, and most mode bodies are omitted. |
| Omission Clarity | 5/10 | The `# ... [lines N-M omitted]` markers are clear about ranges, but they create non-JS fragments and do not summarize omitted symbols. |
| Critical Logic Preservation | 1/10 | Almost all non-obvious behavior, including gates, caching, outlier detection, snapshots, atomic writes, reapply, history, and restore, is missing. |
| Usability | 1/10 | A developer could not integrate with or safely modify this tool from Level 1 alone. |

**What survived well:**
The imports survived, including `z`, `fs`, `path`, `randomBytes`, `createHash`, project context, symbol-index helpers, tree-sitter helpers, edit-engine helpers, and `normalizeLineEndings`. The compressed version also shows `export function register(server, ctx)`, the `server.registerTool("refactor_batch", ...)` title, and a few query/loadDiff return messages such as `target required for query.`, `Multiple definitions:`, `No references.`, and `selection required for loadDiff`.

**What was lost that matters:**
The omitted `lines 20-114` hide `MAX_CHARS`, `DEFAULT_CONTEXT`, `MAX_CONTEXT_LINES`, `_loadCache`, `_payloadCache`, `_retryState`, and all helper signatures and bodies for `deepEqual`, `findModal`, `firstDiffReason`, and `parsePayload`. The `inputSchema` is almost entirely gone, so the accepted modes and parameters are not available. The core implementations of `query`, `loadDiff`, `apply`, `reapply`, `history`, and `restore` are mostly absent, including `impactQuery`, `findSymbol`, outlier `ack`, syntax gates, retry locking, atomic temp-file writes, snapshotting, reindexing, and rollback logic.

**Verdict:** Level 1 is too compressed to be useful. It gives a vague sense that a `refactor_batch` tool exists, but not how to call it or what safety behavior it has.

## Level 2 Review
**Compression ratio:** 9.01%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 4/10 | Keeps imports, constants, caches, comments for helpers, `register`, description, and scattered return paths, but omits most function bodies. |
| Omission Clarity | 7/10 | Most omissions are explicit and include line ranges, making the amount cut fairly clear. |
| Critical Logic Preservation | 2/10 | Some public intent survives through descriptions and error strings, but the important algorithms and write safety paths are hidden. |
| Usability | 2/10 | A developer can infer the broad API shape, but not enough to integrate safely or implement changes. |

**What survived well:**
Level 2 preserves the module constants `MAX_CHARS`, `DEFAULT_CONTEXT`, and `MAX_CONTEXT_LINES`, plus the caches `_loadCache`, `_payloadCache`, and `_retryState`. It keeps the comments describing `parsePayload` input format with examples like `validateCard 1,2,3 ack:3`, and it preserves the `register` tool title and long description explaining `loadDiff`, `apply`, `reapply`, `restore`, and `history`.

**What was lost that matters:**
The actual helper definitions are replaced with markers: `deepEqual`, `findModal`, `firstDiffReason`, and `parsePayload` are not readable. The `inputSchema` after the `mode` field is cut, so parameters such as `target`, `selection`, `payload`, `dryRun`, `symbolGroup`, `newTargets`, `ack`, `symbol`, `file`, and `version` are missing or only indirectly implied. The major `loadDiff` block from target resolution through occurrence gathering and block emission is omitted as `lines 243-413`. The `apply` path is cut before its safety gates and write logic, and `reapply`, `history`, and `restore` are not present.

**Verdict:** Level 2 is a decent overview, but it hides exactly the code a maintainer would need to reason about correctness. It is better than Level 1, but still not enough for integration work.

## Level 3 Review
**Compression ratio:** 12.67%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 5/10 | Preserves more of the input schema and early mode structure, but still removes helper bodies and most implementation bodies. |
| Omission Clarity | 7/10 | Line-range markers make omissions easy to see, though they often replace semantically important blocks without a useful summary. |
| Critical Logic Preservation | 3/10 | Retains API descriptions and some validation/error paths, but not the complex safety and mutation logic. |
| Usability | 3/10 | A developer could identify several call parameters, but would still make mistakes around apply/reapply/restore behavior. |

**What survived well:**
Level 3 keeps the imports, constants, caches, helper section comments, `parsePayload` format comment, `register(server, ctx)`, `server.registerTool("refactor_batch", ...)`, and a useful part of the `inputSchema`: `mode`, `target`, `fileScope`, `direction`, `depth`, `selection`, and `contextLines`. It also preserves early query/loadDiff validation messages such as `target required for query.`, `No references.`, `selection required for loadDiff`, `Nothing to continue.`, and `Run query first.`

**What was lost that matters:**
The helper bodies are still hidden, so the equality/outlier behavior of `deepEqual`, `findModal`, and `firstDiffReason` is unavailable. The schema is cut after `contextLines`, hiding `loadMore`, `payload`, `dryRun`, `symbolGroup`, `newTargets`, `ack`, `symbol`, `file`, and `version`. The compressed file omits the `loadDiff` occurrence walk, modal-structure flagging, char-budget block emission, and cache update. It also omits most of `apply`, including `parsePayload`, loaded-symbol validation, outlier ack enforcement, syntax gates, `applyEditList`, per-file atomic write, snapshotting, reindexing, dry-run reporting, and `_payloadCache` population. The entire `reapply`, `history`, and `restore` implementations are missing.

**Verdict:** Level 3 is the best of the three, but it is still too shallow for a write-capable refactoring tool. It preserves more API shape than Level 2, yet hides the safety properties that matter most.

## Overall Assessment
Level 3 is the best balance among these outputs because it exposes more of the public schema, but it is still not sufficient for a developer working from the compressed version alone. Toon does well at retaining imports, top-level constants, the main `register` entry point, and explicit line-count omission markers. It misses the most important thing for this file: preserving safety-critical control flow. For a mutation tool, compression should prioritize the exact mode boundaries and safety gates for `loadDiff`, `apply`, `reapply`, `history`, and `restore`, including outlier acknowledgement, syntax checks, atomic writes, snapshots, and cache updates. Cutting those into opaque line-range markers makes the output compact but not operationally trustworthy.
