// Ported from: toon/__init__.py public surface
// Python __init__.py exports: encode_output, compress, CompressConfig, TOONCompressor
// Additional re-exports for Wave 4 and integration use.

// ---------------------------------------------------------------------------
// Legacy API (backward-compatible)
// ---------------------------------------------------------------------------
export { encodeOutput, encodeRecursive } from './encoder.js';

// ---------------------------------------------------------------------------
// Full Pipeline API
// ---------------------------------------------------------------------------
export { compress, CompressConfig, TOONCompressor } from './pipeline.js';
export type { ScoredEntries, CompressedOutput } from './pipeline.js';

// ---------------------------------------------------------------------------
// String codec public API
// ---------------------------------------------------------------------------
export { compressString, compressSourceStructured } from './string-codec.js';

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------
export { BMXPlusIndex } from './bmx-plus.js';
export { SageRank } from './sagerank.js';
export type { SageResult } from './sagerank.js';

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------
export { Deduplicator } from './dedup.js';
export type { DedupStats, DedupResult, TemplateInfo } from './dedup.js';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------
export { BudgetAllocator } from './budget.js';
export type { BudgetAllocation } from './budget.js';

// ---------------------------------------------------------------------------
// Router & Presets
// ---------------------------------------------------------------------------
export { fieldMatcherMatches, routeField } from './router.js';
export { PRESETS } from './presets.js';

// ---------------------------------------------------------------------------
// Config factories
// ---------------------------------------------------------------------------
export {
  defaultToonConfig,
  toonConfigPreset,
  toonConfigFromCompressConfig,
  defaultBudgetTier,
  defaultFieldMatcher,
  defaultCodecConfig,
  defaultArrayCodecConfig,
  defaultStringCodecConfig,
  defaultDedupConfig,
  defaultBMXConfig,
} from './config.js';
export type {
  BudgetTier,
  FieldMatcher,
  CodecConfig,
  EncoderRule,
  ArrayCodecConfig,
  StringCodecConfig,
  DedupConfig,
  BMXConfig,
  ToonConfig,
} from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  StructureBlock,
  Anchor,
  EntryMeta,
  DedupStats as DedupStatsBase,
  DedupResult as DedupResultBase,
  TemplateInfoFull,
  CompressConfig as CompressConfigShape,
  ToonArrayMeta,
  ToonTemplateMeta,
} from './types.js';
export { isToonArrayMeta, isToonTemplateMeta, dedupStatsTotal } from './types.js';

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
export {
  normalizeValue,
  blake2bHash,
  canonicalJson,
  estimateTokens,
  estimateTokensObj,
  flattenToText,
  computeGini,
  findKneedle,
  pearsonR,
  NORMALIZERS,
} from './utils.js';
