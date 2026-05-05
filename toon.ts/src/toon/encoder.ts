// Ported from: toon/encoder.py
// Python line count: 132
// Port verification:
//   - encodeOutput: threshold <= 0 raises error with identical message format
//   - encodeRecursive: null → null; list > threshold → {__toon: true, count, sample:[first 3]}
//   - encodeRecursive: list <= threshold → recursively encoded items
//   - encodeRecursive: dict → all values recursively encoded, keys preserved
//   - encodeRecursive: tuple (no native TS tuples) treated as list — handled at call site
//   - encodeRecursive: primitives (string, number, boolean) returned unchanged
//   - __toon metadata format: { __toon: true, count: N, sample: [...] } matches Python exactly
//   - compress re-exported from ./pipeline.js (intentional forward reference for Wave 3)

// Re-export: available after pipeline.ts is created in Wave 3
export { compress } from './pipeline.js';

// ---------------------------------------------------------------------------
// Original API — preserved exactly
// ---------------------------------------------------------------------------

/**
 * Encode tool output by compressing arrays exceeding threshold.
 *
 * Arrays with length > threshold are replaced with metadata:
 * {
 *     "__toon": true,
 *     "count": N,
 *     "sample": [first 3 items]
 * }
 *
 * Non-array data and arrays <= threshold are preserved unchanged.
 * Recursively handles nested structures (dicts, lists).
 *
 * Args:
 *   result: Tool output to encode (any JSON-serializable type)
 *   threshold: Maximum array length before compression (default: 5)
 *
 * Returns:
 *   Encoded output with large arrays compressed
 *
 * Examples:
 *   encodeOutput({"files": ["a", "b", "c"]}, 5)
 *   // => {"files": ["a", "b", "c"]}  // Unchanged (length <= threshold)
 *
 *   encodeOutput({"files": ["a", "b", "c", "d", "e", "f"]}, 5)
 *   // => {"files": {"__toon": true, "count": 6, "sample": ["a", "b", "c"]}}
 *
 *   encodeOutput({"nested": {"data": [1, 2, 3, 4, 5, 6]}}, 5)
 *   // => {"nested": {"data": {"__toon": true, "count": 6, "sample": [1, 2, 3]}}}
 */
export function encodeOutput(result: unknown, threshold: number = 5): unknown {
  if (threshold <= 0) {
    throw new Error(`threshold must be > 0, got ${threshold}`);
  }
  return encodeRecursive(result, threshold);
}

// ---------------------------------------------------------------------------
// Internal recursive encoder
// ---------------------------------------------------------------------------

/**
 * Recursively encode a value, compressing arrays > threshold.
 *
 * Args:
 *   value: Value to encode
 *   threshold: Array length threshold
 *
 * Returns:
 *   Encoded value
 */
export function encodeRecursive(value: unknown, threshold: number): unknown {
  // Handle null (Python: None → None)
  if (value === null) {
    return null;
  }

  // Handle lists/arrays
  if (Array.isArray(value)) {
    if (value.length > threshold) {
      // Compress to TOON metadata
      return {
        __toon: true,
        count: value.length,
        sample: value.slice(0, 3).map((item) => encodeRecursive(item, threshold)),
      };
    }
    // Preserve array, but recursively encode items
    return value.map((item) => encodeRecursive(item, threshold));
  }

  // Handle dictionaries / objects
  // Note: check after Array.isArray to correctly distinguish arrays from objects
  if (typeof value === 'object') {
    // value is non-null, non-array object at this point (null handled above)
    // Runtime check: typeof 'object' and not array — safe to treat as Record
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      result[key] = encodeRecursive(obj[key], threshold);
    }
    return result;
  }

  // Primitive types (string, number, boolean, undefined) — return unchanged
  // Python: str, int, float, bool → return value unchanged
  return value;
}
