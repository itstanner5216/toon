"""tests/test_treesitter.py.

Runs the toon_bridge.js (tree-sitter path) against the same 5 medium files
used in previous reviews, and produces side-by-side comparisons:
  OLD CODEC (regex heuristic) vs NEW CODEC (tree-sitter structured)

Output: tests/comparisons/treesitter/<filename>_ts_compare.txt
"""

import os
import subprocess
import sys

from string_codec import compress_string

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

TEST_FILES = [
    "/home/tanner/Projects/multi-mcp/src/multimcp/mcp_client.py",
    "/home/tanner/Projects/MCPServer/src/meta_mcp/middleware.py",
    "/home/tanner/Projects/toon/engines/sagerank.py",
    "/home/tanner/Projects/toon/toon/pipeline.py",
    "/home/tanner/Projects/multi-mcp/src/multimcp/retrieval/bmx_index.py",
]

BRIDGE = os.path.join(
    os.path.dirname(__file__), "..", "engines", "treesitter", "toon_bridge.js"
)
OUT_DIR = os.path.join(os.path.dirname(__file__), "comparisons", "treesitter")
os.makedirs(OUT_DIR, exist_ok=True)

LEVELS = [70, 50, 30]

SEP = "=" * 80
THIN = "-" * 60


def run_bridge(filepath: str, budget: int) -> str:
    """Call toon_bridge.js via node, return compressed text."""
    try:
        result = subprocess.run(
            ["node", BRIDGE, filepath, str(budget)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return f"[BRIDGE ERROR]\n{result.stderr}"
        return result.stdout
    except subprocess.TimeoutExpired:
        return "[BRIDGE TIMEOUT]"
    except Exception as e:
        return f"[BRIDGE EXCEPTION: {e}]"


for filepath in TEST_FILES:
    fname = os.path.basename(filepath).replace(".", "_")
    out_path = os.path.join(OUT_DIR, f"{fname}_ts_compare.txt")

    with open(filepath, encoding="utf-8", errors="replace") as f:
        raw = f.read()

    raw_len = len(raw)
    raw_lines = len(raw.splitlines())

    print(
        f"Processing: {
            os.path.basename(filepath)} ({
            raw_len:,} chars, {raw_lines} lines)")

    with open(out_path, "w", encoding="utf-8") as out:
        out.write(f"{SEP}\n")
        out.write(f"FILE:     {filepath}\n")
        out.write(f"ORIGINAL: {raw_len:,} chars | {raw_lines} lines\n")
        out.write(f"{SEP}\n\n")

        out.write("[ ORIGINAL ]\n")
        out.write(f"{THIN}\n")
        out.write(raw)
        out.write(f"\n{THIN}\n\n")

        for pct in LEVELS:
            budget = raw_len * pct // 100

            old_result = compress_string(raw, budget)
            new_result = run_bridge(filepath, budget)

            out.write(f"{SEP}\n")
            out.write(f"BUDGET: {pct}%  ({budget:,} chars)\n")
            out.write(f"{SEP}\n\n")

            out.write(
                f"── OLD CODEC (regex heuristic) ──  {
                    len(old_result):,} chars\n")
            out.write(f"{THIN}\n")
            out.write(old_result)
            out.write(f"\n{THIN}\n\n")

            out.write(
                f"── NEW CODEC (tree-sitter structured) ──  {len(new_result):,} chars\n")
            out.write(f"{THIN}\n")
            out.write(new_result)
            out.write(f"\n{THIN}\n\n")

    print(f"  → {out_path}")

print("\nDone. Compare files written to tests/comparisons/treesitter/")
