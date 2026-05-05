import os
import sys

from toon.string_codec import compress_string

sys.path.insert(0, "/home/tanner/Projects/toon")

TEST_FILES = [
    "/home/tanner/Projects/oh-my-opencode-rebase/src/tools/delegate-task/tools.test.ts",
    "/home/tanner/Projects/pantheon-hive/packages/opencode-pantheon/src/index.ts",
    "/home/tanner/Projects/litellm-pgvector-main/cli/pgvector-upload.py",
    "/home/tanner/Projects/litellm-pgvector-main/main.py",
    "/home/tanner/Projects/multi-mcp/src/multimcp/multi_mcp.py",
]

OUT_DIR = "/home/tanner/Projects/toon/tests/comparisons"
os.makedirs(OUT_DIR, exist_ok=True)

for path in TEST_FILES:
    name = os.path.basename(path).replace(".", "_")
    out_path = os.path.join(OUT_DIR, f"{name}_compare.txt")

    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()

    with open(out_path, "w", encoding="utf-8") as out:
        sep = "=" * 80

        out.write(f"{sep}\n")
        out.write(f"FILE: {path}\n")
        out.write(
            f"Original: {len(raw):,} chars  |  {len(raw.splitlines())} lines\n")
        out.write(f"{sep}\n\n")

        out.write("[ ORIGINAL ]\n")
        out.write(f"{sep}\n")
        out.write(raw)
        out.write(f"\n{sep}\n\n")

        for pct in [70, 50, 30, 15]:
            budget = len(raw) * pct // 100
            compressed = compress_string(raw, budget)
            actual_pct = len(compressed) * 100 // len(raw)
            out.write(
                f"[ COMPRESSED {pct}%  →  budget {
                    budget:,} chars  |  actual {actual_pct}%  |  {
                    len(compressed):,} chars  |  {
                    len(
                        compressed.splitlines())} lines ]\n")
            out.write(f"{sep}\n")
            out.write(compressed)
            out.write(f"\n{sep}\n\n")

    print(f"✓  {out_path}  ({len(raw):,} chars in)")

print("\nDone — 5 files in", OUT_DIR)
