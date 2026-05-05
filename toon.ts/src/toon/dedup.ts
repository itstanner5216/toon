// Ported from: toon/dedup.py
// Python line count: 278
// Port verification:
//   - Tier 1 exact hash: blake2bHash(canonicalJson(entry)) with default digest_size=8
//   - Tier 2 near-dup: normalize_value for dicts, _normalize_string for strings, then hash
//   - Tier 2 dict path: schema_h = blake2bHash(canonicalJson(sorted(keys)), digest_size=4)
//   - Tier 3 template detection: 3+ entries, >30% static keys (>80% same value threshold)
//   - _compute_template_key: most_common via manual count, frequency > 0.8, len(static) > len(keys)*0.3
//   - _collapse_templates: removes middle entries (first_index < orig_idx < last_index), annotates first with __toon_template/template_count/template_first/template_last
//   - LRU eviction: OrderedDict(last=False) -> Map insertion order + shift() from front
//   - reset() clears all four state maps
//   - _detect_type: "dict"|"list"|"string"|"primitive"
//   - TemplateInfoFull re-exported as TemplateInfo (public alias per Python naming)
//   - DedupStats, DedupResult, EntryMeta re-exported from ./types.js
//   - NORMALIZERS: each entry is [() => RegExp, string] — call factory per use

import {
  blake2bHash,
  canonicalJson,
  normalizeValue,
  NORMALIZERS,
} from './utils.js';

import {
  DedupStats,
  DedupResult,
  EntryMeta,
  TemplateInfoFull,
} from './types.js';

// Re-export the types that dedup.py defines so callers import from here
export type { DedupStats, DedupResult };

/**
 * TemplateInfo as defined in dedup.py: first_content, last_content, count,
 * first_index, last_index. This is TemplateInfoFull in types.ts — we re-export
 * it under the Python name so import sites can use "TemplateInfo".
 */
export type TemplateInfo = TemplateInfoFull;

// ---------------------------------------------------------------------------
// Deduplicator
// ---------------------------------------------------------------------------

/**
 * Session-scoped three-tier deduplicator with LRU bounds.
 *
 * Implements exact -> near-dup -> template dedup in a single pass
 * over the input list. LRU eviction keeps memory bounded at maxsize
 * fingerprints (~500KB at default 5000).
 *
 * Reset triggers:
 *   - Per-turn: call deduplicate() per tool-call batch
 *   - Per-session: call reset() at session boundaries
 */
export class Deduplicator {
  readonly maxsize: number;
  private _exact_seen: Map<string, number>;
  private _content_seen: Map<string, number>;
  private _schema_groups: Map<string, number[]>;
  private _templates: Map<string, TemplateInfoFull>;

  constructor(maxsize: number = 5000) {
    this.maxsize = maxsize;
    this._exact_seen = new Map<string, number>();
    this._content_seen = new Map<string, number>();
    this._schema_groups = new Map<string, number[]>();
    this._templates = new Map<string, TemplateInfoFull>();
  }

  /**
   * Run three-tier dedup on a list of entries.
   *
   * @param entries Raw tool output entries (JSON-serializable objects).
   * @returns DedupResult with unique entries, stats, and template info.
   */
  deduplicate(entries: unknown[]): DedupResult {
    const stats: DedupStats = { exact: 0, near: 0, template: 0 };
    const unique: EntryMeta[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const entry_meta: EntryMeta = {
        content: entry,
        type: Deduplicator._detect_type(entry),
        index: i,
        template_id: null,
      };

      // Tier 1: Exact match
      const exact_h = blake2bHash(canonicalJson(entry));
      if (this._exact_seen.has(exact_h)) {
        stats.exact += 1;
        continue;
      }
      this._exact_seen.set(exact_h, i);
      this._evict(this._exact_seen);

      // Tier 2: Near-duplicate (structural normalization)
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        // isinstance(entry, dict)
        const normalized = normalizeValue(entry);
        const content_h = blake2bHash(canonicalJson(normalized));
        if (this._content_seen.has(content_h)) {
          stats.near += 1;
          continue;
        }
        this._content_seen.set(content_h, i);
        this._evict(this._content_seen);

        // Track schema groups for Tier 3
        const keys_str = canonicalJson(
          [...Object.keys(entry as Record<string, unknown>)].sort()
        );
        const schema_h = blake2bHash(keys_str, 4);
        entry_meta.template_id = schema_h;
        if (!this._schema_groups.has(schema_h)) {
          this._schema_groups.set(schema_h, []);
        }
        this._schema_groups.get(schema_h)!.push(unique.length);
      } else if (typeof entry === 'string') {
        const content_h = blake2bHash(Deduplicator._normalize_string(entry));
        if (this._content_seen.has(content_h)) {
          stats.near += 1;
          continue;
        }
        this._content_seen.set(content_h, i);
        this._evict(this._content_seen);
      }

      unique.push(entry_meta);
    }

    // Tier 3: Template-based collapsing
    const templates = this._detect_templates(unique);
    const [collapsed, template_removed] = Deduplicator._collapse_templates(
      unique,
      templates
    );
    stats.template = template_removed;

    return {
      entries: collapsed,
      dedup_stats: stats,
      templates,
    };
  }

  /** Full state reset (session boundary). */
  reset(): void {
    this._exact_seen.clear();
    this._content_seen.clear();
    this._schema_groups.clear();
    this._templates.clear();
  }

  // Private helpers

  private static _detect_type(entry: unknown): string {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      return 'dict';
    }
    if (Array.isArray(entry)) {
      return 'list';
    }
    if (typeof entry === 'string') {
      return 'string';
    }
    return 'primitive';
  }

  /** Normalize a string for near-dedup (variable field replacement). */
  private static _normalize_string(s: string): string {
    for (const [reFn, token] of NORMALIZERS) {
      s = s.replace(reFn(), token);
    }
    return s;
  }

  private _evict(cache: Map<string, number>): void {
    while (cache.size > this.maxsize) {
      // Evict oldest (first inserted) entry — Map preserves insertion order
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }
  }

  private _detect_templates(
    entries: EntryMeta[]
  ): Map<string, TemplateInfoFull> {
    /**
     * Identify template-duplicated entries within schema groups.
     *
     * A template exists when 3+ entries share the same schema_hash
     * and >30% of keys have the same value across >80% of entries.
     */
    const templates = new Map<string, TemplateInfoFull>();
    for (const [, indices] of this._schema_groups.entries()) {
      if (indices.length < 3) {
        continue;
      }
      const group: EntryMeta[] = indices
        .filter((i) => i < entries.length)
        .map((i) => entries[i]);
      if (group.length < 3) {
        continue;
      }
      const template_key = Deduplicator._compute_template_key(group);
      if (template_key !== null) {
        const first = group[0];
        const last = group[group.length - 1];
        templates.set(template_key, {
          first_content: first.content,
          last_content: last.content,
          count: group.length,
          first_index: first.index,
          last_index: last.index,
        });
      }
    }
    return templates;
  }

  private static _compute_template_key(group: EntryMeta[]): string | null {
    /**
     * Compute a template key if entries share a common structure.
     *
     * Static fields (>80% same value) must comprise >30% of keys
     * for the group to qualify as a template.
     */
    if (
      group.length === 0 ||
      typeof group[0].content !== 'object' ||
      group[0].content === null ||
      Array.isArray(group[0].content)
    ) {
      return null;
    }
    const keys = new Set<string>(
      Object.keys(group[0].content as Record<string, unknown>)
    );
    if (keys.size === 0) {
      return null;
    }
    const static_values: Record<string, string> = {};
    for (const key of keys) {
      const values: string[] = group
        .filter(
          (e) =>
            typeof e.content === 'object' &&
            e.content !== null &&
            !Array.isArray(e.content)
        )
        .map((e) =>
          String((e.content as Record<string, unknown>)[key])
        );
      if (values.length === 0) {
        continue;
      }
      // most_common = max(set(values), key=lambda v: values.count(v))
      const valueCounts = new Map<string, number>();
      for (const v of values) {
        valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
      }
      let most_common = values[0];
      let most_common_count = 0;
      for (const [v, cnt] of valueCounts.entries()) {
        if (cnt > most_common_count) {
          most_common_count = cnt;
          most_common = v;
        }
      }
      const frequency = valueCounts.get(most_common)! / values.length;
      if (frequency > 0.8) {
        static_values[key] = most_common;
      }
    }
    if (Object.keys(static_values).length > keys.size * 0.3) {
      const template_str = canonicalJson(static_values);
      return blake2bHash(template_str);
    }
    return null;
  }

  private static _collapse_templates(
    entries: EntryMeta[],
    templates: Map<string, TemplateInfoFull>
  ): [EntryMeta[], number] {
    /**
     * Collapse template-duplicate entries into single representatives.
     *
     * Keeps the first and last entry of each template group, removes
     * all middle entries. First entry is annotated with __toon_template
     * metadata so downstream compression can emit the plan-specified
     * template marker: {"__toon_template": true, "count": N,
     * "first": {...}, "last": {...}}.
     */
    if (templates.size === 0) {
      return [entries, 0];
    }

    // Build removal set (middle entries) and map first indices to
    // their TemplateInfoFull for annotation.
    const remove_originals = new Set<number>();
    const template_first_indices = new Map<number, TemplateInfoFull>();

    for (const info of templates.values()) {
      template_first_indices.set(info.first_index, info);
      for (const e of entries) {
        const orig_idx = e.index;
        if (orig_idx === info.first_index || orig_idx === info.last_index) {
          continue;
        }
        if (
          e.template_id !== null &&
          e.template_id !== undefined &&
          info.first_index < orig_idx &&
          orig_idx < info.last_index
        ) {
          remove_originals.add(orig_idx);
        }
      }
    }

    const collapsed: EntryMeta[] = [];
    for (const e of entries) {
      if (remove_originals.has(e.index)) {
        continue;
      }
      // Annotate first entry of each template group
      if (template_first_indices.has(e.index)) {
        const info = template_first_indices.get(e.index)!;
        e.__toon_template = true;
        e.template_count = info.count;
        e.template_first = info.first_content;
        e.template_last = info.last_content;
      }
      collapsed.push(e);
    }

    return [collapsed, remove_originals.size];
  }
}
