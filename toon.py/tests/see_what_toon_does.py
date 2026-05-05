# see_what_toon_does.py
# Drop this in the toon project root and run it:
#   python see_what_toon_does.py
#
# Prints everything AND saves to toon_test_results.txt

import json
import os
import re
import sys
from datetime import datetime

from toon.dedup import Deduplicator
from toon.encoder import encode_output
from toon.pipeline import compress
from toon.string_codec import compress_string

# ══════════════════════════════════════════════════════════════
#  Output to both terminal and file
# ══════════════════════════════════════════════════════════════

OUTPUT_FILE = "toon_test_results.txt"


class TeeWriter:
    """Writes to both stdout and a file simultaneously."""

    def __init__(self, filepath):
        self.terminal = sys.stdout
        self.file = open(filepath, "w", encoding="utf-8")

    def write(self, text):
        self.terminal.write(text)
        self.file.write(text)

    def flush(self):
        self.terminal.flush()
        self.file.flush()

    def close(self):
        self.file.close()


tee = TeeWriter(OUTPUT_FILE)
sys.stdout = tee


# ══════════════════════════════════════════════════════════════
#  Find test files
# ══════════════════════════════════════════════════════════════

# CHANGE THESE to point at your actual MCP server files
# or any real codebase you want to test against
TEST_FILES = [
    "/home/tanner/Projects/oh-my-opencode-rebase/src/tools/delegate-task/tools.test.ts",
    # 132KB  TS test suite
    "/home/tanner/Projects/pantheon-hive/packages/opencode-pantheon/src/index.ts",
    # 74KB   TS source
    "/home/tanner/Projects/litellm-pgvector-main/cli/pgvector-upload.py",  # 94KB   Python
    "/home/tanner/Projects/litellm-pgvector-main/main.py",  # 60KB   Python
    "/home/tanner/Projects/multi-mcp/src/multimcp/multi_mcp.py",  # 53KB   MCP Python
]

# Fallback: use toon's own source files if those paths don't exist
if not os.path.exists(TEST_FILES[0]):
    print("[!] MCP server files not found, using toon source files instead")
    print("[!] Edit TEST_FILES in this script to point at your real project\n")
    TEST_FILES = []
    for root, dirs, files in os.walk("."):
        # Skip hidden dirs and __pycache__
        dirs[:] = [d for d in dirs if not d.startswith(
            ".") and d != "__pycache__"]
        for f in files:
            if f.endswith(".py") and not f.startswith("see_what"):
                path = os.path.join(root, f)
                try:
                    size = os.path.getsize(path)
                    if size > 500:
                        TEST_FILES.append(path)
                except OSError:
                    pass
                if len(TEST_FILES) >= 8:
                    break
        if len(TEST_FILES) >= 8:
            break

if not TEST_FILES:
    print("ERROR: No test files found. Edit TEST_FILES in this script.")
    sys.exit(1)


# ══════════════════════════════════════════════════════════════

print("=" * 72)
print("TOON+ COMPRESSION TEST RESULTS")
print(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print(f"Output saved to: {OUTPUT_FILE}")
print("=" * 72)
print()
print("Files under test:")
for path in TEST_FILES:
    size = os.path.getsize(path)
    lines = open(path).read().count("\n")
    print(f"  {path} — {size:,} chars, {lines} lines")
print()


# ══════════════════════════════════════════════════════════════
#  TEST 1: Single file at different compression levels
# ══════════════════════════════════════════════════════════════

biggest = max(TEST_FILES, key=lambda p: os.path.getsize(p))
with open(biggest) as f:
    raw = f.read()

print("━" * 72)
print("TEST 1: SINGLE FILE COMPRESSION")
print(f"File: {biggest}")
print(f"Original: {len(raw):,} chars, {len(raw.splitlines())} lines")
print("━" * 72)
print()

# Show the raw file first so you can compare
print("┌─ ORIGINAL (first 1500 chars) ─┐")
print(raw[:1500])
if len(raw) > 1500:
    print(f"\n  ... [{len(raw) - 1500:,} more chars in original]")
print()
print("└─ END ORIGINAL ─┘")
print()

for pct in [70, 50, 30, 15]:
    budget = len(raw) * pct // 100
    compressed = compress_string(raw, budget)

    print(f"┌─ COMPRESSED AT {pct}% ({budget:,} char budget) ─┐")
    print(
        f"│ Result: {len(compressed):,} chars, {len(compressed.splitlines())} lines")
    print(f"│ Actual ratio: {len(compressed) * 100 // len(raw)}% of original")
    print(f"├{'─' * 50}┤")
    print()
    print(compressed)
    print()
    print(f"└─ END {pct}% ─┘")
    print()
    print()


# ══════════════════════════════════════════════════════════════
#  TEST 2: Every test file at 30% compression
# ══════════════════════════════════════════════════════════════

print("━" * 72)
print("TEST 2: ALL FILES AT 30% COMPRESSION")
print("Compare each compressed version to what you know about the file")
print("━" * 72)
print()

for path in TEST_FILES:
    with open(path) as f:
        content = f.read()

    budget = len(content) * 30 // 100
    compressed = compress_string(content, budget)

    print(f"┌─ {path} ─┐")
    print(
        f"│ Original: {len(content):,} chars, {len(content.splitlines())} lines")
    print(
        f"│ Compressed: {len(compressed):,} chars, {len(compressed.splitlines())} lines")
    print(f"│ Ratio: {len(compressed) * 100 // max(1, len(content))}%")
    print(f"├{'─' * 50}┤")
    print()
    print(compressed)
    print()
    print(f"└─ END {path} ─┘")
    print()
    print()


# ══════════════════════════════════════════════════════════════
#  TEST 3: Multi-file through full pipeline
# ══════════════════════════════════════════════════════════════

print("━" * 72)
print("TEST 3: MULTI-FILE PIPELINE")
print("Simulates read_multiple_files with compression on")
print("━" * 72)
print()

file_entries = []
total_raw = 0
for path in TEST_FILES:
    with open(path) as f:
        content = f.read()
    file_entries.append({"path": path, "content": content})
    total_raw += len(content)

budget = total_raw // 3
print(f"Input: {len(file_entries)} files, {total_raw:,} total chars")
print(f"Budget: {budget:,} chars (33% of total)")
print()

result = compress(file_entries, budget=budget)

print(f"Pipeline returned {len(result)} entries")
if len(result) < len(file_entries):
    print(
        f"  ({
            len(file_entries) -
            len(result)} entries removed by dedup/scoring)")
print()

for i, entry in enumerate(result):
    if isinstance(entry, dict):
        path = entry.get("path", f"entry_{i}")
        content = entry.get(
            "content", json.dumps(
                entry, indent=2, default=str))
    else:
        path = f"entry_{i}"
        content = str(entry)

    content_str = str(content)
    print(f"┌─ [{i}] {path} ─┐")
    print(f"│ Compressed size: {len(content_str):,} chars")
    print(f"├{'─' * 50}┤")
    print()
    print(content_str)
    print()
    print(f"└─ END [{i}] ─┘")
    print()


# ══════════════════════════════════════════════════════════════
#  TEST 4: Dedup behavior
# ══════════════════════════════════════════════════════════════

print("━" * 72)
print("TEST 4: DEDUP BEHAVIOR")
print("Feeding duplicates and near-duplicates to see what gets caught")
print("━" * 72)
print()

with open(TEST_FILES[0]) as f:
    content_a = f.read()

fake_entries = []

# Entry 0: original
fake_entries.append({"label": "original", "content": content_a})

# Entry 1: exact duplicate
fake_entries.append({"label": "exact_duplicate", "content": content_a})

# Entry 2: near duplicate (timestamps/numbers replaced)
content_near = re.sub(r"\d{4}", "9999", content_a)
content_near = re.sub(
    r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}",
    "0.0.0.0",
    content_near)
fake_entries.append({"label": "near_duplicate", "content": content_near})

# Entry 3: same structure different values (template candidate)
if isinstance(content_a, str) and len(TEST_FILES) > 1:
    with open(TEST_FILES[1]) as f:
        content_b = f.read()
    fake_entries.append({"label": "different_file", "content": content_b})

# Entry 4: another exact duplicate
fake_entries.append({"label": "exact_duplicate_2", "content": content_a})

print(f"Fed {len(fake_entries)} entries:")
for e in fake_entries:
    print(f"  [{e['label']}] {len(str(e['content'])):,} chars")
print()

deduper = Deduplicator()
dedup_result = deduper.deduplicate([e["content"] for e in fake_entries])

print("RESULTS:")
print(f"  Unique entries kept: {len(dedup_result.entries)}")
print(f"  Exact duplicates removed: {dedup_result.dedup_stats.exact}")
print(f"  Near duplicates removed: {dedup_result.dedup_stats.near}")
print(f"  Template collapsed: {dedup_result.dedup_stats.template}")
print()
print(
    f"  Surviving entry indices: {[e['index'] for e in dedup_result.entries]}")
print()

for e in dedup_result.entries:
    content_preview = str(e["content"])[:200]
    print(f"  [{e['index']}] type={e['type']}, {len(str(e['content'])):,} chars")
    print(f"      preview: {content_preview}...")
    print()


# ══════════════════════════════════════════════════════════════
#  TEST 5: Structural encoding (JSON tool output)
# ══════════════════════════════════════════════════════════════

print("━" * 72)
print("TEST 5: STRUCTURAL ENCODING")
print("Simulates a large JSON tool response (search results)")
print("━" * 72)
print()

fake_api = {
    "status": "success",
    "query": "fetchData",
    "totalMatches": 187,
    "results": [
        {
            "path": f"src/components/Component{i}.tsx",
            "matches": [
                {
                    "line": 10 + j * 15,
                    "text": f"  const result = await fetchData('/api/endpoint{i}', {{ id: {j} }});",
                    "context_before": f"  // Handle data fetching for component {i}",
                    "context_after": "  setData(result.data);",
                }
                for j in range(6)
            ],
            "score": round(0.95 - (i * 0.018), 3),
        }
        for i in range(25)
    ],
    "metadata": {
        "searchTime": "127ms",
        "filesScanned": 1847,
        "pattern": "fetchData\\(",
        "engine": "ripgrep",
    },
}

raw_json = json.dumps(fake_api, indent=2)
print(f"Raw JSON response: {len(raw_json):,} chars")
print()

# Show raw first
print("┌─ RAW (first 1000 chars) ─┐")
print(raw_json[:1000])
print(f"  ... [{len(raw_json) - 1000:,} more chars]")
print("└─ END RAW ─┘")
print()

# Legacy encoding
encoded = encode_output(fake_api, threshold=5)
encoded_json = json.dumps(encoded, indent=2)
print(f"┌─ LEGACY encode_output (threshold=5): {len(encoded_json):,} chars ─┐")
print(encoded_json)
print("└─ END LEGACY ─┘")
print()

# Full pipeline at different budgets
for pct in [50, 25]:
    budget = len(raw_json) * pct // 100
    compressed = compress(fake_api, budget=budget)
    comp_json = json.dumps(compressed, indent=2, default=str)
    print(
        f"┌─ FULL PIPELINE at {pct}% ({
            budget:,} char budget): {
            len(comp_json):,} chars ─┐")
    print(comp_json)
    print(f"└─ END PIPELINE {pct}% ─┘")
    print()


# ══════════════════════════════════════════════════════════════
#  TEST 6: Content type detection + type-specific compression
# ══════════════════════════════════════════════════════════════

print("━" * 72)
print("TEST 6: CONTENT-TYPE SPECIFIC COMPRESSION")
print("Stack traces, logs, JSON-in-string — each gets different treatment")
print("━" * 72)
print()

# ── Stack trace ──
stack_trace = """Traceback (most recent call last):
  File "/app/server.py", line 42, in handle_request
    result = await process_query(request.body)
  File "/app/handlers/query.py", line 156, in process_query
    validated = schema.validate(raw_input)
  File "/app/handlers/query.py", line 89, in _inner_validate
    return self._run_validators(data)
  File "/app/validation/core.py", line 34, in _run_validators
    for v in self.validators:
  File "/app/validation/core.py", line 41, in _check_type
    raise TypeError(f"Expected dict, got {type(data)}")
  File "/usr/lib/python3.11/site-packages/pydantic/validators.py", line 234, in _run_validators
    v(data)
  File "/usr/lib/python3.11/site-packages/pydantic/validators.py", line 118, in validate_type
    raise TypeError(f"Expected dict, got {type(data)}")
  File "/usr/lib/python3.11/site-packages/pydantic/main.py", line 341, in __init__
    raise validation_error
  File "/usr/lib/python3.11/site-packages/sqlalchemy/engine/base.py", line 1965, in connect
    return self._connection_cls(self)
  File "/usr/lib/python3.11/site-packages/sqlalchemy/pool/base.py", line 331, in get
    raise TimeoutError("Pool exhausted")
  File "/usr/lib/python3.11/site-packages/sqlalchemy/pool/impl.py", line 145, in _do_get
    return self._create_connection()
TypeError: Expected dict, got <class 'str'>"""

print("── STACK TRACE ──")
print(
    f"Original: {len(stack_trace)} chars, {len(stack_trace.splitlines())} lines")
print()
print("ORIGINAL:")
print(stack_trace)
print()

for pct in [50, 30]:
    compressed = compress_string(stack_trace, len(stack_trace) * pct // 100)
    print(
        f"COMPRESSED AT {pct}% ({
            len(stack_trace) *
            pct //
            100} char budget):")
    print(compressed)
    print()

# ── Log output ──
log_lines = []
severities = [
    "INFO",
    "INFO",
    "INFO",
    "INFO",
    "WARN",
    "INFO",
    "INFO",
    "ERROR",
    "INFO",
    "INFO",
    "INFO",
    "INFO",
    "INFO",
    "INFO",
    "INFO",
]
messages = [
    "Processing request from client {}",
    "Query executed in {}ms",
    "Cache hit for key user_{}",
    "Response sent: 200 OK",
    "Connection pool at {}% capacity",
    "Retrying failed request (attempt {}/3)",
    "Failed to process request: timeout after 30s",
    "Database connection restored",
    "Rate limit reached for client {}",
    "Background job completed: cleanup_sessions",
]
for i in range(60):
    sev = severities[i % len(severities)]
    msg = messages[i % len(messages)].format(i)
    log_lines.append(f"2026-04-12T10:{i // 60:02d}:{i % 60:02d}Z {sev}  {msg}")

log_output = "\n".join(log_lines)

print("── LOG OUTPUT ──")
print(f"Original: {len(log_output)} chars, {len(log_lines)} lines")
print()
print("ORIGINAL (first 15 lines):")
print("\n".join(log_lines[:15]))
print(f"  ... [{len(log_lines) - 15} more lines]")
print()

for pct in [50, 25]:
    compressed = compress_string(log_output, len(log_output) * pct // 100)
    print(f"COMPRESSED AT {pct}%:")
    print(compressed)
    print()

# ── JSON-in-string ──
json_string = json.dumps({"users": [{"id": i,
                                     "name": f"User {i}",
                                     "email": f"user{i}@example.com",
                                     "roles": ["admin"] if i == 0 else ["user"],
                                     "lastLogin": f"2026-04-{10 + i}T12:00:00Z",
                                     "preferences": {"theme": "dark",
                                                     "language": "en",
                                                     "notifications": True},
                                     } for i in range(20)],
                          "pagination": {"page": 1,
                                         "total": 200,
                                         "perPage": 20},
                          "filters": {"active": True,
                                      "role": None,
                                      "search": ""},
                          })

print("── JSON-IN-STRING ──")
print(f"Original: {len(json_string)} chars")
print()
print("ORIGINAL (first 500 chars):")
print(json_string[:500])
print(f"  ... [{len(json_string) - 500} more chars]")
print()

for pct in [50, 25]:
    compressed = compress_string(json_string, len(json_string) * pct // 100)
    print(f"COMPRESSED AT {pct}%:")
    print(compressed)
    print()


# ══════════════════════════════════════════════════════════════
#  Summary
# ══════════════════════════════════════════════════════════════

print("━" * 72)
print("TEST COMPLETE")
print("━" * 72)
print()
print(f"Full results saved to: {OUTPUT_FILE}")
print()
print("Review checklist:")
print("  [ ] TEST 1: At what % does the biggest file become unreadable?")
print("  [ ] TEST 2: Can you tell what each file does at 30%?")
print("  [ ] TEST 3: Did the multi-file pipeline allocate budget sensibly?")
print("  [ ] TEST 4: Did dedup catch exact and near duplicates?")
print("  [ ] TEST 5: Is the JSON structural encoding useful or lossy?")
print("  [ ] TEST 6: Did stack trace compression keep user-code frames?")
print("  [ ] TEST 6: Did log compression keep errors over info lines?")
print("  [ ] TEST 6: Did JSON-in-string compression keep important keys?")
print()
print("If something looks wrong, note the test number and what's missing.")
print("That tells us exactly which codec or pipeline stage to tune.")

# Restore stdout and close file
sys.stdout = tee.terminal
tee.close()
print(f"\nResults saved to {OUTPUT_FILE}")
