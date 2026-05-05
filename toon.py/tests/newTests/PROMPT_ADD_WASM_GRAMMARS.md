# Research Task: Find Install Commands for Missing Tree-Sitter WASM Grammars

## CRITICAL OUTPUT REQUIREMENT

**Your entire response must be a set of copy-paste shell commands — nothing else.**
No background, no explanation, no research summary. Just the exact commands to
run on Ubuntu (as of May 4, 2026) to install each missing WASM file into the
correct directory. If you cannot find a working install method for a language,
say so in ONE line and move on. Do not pad with research narrative.

The target directory for every WASM is:
```
/home/tanner/Projects/Zenith-MCP/dist/grammars/grammars/
```

Each file must be named exactly: `tree-sitter-{lang}.wasm`

---

## What We Need

We need prebuilt `.wasm` grammar files for `web-tree-sitter` version `0.26.x`
for these 9 languages (as of May 4, 2026, on Ubuntu):

- rust
- c
- cpp
- csharp
- go
- java
- kotlin
- php
- ruby
- swift

We already have and do NOT need: bash, css, javascript, json, markdown, python,
sql, tsx, typescript, yaml.

---

## Version Constraint — This Is Non-Negotiable

The installed `web-tree-sitter` version is `0.26.x`. WASM files compiled for a
different ABI version will fail at load time. Every install method you provide
must produce a WASM that is ABI-compatible with `web-tree-sitter 0.26.x`.

Verify this is satisfied before including any command. If a source only has
WASMs for `0.22.x` or `0.24.x`, it is NOT acceptable — do not include it.

---

## Likely Sources to Research

Research these in order — find the one that covers the most languages in a
single command, that is confirmed available as of May 2026:

1. **`tree-sitter-wasms` npm package** — check the latest version on npm,
   confirm it contains 0.26.x compatible WASMs, check which of the 9 languages
   it includes. If it covers them all, one `npm install` + copy commands is the
   ideal output.

2. **Individual npm packages** — packages like `tree-sitter-rust`,
   `tree-sitter-go`, etc. Some publish prebuilt WASMs as part of their npm
   package. Check each one for a `.wasm` file in the package contents.

3. **GitHub releases** — `https://github.com/tree-sitter/tree-sitter-{lang}/releases`
   — look for release assets containing `.wasm` files with a version tag that
   corresponds to `web-tree-sitter 0.26.x` compatibility.

4. **`@nicolo-ribaudo` or `@tree-sitter-grammars` npm scopes** — community
   packages that bundle prebuilt WASMs.

---

## Required Output Format

For each language, output exactly this shape:

```
# rust
<one or more shell commands that download/copy the wasm to the correct path>

# c
<commands>

# cpp
<commands>
...
```

If a language has no confirmed working source as of May 2026, output:
```
# kotlin
# NOT FOUND — no confirmed web-tree-sitter 0.26.x compatible WASM available as of May 2026
```

---

## Verification Command

After your install commands, include this single verification block that the
user can run to confirm each WASM loads correctly:

```bash
cd /home/tanner/Projects/Zenith-MCP
for lang in rust c cpp csharp go java kotlin php ruby swift; do
  node --input-type=module <<EOF
import Parser from './node_modules/web-tree-sitter/web-tree-sitter.js';
await Parser.init();
try {
  const lang = await Parser.Language.load('dist/grammars/grammars/tree-sitter-${lang}.wasm');
  console.log('✓ ${lang}:', lang.nodeTypeCount, 'node types');
} catch(e) {
  console.log('✗ ${lang}:', e.message);
}
EOF
done
```
