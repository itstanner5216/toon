// Ported from: toon/router.py
// Python line count: 119 (after stripping self-test at line 123, skipping 163 lines)
// Port verification:
//   - field_matcher_matches: all four conditions (field_path exact+prefix, field_pattern,
//     min_length, max_length) ported with identical AND logic
//   - Non-string values silently skip min_length/max_length checks (same as Python)
//   - Prefix match requires trailing "." to prevent "payload_extra" matching "payload"
//   - route_field priority chain: preserve_rules → encode_rules → default_codec → "passthrough"
//   - Global kill-switch: config.enabled=false → always "passthrough"
//   - re.search(pattern, last_segment) → new RegExp(pattern).exec(lastSegment) (no anchoring)

import type { FieldMatcher, ToonConfig } from './config.js';

// ---------------------------------------------------------------------------
//  Matcher evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether matcher accepts the given field.
 *
 * All specified (non-null) conditions are AND-ed. A matcher whose
 * every attribute is null matches unconditionally.
 *
 * @param matcher   - The predicate to test.
 * @param fieldPath - Dot-delimited path to the field, e.g. "payload.output".
 * @param value     - The runtime value stored at fieldPath.
 * @returns true if all specified conditions pass.
 */
export function fieldMatcherMatches(
  matcher: FieldMatcher,
  fieldPath: string,
  value: unknown,
): boolean {
  // field_path: exact match OR dot-prefix match
  if (matcher.field_path !== null) {
    if (fieldPath !== matcher.field_path) {
      // Prefix check: matcher "payload" should match "payload.output"
      // but NOT "payload_extra". We require the candidate to start
      // with "<matcher.field_path>." so segment boundaries are respected.
      if (!fieldPath.startsWith(matcher.field_path + ".")) {
        return false;
      }
    }
  }

  // field_pattern: regex against the last path segment
  if (matcher.field_pattern !== null) {
    const lastSegment = fieldPath.includes(".")
      ? fieldPath.slice(fieldPath.lastIndexOf(".") + 1)
      : fieldPath;
    if (!new RegExp(matcher.field_pattern).exec(lastSegment)) {
      return false;
    }
  }

  // min_length / max_length: only evaluated for str values
  if (matcher.min_length !== null) {
    if (typeof value === "string") {
      if (value.length < matcher.min_length) {
        return false;
      }
    }
    // Non-string values silently skip the length check so that
    // a min_length rule doesn't accidentally block dict/list fields.
  }

  if (matcher.max_length !== null) {
    if (typeof value === "string") {
      if (value.length > matcher.max_length) {
        return false;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
//  Route dispatch
// ---------------------------------------------------------------------------

/**
 * Determine the compression action for a field.
 *
 * Priority (highest -> lowest):
 *
 * 1. preserve_rules — if any matcher hits -> "preserve".
 * 2. encode_rules   — first match wins -> that rule's codec.strategy.
 * 3. default_codec  — if set -> its strategy.
 * 4. -> "passthrough".
 *
 * @param fieldPath - Dot-delimited path to the field.
 * @param value     - Runtime value at fieldPath.
 * @param config    - The active ToonConfig.
 * @returns Action string: one of "preserve" | "truncate" | "dedup" |
 *          "parse_json" | "drop" | "array" | "passthrough".
 */
export function routeField(
  fieldPath: string,
  value: unknown,
  config: ToonConfig,
): string {
  // 0. Global kill-switch
  if (!config.enabled) {
    return "passthrough";
  }

  // 1. Preserve rules (any match → preserve)
  for (const matcher of config.preserve_rules) {
    if (fieldMatcherMatches(matcher, fieldPath, value)) {
      return "preserve";
    }
  }

  // 2. Encode rules (first match wins)
  for (const rule of config.encode_rules) {
    if (fieldMatcherMatches(rule.matcher, fieldPath, value)) {
      return rule.codec.strategy;
    }
  }

  // 3. Default codec
  if (config.default_codec !== null) {
    return config.default_codec.strategy;
  }

  // 4. Fallback
  return "passthrough";
}
