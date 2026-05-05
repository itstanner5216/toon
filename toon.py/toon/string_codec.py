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

from ._utils import NORMALIZERS, blake2b_hash

# Detection patterns
_STACK_TRACE_RE = re.compile(
    r'(Traceback|Exception|Error|Caused by:|^\s+at\s+|^\s+File\s+")',
    re.MULTILINE,
)
_LOG_SEVERITY_RE = re.compile(
    r"\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b",
    re.IGNORECASE,
)
_TIMESTAMP_LINE_RE = re.compile(
    r"^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}",
    re.MULTILINE,
)
_ERROR_KEYWORDS = frozenset(
    {
        "error",
        "fatal",
        "critical",
        "exception",
        "traceback",
        "caused by",
        "failed",
        "killed",
        "oom",
        "panic",
        "crash",
        "abort",
    }
)
_FRAME_RE = re.compile(r'^\s+(at\s+|File\s+")', re.MULTILINE)
_USER_FRAME_EXCLUDES = re.compile(
    r"(java\.|javax\.|sun\.|org\.springframework\.|org\.python\.|"
    r"importlib\.|_bootstrap|site-packages)"
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

    # Source code check runs first — import/def patterns are unambiguous structural
    # signals and prevent false-positive stack-trace or log detection on
    # source files.
    if _is_source_code(text):
        return _compress_source_code(text, budget)

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


#  Content Type Detection


def _is_stack_trace(text: str) -> bool:
    """Detect stack traces by scanning the first 2000 chars for frame patterns."""
    return bool(_STACK_TRACE_RE.search(text[:2000]))


def _is_json_string(text: str) -> bool:
    """Detect JSON-in-string by checking for leading { or [."""
    stripped = text.strip()
    return (stripped.startswith("{") or stripped.startswith(
        "[")) and len(stripped) > 2


def _is_log_output(text: str) -> bool:
    """Detect log output by counting timestamps and severity keywords in first 20 lines."""
    lines = text.split("\n", 20)
    ts_count = sum(1 for line in lines if _TIMESTAMP_LINE_RE.match(line))
    sev_count = sum(1 for line in lines if _LOG_SEVERITY_RE.search(line))
    return ts_count >= 3 or sev_count >= 3


#  Stack Trace Compression (FaST-inspired, ICSE 2022)


def _compress_stack_trace(text: str, budget: int, max_user_frames: int) -> str:
    """FaST-inspired stack trace compression.

    Priority: exception headers > user-code frames > library frames > other.
    Frame importance = 1/position × rarity (FaST heuristic).
    Truncation direction: deepest (oldest) frames removed first.
    """
    lines = text.split("\n")
    priority_lines: list[tuple[float, int, str]] = []

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        # Priority 1: Exception headers (always keep)
        if any(kw in stripped.lower()
               for kw in ("exception", "error:", "caused by:")):
            priority_lines.append((1000.0 - i * 0.01, i, line))
            continue

        # Priority 2: Stack frames (user-code vs library)
        if _FRAME_RE.match(line):
            if not _USER_FRAME_EXCLUDES.search(stripped):
                # User-code frame: high priority, inversely proportional to
                # depth
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
    result = "\n".join(line for _, line in selected)
    omitted = len(lines) - len(selected)
    if omitted > 0:
        result += f"\n... [{omitted} frames omitted]"
    return result


#  JSON-in-String Compression


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

    depth_budget = int(budget * (0.5**depth)) if depth > 0 else budget

    if isinstance(obj, dict):
        if depth >= 3:
            return json.dumps(
                {
                    "__keys": sorted(obj.keys()),
                    "__depth": depth,
                    "__omitted": len(obj),
                }
            )

        result_parts: list[str] = []
        remaining = depth_budget

        # Prioritize important keys
        important = {
            "error",
            "message",
            "status",
            "code",
            "type",
            "id",
            "name",
            "result",
            "output",
        }
        sorted_keys = sorted(
            obj.keys(),
            key=lambda k: (0 if k.lower() in important else 1, k),
        )

        for key in sorted_keys:
            if remaining <= 20:
                result_parts.append(
                    f'  "...": "({len(obj) - len(result_parts)} more keys)"')
                break
            val = obj[key]
            # Skip nulls and empty collections when budget is tight
            if remaining < depth_budget * \
                    0.5 and (val is None or val == [] or val == {}):
                continue
            val_str = _compress_json(val, remaining // 2, depth + 1)
            entry = f"  {json.dumps(key)}: {val_str}"
            result_parts.append(entry)
            remaining -= len(entry)

        return "{\n" + ",\n".join(result_parts) + "\n}"

    elif isinstance(obj, list):
        if len(obj) == 0:
            return "[]"
        if len(obj) <= 5:
            items = [
                _compress_json(item, depth_budget // max(1, len(obj)), depth + 1)
                for item in obj
            ]
            return "[" + ", ".join(items) + "]"
        else:
            # Check homogeneity
            types = {type(item).__name__ for item in obj[:5]}
            if len(types) == 1:
                head = [_compress_json(obj[0], depth_budget // 3, depth + 1)]
                return "[" + head[0] + \
                    f', "... ({len(obj) - 1} more similar items)"]'
            else:
                head = [_compress_json(
                    item, depth_budget // 8, depth + 1) for item in obj[:3]]
                tail = [_compress_json(
                    item, depth_budget // 8, depth + 1) for item in obj[-2:]]
                mid = f'"... ({len(obj) - 5} more items)"'
                return "[" + ", ".join(head) + ", " + \
                    mid + ", " + ", ".join(tail) + "]"

    else:
        s = json.dumps(obj, default=str)
        if len(s) > depth_budget:
            return json.dumps(str(obj)[: depth_budget - 10] + "...")
        return s


#  Log Output Compression


def _compress_log(text: str, budget: int) -> str:
    """Template-based log compression with severity priority.

    Strategy:
      1. Normalize variable fields (timestamps, UUIDs, IPs, numbers, base64)
      2. Hash normalized lines for dedup (keep first+last per template)
      3. Classify by severity: HIGH (errors) > MEDIUM (warnings) > LOW (info)
      4. Fill budget from HIGH → MEDIUM → LOW, tail-heavy within tiers
    """
    lines = text.split("\n")

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
            kw in lower for kw in ("warn", "timeout", "retry", "refused", "denied")
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
            output_parts.append(f"{line}  [repeated {count} times]")
        else:
            output_parts.append(line)

    omitted = len(lines) - len(result_lines)
    result = "\n".join(output_parts)
    if omitted > 0:
        result += f"\n... [{omitted} log lines omitted]"
    return result


#  Source Code Compression

# Names that signal "this is the entry point you came to read"
_ENTRY_POINT_NAMES = frozenset(
    {
        "__init__",
        "__call__",
        "__enter__",
        "__exit__",
        "__aenter__",
        "__aexit__",
        "__str__",
        "__repr__",
        "__len__",
        "__iter__",
        "__next__",
        "__getitem__",
        "__setitem__",
        "__contains__",
        "main",
        "run",
        "start",
        "stop",
        "close",
        "open",
        "setup",
        "teardown",
        "reset",
        "compress",
        "decompress",
        "encode",
        "decode",
        "search",
        "query",
        "find",
        "get",
        "fetch",
        "build",
        "build_index",
        "index",
        "add",
        "remove",
        "update",
        "delete",
        "handle",
        "on_call_tool",
        "execute",
        "process",
        "dispatch",
        "call",
        "invoke",
        "create",
        "insert",
        "save",
        "load",
        "read",
        "write",
        "connect",
        "disconnect",
        "send",
        "receive",
        "listen",
        "validate",
        "parse",
        "serialize",
        "deserialize",
        "from_dict",
        "to_dict",
        "feed",
        "transform",
        "apply",
        "fit",
        "predict",
        "register",
        "unregister",
        "subscribe",
        "unsubscribe",
        "allocate",
        "score",
        "rank",
        "deduplicate",
    }
)

# Dunder methods that behave like public entry points
_DUNDER_KEEPERS = frozenset(
    {
        "__init__",
        "__call__",
        "__enter__",
        "__exit__",
        "__aenter__",
        "__aexit__",
        "__str__",
        "__repr__",
        "__len__",
        "__iter__",
        "__next__",
        "__getitem__",
        "__setitem__",
        "__contains__",
    }
)

# Matches the start of a function/class/method definition (applied to
# stripped line)
_DEF_RE = re.compile(
    r"^(?:(?:async\s+)?def\s+(\w+)"  # Python def
    r"|class\s+(\w+)"  # Python class
    r"|(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)"  # JS/TS function
    r"|(?:export\s+)?class\s+(\w+)"  # JS/TS class
    r"|(?:export\s+)?(?:interface|type|enum)\s+(\w+)"  # TS interface/type/enum
    # arrow/fn expr
    r"|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\()"
    r")"
)

_SOURCE_IMPORT_RE = re.compile(
    r"^\s*(?:from\s+\S|\bimport\s|\brequire\(|export\s*\{)",
)

_DECORATOR_RE = re.compile(r"^\s*@\w+")
_DOC_TAG_RE = re.compile(
    r"^\s*(?:\*\s*)?@(?:param|returns?|type|template|typedef|property|throws?)\b"
)
_MIN_OMISSION_THRESHOLD = 3


def _is_comment_only_line(line: str) -> bool:
    stripped = line.strip()
    return not stripped or stripped.startswith(
        ("/*", "/**", "*/", "*", "//", "#"))


def _strip_doc_blocks_before_blocks(
    lines: list[str], top_level_lines: list[int], structure: list[dict]
) -> list[int]:
    """Drop JSDoc-style parameter blocks that sit immediately above a definition.

    Tree-sitter block ranges begin at the function/class definition line, so
    doc comments above that line otherwise look like top-level content and get
    preserved too aggressively.
    """
    top_level_set = set(top_level_lines)
    remove = set()

    for block in structure:
        scan = block["startLine"] - 1
        span: list[int] = []
        has_doc_tags = False

        while scan >= 0 and scan in top_level_set and _is_comment_only_line(
                lines[scan]):
            span.append(scan)
            if _DOC_TAG_RE.search(lines[scan]):
                has_doc_tags = True
            scan -= 1

        if has_doc_tags:
            remove.update(span)

    return [idx for idx in top_level_lines if idx not in remove]


def _is_source_code(text: str) -> bool:
    """Detect Python or JS/TS source by keyword density in first 50 lines."""
    score = 0
    for line in text.split("\n", 50):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith(("import ", "from ")):
            score += 2
        elif _DEF_RE.match(s):
            score += 3
        elif s.startswith(("export ", "require(")):
            score += 2
        elif s.startswith(("const ", "let ", "var ")) or s.startswith(('"""', "'''")):
            score += 1
    return score >= 5


def _compress_source_code(text: str, budget: int) -> str:
    """Structure-aware source code compression.

    Priority order:
      1. Module-level docstring — capped to 5 lines max.
      2. Always keep: imports, top-level constants, decorator lines,
         def/class signature lines, first docstring line per function.
      3. Remaining budget → function bodies ranked by priority:
         entry-point names (300) > public functions (200) > private helpers (100).
         Bodies truncated from the inside with clean '# ... [N lines omitted]' markers.
    """
    lines = text.split("\n")
    n = len(lines)

    # Find and cap module-level docstring
    i = 0
    while i < n and not lines[i].strip():
        i += 1

    mod_doc_indices: list[int] = []
    MOD_DOC_CAP = 5
    if i < n:
        s = lines[i].strip()
        if s.startswith(('"""', "'''")):
            marker = s[:3]
            mod_doc_indices.append(i)
            if not (s.count(marker) >= 2 and len(s) > 3):  # multi-line
                j = i + 1
                while j < n:
                    mod_doc_indices.append(j)
                    if lines[j].strip().endswith(marker) and j > i:
                        break
                    j += 1

    mod_doc_set = set(mod_doc_indices)
    mod_doc_keep = mod_doc_indices[:MOD_DOC_CAP]
    mod_doc_omitted = len(mod_doc_indices) - len(mod_doc_keep)

    # Parse lines into anchor groups
    # Each def/class/function starts an anchor_group. Lines between groups
    # (imports, constants, logger setup) are always included.
    always_lines: list[int] = []  # imports + top-level code
    anchor_groups: list[dict] = []
    pending_decorators: list[int] = []
    current_group: dict | None = None

    for i, line in enumerate(lines):
        if i in mod_doc_set:
            continue
        stripped = line.strip()

        if not stripped:
            if current_group is not None:
                current_group["body_lines"].append(i)
            continue

        if _SOURCE_IMPORT_RE.match(line):
            always_lines.append(i)
            current_group = None
            pending_decorators = []
            continue

        if _DECORATOR_RE.match(line):
            pending_decorators.append(i)
            continue

        m = _DEF_RE.match(stripped)
        if m:
            name = next((g for g in m.groups() if g), "")
            indent = len(line) - len(line.lstrip())
            is_dunder = name in _DUNDER_KEEPERS
            is_private = name.startswith("_") and not is_dunder
            is_entry = name.lower() in _ENTRY_POINT_NAMES
            priority = (
                300 if is_entry else 200 if not is_private else 100) - indent * 0.5

            current_group = {
                "sig_line": i,
                "decorator_lines": list(pending_decorators),
                "name": name,
                "priority": priority,
                "body_lines": [],
            }
            anchor_groups.append(current_group)
            pending_decorators = []
            continue

        if current_group is not None:
            current_group["body_lines"].append(i)
        else:
            # Top-level code outside any def (constants, logger = ..., etc.)
            if pending_decorators:
                always_lines.extend(pending_decorators)
                pending_decorators = []
            always_lines.append(i)

    # Build mandatory set
    mandatory: set[int] = set(mod_doc_keep)
    mandatory.update(always_lines)
    for g in anchor_groups:
        mandatory.add(g["sig_line"])
        mandatory.update(g["decorator_lines"])
        # First non-blank body line if it looks like a docstring
        for li in g["body_lines"]:
            if not lines[li].strip():
                continue
            if lines[li].strip().startswith(('"""', "'''", "//", "/*", "*")):
                mandatory.add(li)
            break  # only check the very first non-blank body line

    def lc(idx: int) -> int:
        return len(lines[idx]) + 1

    mandatory_chars = sum(lc(i) for i in mandatory)
    if mod_doc_omitted:
        mandatory_chars += 50
    remaining = max(0, budget - mandatory_chars)

    # Fill bodies by priority
    included_body: set[int] = set()
    MARKER_COST = 45  # approx cost of a '# ... [NNNN lines omitted]\n' marker

    for group in sorted(
            anchor_groups,
            key=lambda g: g["priority"],
            reverse=True):
        if remaining <= 0:
            break
        body = [li for li in group["body_lines"] if li not in mandatory]
        if not body:
            continue

        body_chars = sum(lc(li) for li in body)
        if body_chars <= remaining:
            included_body.update(body)
            remaining -= body_chars
        else:
            # Fit lines from the top of the body, leave room for omission
            # marker
            used = 0
            for li in body:
                cost = lc(li)
                if used + cost + MARKER_COST > remaining:
                    break
                included_body.add(li)
                used += cost
            remaining -= used

    # Reconstruct in original line order
    all_included = mandatory | included_body
    result: list[str] = []

    # Module docstring block
    for i in mod_doc_keep:
        result.append(lines[i])
    if mod_doc_omitted:
        result.append(f"# ... [{mod_doc_omitted} docstring lines omitted]")

    # Scan remaining lines in order, inserting omission markers at cut points
    pending_blanks: list[str] = []
    omit_count = 0
    omit_indent = "    "

    for i, line in enumerate(lines):
        if i in mod_doc_set:
            continue

        if not line.strip():
            pending_blanks.append(line)
            continue

        if i in all_included:
            if omit_count > 0:
                result.append(
                    f"{omit_indent}# ... [{omit_count} lines omitted]")
                omit_count = 0
            result.extend(pending_blanks)
            pending_blanks = []
            result.append(line)
            omit_indent = " " * (len(line) - len(line.lstrip()) + 4)
        else:
            pending_blanks = []  # discard blanks belonging to omitted section
            omit_count += 1

    if omit_count > 0:
        result.append(f"{omit_indent}# ... [{omit_count} lines omitted]")

    return "\n".join(result)


#  Structured Source Compression (tree-sitter metadata path)


def compress_source_structured(
        text: str,
        budget: int,
        structure: list[dict]) -> str:
    """Compress source code using pre-parsed tree-sitter block structure.

    ``structure`` is a list of dicts from toon_bridge.js, each containing:
        type      - 'function', 'class', 'method', etc.
        name      - identifier string
        startLine - 0-based start line (already converted from tree-sitter's 1-based)
        endLine   - 0-based end line (inclusive)
        exported  - bool (always False from current bridge; reserved for future)

    Strategy:
      1. Top-level lines (not inside any block) → always included first (imports,
         module constants, module docstring, etc.)
      2. Blocks scored by name/type, then filled highest-priority-first.
      3. Overlapping blocks (class containing methods) handled by counting only
         lines not yet in the result — so high-priority children claim their lines
         before the parent class tries to include them again.
      4. Clean ``# ... [N lines omitted]`` markers at every cut point.
    """
    lines = text.split("\n")
    n = len(lines)

    if not structure:
        return compress_string(text, budget)

    if budget >= len(text):
        return text

    # Score each block
    for block in structure:
        name = (block.get("name") or "").strip()
        block.get("type") or ""
        exported = block.get("exported", False)

        # Test/main harness blocks are rarely useful in compressed view
        if name == "__main__" or name.startswith(
                "test_") or name.startswith("Test"):
            block["priority"] = 10
        elif name.lower() in _ENTRY_POINT_NAMES or name in _DUNDER_KEEPERS or exported:
            block["priority"] = 300
        elif name.startswith("_"):
            block["priority"] = 100
        else:
            block["priority"] = 200

    # Identify lines that belong to at least one block
    all_block_lines: set[int] = set()
    for block in structure:
        start = max(0, block["startLine"])
        end = min(n - 1, block["endLine"])
        for ln in range(start, end + 1):
            all_block_lines.add(ln)

    # Top-level lines (imports, constants, module-level code) → always first
    result_lines: dict[int, str] = {}
    top_level_lines = [i for i in range(n) if i not in all_block_lines]
    top_level_lines = _strip_doc_blocks_before_blocks(
        lines, top_level_lines, structure)

    # Fix 1: tree-sitter only tags function/class definitions, so
    # `if __name__ == '__main__':` lands in top_level_lines and would be
    # unconditionally included. Reclassify everything from that line to EOF
    # as a priority-10 scored block so it only appears if budget allows.
    main_start = next(
        (i for i in top_level_lines if lines[i].strip().startswith("if __name__")),
        None,
    )
    if main_start is not None:
        main_lines = [i for i in top_level_lines if i >= main_start]
        top_level_lines = [i for i in top_level_lines if i < main_start]
        structure.append(
            {
                "type": "main_block",
                "name": "__main__",
                "startLine": main_start,
                "endLine": main_lines[-1],
                "exported": False,
                "priority": 10,
            }
        )

    # Fix 2: Hard budget cap on top-level lines (40% of budget max).
    # Imports are kept first; remaining capacity filled in original order.
    top_level_cap = budget * 40 // 100
    top_level_cost = sum(len(lines[i]) + 1 for i in top_level_lines)
    if top_level_cost > top_level_cap:
        import_set = {
            i for i in top_level_lines if _SOURCE_IMPORT_RE.match(
                lines[i])}
        import_cost = sum(len(lines[i]) + 1 for i in import_set)
        remaining = top_level_cap - import_cost
        kept: list[int] = list(import_set)
        for i in top_level_lines:
            if i in import_set:
                continue
            cost = len(lines[i]) + 1
            if remaining <= 0:
                break
            kept.append(i)
            remaining -= cost
        top_level_lines = sorted(kept)

    for i in top_level_lines:
        result_lines[i] = lines[i]
    used = sum(len(lines[i]) + 1 for i in top_level_lines)

    # Fill blocks by priority, highest first
    sorted_blocks = sorted(
        structure,
        key=lambda b: b["priority"],
        reverse=True)

    def line_cost(idx: int) -> int:
        return len(lines[idx]) + 1

    def rendered_signature(idx: int) -> str:
        return lines[idx] + f"  # L{idx + 1}"

    def rendered_signature_cost(idx: int) -> int:
        return len(rendered_signature(idx)) + 1

    for block in sorted_blocks:
        start = max(0, block["startLine"])
        end = min(n - 1, block["endLine"])
        if start > end:
            continue

        # Only charge for lines not already included (handles overlapping
        # blocks)
        new_indices = [
            i for i in range(
                start,
                end +
                1) if i not in result_lines]
        if not new_indices:
            # Block fully covered already (e.g. class body after methods)
            continue

        sig_text = rendered_signature(start)
        sig_size = rendered_signature_cost(start)
        new_size = sig_size + sum(line_cost(i)
                                  for i in new_indices if i != start)
        range_marker = f"    # ... [lines {start + 2}-{end + 1} omitted]"
        range_marker_cost = len(range_marker) + 1

        if used + new_size <= budget:
            # Full block fits — annotate signature with 1-based line number
            for i in new_indices:
                result_lines[i] = lines[i]
            result_lines[start] = sig_text
            used += new_size

        elif start not in result_lines and used + sig_size + range_marker_cost <= budget:
            body_indices = [i for i in new_indices if i != start]
            anchor_specs = sorted(
                block.get("anchors", []),
                key=lambda a: (-a.get("priority", 0), a.get("startLine", start)),
            )

            selected_body: list[int] = []
            selected_set: set[int] = set()
            selected_body_cost = 0
            remaining = budget - used - sig_size
            anchor_priority_by_line: dict[int, int] = {}

            def body_render_cost(indices: set[int] | list[int]) -> int:
                sorted_indices = sorted(indices)
                if not sorted_indices:
                    return 0

                cost = 0
                prev_idx = start
                for idx in sorted_indices:
                    if idx > prev_idx + \
                            1 and (idx - prev_idx - 1) >= _MIN_OMISSION_THRESHOLD:
                        indent = " " * \
                            (len(lines[idx]) - len(lines[idx].lstrip()))
                        gap_marker = f"{indent}# ... [lines {
                            prev_idx + 2}-{idx} omitted]"
                        cost += len(gap_marker) + 1
                    cost += line_cost(idx)
                    prev_idx = idx
                return cost

            def try_add_range(
                    indices: list[int],
                    priority: int | None = None) -> bool:
                nonlocal selected_body_cost
                if not indices:
                    return False

                new_indices_local = [
                    idx for idx in indices if idx not in selected_set]
                if not new_indices_local:
                    return False

                new_cost = sum(line_cost(idx) for idx in new_indices_local)
                candidate_cost = selected_body_cost + new_cost
                if candidate_cost > remaining:
                    return False

                for idx in new_indices_local:
                    selected_set.add(idx)
                    selected_body.append(idx)
                    if priority is not None:
                        anchor_priority_by_line[idx] = max(
                            anchor_priority_by_line.get(idx, priority), priority
                        )
                selected_body_cost = candidate_cost
                return True

            for anchor in anchor_specs:
                anchor_start = max(
                    start + 1, min(end, anchor.get("startLine", start + 1)))
                anchor_end = max(
                    anchor_start, min(
                        end, anchor.get(
                            "endLine", anchor_start)))
                try_add_range(
                    [
                        idx
                        for idx in range(anchor_start, anchor_end + 1)
                        if idx in body_indices
                    ],
                    anchor.get("priority"),
                )

            if body_render_cost(selected_set) > remaining:
                removable = sorted(
                    anchor_priority_by_line,
                    key=lambda idx: (anchor_priority_by_line[idx], -idx),
                )
                while removable and body_render_cost(selected_set) > remaining:
                    selected_set.discard(removable.pop(0))
                selected_body = [
                    idx for idx in selected_body if idx in selected_set]
                selected_body_cost = sum(line_cost(idx)
                                         for idx in selected_set)

            # Use any leftover budget to fill local context in source order.
            for idx in body_indices:
                if idx in selected_set:
                    continue
                candidate_indices = set(selected_set)
                candidate_indices.add(idx)
                if body_render_cost(candidate_indices) > remaining:
                    break
                selected_set.add(idx)
                selected_body.append(idx)
                selected_body_cost += line_cost(idx)

            if selected_body:
                omitted_lines = [
                    idx for idx in body_indices if idx not in selected_set]
                omitted_count = len(omitted_lines)
                if 0 < omitted_count < _MIN_OMISSION_THRESHOLD:
                    candidate_indices = set(selected_set)
                    candidate_indices.update(omitted_lines)
                    if body_render_cost(candidate_indices) <= remaining:
                        for idx in omitted_lines:
                            selected_set.add(idx)
                            selected_body.append(idx)
                            selected_body_cost += line_cost(idx)
                        omitted_lines = []
                        omitted_count = 0

                selected_body = sorted(selected_set)
                body_cost = body_render_cost(selected_body)

                result_lines[start] = sig_text
                for idx in selected_body:
                    result_lines[idx] = lines[idx]
                used += sig_size + body_cost
                continue

            # Signature + range omission marker
            result_lines[start] = sig_text
            marker_line = start + 1
            if marker_line <= end and marker_line not in result_lines:
                result_lines[marker_line] = range_marker
                used += sig_size + range_marker_cost
            else:
                used += sig_size

        # else: budget exhausted, block entirely omitted

    # Reassemble in original line order with gap markers
    if len(result_lines) >= 2:
        tiny_gap_lines: set[int] = set()
        sorted_keys = sorted(result_lines)
        prev = sorted_keys[0]
        for ln in sorted_keys[1:]:
            gap = ln - prev - 1
            if 0 < gap < _MIN_OMISSION_THRESHOLD:
                tiny_gap_lines.update(range(prev + 1, ln))
            prev = ln

        for idx in sorted(tiny_gap_lines):
            if idx not in result_lines and used + line_cost(idx) <= budget:
                result_lines[idx] = lines[idx]
                used += line_cost(idx)

    output: list[str] = []
    sorted_keys = sorted(result_lines)
    prev = -1
    actual_used = 0

    for ln in sorted_keys:
        line_text = result_lines[ln]
        line_size = len(line_text) + 1
        if prev >= 0 and ln > prev + 1:
            prev_content = output[-1] if output else ""
            if "# ..." not in prev_content and (
                    ln - prev - 1) >= _MIN_OMISSION_THRESHOLD:
                indent = " " * \
                    (len(result_lines[ln]) - len(result_lines[ln].lstrip()))
                gap_marker = f"{indent}# ... [lines {prev + 2}-{ln} omitted]"
                gap_marker_size = len(gap_marker) + 1
                if actual_used + gap_marker_size + line_size <= budget:
                    output.append(gap_marker)
                    actual_used += gap_marker_size
        if actual_used + line_size > budget:
            break
        output.append(line_text)
        actual_used += line_size
        prev = ln

    result = "\n".join(output)
    return result


#  Default: Content-Aware Truncation


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

    head_10pct = text[: max(1, int(len(text) * 0.1))]
    head_has_structure = head_10pct.count("\n") < 3 and ":" in head_10pct

    if tail_has_error:
        head_ratio, _tail_ratio = 0.4, 0.6
    elif head_has_structure:
        head_ratio, _tail_ratio = 0.8, 0.2
    else:
        head_ratio, _tail_ratio = 0.5, 0.5

    marker = "\n...[content truncated]...\n"
    usable = budget - len(marker)
    if usable <= 0:
        return text[:budget]
    head_budget = int(usable * head_ratio)
    tail_budget = usable - head_budget

    return text[:head_budget] + marker + text[-tail_budget:]
