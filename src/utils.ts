// utils.ts — math + serialization helpers for the source compression route.
//
// Pure, engine-agnostic. Nothing here scores, decides, or routes; these are the
// mechanical primitives the engines and the (forthcoming) aggregation stage call.
// The log/tool-output heritage that used to live here (value NORMALIZERS, regex
// singletons, normalizeValue, blake2bHash, flattenToText) has been removed — it
// belonged to the deleted log codecs, not to source compression.

// ---------------------------------------------------------------------------
// canonicalJson — deterministic serialization (used by estimateTokensObj)
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys at every nesting level so serialization is
 * deterministic regardless of insertion order.
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

/** Deterministic JSON serialization (sorted keys; non-serializable -> String()). */
export function canonicalJson(obj: unknown): string {
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
 * Used to detect redundancy between two engines' score curves (if two distinct
 * intelligences correlate too tightly, their agreement carries less signal).
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
