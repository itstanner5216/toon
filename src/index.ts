// zenith-toon (source) — source-code line-range compressor
//
// One-way pipeline for making LLM codebase scanning cheap: numbered source text
// flows forward through engines that each append their own ranking as metadata.
// Removal is by LINE RANGE only (never by word) — functions, bodies, and symbols
// survive intact — and gaps are rendered as `[TRUNCATED: lines X-Y]` markers.
//
// This copy is being rebuilt into a PURE source compressor. The log / tool-output
// heritage (the entry-list `compress` pipeline, dedup, the JSON/stack/log string
// codecs, the v1 array-folder, and the ToonConfig/router field-routing surface)
// has been removed — only what ranks and cuts SOURCE survives. Language / AST
// awareness is supplied by the consumer (Zenith-MCP
// tree-sitter + symbol index) as `StructureBlock[]` + `ASTEdge[]`, which are meant
// to feed SageRank's call-graph path (`rankWithAST` / `_mergeASTEdges`) — NOT a
// forked, hand-rolled centrality scorer.

// ---------------------------------------------------------------------------
// The single one-way route — entry point
// ---------------------------------------------------------------------------
// `compressSource(payload)` is the one and only path through zenith-toon: a
// linear (Payload) -> Payload chain (rank by centrality -> rank by relevance ->
// mechanical aggregate -> line-range removal -> <6-line flag -> AST restructure
// -> trivial gap render), terminating in a rendered string. No orchestrator, no
// shared scorer, no back-edge — see compress-source.ts for the law it enforces.
//
// The old `compressSourceStructured` (string-codec.ts) was the imposter source
// path: a strip-then-re-derive line renderer wrapped around a hand-rolled regex
// pseudo-AST scorer (_DEF_RE/_DECORATOR_RE anchors), frame/window placement, and
// multi-pass run enforcement. The whole file was DELETED; a salvage pass proved
// none of its "unique" pieces survive the pure-source / lines-only / no-fork /
// no-marker / no-log rules. Nothing was recreated from it.
//
// Status: engine 1 (SageRank) is wired; later stages are documented pass-through
// stubs, realized one at a time. The route runs end-to-end today.
export { compressSource } from './compress-source.js';
export type { Payload, SourceBlock, EngineRanking } from './compress-source.js';

// ---------------------------------------------------------------------------
// Ranking engines — two distinct, complementary intelligences:
//   SageRank      : structural CENTRALITY — PageRank over the call graph via the
//                   currently-dormant rankWithAST/_mergeASTEdges seam Kimi feeds.
//   BMXPlusIndex  : lexical RELEVANCE / informativeness — entropy-weighted BM25
//                   successor + Soft-AND coverage. Surfaces distinctive / query-
//                   relevant blocks that centrality cannot, by design. Content-
//                   agnostic, near-zero latency, strongest on code.
// Each appends its own forward-only ranking; their divergence is the signal.
// ---------------------------------------------------------------------------
export { SageRank } from './sagerank.js';
export type { SageResult } from './sagerank.js';
export { BMXPlusIndex } from './bmx-plus.js';

// ---------------------------------------------------------------------------
// Budget — generic score-proportional token allocation (no source-specific graft)
// ---------------------------------------------------------------------------
export { BudgetAllocator } from './budget.js';
export type { BudgetAllocation } from './budget.js';

// ---------------------------------------------------------------------------
// Source / AST shapes — the contract the consumer (and Kimi) fills in
// ---------------------------------------------------------------------------
export type { StructureBlock, Anchor, ASTEdge, ASTEdgeResult } from './types.js';

// ---------------------------------------------------------------------------
// Math utils retained for mechanical aggregation over the source score curve
// ---------------------------------------------------------------------------
export { estimateTokens, estimateTokensObj, computeGini, findKneedle, pearsonR } from './utils.js';
