"""Three-tier deduplication: exact, near-duplicate, template-based.

Tier 1 — Exact: blake2b(canonical_json(entry), digest_size=8) → 64-bit hash.
Tier 2 — Near-duplicate: normalize variable fields (timestamps, UUIDs, IPs,
         large numbers, base64) then hash the normalized form.
         Dual fingerprint: schema_hash (keys only) + content_hash (values).
Tier 3 — Template: for entries sharing the same schema, detect >80% static
         fields and collapse groups of 3+ into first+last with count markers.

All tiers are LRU-bounded (maxsize=5000, ~500KB memory) and session-scoped.

Zero external dependencies. Pure Python.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from ._utils import blake2b_hash, canonical_json, normalize_value, NORMALIZERS


@dataclass
class TemplateInfo:
    """Tracks template-deduplicated entries."""
    first_content: Any
    last_content: Any
    count: int
    first_index: int
    last_index: int


@dataclass
class DedupStats:
    """Statistics from dedup pass."""
    exact: int = 0
    near: int = 0
    template: int = 0

    @property
    def total_removed(self) -> int:
        return self.exact + self.near + self.template


@dataclass
class DedupResult:
    """Output of the dedup stage.

    entries: unique entries with metadata —
        [{\"content\": Any, \"type\": str, \"index\": int, \"template_id\": str | None}, ...]
    dedup_stats: counts of exact/near/template duplicates removed
    templates: template_hash → TemplateInfo for template-collapsed groups
    """
    entries: list[dict]
    dedup_stats: DedupStats
    templates: dict[str, TemplateInfo]


class Deduplicator:
    """Session-scoped three-tier deduplicator with LRU bounds.

    Implements exact → near-dup → template dedup in a single pass
    over the input list. LRU eviction keeps memory bounded at maxsize
    fingerprints (~500KB at default 5000).

    Reset triggers:
      - Per-turn: call deduplicate() per tool-call batch
      - Per-session: call reset() at session boundaries
    """

    def __init__(self, maxsize: int = 5000):
        self.maxsize = maxsize
        self._exact_seen: OrderedDict[str, int] = OrderedDict()
        self._content_seen: OrderedDict[str, int] = OrderedDict()
        self._schema_groups: dict[str, list[int]] = {}
        self._templates: dict[str, TemplateInfo] = {}

    def deduplicate(self, entries: list[Any]) -> DedupResult:
        """Run three-tier dedup on a list of entries.

        Args:
            entries: Raw tool output entries (JSON-serializable objects).

        Returns:
            DedupResult with unique entries, stats, and template info.
        """
        stats = DedupStats()
        unique: list[dict] = []

        for i, entry in enumerate(entries):
            entry_meta: dict[str, Any] = {
                "content": entry,
                "type": self._detect_type(entry),
                "index": i,
                "template_id": None,
            }

            # ── Tier 1: Exact match ──
            exact_h = blake2b_hash(canonical_json(entry))
            if exact_h in self._exact_seen:
                stats.exact += 1
                continue
            self._exact_seen[exact_h] = i
            self._evict(self._exact_seen)

            # ── Tier 2: Near-duplicate (structural normalization) ──
            if isinstance(entry, dict):
                normalized = normalize_value(entry)
                content_h = blake2b_hash(canonical_json(normalized))
                if content_h in self._content_seen:
                    stats.near += 1
                    continue
                self._content_seen[content_h] = i
                self._evict(self._content_seen)

                # Track schema groups for Tier 3
                keys_str = canonical_json(sorted(entry.keys()))
                schema_h = blake2b_hash(keys_str, digest_size=4)
                entry_meta["template_id"] = schema_h
                if schema_h not in self._schema_groups:
                    self._schema_groups[schema_h] = []
                self._schema_groups[schema_h].append(len(unique))

            elif isinstance(entry, str):
                content_h = blake2b_hash(self._normalize_string(entry))
                if content_h in self._content_seen:
                    stats.near += 1
                    continue
                self._content_seen[content_h] = i
                self._evict(self._content_seen)

            unique.append(entry_meta)

        # ── Tier 3: Template-based collapsing ──
        templates = self._detect_templates(unique)
        collapsed, template_removed = self._collapse_templates(unique, templates)
        stats.template = template_removed

        return DedupResult(
            entries=collapsed,
            dedup_stats=stats,
            templates=templates,
        )

    def reset(self):
        """Full state reset (session boundary)."""
        self._exact_seen.clear()
        self._content_seen.clear()
        self._schema_groups.clear()
        self._templates.clear()

    # ── Private helpers ──

    @staticmethod
    def _detect_type(entry: Any) -> str:
        if isinstance(entry, dict):
            return "dict"
        if isinstance(entry, (list, tuple)):
            return "list"
        if isinstance(entry, str):
            return "string"
        return "primitive"

    @staticmethod
    def _normalize_string(s: str) -> str:
        """Normalize a string for near-dedup (variable field replacement)."""
        for pattern, token in NORMALIZERS:
            s = pattern.sub(token, s)
        return s

    def _evict(self, cache: OrderedDict) -> None:
        while len(cache) > self.maxsize:
            cache.popitem(last=False)

    def _detect_templates(self, entries: list[dict]) -> dict[str, TemplateInfo]:
        """Identify template-duplicated entries within schema groups.

        A template exists when 3+ entries share the same schema_hash
        and >30% of keys have the same value across >80% of entries.
        """
        templates: dict[str, TemplateInfo] = {}
        for schema_h, indices in self._schema_groups.items():
            if len(indices) < 3:
                continue
            group = [entries[i] for i in indices if i < len(entries)]
            if len(group) < 3:
                continue
            template_key = self._compute_template_key(group)
            if template_key:
                first = group[0]
                last = group[-1]
                templates[template_key] = TemplateInfo(
                    first_content=first["content"],
                    last_content=last["content"],
                    count=len(group),
                    first_index=first["index"],
                    last_index=last["index"],
                )
        return templates

    @staticmethod
    def _compute_template_key(group: list[dict]) -> str | None:
        """Compute a template key if entries share a common structure.

        Static fields (>80% same value) must comprise >30% of keys
        for the group to qualify as a template.
        """
        if not group or not isinstance(group[0]["content"], dict):
            return None
        keys = set(group[0]["content"].keys())
        if not keys:
            return None
        static_values: dict[str, Any] = {}
        for key in keys:
            values = [
                str(e["content"].get(key))
                for e in group
                if isinstance(e["content"], dict)
            ]
            if not values:
                continue
            most_common = max(set(values), key=lambda v: values.count(v))
            frequency = values.count(most_common) / len(values)
            if frequency > 0.8:
                static_values[key] = most_common
        if len(static_values) > len(keys) * 0.3:
            template_str = canonical_json(static_values)
            return blake2b_hash(template_str)
        return None

    @staticmethod
    def _collapse_templates(
        entries: list[dict],
        templates: dict[str, TemplateInfo],
    ) -> tuple[list[dict], int]:
        """Collapse template-duplicate entries into single representatives.

        Keeps the first and last entry of each template group, removes
        all middle entries. First entry is annotated with __toon_template
        metadata so downstream compression can emit the plan-specified
        template marker: {"__toon_template": true, "count": N,
        "first": {...}, "last": {...}}.
        """
        if not templates:
            return entries, 0

        # Build removal set (middle entries) and map first indices to
        # their TemplateInfo for annotation.
        remove_originals: set[int] = set()
        template_first_indices: dict[int, TemplateInfo] = {}

        for info in templates.values():
            template_first_indices[info.first_index] = info
            for e in entries:
                orig_idx = e["index"]
                if orig_idx == info.first_index or orig_idx == info.last_index:
                    continue
                if (
                    e.get("template_id")
                    and info.first_index < orig_idx < info.last_index
                ):
                    remove_originals.add(orig_idx)

        collapsed = []
        for e in entries:
            if e["index"] in remove_originals:
                continue
            # Annotate first entry of each template group
            if e["index"] in template_first_indices:
                info = template_first_indices[e["index"]]
                e["__toon_template"] = True
                e["template_count"] = info.count
                e["template_first"] = info.first_content
                e["template_last"] = info.last_content
            collapsed.append(e)

        return collapsed, len(remove_originals)
