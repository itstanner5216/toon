// Ported from: toon/_utils.py
// Python line count: 204
// Port verification:
//   - TIMESTAMP_RE, UUID_RE, IP_RE, BIGNUM_RE, B64_RE: regex patterns match Python source
//     (Python re.IGNORECASE on UUID_RE → /i flag; other flags preserved)
//   - NORMALIZERS array: same order (timestamps before big-numbers), same replacement tokens
//   - normalizeValue: recursive; int/float → '<NUM>'; dict keys sorted; list items recursed
//   - blake2bHash: see DEVIATION NOTE below — uses blake2b512 full hash + hex slice
//   - canonicalJson: recursive key-sort via sortKeysDeep to match json.dumps(sort_keys=True)
//   - estimateTokens: JSON ('{' or '[' start) → chars//2, else → chars//4, min 1
//   - estimateTokensObj: canonicalJson then estimateTokens
//   - flattenToText: dict emits 'key value' pairs; list/tuple joined; null → ''; str passthrough
//   - computeGini: exact algorithm from Python (cumulative sum formula)
//   - findKneedle: n<3 → n-1; flat → n-1; diff from diagonal; walk from best_idx
//   - pearsonR: n<3 → 0.0; zero variance → 0.0; cov/(sx*sy)

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Regex constants (match Python source exactly)
// ---------------------------------------------------------------------------

export const TIMESTAMP_RE: RegExp =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

export const UUID_RE: RegExp =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const IP_RE: RegExp = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export const BIGNUM_RE: RegExp = /\b\d{10,}\b/g;

export const B64_RE: RegExp = /\b[A-Za-z0-9+/]{20,}={0,2}\b/g;

// NOTE: JS regex with /g flag is STATEFUL — each regex in NORMALIZERS is a
// factory function to produce a fresh instance per call, avoiding lastIndex
// contamination across calls.
export const NORMALIZERS: ReadonlyArray<readonly [() => RegExp, string]> = [
  [(): RegExp => /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  [(): RegExp => /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [(): RegExp => /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>'],
  [(): RegExp => /\b\d{10,}\b/g, '<NUM>'],
  [(): RegExp => /\b[A-Za-z0-9+/]{20,}={0,2}\b/g, '<B64>'],
];

// ---------------------------------------------------------------------------
// normalizeValue
// ---------------------------------------------------------------------------

/**
 * Recursively normalize variable fields in a JSON-like structure.
 *
 * Replaces timestamps, UUIDs, IPs, large numbers, and base64 blobs with
 * placeholder tokens so that structurally identical entries with different
 * volatile values hash to the same fingerprint.
 */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === 'string') {
    let s = v;
    for (const [reFn, token] of NORMALIZERS) {
      // Fresh regex instance per call to avoid /g lastIndex contamination.
      s = s.replace(reFn(), token);
    }
    return s;
  }
  if (typeof v === 'number') {
    // Python: isinstance(v, (int, float)) → '<NUM>'
    return '<NUM>';
  }
  if (Array.isArray(v)) {
    return v.map((item) => normalizeValue(item));
  }
  if (v !== null && typeof v === 'object') {
    // Dict: sort keys (matches Python sorted(v.items()))
    const obj = v as Record<string, unknown>;
    const sorted = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const k of sorted) {
      result[k] = normalizeValue(obj[k]);
    }
    return result;
  }
  // None / bool / other pass-through (Python: return v)
  return v;
}

// ---------------------------------------------------------------------------
// blake2bHash
// ---------------------------------------------------------------------------

/**
 * Fast hash for dedup. Returns hex string.
 *
 * DEVIATION: Python's hashlib.blake2b(data, digest_size=N) computes a
 * fundamentally different hash for each digest_size value — it is NOT
 * truncation of a larger hash. Node's crypto module only exposes
 * 'blake2b512' (full 64-byte output) with no variable-digest API.
 * Therefore: this implementation hashes with blake2b512 then slices to
 * digestSize*2 hex characters. Cross-implementation hash matching is NOT
 * preserved, but this is acceptable because the TS codebase replaces Python
 * entirely — there is no cross-language dedup fingerprint sharing.
 * All comparisons are TS↔TS within the same process.
 */
export function blake2bHash(data: string, digestSize: number = 8): string {
  return createHash('blake2b512')
    .update(Buffer.from(data, 'utf-8'))
    .digest('hex')
    .slice(0, digestSize * 2);
}

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization for hashing.
 *
 * Sorts keys recursively at every nesting level, matching Python's
 * json.dumps(obj, sort_keys=True, separators=(',', ':'), default=str).
 *
 * Plain JSON.stringify(obj, Object.keys(obj).sort()) does NOT recurse —
 * this function uses sortKeysDeep to handle arbitrarily nested objects.
 */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(sortKeysDeep);
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const sorted = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const k of sorted) {
      result[k] = sortKeysDeep(obj[k]);
    }
    return result;
  }
  return v;
}

export function canonicalJson(obj: unknown): string {
  // Python default=str serializes non-serializable objects as their str().
  // We replicate this with a replacer that converts unknown values to strings.
  const sorted = sortKeysDeep(obj);
  return JSON.stringify(sorted, (_key: string, value: unknown): unknown => {
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string' ||
      Array.isArray(value) ||
      (typeof value === 'object')
    ) {
      return value;
    }
    // Non-JSON-serializable: match Python default=str
    return String(value);
  });
}

// ---------------------------------------------------------------------------
// estimateTokens / estimateTokensObj
// ---------------------------------------------------------------------------

/**
 * Conservative token estimation. JSON: chars/2, text: chars/4.
 *
 * Heuristic from Anthropic cookbook analysis: JSON markup inflates
 * token counts relative to plain text.
 *
 * Python uses integer floor division (//); Math.floor preserves that.
 */
export function estimateTokens(text: string): number {
  if (text.startsWith('{') || text.startsWith('[')) {
    return Math.max(1, Math.floor(text.length / 2));
  }
  return Math.max(1, Math.floor(text.length / 4));
}

/** Estimate tokens for an arbitrary value via canonical JSON. */
export function estimateTokensObj(obj: unknown): number {
  return estimateTokens(canonicalJson(obj));
}

// ---------------------------------------------------------------------------
// flattenToText
// ---------------------------------------------------------------------------

/**
 * Convert any object to a flat text string for BMX+ indexing.
 *
 * Dicts emit 'key value' pairs, lists emit space-joined children,
 * primitives emit String(). null → '' (matches Python None → '').
 */
export function flattenToText(obj: unknown): string {
  if (typeof obj === 'string') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => flattenToText(item)).join(' ');
  }
  if (obj !== null && typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    const parts: string[] = [];
    for (const [k, v] of entries) {
      parts.push(`${k} ${flattenToText(v)}`);
    }
    return parts.join(' ');
  }
  // Python: return str(obj) if obj is not None else ''
  if (obj === null) {
    return '';
  }
  return String(obj);
}

// ---------------------------------------------------------------------------
// computeGini
// ---------------------------------------------------------------------------

/**
 * Gini coefficient of a distribution. 0 = perfect equality, 1 = max inequality.
 *
 * Derived from T-Retrievability (Ganguly et al. 2025, arXiv:2508.21704):
 * Gini < 0.2 indicates near-uniform document exposure.
 */
export function computeGini(values: number[]): number {
  const n = values.length;
  if (n < 2) {
    return 0.0;
  }
  const sortedV = [...values].sort((a, b) => a - b);
  let total = 0;
  for (const v of sortedV) {
    total += v;
  }
  if (total === 0) {
    return 0.0;
  }
  let cumulative = 0.0;
  let giniSum = 0.0;
  for (let i = 0; i < n; i++) {
    cumulative += sortedV[i];
    giniSum += cumulative;
  }
  return 1.0 - (2.0 * giniSum) / (n * total) + 1.0 / n;
}

// ---------------------------------------------------------------------------
// findKneedle
// ---------------------------------------------------------------------------

/**
 * Find knee point in a sorted-descending score curve.
 *
 * Returns index of the knee (boundary between core and periphery).
 * Implements Satopää et al. 2011 (IEEE ICDCS) simplified for 1D sorted data.
 *
 * Args:
 *   scores: Descending-sorted list of scores.
 *   sensitivity: Kneedle S parameter. S=1.0 recommended for online settings.
 *
 * Returns:
 *   Index of the knee point.
 */
export function findKneedle(scores: number[], sensitivity: number = 1.0): number {
  const n = scores.length;
  if (n < 3) {
    return n - 1;
  }

  // Normalize to [0,1]
  let sMin = scores[0];
  let sMax = scores[0];
  for (let i = 1; i < n; i++) {
    if (scores[i] < sMin) sMin = scores[i];
    if (scores[i] > sMax) sMax = scores[i];
  }
  const sRange = sMax - sMin;
  if (sRange < 1e-10) {
    return n - 1; // flat distribution — no knee
  }

  const xNorm: number[] = [];
  const yNorm: number[] = [];
  for (let i = 0; i < n; i++) {
    xNorm.push(i / (n - 1));
    yNorm.push((scores[i] - sMin) / sRange);
  }

  // Difference from diagonal y = 1 - x
  const diff: number[] = [];
  for (let i = 0; i < n; i++) {
    diff.push(yNorm[i] - (1.0 - xNorm[i]));
  }

  // Find global maximum of difference curve (Python iterates range(1, n-1))
  let bestIdx = 0;
  let bestVal = diff[0];
  for (let i = 1; i < n - 1; i++) {
    if (diff[i] > bestVal) {
      bestVal = diff[i];
      bestIdx = i;
    }
  }

  // Walk forward: first point where diff drops below threshold
  const threshold = bestVal - sensitivity * sRange / n;
  for (let i = bestIdx + 1; i < n; i++) {
    if (diff[i] < threshold) {
      return i;
    }
  }

  return bestIdx;
}

// ---------------------------------------------------------------------------
// pearsonR
// ---------------------------------------------------------------------------

/**
 * Pearson correlation coefficient between two equal-length lists.
 *
 * Returns 0.0 for degenerate inputs (n < 3 or zero variance).
 * Used in the pipeline to detect Phase 2/4 redundancy.
 */
export function pearsonR(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) {
    return 0.0;
  }
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
  }
  const mx = sumX / n;
  const my = sumY / n;

  let cov = 0.0;
  let varX = 0.0;
  let varY = 0.0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const sx = Math.sqrt(varX);
  const sy = Math.sqrt(varY);
  if (sx < 1e-10 || sy < 1e-10) {
    return 0.0;
  }
  return cov / (sx * sy);
}
