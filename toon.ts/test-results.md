# Toon Compression Runtime Test Results

**Method**: `node dist/core/toon_bridge.js <file> <budget>` (Zenith-MCP bridge → tree-sitter structure → Python toon --structured)

| File | Language | Original | Compressed | Budget | Retained |
|------|----------|----------|------------|--------|----------|
| pipeline.py | Python | 28927B | 20299B | 20249 | 70.1% |
| shared.js | JavaScript | 16400B | 11589B | 11480 | 70.6% |
| test-dcp-cache.sh | Shell | 13441B | 8384B | 9409 | 62.3% |
| index.ts | TypeScript | 2164B | 2163B | 1515 | 99.9% |
| package.json | JSON | 2268B | 1583B | 1588 | 69.7% |

All exit code 0. Character budgets respected (±1%).
