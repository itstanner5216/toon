// Ported from: toon/pipeline.py
// Python line count: 572 (up to `if __name__ == "__main__":` at line 573)
// Port verification:
//   - 5-phase scoring: Phase 0 (count guard) → Phase 1 (BMX+ index) →
//     Phase 2 (SageRank/hybrid centrality) → Gini check → hubness detection
//     → Phase 3 (Kneedle core) → Phase 4 (BMX+ relevance vs core) →
//     redundancy check → Phase 5 (tier assignment p75/p25)
//   - Deterministic seeding: Python uses random.Random(md5.hexdigest()) for n>1000.
//     TS uses Mulberry32 PRNG seeded from MD5 hex prefix (see seededPRNG below).
//     Same input → same output; exact float values differ from Python's Mersenne Twister.
//   - Pipeline order: dedup → _scoreEntries → BudgetAllocator.allocate → _compressEntries
//   - compress() returns same top-level type as input (single obj or list)
//   - TOONCompressor.feed() returns null for deduped entries (None in Python)
//   - _compressEntry: template marker, str → compressString, dict → _compressDict,
//     array/tuple → encodeRecursive, else passthrough
//   - _compressDict: preserve_fields passthrough, encode_fields array/str compress, else passthrough
//   - CompressConfig defaults match Python exactly

import { createHash } from 'node:crypto';
import {
  flattenToText,
  estimateTokensObj,
  computeGini,
  findKneedle,
  pearsonR,
} from './utils.js';
import { Deduplicator } from './dedup.js';
import type { DedupResult } from './dedup.js';
import { BudgetAllocator } from './budget.js';
import type { BudgetAllocation } from './budget.js';
import { compressString } from './string-codec.js';
import { encodeRecursive } from './encoder.js';
import { BMXPlusIndex } from './bmx-plus.js';
import { SageRank } from './sagerank.js';
import type { EntryMeta, ScoredEntries, CompressedOutput } from './types.js';

export type { ScoredEntries, CompressedOutput };

// ---------------------------------------------------------------------------
// CompressConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the TOON compression pipeline.
 *
 * All defaults are documented with their evidence basis.
 * Engineering heuristics are explicitly flagged as unvalidated.
 */
export class CompressConfig {
  /** Method for adaptive core_fraction detection.
   * Default: "kneedle" — Satopää et al. 2011, IEEE ICDCS.
   * Alternative: "fixed" uses core_fraction_fixed value. */
  core_fraction_method: string = 'kneedle';

  /** Fixed core fraction (used only when core_fraction_method="fixed").
   * Engineering heuristic — not empirically validated. */
  core_fraction_fixed: number = 0.15;

  /** Gini coefficient below which self-scoring is abandoned.
   * Derived from T-Retrievability (Ganguly 2025, arXiv:2508.21704).
   * Below 0.2 → corpus is undifferentiated, self-scoring uninformative. */
  gini_threshold: number = 0.2;

  /** Median/MAD z-score threshold for hub detection.
   * Based on adversarial hubness research (Cisco 2026).
   * Hubs with z > 3.0 are capped at median + 2·MAD. */
  hubness_z_threshold: number = 3.0;

  /** Pearson r above which Phase 2/4 correlation indicates redundancy.
   * Engineering heuristic — not empirically validated. */
  redundancy_r_threshold: number = 0.95;

  /** Dedup scope: "session" (LRU-bounded), "turn" (per-call reset), "none". */
  dedup_scope: string = 'session';

  /** LRU cache size for dedup fingerprints.
   * At 5000, memory overhead ≈ 500KB. Covers typical session lengths. */
  dedup_maxsize: number = 5000;

  /** Budget halving per JSON depth level.
   * Engineering heuristic — not empirically validated. */
  string_budget_ratio: number = 0.5;

  /** Max user-code frames to retain in stack trace compression.
   * FaST heuristic (ICSE 2022): position × rarity scoring.
   * Gap: no empirical N for LLM-reading context. 10 is conservative. */
  stack_trace_max_user_frames: number = 10;

  /** Budget distribution across tiers.
   * Informed by LLMLingua ablation: per-component > uniform (EM 79.08 vs 73.62).
   * Source: https://aclanthology.org/2024.acl-long.91/ */
  tier_ratios: Record<string, number> = {
    high: 0.60,
    medium: 0.30,
    low: 0.10,
  };

  /** Minimum entries needed to run self-scoring. Below this, preserve all. */
  min_entries_for_scoring: number = 5;

  /** If > 0, use SageRank for within-entry sentence ranking at this top-k.
   * 0 = disabled (entries scored but not internally reranked). */
  sagerank_top_k: number = 0;

  /** Field names that are always preserved at full fidelity. */
  preserve_fields: ReadonlySet<string> = new Set([
    'error', 'exception', 'message', 'status', 'code', 'id', 'type', 'name',
  ]);

  /** Field names that are candidates for array compression. */
  encode_fields: ReadonlySet<string> = new Set([
    'data', 'results', 'items', 'records', 'rows', 'entries', 'payload',
  ]);

  constructor(overrides?: Partial<CompressConfig>) {
    if (overrides !== undefined) {
      if (overrides.core_fraction_method !== undefined) {
        this.core_fraction_method = overrides.core_fraction_method;
      }
      if (overrides.core_fraction_fixed !== undefined) {
        this.core_fraction_fixed = overrides.core_fraction_fixed;
      }
      if (overrides.gini_threshold !== undefined) {
        this.gini_threshold = overrides.gini_threshold;
      }
      if (overrides.hubness_z_threshold !== undefined) {
        this.hubness_z_threshold = overrides.hubness_z_threshold;
      }
      if (overrides.redundancy_r_threshold !== undefined) {
        this.redundancy_r_threshold = overrides.redundancy_r_threshold;
      }
      if (overrides.dedup_scope !== undefined) {
        this.dedup_scope = overrides.dedup_scope;
      }
      if (overrides.dedup_maxsize !== undefined) {
        this.dedup_maxsize = overrides.dedup_maxsize;
      }
      if (overrides.string_budget_ratio !== undefined) {
        this.string_budget_ratio = overrides.string_budget_ratio;
      }
      if (overrides.stack_trace_max_user_frames !== undefined) {
        this.stack_trace_max_user_frames = overrides.stack_trace_max_user_frames;
      }
      if (overrides.tier_ratios !== undefined) {
        this.tier_ratios = overrides.tier_ratios;
      }
      if (overrides.min_entries_for_scoring !== undefined) {
        this.min_entries_for_scoring = overrides.min_entries_for_scoring;
      }
      if (overrides.sagerank_top_k !== undefined) {
        this.sagerank_top_k = overrides.sagerank_top_k;
      }
      if (overrides.preserve_fields !== undefined) {
        this.preserve_fields = overrides.preserve_fields;
      }
      if (overrides.encode_fields !== undefined) {
        this.encode_fields = overrides.encode_fields;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming Mode
// ---------------------------------------------------------------------------

/**
 * Stateful compressor for streaming mode.
 *
 * In streaming mode, self-scoring is not available (requires the full
 * corpus). Only dedup and string codec / structural compression apply.
 *
 * Usage:
 *   const compressor = new TOONCompressor();
 *   for (const entry of toolOutputStream) {
 *     const compressed = compressor.feed(entry);
 *     if (compressed !== null) { context.push(compressed); }
 *   }
 *   compressor.reset(); // at session boundary
 */
export class TOONCompressor {
  readonly config: CompressConfig;
  private readonly _deduplicator: Deduplicator;

  constructor(config?: CompressConfig | null) {
    this.config = config ?? new CompressConfig();
    this._deduplicator = new Deduplicator(this.config.dedup_maxsize);
  }

  /**
   * Process a single entry in streaming mode.
   *
   * Returns compressed entry, or null if deduplicated away.
   */
  feed(entry: unknown): unknown | null {
    const result = this._deduplicator.deduplicate([entry]);
    if (result.entries.length === 0) {
      return null;
    }
    const content = result.entries[0].content;
    return _compressEntry(content, null, this.config);
  }

  /** Reset dedup state (session boundary). */
  reset(): void {
    this._deduplicator.reset();
  }
}

// ---------------------------------------------------------------------------
// Functional API
// ---------------------------------------------------------------------------

/**
 * Full TOON compression pipeline.
 *
 * Runs all three stages: dedup → self-scoring → budget-aware compression.
 *
 * @param data Tool output data. Can be a single object or list of objects.
 * @param budget Target token budget. null = auto (50% of original size).
 * @param query Optional query to bias relevance scoring toward.
 * @param config Pipeline configuration. null = defaults.
 * @returns Compressed data (same top-level type as input).
 */
export function compress(
  data: unknown,
  budget: number | null = null,
  query: string | null = null,
  config: CompressConfig | null = null,
): unknown {
  const cfg = config ?? new CompressConfig();

  // Normalize input to list
  const is_single = !Array.isArray(data);
  const entries: unknown[] = is_single ? [data] : (data as unknown[]);

  if (entries.length === 0) {
    return data;
  }

  // Default budget: 50% of original size
  let effectiveBudget: number;
  if (budget === null) {
    const original_tokens = entries.reduce(
      (sum: number, e) => sum + estimateTokensObj(e),
      0,
    );
    effectiveBudget = Math.max(100, Math.floor(original_tokens / 2));
  } else {
    effectiveBudget = budget;
  }

  // Stage 1: Structural Decomposition & Dedup
  const deduplicator = new Deduplicator(cfg.dedup_maxsize);
  const dedup_result = deduplicator.deduplicate(entries);

  if (dedup_result.entries.length === 0) {
    return is_single ? null : [];
  }

  // Stage 2: Self-Scoring & Relevance Ranking
  const scored = _scoreEntries(dedup_result, query, cfg);

  // Stage 3: Budget-Aware Compression
  const allocation = BudgetAllocator.allocate(
    scored.entries,
    scored.scores,
    scored.tiers,
    effectiveBudget,
  );

  const compressed = _compressEntries(scored, allocation, cfg);

  if (is_single && compressed.entries.length > 0) {
    return compressed.entries[0];
  }
  return compressed.entries;
}

// ---------------------------------------------------------------------------
// Stage 2: Self-Scoring & Relevance Ranking (5-Phase Algorithm)
// ---------------------------------------------------------------------------

/**
 * Stage 2: 5-phase centrality + relevance scoring.
 *
 * Phase 0: entry count pre-check, Phase 1: BMX+ index,
 * Phase 2: SageRank centrality (Gini guard), Phase 3: Kneedle core,
 * Phase 4: BMX+ relevance vs core, Phase 5: tier assignment.
 */
function _scoreEntries(
  dedup_result: DedupResult,
  query: string | null,
  config: CompressConfig,
): ScoredEntries {
  const entries = dedup_result.entries;
  const n = entries.length;

  // Phase 0: Too few entries for meaningful scoring
  if (n < config.min_entries_for_scoring) {
    return {
      entries,
      scores: new Array<number>(n).fill(1.0),
      tiers: new Array<string>(n).fill('preserve'),
      core_indices: Array.from({ length: n }, (_, i) => i),
      scoring_stats: {
        method: 'bypass',
        reason: `n=${n} < min=${config.min_entries_for_scoring}`,
      },
    };
  }

  // Phase 1: Text extraction + BMX+ index
  const texts: string[] = entries.map((e) => flattenToText(e.content));
  const chunks = texts.map((text, i) => ({ chunk_id: String(i), text }));
  const index = new BMXPlusIndex();
  index.buildIndex(chunks);

  // Phase 2: Centrality scoring
  // SageRank graph centrality where tractable (n ≤ 1000).
  // For larger corpora, SageRank on random sample + BMX+ for the rest.
  // Threshold: n=1000 is where graph construction exceeds ~2s.
  const _GRAPH_LIMIT = 1000;

  let self_scores: number[];

  if (n <= _GRAPH_LIMIT) {
    const sage = new SageRank();
    const sage_result = sage.rankSentences(texts, n);
    self_scores = sage_result.scores;
  } else {
    // Hybrid: SageRank sample + BMX+ scoring
    // Deterministic seed for reproducibility.
    // DEVIATION from Python: Python uses random.Random(md5.hexdigest()) which
    // gives a Mersenne Twister PRNG seeded with the hex string. Here we use
    // Mulberry32 seeded from the first 8 hex chars of MD5 as a 32-bit uint.
    // Same input → same output (deterministic); exact float values differ
    // from Python's Mersenne Twister. Statistical equivalence is preserved.
    const seed_text = texts.length > 0 ? texts[0].slice(0, 100) : '';
    const rng = seededPRNG(seed_text);
    const sample_size = Math.min(500, n);

    // Fisher-Yates partial shuffle to sample sample_size unique indices
    const pool = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < sample_size; i++) {
      const j = i + Math.floor(rng() * (n - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    const sample_indices = pool.slice(0, sample_size).sort((a, b) => a - b);

    // SageRank on sample → real graph centrality scores
    const sage = new SageRank();
    const sage_result = sage.rankSentences(
      sample_indices.map((i) => texts[i]),
      sample_size,
    );
    const sample_scores = new Map<number, number>();
    for (let i = 0; i < sample_size; i++) {
      sample_scores.set(sample_indices[i], sage_result.scores[i]);
    }

    // Core from sample: top centrality entries (sample_size // 5)
    const sorted_sample = [...sample_scores.entries()].sort(
      (a, b) => b[1] - a[1],
    );
    const sample_core_size = Math.max(3, Math.floor(sample_size / 5));
    let core_query = sorted_sample
      .slice(0, sample_core_size)
      .map(([idx]) => texts[idx].slice(0, 200))
      .join(' ');
    if (query !== null) {
      core_query = query + ' ' + core_query.slice(0, 500);
    } else {
      core_query = core_query.slice(0, 2000);
    }

    // BMX+ scores ALL entries against the graph-derived core
    const bmx_results = index.search(core_query, n);
    const bmx_map = new Map<number, number>();
    for (const [cid, score] of bmx_results) {
      bmx_map.set(parseInt(cid, 10), score);
    }

    // Merge: normalize both scales, blend for sampled entries
    const max_bmx = bmx_map.size > 0
      ? Math.max(...bmx_map.values())
      : 1.0;
    const sample_score_values = [...sample_scores.values()];
    const max_sage = sample_score_values.length > 0
      ? Math.max(...sample_score_values)
      : 1.0;

    self_scores = [];
    for (let i = 0; i < n; i++) {
      const bmx_norm =
        max_bmx > 0 ? (bmx_map.get(i) ?? 0.0) / max_bmx : 0.0;
      if (sample_scores.has(i)) {
        const sage_norm =
          max_sage > 0 ? (sample_scores.get(i) ?? 0.0) / max_sage : 0.0;
        self_scores.push(0.5 * sage_norm + 0.5 * bmx_norm);
      } else {
        self_scores.push(bmx_norm);
      }
    }
  }

  // Gini check
  // Below threshold → degenerate corpus, self-scoring uninformative.
  // Derived from T-Retrievability (Ganguly 2025, arXiv:2508.21704).
  const gini = computeGini(self_scores);
  if (gini < config.gini_threshold) {
    console.warn(
      `Gini coefficient ${gini.toFixed(3)} < ${config.gini_threshold.toFixed(1)}: corpus is undifferentiated, falling back to uniform allocation`,
    );
    return {
      entries,
      scores: new Array<number>(n).fill(1.0 / n),
      tiers: new Array<string>(n).fill('medium'),
      core_indices: [],
      scoring_stats: {
        method: 'uniform_fallback',
        gini: Math.round(gini * 10000) / 10000,
        reason: 'degenerate corpus',
      },
    };
  }

  // Hubness detection (median/MAD)
  // Cisco 2026: median/MAD z-score detection outperforms mean-based.
  // Radovanović et al. (JMLR 2010): hubs distort centrality.
  const sorted_ss = [...self_scores].sort((a, b) => a - b);
  const median_ss = sorted_ss[Math.floor(n / 2)];
  const abs_devs = self_scores
    .map((s) => Math.abs(s - median_ss))
    .sort((a, b) => a - b);
  const mad = abs_devs[Math.floor(n / 2)] * 1.4826; // MAD to std conversion factor

  const hubs: number[] = [];
  if (mad > 0) {
    for (let i = 0; i < n; i++) {
      const z = (self_scores[i] - median_ss) / mad;
      if (z > config.hubness_z_threshold) {
        self_scores[i] = median_ss + 2 * mad;
        hubs.push(i);
      }
    }
  }

  // Phase 3: Core identification via Kneedle
  const sorted_indices = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => self_scores[b] - self_scores[a],
  );
  const sorted_scores = sorted_indices.map((i) => self_scores[i]);

  let core_size: number;
  if (config.core_fraction_method === 'kneedle') {
    const knee = findKneedle(sorted_scores, 1.0);
    core_size = Math.max(1, Math.min(knee + 1, Math.floor(n / 2)));
    core_size = Math.max(core_size, Math.max(1, Math.floor(n / 20))); // At least 5%
  } else {
    core_size = Math.max(1, Math.floor(n * config.core_fraction_fixed));
  }

  const core_indices = sorted_indices.slice(0, core_size);

  // Phase 4: Relevance scoring against core
  let core_text = core_indices.map((i) => texts[i].slice(0, 200)).join(' ');
  let combined_query: string;
  if (query !== null) {
    combined_query = query + ' ' + core_text.slice(0, 500);
  } else {
    combined_query = core_text.slice(0, 2000);
  }

  const relevance_results = index.search(combined_query, n);
  const relevance_map = new Map<string, number>();
  for (const [cid, score] of relevance_results) {
    relevance_map.set(cid, score);
  }
  const relevance_scores: number[] = Array.from({ length: n }, (_, i) =>
    relevance_map.get(String(i)) ?? 0.0,
  );

  // Redundancy check
  const r = pearsonR(self_scores, relevance_scores);
  let final_scores: number[];
  if (r > config.redundancy_r_threshold) {
    final_scores = [...self_scores];
  } else {
    final_scores = self_scores.map((ss, i) => 0.4 * ss + 0.6 * relevance_scores[i]);
  }

  // Normalize to [0,1]
  const max_fs = final_scores.length > 0 ? Math.max(...final_scores) : 1.0;
  if (max_fs > 0) {
    for (let i = 0; i < final_scores.length; i++) {
      final_scores[i] = final_scores[i] / max_fs;
    }
  }

  // Phase 5: Tier assignment
  const sorted_final = [...final_scores].sort((a, b) => a - b);
  const p75 =
    n > 3 ? sorted_final[Math.floor(n * 0.75)] : sorted_final[sorted_final.length - 1];
  const p25 = n > 3 ? sorted_final[Math.floor(n * 0.25)] : sorted_final[0];

  const tiers: string[] = [];
  for (let i = 0; i < n; i++) {
    const score = final_scores[i];
    if (score >= p75) {
      tiers.push('high');
    } else if (score >= p25) {
      tiers.push('medium');
    } else if (score > 0) {
      tiers.push('low');
    } else {
      tiers.push('cut');
    }
  }

  return {
    entries,
    scores: final_scores,
    tiers,
    core_indices,
    scoring_stats: {
      method: 'sagerank_centrality',
      gini: Math.round(gini * 10000) / 10000,
      core_size,
      hubs_detected: hubs.length,
      phase2_phase4_r: Math.round(r * 10000) / 10000,
      kneedle_threshold: core_size,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Budget-Aware Compression
// ---------------------------------------------------------------------------

/**
 * Stage 3: Apply budget-aware compression to each entry.
 */
function _compressEntries(
  scored: ScoredEntries,
  allocation: BudgetAllocation,
  config: CompressConfig,
): CompressedOutput {
  let total_tokens = 0;
  let entries_cut = 0;

  // Build list of (original_index, compressed_entry) for order preservation
  const indexed_results: Array<[number, unknown]> = [];

  for (let i = 0; i < scored.entries.length; i++) {
    const entry = scored.entries[i];
    const tier = scored.tiers[i];
    const entry_budget = allocation.entry_budgets[i];

    if (tier === 'cut') {
      entries_cut += 1;
      continue;
    }

    const content = entry.content;
    const result = _compressEntry(content, entry_budget, config, entry);
    indexed_results.push([entry.index, result]);
    total_tokens += estimateTokensObj(result);
  }

  // Sort by original index to preserve input order
  indexed_results.sort((a, b) => a[0] - b[0]);
  const compressed = indexed_results.map(([, r]) => r);

  const original_tokens = scored.entries.reduce(
    (sum, e) => sum + estimateTokensObj(e.content),
    0,
  );

  // Build tier_distribution
  const tier_distribution: Record<string, number> = {};
  for (const tier of scored.tiers) {
    tier_distribution[tier] = (tier_distribution[tier] ?? 0) + 1;
  }

  return {
    entries: compressed,
    budget_used: total_tokens,
    stats: {
      compression_ratio:
        Math.round((1.0 - total_tokens / Math.max(1, original_tokens)) * 10000) /
        10000,
      entries_kept: compressed.length,
      entries_cut,
      tier_distribution,
      scoring_stats: scored.scoring_stats,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry-Level Compression
// ---------------------------------------------------------------------------

/**
 * Compress a single entry using type-appropriate strategy.
 *
 * Dispatch: template-annotated → marker, str → string codec,
 * dict → field routing, list/tuple → encodeRecursive, else passthrough.
 */
function _compressEntry(
  content: unknown,
  budget: number | null,
  config: CompressConfig,
  entry_meta?: EntryMeta | null,
): unknown {
  // Template-collapsed entries → emit structured marker
  if (
    entry_meta !== undefined &&
    entry_meta !== null &&
    entry_meta.__toon_template === true
  ) {
    const half = budget !== null ? Math.floor(budget / 2) : null;
    return {
      __toon_template: true,
      count: entry_meta.template_count,
      first: _compressEntry(entry_meta.template_first, half, config),
      last: _compressEntry(entry_meta.template_last, half, config),
    };
  }

  if (typeof content === 'string') {
    let effectiveBudget = budget !== null ? budget : content.length;

    // Within-entry SageRank ranking (opt-in, default disabled)
    if (
      config.sagerank_top_k > 0 &&
      content.length > effectiveBudget &&
      content.length > 500
    ) {
      const sr = new SageRank();
      const sr_result = sr.rank(content, config.sagerank_top_k);
      if (sr_result.selectedSentences.length > 0) {
        const ranked = sr_result.selectedSentences.join(' ');
        if (ranked.length <= effectiveBudget) {
          return ranked;
        }
      }
    }

    return compressString(
      content,
      effectiveBudget,
      config.stack_trace_max_user_frames,
    );
  }

  if (
    typeof content === 'object' &&
    content !== null &&
    !Array.isArray(content)
  ) {
    return _compressDict(content as Record<string, unknown>, budget, config);
  }

  if (Array.isArray(content)) {
    const threshold =
      budget !== null ? Math.max(3, Math.floor(budget / 50)) : 5;
    return encodeRecursive(content, threshold);
  }

  return content;
}

/**
 * Compress a dict with field routing: preserve vs. encode.
 */
function _compressDict(
  obj: Record<string, unknown>,
  budget: number | null,
  config: CompressConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const key of keys) {
    const value = obj[key];
    const lowerKey = key.toLowerCase();
    if (config.preserve_fields.has(lowerKey)) {
      result[key] = value;
    } else if (config.encode_fields.has(lowerKey)) {
      if (Array.isArray(value) && value.length > 5) {
        result[key] = encodeRecursive(value, 5);
      } else if (typeof value === 'string' && budget !== null) {
        const field_budget = Math.floor(budget / Math.max(1, keys.length));
        result[key] = compressString(
          value,
          field_budget,
          config.stack_trace_max_user_frames,
        );
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (replaces Python random.Random(md5.hexdigest()))
// ---------------------------------------------------------------------------

/**
 * Create a deterministic PRNG seeded from an MD5 hex digest.
 *
 * Python uses random.Random(hashlib.md5(seed_text.encode()).hexdigest())
 * which seeds a Mersenne Twister with the full hex string. Here we use
 * Mulberry32 seeded from the first 8 hex chars of MD5 as a 32-bit uint.
 *
 * Deviation: exact float sequences differ from Python's Mersenne Twister,
 * but determinism is preserved (same input → same output) and the sampling
 * distribution is statistically equivalent (uniform over the index range).
 */
function seededPRNG(seed: string): () => number {
  const hex = createHash('md5')
    .update(seed, 'utf-8')
    .digest('hex')
    .slice(0, 8);
  let state = (parseInt(hex, 16) >>> 0);
  // Mulberry32
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
