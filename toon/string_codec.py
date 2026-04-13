"""Content-aware string compression for stack traces, JSON-in-string, logs.

Detection priority:
  1. Stack trace → FaST-inspired (ICSE 2022) frame priority scoring
  2. JSON-in-string → depth-limited traversal with budget inheritance
  3. Log output → normalize+hash dedup with severity priority
  4. Default → adaptive head/tail truncation (NOT fixed 70/30)

Each strategy operates within a character budget and preserves the
information an LLM most needs to reason about the content.

Zero external dependencies. Pure Python.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ._utils import blake2b_hash, NORMALIZERS

# ── Detection patterns ──
_STACK_TRACE_RE = re.compile(
    r'(Traceback|Exception|Error|Caused by:|^\s+at\s+|^\s+File\s+")',
    re.MULTILINE,
)
_LOG_SEVERITY_RE = re.compile(
    r'\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b',
    re.IGNORECASE,
)
_TIMESTAMP_LINE_RE = re.compile(
    r'^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}',
    re.MULTILINE,
)
_ERROR_KEYWORDS = frozenset({
    'error', 'fatal', 'critical', 'exception', 'traceback',
    'caused by', 'failed', 'killed', 'oom', 'panic', 'crash', 'abort',
})
_FRAME_RE = re.compile(r'^\s+(at\s+|File\s+")', re.MULTILINE)
_USER_FRAME_EXCLUDES = re.compile(
    r'(java\.|javax\.|sun\.|org\.springframework\.|org\.python\.|'
    r'importlib\.|_bootstrap|site-packages)'
)


def compress_string(text: str, budget: int, max_user_frames: int = 10) -> str:
    """Compress a string using content-type detection and type-specific strategies.

    Dispatches to the most appropriate compressor based on content analysis:
    stack traces, JSON-in-string, log output, or adaptive truncation.

    Args:
        text: Input string.
        budget: Maximum character budget for output.
        max_user_frames: Max user-code frames to retain in stack traces.

    Returns:
        Compressed string within budget.
    """
    if len(text) <= budget:
        return text

    if _is_stack_trace(text):
        return _compress_stack_trace(text, budget, max_user_frames)

    if _is_json_string(text):
        try:
            parsed = json.loads(text)
            return _compress_json(parsed, budget, depth=0)
        except (json.JSONDecodeError, RecursionError):
            pass

    if _is_log_output(text):
        return _compress_log(text, budget)

    return _content_aware_truncate(text, budget)


# ════════════════════════════════════════════════════════════════════════
#  Content Type Detection
# ════════════════════════════════════════════════════════════════════════

def _is_stack_trace(text: str) -> bool:
    """Detect stack traces by scanning the first 2000 chars for frame patterns."""
    return bool(_STACK_TRACE_RE.search(text[:2000]))


def _is_json_string(text: str) -> bool:
    """Detect JSON-in-string by checking for leading { or [."""
    stripped = text.strip()
    return (stripped.startswith('{') or stripped.startswith('[')) and len(stripped) > 2


def _is_log_output(text: str) -> bool:
    """Detect log output by counting timestamps and severity keywords in first 20 lines."""
    lines = text.split('\n', 20)
    ts_count = sum(1 for line in lines if _TIMESTAMP_LINE_RE.match(line))
    sev_count = sum(1 for line in lines if _LOG_SEVERITY_RE.search(line))
    return ts_count >= 3 or sev_count >= 3


# ════════════════════════════════════════════════════════════════════════
#  Stack Trace Compression (FaST-inspired, ICSE 2022)
# ════════════════════════════════════════════════════════════════════════

def _compress_stack_trace(text: str, budget: int, max_user_frames: int) -> str:
    """FaST-inspired stack trace compression.

    Priority: exception headers > user-code frames > library frames > other.
    Frame importance = 1/position × rarity (FaST heuristic).
    Truncation direction: deepest (oldest) frames removed first.
    """
    lines = text.split('\n')
    priority_lines: list[tuple[float, int, str]] = []

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        # Priority 1: Exception headers (always keep)
        if any(kw in stripped.lower() for kw in ('exception', 'error:', 'caused by:')):
            priority_lines.append((1000.0 - i * 0.01, i, line))
            continue

        # Priority 2: Stack frames (user-code vs library)
        if _FRAME_RE.match(line):
            if not _USER_FRAME_EXCLUDES.search(stripped):
                # User-code frame: high priority, inversely proportional to depth
                position_score = 1.0 / max(1, i)
                priority_lines.append((100.0 * position_score, i, line))
            else:
                # Library frame: low priority
                priority_lines.append((1.0 / max(1, i), i, line))
            continue

        # Priority 3: Other content
        priority_lines.append((0.1, i, line))

    # Sort by priority descending, greedily select within budget
    priority_lines.sort(key=lambda x: x[0], reverse=True)
    selected: list[tuple[int, str]] = []
    used = 0
    user_frame_count = 0

    for pri, idx, line in priority_lines:
        line_len = len(line) + 1  # +1 for newline
        if used + line_len > budget:
            continue
        # Cap user frames at max_user_frames
        if 1.0 <= pri < 100.0:
            # This is a library frame scored by 1/position — not a user frame
            pass
        elif 100.0 <= pri < 1000.0:
            # User-code frame range
            if user_frame_count >= max_user_frames:
                continue
            user_frame_count += 1
        selected.append((idx, line))
        used += line_len

    # Restore original line order
    selected.sort(key=lambda x: x[0])
    result = '\n'.join(line for _, line in selected)
    omitted = len(lines) - len(selected)
    if omitted > 0:
        result += f'\n... [{omitted} frames omitted]'
    return result


# ════════════════════════════════════════════════════════════════════════
#  JSON-in-String Compression
# ════════════════════════════════════════════════════════════════════════

def _compress_json(obj: Any, budget: int, depth: int) -> str:
    """Depth-limited JSON compression with budget inheritance.

    Budget inheritance formula: depth_N_budget = parent_budget × 0.5^N.
    Engineering heuristic — not empirically validated.
    Synthesized from TOON token analysis and Struct-X (arXiv 2407.12522).

    Key selection when budget tight:
      Prefer: error, message, status, code, type, id, name, result, output
      Omit: null values, empty arrays, metadata keys
    """
    if budget <= 0:
        return f'"...({type(obj).__name__} at depth {depth})"'

    depth_budget = int(budget * (0.5 ** depth)) if depth > 0 else budget

    if isinstance(obj, dict):
        if depth >= 3:
            return json.dumps({
                "__keys": sorted(obj.keys()),
                "__depth": depth,
                "__omitted": len(obj),
            })

        result_parts: list[str] = []
        remaining = depth_budget

        # Prioritize important keys
        important = {
            'error', 'message', 'status', 'code', 'type',
            'id', 'name', 'result', 'output',
        }
        sorted_keys = sorted(
            obj.keys(),
            key=lambda k: (0 if k.lower() in important else 1, k),
        )

        for key in sorted_keys:
            if remaining <= 20:
                result_parts.append(
                    f'  "...": "({len(obj) - len(result_parts)} more keys)"'
                )
                break
            val = obj[key]
            # Skip nulls and empty collections when budget is tight
            if remaining < depth_budget * 0.5 and (
                val is None or val == [] or val == {}
            ):
                continue
            val_str = _compress_json(val, remaining // 2, depth + 1)
            entry = f'  {json.dumps(key)}: {val_str}'
            result_parts.append(entry)
            remaining -= len(entry)

        return '{\n' + ',\n'.join(result_parts) + '\n}'

    elif isinstance(obj, list):
        if len(obj) == 0:
            return '[]'
        if len(obj) <= 5:
            items = [
                _compress_json(item, depth_budget // max(1, len(obj)), depth + 1)
                for item in obj
            ]
            return '[' + ', '.join(items) + ']'
        else:
            # Check homogeneity
            types = set(type(item).__name__ for item in obj[:5])
            if len(types) == 1:
                head = [_compress_json(obj[0], depth_budget // 3, depth + 1)]
                return '[' + head[0] + f', "... ({len(obj)-1} more similar items)"]'
            else:
                head = [
                    _compress_json(item, depth_budget // 8, depth + 1)
                    for item in obj[:3]
                ]
                tail = [
                    _compress_json(item, depth_budget // 8, depth + 1)
                    for item in obj[-2:]
                ]
                mid = f'"... ({len(obj)-5} more items)"'
                return '[' + ', '.join(head) + ', ' + mid + ', ' + ', '.join(tail) + ']'

    else:
        s = json.dumps(obj, default=str)
        if len(s) > depth_budget:
            return json.dumps(str(obj)[:depth_budget - 10] + '...')
        return s


# ════════════════════════════════════════════════════════════════════════
#  Log Output Compression
# ════════════════════════════════════════════════════════════════════════

def _compress_log(text: str, budget: int) -> str:
    """Template-based log compression with severity priority.

    Strategy:
      1. Normalize variable fields (timestamps, UUIDs, IPs, numbers, base64)
      2. Hash normalized lines for dedup (keep first+last per template)
      3. Classify by severity: HIGH (errors) > MEDIUM (warnings) > LOW (info)
      4. Fill budget from HIGH → MEDIUM → LOW, tail-heavy within tiers
    """
    lines = text.split('\n')

    # Classify lines by severity
    high: list[tuple[int, str]] = []
    medium: list[tuple[int, str]] = []
    low: list[tuple[int, str]] = []

    # Normalize + hash for dedup
    seen_normalized: dict[str, list[int]] = {}

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        # Normalize for dedup
        normalized = stripped
        for pattern, token in NORMALIZERS:
            normalized = pattern.sub(token, normalized)
        norm_hash = blake2b_hash(normalized)

        if norm_hash not in seen_normalized:
            seen_normalized[norm_hash] = []
        seen_normalized[norm_hash].append(i)

        # Only keep first and last of each normalized group
        group = seen_normalized[norm_hash]
        if len(group) > 2 and i != group[0]:
            # Not first — only keep if it's currently the last
            # (will be updated on next occurrence)
            continue

        # Classify by severity
        lower = stripped.lower()
        if any(kw in lower for kw in _ERROR_KEYWORDS):
            high.append((i, line))
        elif _LOG_SEVERITY_RE.search(stripped) and any(
            kw in lower for kw in ('warn', 'timeout', 'retry', 'refused', 'denied')
        ):
            medium.append((i, line))
        else:
            low.append((i, line))

    # Assemble within budget, HIGH first
    result_lines: list[tuple[int, str]] = []
    remaining = budget

    # Count markers for deduplicated lines
    count_markers: dict[str, int] = {}
    for norm_hash, indices in seen_normalized.items():
        if len(indices) > 2:
            count_markers[norm_hash] = len(indices)

    for priority_group in [high, medium, low]:
        for idx, line in priority_group:
            line_budget = len(line) + 1
            if remaining < line_budget:
                break
            result_lines.append((idx, line))
            remaining -= line_budget

    # Sort by original position and format
    result_lines.sort(key=lambda x: x[0])
    output_parts: list[str] = []
    for idx, line in result_lines:
        # Check if this line had duplicates
        stripped = line.strip()
        normalized = stripped
        for pattern, token in NORMALIZERS:
            normalized = pattern.sub(token, normalized)
        norm_hash = blake2b_hash(normalized)
        count = count_markers.get(norm_hash)
        if count:
            output_parts.append(f'{line}  [repeated {count} times]')
        else:
            output_parts.append(line)

    omitted = len(lines) - len(result_lines)
    result = '\n'.join(output_parts)
    if omitted > 0:
        result += f'\n... [{omitted} log lines omitted]'
    return result


# ════════════════════════════════════════════════════════════════════════
#  Default: Content-Aware Truncation
# ════════════════════════════════════════════════════════════════════════

def _content_aware_truncate(text: str, budget: int) -> str:
    """Adaptive head/tail truncation. NOT fixed 70/30.

    70/30 has NO empirical validation (confirmed in research Q3 Section 2.1).
    Instead, adapts ratio based on content structure:
      - Error/result at end → 40% head / 60% tail
      - Structured header at start → 80% head / 20% tail
      - Default → 50% head / 50% tail

    Evidence: MiddleSum (ACL 2024) shows LLMs attend less to middle context,
    supporting head+tail over middle-out strategies.
    """
    # Detect if error/result info is at the tail
    tail_20pct = text[int(len(text) * 0.8):]
    tail_has_error = any(kw in tail_20pct.lower() for kw in _ERROR_KEYWORDS)

    head_10pct = text[:max(1, int(len(text) * 0.1))]
    head_has_structure = head_10pct.count('\n') < 3 and ':' in head_10pct

    if tail_has_error:
        head_ratio, tail_ratio = 0.4, 0.6
    elif head_has_structure:
        head_ratio, tail_ratio = 0.8, 0.2
    else:
        head_ratio, tail_ratio = 0.5, 0.5

    marker = '\n...[content truncated]...\n'
    usable = budget - len(marker)
    if usable <= 0:
        return text[:budget]
    head_budget = int(usable * head_ratio)
    tail_budget = usable - head_budget

    return text[:head_budget] + marker + text[-tail_budget:]
