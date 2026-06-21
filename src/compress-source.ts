// compress-source.ts — the single one-way route through zenith-toon.
//
// ── THE ONE LAW OF THIS FILE ────────────────────────────────────────────────
// Text flows forward, once, through each engine and never circles back. There
// is no orchestrator, no shared scoring module, no convergence loop, and no
// back-edge. `compressSource` is a linear pipe: every stage has the shape
// (Payload) -> Payload, takes the WHOLE payload, appends its own contribution,
// and hands it to the next stage. A linear pipe is NOT an orchestrator — no
// stage holds another stage, decides whether to run it, or shares mutable state
// with it. Recreating an orchestrator (a pipeline.ts, a router, a shared
// `_scoreEntries`) must always cost more than extending this straight line. If
// you are ever tempted to add one: don't. Shape the INPUT to the existing
// engine instead, so the real engine produces a safe cut by itself.
//
// ── COORDINATE SYSTEM: LINE NUMBERS ─────────────────────────────────────────
// Line numbers arrive attached to the source (from Zenith-MCP) and are NEVER
// stripped, re-derived, or recomputed by any stage. Removal is by LINE RANGE
// only — never by word or character. A removed range simply leaves a gap in the
// numbering; the final render drops a `[TRUNCATED: lines X-Y]` marker into that
// gap. Nothing ever computes "where a line used to be" — the missing numbers
// ARE the gaps.
//
// ── HOW AN ENGINE STAGE WORKS (the pattern every engine must follow) ─────────
// Take the whole payload. FEED the blocks into the REAL engine via its existing
// public method (we never fork or re-implement an engine's scoring). Read the
// ranking the engine itself produced. Name the least-useful ~30% as the TAIL of
// that engine's OWN score order (not a second opinion — just the bottom of the
// ranking the engine already produced). Append it to `payload.rankings` as
// forward-only metadata. The append flows into the next engine and nowhere
// else, so there is no cycle to "solve" and no shared scorer to extract.

import { SageRank } from './sagerank.js';
import { BMXPlusIndex } from './bmx-plus.js';
import { findKneedle, pearsonR } from './utils.js';
//
// NOTE on AST: a `SourceBlock` below is the pure-source projection of Zenith's
// richer `StructureBlock` (./types.js) — same line range, plus (later) parent
// symbol, anchors, kind, and the call-graph `ASTEdge[]`. The text-only route
// needs only the line range + text; AST facts arrive later and plug into
// engine 2's QueryBundle (as lexical query material) and stage 1's rankWithAST
// seam — never into a forked scorer.

// ---------------------------------------------------------------------------
// The payload — the single object that flows through every stage.
// ---------------------------------------------------------------------------

/**
 * One contiguous line-range unit of source. Line numbers are the coordinate
 * system: `startLine`/`endLine` arrive from the consumer (Zenith-MCP) and are
 * treated as ground truth — never recomputed. `text` keeps its line-numbered
 * prefix intact for the same reason.
 *
 * In the integrated system this is the projection of a Zenith `StructureBlock`
 * (which additionally carries parent symbol, anchors, kind, exported, AST
 * edges). The pure-source route only requires the line range + text; the richer
 * AST facts ride alongside once Kimi's translator supplies them.
 */
export interface SourceBlock {
  readonly startLine: number;  // 1-based inclusive, as received — never re-derived
  readonly endLine: number;    // 1-based inclusive
  readonly text: string;       // block source WITH its line-number prefixes preserved
}

/**
 * One engine's forward-only verdict. Append-only metadata that rides the
 * payload into the NEXT stage and nowhere else — it never circles back to the
 * engine that produced it. Each engine fills this from ITS OWN scoring
 * intelligence; nothing here is shared between engines.
 */
export interface EngineRanking {
  readonly engine: string;          // which intelligence produced this ("SageRank", ...)
  readonly scores: readonly number[];      // index-aligned to payload.blocks — the engine's OWN scores
  readonly leastUseful: readonly number[]; // block indices this engine nominates to cut (~bottom 30%)
}

/** A contiguous span of source lines — the unit of removal. */
export interface LineRange {
  readonly startLine: number;  // 1-based inclusive
  readonly endLine: number;    // 1-based inclusive
}

/**
 * A pearsonR reading between two engines' usefulness curves. This is a MONITOR,
 * not a judge: it rides forward as an observation and NEVER weights, drops, or
 * otherwise overrules any engine. Nothing we have built is intelligent enough to
 * declare that two engines agreeing is "wrong" — so correlation is watched, not
 * acted on ("until proven otherwise").
 */
export interface EnginePairCorrelation {
  readonly engineA: string;
  readonly engineB: string;
  readonly r: number;  // observed correlation; informational only
}

/**
 * Output of the mechanical aggregation stage (stage 3). This stage IS the
 * keep/drop decision — the only one — but it is purely mechanical: it sums the
 * engines' equally-weighted verdicts into one final score per block the same way
 * every time, and drops the least-informative ~30% of the file.
 */
export interface Aggregation {
  readonly doomedRanges: readonly LineRange[];               // the least-useful ~30% to cut
  readonly finalScores: readonly number[];                   // index-aligned equal-weight fused usefulness
  readonly correlationMonitor: readonly EnginePairCorrelation[]; // pearsonR readings — monitor only
}

/**
 * The payload. Flows through the route, growing only by appended forward
 * metadata: `rankings` grows by one entry per engine; `aggregation` is set once
 * by stage 3. Stages return a NEW payload — no mutable shared state.
 */
export interface Payload {
  readonly blocks: readonly SourceBlock[];       // numbered source, never re-derived
  readonly rankings: readonly EngineRanking[];   // append-only; one per engine, in route order
  readonly charBudget: number;                   // the target the final AST stage restructures within (chars)
  readonly query: string | null;                 // scan focus; biases the relevance engines
  readonly aggregation?: Aggregation;            // set by stage 3; consumed by stage 4
}

/**
 * The least-useful fraction. Each engine nominates ~this much as its own bottom
 * tail; aggregation drops ~this much of the FILE (by line count). One constant,
 * one meaning of "30%", everywhere.
 */
const CUT_FRACTION = 0.30;

// ---------------------------------------------------------------------------
// Stage 1 — SageRank: structural centrality.   [WIRED]
// ---------------------------------------------------------------------------

/**
 * Feed the blocks into SageRank and read back its centrality ranking.
 *
 * We call the REAL engine (`rankSentences`) over the block texts — SageRank
 * treats each block as a node and scores it by PageRank centrality over its
 * text-similarity graph. We do NOT recompute, mimic, or fork any part of that;
 * we read `.scores` (index-aligned to the blocks) straight off the result and
 * take its bottom fraction as this engine's cut nomination.
 *
 * TODO(kimi/ast): once Zenith supplies call-graph edges (ASTEdge[]), switch the
 * single call below to `sage.rankWithAST(texts, n, astEdges, query)` — the SAME
 * engine, with AST awareness fed through its existing `_mergeASTEdges` seam. Do
 * NOT add a parallel AST scorer; feed the edges to the engine that already
 * merges them.
 */
export function rankByCentrality(payload: Payload): Payload {
  const texts = payload.blocks.map((b) => b.text);
  const n = texts.length;

  const sage = new SageRank();
  // topK only controls which indices SageRank flags as "selected"; we read the
  // full per-block score curve regardless, so pass n (rank every block).
  const result = sage.rankSentences(texts, n, payload.query);

  // Least-useful ~30% = the TAIL of the engine's OWN score order. Sorting block
  // indices by the engine's scores is reading a ranking, not producing one — no
  // scoring happens here. (Inlined on purpose: no scoring/selection code is
  // shared between engines, so no shared module can congeal into a fork.)
  const order = [...result.scores.keys()].sort(
    (a, b) => (result.scores[a] ?? 0) - (result.scores[b] ?? 0), // ascending: worst first
  );
  const cutCount = Math.floor(order.length * CUT_FRACTION);
  const leastUseful = order.slice(0, cutCount);

  const ranking: EngineRanking = {
    engine: 'SageRank',
    scores: result.scores,
    leastUseful,
  };

  return { ...payload, rankings: [...payload.rankings, ranking] };
}

// ---------------------------------------------------------------------------
// Stage 2 — BMX+: lexical / source relevance.   [WIRED]
// ---------------------------------------------------------------------------

/**
 * The lexical material BMX+ is pointed at. BMX+ does NOT "know importance" on
 * its own — it is a search engine. Its job is to answer "which candidate blocks
 * actually contain the named/lexical evidence of what we care about." So we feed
 * it the richest query we can assemble, from two categories (one BMX+ index
 * serves both — "use BMX twice conceptually, one implementation"):
 *
 *   • SAGE-SYNERGY — the text of the blocks SageRank ranked most central, read
 *     forward off engine 1's ranking that already rides the payload. ("Which
 *     blocks resemble the structural core?")
 *   • REAL-INTENT — the actual lexical/source signals naming the thing the scan
 *     cares about. ("Which blocks contain that named evidence?")
 *
 * This bundle is the integration seam for Kimi's translated AST facts: every
 * real-intent slot below is a socket where a Zenith-supplied fact (symbol /
 * import / call name, module path, test name, diagnostic) plugs straight into
 * the query — shaping BMX+'s INPUT so the real engine produces a source-aware
 * ranking by itself. It is forward-only (sage-synergy comes from engine 1;
 * real-intent rides in with the source) and it SCORES NOTHING — it is query text.
 *
 * Three engines, three distinct teeth in one gear (not redundant):
 *   SageRank = structural centrality · AST = code topology · BMX+ = lexical evidence.
 */
interface QueryBundle {
  // sage-synergy (wired now: derived from engine 1's forward ranking)
  sageCoreText: string;
  // real-intent (scanQuery wired now; the rest arrive from Zenith's AST DB)
  scanQuery: string | null;
  // TODO(zenith/ast): populate from StructureBlock / ASTEdge once Zenith
  // supplies them — each is its own lexical slot so AST facts plug straight in.
  symbolNames?: string[];      // function / class / type / variable names
  imports?: string[];          // imported module + symbol names
  exports?: string[];          // exported symbol names
  callNeighbors?: string[];    // names of call-graph-adjacent symbols
  modulePath?: string | null;  // file / module path context
  testNames?: string[];        // associated test / spec names
  diagnostics?: string[];      // diagnostic / error identifiers touching these blocks
}

/** Flatten the populated bundle slots into one query string. Concatenation of
 *  query material only — it does NOT score or rank. */
function bundleToQuery(b: QueryBundle): string {
  const parts: string[] = [b.sageCoreText];
  if (b.scanQuery) parts.push(b.scanQuery);
  if (b.symbolNames?.length) parts.push(b.symbolNames.join(' '));
  if (b.imports?.length) parts.push(b.imports.join(' '));
  if (b.exports?.length) parts.push(b.exports.join(' '));
  if (b.callNeighbors?.length) parts.push(b.callNeighbors.join(' '));
  if (b.modulePath) parts.push(b.modulePath);
  if (b.testNames?.length) parts.push(b.testNames.join(' '));
  if (b.diagnostics?.length) parts.push(b.diagnostics.join(' '));
  return parts.filter((s) => s.length > 0).join(' ');
}

/**
 * Feed the candidate blocks into BMX+ and append its relevance ranking.
 *
 * Same law as stage 1 — FEED the real engine, READ its scores, APPEND forward.
 * Build BMX+'s index over the candidate blocks (chunk_id = block index),
 * assemble the query bundle, run the engine's real `search`, then take the
 * bottom ~30% of the engine's OWN order as this engine's cut nomination.
 *
 * TODO(scoring-phase): one combined search over the bundle (current) vs. two
 * focused searches (sage-synergy vs. real-intent) blended — a tuning call that
 * belongs with the scoring iteration, deliberately deferred (not now).
 */
export function rankByRelevance(payload: Payload): Payload {
  const blocks = payload.blocks;
  const n = blocks.length;
  if (n === 0) return payload;

  // Candidate units = the payload's blocks (once Zenith supplies symbol/doc
  // units they arrive AS blocks). chunk_id is the block index, as a string.
  const idx = new BMXPlusIndex();
  idx.buildIndex(blocks.map((b, i) => ({ chunk_id: String(i), text: b.text })));

  // Sage-synergy: read forward off engine 1's ranking. Find the Kneedle elbow of
  // SageRank's OWN score curve (selection by reading — no re-scoring), then join
  // the core blocks' text as query material.
  let sageCoreText = '';
  const sage = payload.rankings.find((r) => r.engine === 'SageRank');
  if (sage && sage.scores.length > 0) {
    const coreOrder = [...sage.scores.keys()].sort(
      (a, b) => (sage.scores[b] ?? 0) - (sage.scores[a] ?? 0), // descending: core first
    );
    const knee = findKneedle(coreOrder.map((i) => sage.scores[i] ?? 0));
    const coreIdx = coreOrder.slice(0, Math.max(1, knee));
    sageCoreText = coreIdx.map((i) => blocks[i]?.text ?? '').join(' ');
  }

  const bundle: QueryBundle = {
    sageCoreText,
    scanQuery: payload.query,
    // TODO(zenith/ast): fill symbolNames/imports/exports/callNeighbors/
    // modulePath/testNames/diagnostics from Zenith's translated facts.
  };

  // Feed the real engine; read its scores back, index-aligned to blocks.
  const ranked = idx.search(bundleToQuery(bundle), n); // [chunk_id, score][]
  const scores = new Array<number>(n).fill(0);
  for (const [cid, score] of ranked) {
    const i = Number(cid);
    if (Number.isInteger(i) && i >= 0 && i < n) scores[i] = score;
  }

  // Least-useful ~30% = the tail of BMX+'s OWN order (inlined per-engine; no
  // selection code is shared, so nothing can congeal into a cross-engine fork).
  const order = [...scores.keys()].sort(
    (a, b) => (scores[a] ?? 0) - (scores[b] ?? 0), // ascending: worst first
  );
  const cutCount = Math.floor(order.length * CUT_FRACTION);
  const leastUseful = order.slice(0, cutCount);

  return {
    ...payload,
    rankings: [...payload.rankings, { engine: 'BMX+', scores, leastUseful }],
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — Mechanical aggregation.   [WIRED]   (the only keep/drop decision)
// ---------------------------------------------------------------------------

/** Min-max normalize a score curve to [0,1] usefulness, so every engine is
 *  compared on a common scale before EQUAL-weight fusion. A flat curve (no
 *  signal) maps to all zeros. Pure; deterministic; scores nothing. */
function normalize01(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  if (range < 1e-12) return scores.map(() => 0);
  return scores.map((s) => (s - min) / range);
}

/**
 * Aggregate the engines' rankings into the keep/drop decision. This stage
 * consults NO engine and applies NO intelligence of its own — it sums verdicts.
 *
 * EQUAL WEIGHTING: each engine's score curve is put on a common [0,1] scale and
 * averaged with equal weight. No engine is discounted. Agreement is a STRONG
 * SIGNAL by construction — blocks every engine scores high stay high, blocks
 * every engine scores low sink low, disagreement lands in the uncertain middle.
 * We never suppress agreement: nothing here is smart enough to declare that two
 * intelligent engines agreeing is somehow wrong.
 *
 * pearsonR IS A MONITOR, NOT A JUDGE: pairwise correlation is observed and
 * carried forward as a reading, but it never weights, drops, or alters anything.
 *
 * THE DECISION: drop the least-informative ~30% of the FILE (by line count).
 * Sort blocks ascending by the final score and remove whole line-ranges until
 * ~30% of the source's lines are gone. Computed the same exact way every time
 * (deterministic; stable ties). Gap/marker logic is NOT this step's concern.
 */
export function aggregateLeastUseful(payload: Payload): Payload {
  const blocks = payload.blocks;
  const n = blocks.length;
  const k = payload.rankings.length;
  if (n === 0 || k === 0) {
    return {
      ...payload,
      aggregation: { doomedRanges: [], finalScores: [], correlationMonitor: [] },
    };
  }

  // 1. Put every engine on a common [0,1] scale so equal weighting is fair.
  const curves = payload.rankings.map((r) => normalize01(r.scores));

  // 2. Final score per block = EQUAL-weight mean across engines. Same math,
  //    every time. The engines decide; this only adds their verdicts up.
  const finalScores: number[] = new Array<number>(n).fill(0);
  for (let b = 0; b < n; b++) {
    let acc = 0;
    for (let i = 0; i < k; i++) acc += curves[i]?.[b] ?? 0;
    finalScores[b] = acc / k;
  }

  // 3. Monitor only: observe how correlated each engine pair is. Never acted on.
  const correlationMonitor: EnginePairCorrelation[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      correlationMonitor.push({
        engineA: payload.rankings[i]?.engine ?? `engine${i}`,
        engineB: payload.rankings[j]?.engine ?? `engine${j}`,
        r: pearsonR(curves[i] ?? [], curves[j] ?? []),
      });
    }
  }

  // 4. The only keep/drop decision: drop the least-informative ~30% of the file
  //    by line count. Whole line-ranges, ascending by final score.
  let totalLines = 0;
  for (const blk of blocks) totalLines += blk.endLine - blk.startLine + 1;
  const lineQuota = Math.floor(totalLines * CUT_FRACTION);

  const doomedRanges: LineRange[] = [];
  if (lineQuota > 0) {
    const order = [...finalScores.keys()].sort(
      (a, b) => (finalScores[a] ?? 0) - (finalScores[b] ?? 0), // ascending: least useful first
    );
    let dropped = 0;
    const doomedIdx: number[] = [];
    for (const bi of order) {
      if (dropped >= lineQuota) break;
      const blk = blocks[bi];
      if (blk === undefined) continue;
      doomedIdx.push(bi);
      dropped += blk.endLine - blk.startLine + 1;
    }
    doomedIdx
      .map((bi) => blocks[bi])
      .filter((b): b is SourceBlock => b !== undefined)
      .sort((a, b) => a.startLine - b.startLine)
      .forEach((b) => doomedRanges.push({ startLine: b.startLine, endLine: b.endLine }));
  }

  return {
    ...payload,
    aggregation: { doomedRanges, finalScores, correlationMonitor },
  };
}

// ---------------------------------------------------------------------------
// Stage 4 — Line-range removal.   [TODO]
// ---------------------------------------------------------------------------

/**
 * TODO(stage-4): EXECUTE the decision stage 3 already made — delete exactly the
 * line ranges in `payload.aggregation.doomedRanges`. This stage decides nothing;
 * it carries out the keep/drop verdict.
 *
 * Removal is by LINE RANGE only. Because line numbers ride with the text, this
 * stage just drops the blocks/lines whose numbers fall in a doomed range; the
 * survivors keep their original numbers unchanged. The result is source with
 * gaps in its numbering — and those gaps are all stage 7 needs to place
 * markers. Never truncate inside a line; never re-number; never compute a
 * line's "former" position.
 */
export function removeLineRanges(payload: Payload): Payload {
  // TODO(stage-4): drop the blocks/lines in payload.aggregation.doomedRanges.
  return payload;
}

// ---------------------------------------------------------------------------
// Stage 5 — Flag small blocks.   [TODO]
// ---------------------------------------------------------------------------

/**
 * TODO(stage-5): flag any surviving code block shorter than 6 lines as needing
 * the final AST engine (stage 6). This is a cheap structural pass — count
 * `endLine - startLine + 1 < 6` — that marks fragments the restructurer must
 * fold back into something whole. No scoring, no removal.
 */
export function flagSmallBlocks(payload: Payload): Payload {
  // TODO(stage-5): mark blocks with < 6 lines for stage 6.
  return payload;
}

// ---------------------------------------------------------------------------
// Stage 6 — AST restructuring engine.   [TODO — DEFERRED to Kimi / AST phase]
// ---------------------------------------------------------------------------

/**
 * TODO(stage-6): the single, final, deeply AST-aware engine.
 *
 * It receives what would be the output — the cuts from stages 3–4 are ALREADY
 * made, so total compression already meets the target. Its job is to restructure
 * WITHIN the same character budget so no surviving code block is shorter than 6
 * lines, cherry-picking which fragments to keep vs. drop where the most language
 * meaning can be made whole (don't split a function / function body / symbol).
 * One pass. No loop. No back-edge to earlier stages.
 *
 * DO NOT FORK AN ENGINE HERE. When this is realized, AST awareness arrives as
 * data (Zenith's symbol/AST facts translated into ASTEdge[]/StructureBlock[])
 * and is FED into the real engines' existing seams — it does not become a new
 * hand-rolled scorer living in this file. This stub stays a pass-through until
 * that AST translation work (Kimi's mission) lands.
 */
export function restructureAST(payload: Payload): Payload {
  // TODO(stage-6): AST-aware restructure within the fixed char budget.
  return payload;
}

// ---------------------------------------------------------------------------
// Stage 7 — Render with gap markers.   [TODO]   (trivial — last)
// ---------------------------------------------------------------------------

/**
 * TODO(stage-7): emit the final compressed source. Because survivors carry their
 * original line numbers, rendering is trivial: walk the kept lines in order and,
 * wherever the numbering jumps, drop a `[TRUNCATED: lines X-Y]` marker into the
 * gap (X..Y = the missing numbers). No position math, no re-derivation.
 *
 * Currently a faithful stub: with stages 3–4 not yet realized nothing is cut, so
 * this returns the source unchanged (block texts joined in order). Once removal
 * is real, this gains only the gap-marker emission.
 */
export function renderWithGapMarkers(payload: Payload): string {
  // TODO(stage-7): insert [TRUNCATED: lines X-Y] markers into numbering gaps.
  return payload.blocks.map((b) => b.text).join('\n');
}

// ---------------------------------------------------------------------------
// The single route — entry point.
// ---------------------------------------------------------------------------

/**
 * The one and only route through zenith-toon: numbered source in → compressed
 * source out. Read top to bottom, it IS the spec — a straight line of
 * (Payload) -> Payload stages with one terminal render. There is no other path,
 * by design.
 *
 * Status: engines 1-2 (SageRank + BMX+) and the aggregation decision (stage 3)
 * are wired — engines append rankings, aggregation computes the final per-block
 * scores and names the least-useful ~30% as `doomedRanges`. Removal/flag/AST/
 * render remain documented pass-through stubs, realized one at a time. The route
 * runs end-to-end today and returns the source unchanged (nothing is cut until
 * removal executes the decision).
 */
export function compressSource(payload: Payload): string {
  let p = payload;
  p = rankByCentrality(p);       // engine 1 — SageRank (structural centrality)   [WIRED]
  p = rankByRelevance(p);        // engine 2 — BMX+ (lexical relevance)           [WIRED]
  p = aggregateLeastUseful(p);   // the keep/drop decision: least-useful ~30% lines [WIRED]
  p = removeLineRanges(p);       // mechanical: delete those ranges, leave gaps    [TODO]
  p = flagSmallBlocks(p);        // mechanical: mark blocks < 6 lines for stage 6  [TODO]
  p = restructureAST(p);         // engine: AST-aware restructure within budget    [TODO/kimi]
  return renderWithGapMarkers(p); // mechanical: emit text + [TRUNCATED: …] gaps    [TODO]
}
