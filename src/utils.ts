import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Regex constants for value normalization
// ---------------------------------------------------------------------------

export const TIMESTAMP_RE: RegExp =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

export const UUID_RE: RegExp =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const IP_RE: RegExp = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export const BIGNUM_RE: RegExp = /\b\d{10,}\b/g;

export const B64_RE: RegExp = /\b[A-Za-z0-9+/]{20,}={0,2}\b/g;

// NOTE: JS regex with /g flag is STATEFUL — each regex in NORMALIZERS is a factory function to produce a fresh instance per call, avoiding lastIndex contamination across calls.
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
 *.
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
    return '<NUM>';
  }
  if (Array.isArray(v)) {
    return v.map((item) => normalizeValue(item));
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const sorted = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const k of sorted) {
      result[k] = normalizeValue(obj[k]);
    }
    return result;
  }
  // None / bool / other pass-through
  return v;
}

// ---------------------------------------------------------------------------
// blake2bHash
// ---------------------------------------------------------------------------

/**
 * Fast hash for dedup. Returns hex string.
 *
 * Uses blake2b512 full hash then slices to digestSize*2 hex characters.
 * This differs from a native variable-digest-size API but all comparisons
 * are internal (same process), so collision resistance is preserved.
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
 * Sorts keys recursively at every nesting level, for deterministic output.
 * json.dumps(obj, sort_keys=True, separators=(',', ':'), default=str).
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
  // Non-serializable objects are converted via String().
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
    // Non-JSON-serializable: use String()
    return String(value);
  });
}

// ---------------------------------------------------------------------------
// estimateTokens / estimateTokensObj
// ---------------------------------------------------------------------------

/**
 * Conservative token estimation. JSON: chars/2, text: chars/4.
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
  for (const v of sortedV) {
    cumulative += v;
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
 * Implements Satopää et al. 2011 (IEEE ICDCS) simplified for 1D sorted 
 * data.
 */
export function findKneedle(scores: number[], sensitivity: number = 1.0): number {
  const n = scores.length;
  if (n < 3) {
    return n - 1;
  }

  // Normalize to [0,1]. After the n < 3 guard above, scores has at least 3
  // entries, so reduce() with no initializer is safe and returns number, not
  // number | undefined.
  const sMin = scores.reduce((a, b) => Math.min(a, b));
  const sMax = scores.reduce((a, b) => Math.max(a, b));
  const sRange = sMax - sMin;
  if (sRange < 1e-10) {
    return n - 1; // flat distribution — no knee
  }

  const xNorm: number[] = [];
  const yNorm: number[] = [];
  for (const [i, score] of scores.entries()) {
    xNorm.push(i / (n - 1));
    yNorm.push((score - sMin) / sRange);
  }

  // Difference from diagonal y = 1 - x. yNorm and xNorm both have length n
  // (built from scores above), so destructuring via entries() yields defined
  // values throughout.
  const diff: number[] = [];
  for (const [i, yi] of yNorm.entries()) {
    const xi = xNorm[i];
    if (xi === undefined) {
      throw new Error('invariant: xNorm and yNorm have identical length');
    }
    diff.push(yi - (1.0 - xi));
  }

  // Find global maximum of difference curve.
  // n >= 3 guarantees diff[0] exists.
  const diff0 = diff[0];
  if (diff0 === undefined) {
    throw new Error('invariant: diff has at least 3 entries when n >= 3');
  }
  let bestIdx = 0;
  let bestVal = diff0;
  for (let i = 1; i < n - 1; i++) {
    const di = diff[i];
    if (di === undefined) continue;
    if (di > bestVal) {
      bestVal = di;
      bestIdx = i;
    }
  }

  // Walk forward: first point where diff drops below threshold
  const threshold = bestVal - sensitivity * sRange / n;
  for (let i = bestIdx + 1; i < n; i++) {
    const di = diff[i];
    if (di === undefined) continue;
    if (di < threshold) {
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
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) {
      throw new Error('invariant: x and y must have identical length');
    }
    sumX += xi;
    sumY += yi;
  }
  const mx = sumX / n;
  const my = sumY / n;

  let cov = 0.0;
  let varX = 0.0;
  let varY = 0.0;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) {
      throw new Error('invariant: x and y must have identical length');
    }
    const dx = xi - mx;
    const dy = yi - my;
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
