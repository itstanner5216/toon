// toon_bridge.js
// Accepts a file path and budget (chars) via CLI args.
// Runs tree-sitter to extract code structure, then calls toon's
// --structured mode via subprocess, returning the compressed result.
//
// Usage: node toon_bridge.js <filepath> <budget_chars>

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

import { getDefinitions, getLangForFile } from './core/tree-sitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const inputPath = process.argv[2];
const budget    = parseInt(process.argv[3], 10);

if (!inputPath || isNaN(budget)) {
    process.stderr.write('Usage: node toon_bridge.js <filepath> <budget_chars>\n');
    process.exit(1);
}

const content = readFileSync(inputPath, 'utf8');

// Already within budget — no compression needed
if (content.length <= budget) {
    process.stdout.write(content);
    process.exit(0);
}

let structure = null;
const langName = getLangForFile(inputPath);

if (langName) {
    try {
        const defs = await getDefinitions(content, langName);
        if (defs && defs.length > 0) {
            // Convert 1-based tree-sitter lines to 0-based Python array indices
            structure = defs.map(d => ({
                type:      d.type,
                name:      d.name,
                startLine: d.line - 1,
                endLine:   d.endLine - 1,
                exported:  false,          // not exposed by the .scm tags
            }));
        }
    } catch (e) {
        process.stderr.write(`tree-sitter parse failed for ${inputPath}: ${e.message}\n`);
    }
}

// Hand off to toon --structured (falls back to regex codec if structure is null)
const payload = JSON.stringify({ content, budget, structure });

const toonProjectDir = path.join(__dirname, '..', '..');

const result = execFileSync('python3', ['-m', 'toon', '--structured'], {
    input:     payload,
    encoding:  'utf8',
    maxBuffer: 10 * 1024 * 1024,
    cwd:       toonProjectDir,
});

process.stdout.write(result);
