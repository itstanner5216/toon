// Ported from: toon/config.py, toon/dedup.py, toon/pipeline.py, toon/encoder.py, toon/_utils.py
// Python line count: N/A (aggregate of shared shapes across 5 files)
// Port verification:
//   - All dataclass fields present with correct types
//   - Optional fields use T | null to match Python Optional[T]
//   - Python Any at public boundaries -> unknown
//   - camelCase field names match the bridge contract (startLine/endLine from tree-sitter.ts)
//   - DedupStats.totalRemoved exposed as a getter (matches Python @property)
//   - TemplateInfo matches dedup.py fields exactly
//   - CompressConfig defaults match pipeline.py defaults

// ---------------------------------------------------------------------------
// Shared structural types (used by Wave 2 and Wave 3 modules)
// ---------------------------------------------------------------------------

export interface StructureBlock {
  name: string;
  kind: string;
  type: string;
  startLine: number;     // 0-based (NOT start_line)
  endLine: number;       // 0-based inclusive (NOT end_line)
  exported: boolean;
  anchors: Anchor[];
  priority?: number;
}

export interface Anchor {
  startLine: number;
  endLine: number;
  kind: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// config.py shapes
// ---------------------------------------------------------------------------

export interface BudgetTier {
  percentile: number;
  tier_name: string;
}

export interface FieldMatcher {
  field_path: string | null;
  field_pattern: string | null;
  min_length: number | null;
  max_length: number | null;
}

export interface CodecConfig {
  strategy: string;
  budget: number | null;
}

export interface EncoderRule {
  matcher: FieldMatcher;
  codec: CodecConfig;
}

export interface ArrayCodecConfig {
  enabled: boolean;
  threshold: number;
  sample_size: number;
}

export interface StringCodecConfig {
  enabled: boolean;
  default_budget: number;
  min_length: number;
  parse_json: boolean;
  stack_trace_max_user_frames: number;
}

export interface DedupConfig {
  enabled: boolean;
  scope: string;
  maxsize: number;
}

export interface BMXConfig {
  enabled: boolean;
  mode: string;
  query: string | null;
  core_fraction: number;
  gini_threshold: number;
  tiers: BudgetTier[];
}

export interface ToonConfig {
  enabled: boolean;
  preserve_rules: FieldMatcher[];
  encode_rules: EncoderRule[];
  default_codec: CodecConfig | null;
  array: ArrayCodecConfig;
  string: StringCodecConfig;
  dedup: DedupConfig;
  bmx: BMXConfig;
  emit_markers: boolean;
  emit_stats: boolean;
}

// ---------------------------------------------------------------------------
// dedup.py shapes
// ---------------------------------------------------------------------------

export interface DedupStats {
  exact: number;
  near: number;
  template: number;
}

/** Computed property equivalent to Python DedupStats.total_removed */
export function dedupStatsTotal(stats: DedupStats): number {
  return stats.exact + stats.near + stats.template;
}

export interface TemplateInfo {
  pattern: string;
  count: number;
  sample: unknown;
}

/**
 * Full TemplateInfo as used by dedup.py internally —
 * tracks first/last content for template collapsing.
 */
export interface TemplateInfoFull {
  first_content: unknown;
  last_content: unknown;
  count: number;
  first_index: number;
  last_index: number;
}

/** Entry metadata dict as produced by the deduplicator pass. */
export interface EntryMeta {
  content: unknown;
  type: string;
  index: number;
  template_id: string | null;
  __toon_template?: boolean;
  template_count?: number;
  template_first?: unknown;
  template_last?: unknown;
}

export interface DedupResult {
  entries: EntryMeta[];
  dedup_stats: DedupStats;
  templates: Map<string, TemplateInfoFull>;
}

// ---------------------------------------------------------------------------
// pipeline.py shapes
// ---------------------------------------------------------------------------

export interface CompressConfig {
  core_fraction_method: string;
  core_fraction_fixed: number;
  gini_threshold: number;
  hubness_z_threshold: number;
  redundancy_r_threshold: number;
  dedup_scope: string;
  dedup_maxsize: number;
  string_budget_ratio: number;
  stack_trace_max_user_frames: number;
  tier_ratios: Record<string, number>;
  min_entries_for_scoring: number;
  sagerank_top_k: number;
  preserve_fields: ReadonlySet<string>;
  encode_fields: ReadonlySet<string>;
}

export interface ScoredEntries {
  entries: EntryMeta[];
  scores: number[];
  tiers: string[];
  core_indices: number[];
  scoring_stats: Record<string, unknown>;
}

export interface CompressedOutput {
  entries: unknown[];
  budget_used: number;
  stats: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// encoder.py shapes
// ---------------------------------------------------------------------------

/**
 * TOON metadata summary for compressed arrays.
 * Exact field names and values must match Python encoder output.
 */
export interface ToonArrayMeta {
  __toon: true;
  count: number;
  sample: unknown[];
}

/** Template marker emitted by pipeline Stage 3. */
export interface ToonTemplateMeta {
  __toon_template: true;
  count: number;
  first: unknown;
  last: unknown;
}

// ---------------------------------------------------------------------------
// Utility: type guards
// ---------------------------------------------------------------------------

export function isToonArrayMeta(v: unknown): v is ToonArrayMeta {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['__toon'] === true &&
    typeof (v as Record<string, unknown>)['count'] === 'number' &&
    Array.isArray((v as Record<string, unknown>)['sample'])
  );
}

export function isToonTemplateMeta(v: unknown): v is ToonTemplateMeta {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['__toon_template'] === true &&
    typeof (v as Record<string, unknown>)['count'] === 'number'
  );
}
