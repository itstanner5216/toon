#!/usr/bin/env node
/**
 * toon-bridge.ts — file → tree-sitter → toon compressor (single binary).
 *
 * Behavioral port of the original toon_bridge.js. The previous Python out-of-process
 * call is replaced by direct TypeScript calls into compressSourceStructured /
 * compressString.
 *
 * Usage: node toon-bridge.js <filepath> <budget_chars>
 */
import { readFileSync } from 'fs';
import { getDefinitions, getLangForFile } from './tree-sitter.js';
import { compressSourceStructured, compressString } from '../../toon/string-codec.js';
import type { StructureBlock } from '../../toon/types.js';

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const budgetArg = process.argv[3];
  const budget = budgetArg !== undefined ? parseInt(budgetArg, 10) : NaN;

  if (!inputPath || isNaN(budget)) {
    process.stderr.write('Usage: node toon-bridge.js <filepath> <budget_chars>\n');
    process.exit(1);
  }

  const content = readFileSync(inputPath, 'utf8');

  // Already within budget — no compression needed
  if (content.length <= budget) {
    process.stdout.write(content);
    return;
  }

  let structure: StructureBlock[] | null = null;
  const langName = getLangForFile(inputPath);

  if (langName) {
    try {
      const defs = await getDefinitions(content, langName);
      if (defs && defs.length > 0) {
        // Convert 1-based tree-sitter lines to 0-based (matching Python array indices).
        // StructureBlock requires ALL fields: name, kind, type, startLine, endLine,
        // exported, anchors (per src/toon/types.ts).
        structure = defs.map((d) => ({
          name: d.name,
          kind: d.kind,
          type: d.type,
          startLine: d.line - 1,
          endLine: d.endLine - 1,
          exported: false,
          anchors: [],
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`tree-sitter parse failed for ${inputPath}: ${msg}\n`);
    }
  }

  const result = structure
    ? compressSourceStructured(content, budget, structure)
    : compressString(content, budget);

  process.stdout.write(result);
}

await main();
