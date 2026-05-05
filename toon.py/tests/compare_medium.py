import os
import sys

from toon.string_codec import compress_string

sys.path.insert(0, "/home/tanner/Projects/toon")

TEST_FILES = [
    "/home/tanner/Projects/multi-mcp/src/multimcp/mcp_client.py",  # 34KB  MCP client
    "/home/tanner/Projects/MCPServer/src/meta_mcp/middleware.py",  # 30KB  MCP middleware
    "/home/tanner/Projects/toon/engines/sagerank.py",  # 31KB  SageRank engine
    "/home/tanner/Projects/toon/toon/pipeline.py",  # 31KB  toon pipeline
    "/home/tanner/Projects/multi-mcp/src/multimcp/retrieval/bmx_index.py",  # 31KB  BMX index
]

OUT_DIR = "/home/tanner/Projects/toon/tests/comparisons/medium"
os.makedirs(OUT_DIR, exist_ok=True)

total_raw = 0
for path in TEST_FILES:
    name = os.path.basename(path).replace(".", "_")
    out_path = os.path.join(OUT_DIR, f"{name}_compare.txt")

    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    total_raw += len(raw)

    with open(out_path, "w", encoding="utf-8") as out:
        sep = "=" * 80
        thin = "-" * 80

        out.write(f"{sep}\n")
        out.write(f"FILE:     {path}\n")
        out.write(
            f"ORIGINAL: {len(raw):,} chars  |  {len(raw.splitlines())} lines\n")
        out.write(f"{sep}\n\n")

        out.write("[ ORIGINAL ]\n")
        out.write(f"{thin}\n")
        out.write(raw)
        out.write(f"\n{thin}\n\n")

        for pct in [70, 50, 30, 15]:
            budget = len(raw) * pct // 100
            compressed = compress_string(raw, budget)
            actual_pct = len(compressed) * 100 // len(raw)
            out.write(
                f"[ COMPRESSED {pct}%  →  budget {
                    budget:,}  |  actual {actual_pct}%  |  {
                    len(compressed):,} chars  |  {
                    len(
                        compressed.splitlines())} lines ]\n")
            out.write(f"{thin}\n")
            out.write(compressed)
            out.write(f"\n{thin}\n\n")

    print(f"✓  {os.path.basename(out_path)}  ({len(raw):,} chars)")

print(
    f"\nTotal raw across 5 files: {
        total_raw:,} chars  (~{
            total_raw // 1024}KB)")
print(f"At 30% compression that would be: ~{total_raw * 30 // 100 // 1024}KB")
print(f"Files saved to: {OUT_DIR}")
