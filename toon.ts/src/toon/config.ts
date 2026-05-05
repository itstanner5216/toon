// Ported from: toon/config.py
// Python line count: 315
// Port verification:
//   - All dataclass fields preserved with exact default values
//   - BudgetTier, FieldMatcher, CodecConfig, EncoderRule: all required fields, no defaults changed
//   - ArrayCodecConfig defaults: enabled=true, threshold=5, sample_size=3
//   - StringCodecConfig defaults: enabled=true, default_budget=500, min_length=200, parse_json=true, stack_trace_max_user_frames=10
//   - DedupConfig defaults: enabled=true, scope="session", maxsize=5000
//   - BMXConfig defaults: enabled=false, mode="self", query=null, core_fraction=0.15, gini_threshold=0.2, tiers=[{0.75,"high"},{0.25,"medium"},{0.0,"low"}]
//   - ToonConfig defaults: enabled=true, preserve_rules=[], encode_rules=[], default_codec=null, array/string/dedup/bmx=defaults, emit_markers=true, emit_stats=false
//   - preset() raises Error for unknown names with sorted valid keys list
//   - fromCompressConfig() maps all fields: preserve_rules, encode_rules, array, string, dedup, bmx, emit_markers, emit_stats
//   - tier_ratios sorted descending by percentile
//   - deepCopyConfig uses JSON.parse/JSON.stringify (all configs are JSON-safe)

/**
 * A single tier boundary used by BMX scoring to bucket entries.
 * Entries whose normalised score is >= percentile are assigned tier_name.
 * Tiers are evaluated top-down; the first match wins.
 */
export interface BudgetTier {
  percentile: number;
  tier_name: string;
}

export function defaultBudgetTier(percentile: number, tier_name: string): BudgetTier {
  return { percentile, tier_name };
}

/**
 * Predicate that decides whether a (field_path, value) pair matches.
 * All specified (non-null) conditions are AND-ed together.
 * A matcher with every field null matches everything.
 */
export interface FieldMatcher {
  field_path: string | null;
  field_pattern: string | null;
  min_length: number | null;
  max_length: number | null;
}

export function defaultFieldMatcher(overrides?: Partial<FieldMatcher>): FieldMatcher {
  return {
    field_path: null,
    field_pattern: null,
    min_length: null,
    max_length: null,
    ...overrides,
  };
}

/**
 * Describes how a matched field should be compressed.
 * strategy is one of: "truncate" | "dedup" | "parse_json" | "drop" | "array" | "passthrough"
 */
export interface CodecConfig {
  strategy: string;
  budget: number | null;
}

export function defaultCodecConfig(strategy: string, budget: number | null = null): CodecConfig {
  return { strategy, budget };
}

/**
 * Pairs a matcher with the codec to apply when it fires.
 * Rules are evaluated in list order; the first match wins.
 */
export interface EncoderRule {
  matcher: FieldMatcher;
  codec: CodecConfig;
}

/**
 * Controls threshold-based array folding (TOON v1 behaviour).
 */
export interface ArrayCodecConfig {
  enabled: boolean;
  threshold: number;
  sample_size: number;
}

export function defaultArrayCodecConfig(overrides?: Partial<ArrayCodecConfig>): ArrayCodecConfig {
  return {
    enabled: true,
    threshold: 5,
    sample_size: 3,
    ...overrides,
  };
}

/**
 * Controls string-level compression (truncation, JSON parsing, stack trace collapsing).
 */
export interface StringCodecConfig {
  enabled: boolean;
  default_budget: number;
  min_length: number;
  parse_json: boolean;
  stack_trace_max_user_frames: number;
}

export function defaultStringCodecConfig(overrides?: Partial<StringCodecConfig>): StringCodecConfig {
  return {
    enabled: true,
    default_budget: 500,
    min_length: 200,
    parse_json: true,
    stack_trace_max_user_frames: 10,
    ...overrides,
  };
}

/**
 * Controls the deduplication stage.
 */
export interface DedupConfig {
  enabled: boolean;
  scope: string;
  maxsize: number;
}

export function defaultDedupConfig(overrides?: Partial<DedupConfig>): DedupConfig {
  return {
    enabled: true,
    scope: "session",
    maxsize: 5000,
    ...overrides,
  };
}

/**
 * Controls the BMX+ / SageRank scoring stage (opt-in).
 */
export interface BMXConfig {
  enabled: boolean;
  mode: string;
  query: string | null;
  core_fraction: number;
  gini_threshold: number;
  tiers: BudgetTier[];
}

export function defaultBMXConfig(overrides?: Partial<BMXConfig>): BMXConfig {
  return {
    enabled: false,
    mode: "self",
    query: null,
    core_fraction: 0.15,
    gini_threshold: 0.2,
    tiers: [
      { percentile: 0.75, tier_name: "high" },
      { percentile: 0.25, tier_name: "medium" },
      { percentile: 0.0, tier_name: "low" },
    ],
    ...overrides,
  };
}

/**
 * Master configuration for the TOON compression pipeline.
 * Every field has a default, so defaultToonConfig() is always valid.
 *
 * Routing priority (evaluated by toon.router.route_field):
 *   1. preserve_rules — if any matcher hits -> "preserve"
 *   2. encode_rules   — first match wins -> that rule's codec strategy
 *   3. default_codec  — fallback codec if nothing else matched
 *   4. -> "passthrough"
 */
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

export function defaultToonConfig(overrides?: Partial<ToonConfig>): ToonConfig {
  return {
    enabled: true,
    preserve_rules: [],
    encode_rules: [],
    default_codec: null,
    array: defaultArrayCodecConfig(),
    string: defaultStringCodecConfig(),
    dedup: defaultDedupConfig(),
    bmx: defaultBMXConfig(),
    emit_markers: true,
    emit_stats: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Deep copy helper
//  All config objects are JSON-safe (no functions, Maps, or class instances),
//  so JSON round-trip is correct for deep cloning.
// ─────────────────────────────────────────────────────────────────────────────

function deepCopyConfig<T>(c: T): T {
  return JSON.parse(JSON.stringify(c)) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Legacy CompressConfig shape (minimal, for fromCompressConfig)
// ─────────────────────────────────────────────────────────────────────────────

interface LegacyCompressConfig {
  preserve_fields: string[];
  encode_fields: string[];
  tier_ratios: Record<string, number>;
  core_fraction_fixed: number;
  stack_trace_max_user_frames: number;
  dedup_scope: string;
  dedup_maxsize: number;
  gini_threshold: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Factory helpers — class-method equivalents
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return a deep-copied preset config by name.
 * Raises Error for unknown presets, listing the valid ones.
 *
 * Note: In the TS port, PRESETS must be passed in directly to avoid
 * the circular-import lazy-load pattern used in the Python source.
 */
export function toonConfigPreset(
  name: string,
  presets: Record<string, ToonConfig>
): ToonConfig {
  if (!(name in presets)) {
    const available = Object.keys(presets).sort();
    throw new Error(
      `Unknown preset: ${JSON.stringify(name)}. Available: ${JSON.stringify(available)}`
    );
  }
  return deepCopyConfig(presets[name]);
}

/**
 * Convert a legacy CompressConfig into a ToonConfig.
 * This is the backward-compatibility bridge.
 */
export function toonConfigFromCompressConfig(cc: LegacyCompressConfig): ToonConfig {
  // Preserve rules from cc.preserve_fields
  const preserveRules: FieldMatcher[] = [...cc.preserve_fields]
    .sort()
    .map((fname) => defaultFieldMatcher({ field_pattern: `^${fname}$` }));

  // Encode rules from cc.encode_fields
  const encodeRules: EncoderRule[] = [...cc.encode_fields]
    .sort()
    .map((fname) => ({
      matcher: defaultFieldMatcher({ field_pattern: `^${fname}$` }),
      codec: defaultCodecConfig("array"),
    }));

  // Map tier_ratios -> BudgetTier list
  // CompressConfig stores {"high": 0.60, "medium": 0.30, "low": 0.10}
  // We convert to percentile thresholds: high >= 0.75, medium >= 0.25, low >= 0.0
  const tierMap: Record<string, number> = {
    high: 0.75,
    medium: 0.25,
    low: 0.0,
  };
  const budgetTiers: BudgetTier[] = Object.keys(cc.tier_ratios).map((name) => ({
    percentile: tierMap[name] ?? 0.0,
    tier_name: name,
  }));
  // Sort descending by percentile so top-down evaluation works
  budgetTiers.sort((a, b) => b.percentile - a.percentile);

  // Determine BMX mode
  const bmxMode = "self";
  // If core_fraction_method is "fixed", keep self mode but set fraction
  const coreFrac = cc.core_fraction_fixed;

  return defaultToonConfig({
    preserve_rules: preserveRules,
    encode_rules: encodeRules,
    array: defaultArrayCodecConfig({
      enabled: true,
      threshold: 5,
      sample_size: 3,
    }),
    string: defaultStringCodecConfig({
      enabled: true,
      stack_trace_max_user_frames: cc.stack_trace_max_user_frames,
    }),
    dedup: defaultDedupConfig({
      enabled: cc.dedup_scope !== "none",
      scope: cc.dedup_scope,
      maxsize: cc.dedup_maxsize,
    }),
    bmx: defaultBMXConfig({
      enabled: false, // CompressConfig doesn't have an explicit toggle
      mode: bmxMode,
      core_fraction: coreFrac,
      gini_threshold: cc.gini_threshold,
      tiers: budgetTiers,
    }),
    emit_markers: true,
    emit_stats: false,
  });
}
