#!/usr/bin/env node
// CLI entry point — port of toon/__main__.py

import { compress } from './toon/pipeline.js';
import { compressSourceStructured, compressString } from './toon/string-codec.js';
import type { StructureBlock } from './toon/types.js';

// ---------------------------------------------------------------------------
// Stdin
// ---------------------------------------------------------------------------

async function readAllStdin(): Promise<string> {
  process.stdin.setEncoding('utf-8');
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  help: boolean;
  structured: boolean;
  budget: number | null;
  unknown: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, structured: false, budget: null, unknown: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      i += 1;
    } else if (arg === '--structured') {
      result.structured = true;
      i += 1;
    } else if (arg === '--budget') {
      // --budget N  (next token)
      i += 1;
      const val = argv[i];
      if (val === undefined) {
        process.stderr.write('toon: error: --budget requires an integer argument\n');
        process.exit(1);
      }
      const n = Number(val);
      if (!Number.isInteger(n)) {
        process.stderr.write(`toon: error: invalid --budget value: ${val}\n`);
        process.exit(1);
      }
      if (n < 0) {
        process.stderr.write(`toon: error: --budget must be non-negative, got ${n}\n`);
        process.exit(1);
      }
      result.budget = n;
      i += 1;
    } else if (arg.startsWith('--budget=')) {
      // --budget=N
      const val = arg.slice('--budget='.length);
      const n = Number(val);
      if (!Number.isInteger(n)) {
        process.stderr.write(`toon: error: invalid --budget value: ${val}\n`);
        process.exit(1);
      }
      if (n < 0) {
        process.stderr.write(`toon: error: --budget must be non-negative, got ${n}\n`);
        process.exit(1);
      }
      result.budget = n;
      i += 1;
    } else {
      result.unknown.push(arg);
      i += 1;
    }
  }
  return result;
}

function printHelp(): void {
  process.stdout.write(
    [
      'usage: toon [-h] [--budget N] [--structured]',
      '',
      'TOON compression CLI',
      '',
      'options:',
      '  -h, --help    show this help message and exit',
      '  --budget N    character budget override (default: from payload or pipeline preset)',
      '  --structured  structured mode: read {content, budget, structure} JSON from stdin',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Structured-mode payload parsing
// ---------------------------------------------------------------------------

/**
 * Type predicate for StructureBlock — validates the shape of an unknown value
 * received from JSON. Required fields per src/toon/types.ts:
 *   name, kind, type, startLine, endLine, exported, anchors
 * Optional: priority
 */
function isStructureBlock(value: unknown): value is StructureBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as {
    name?: unknown;
    kind?: unknown;
    type?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    exported?: unknown;
    anchors?: unknown;
    priority?: unknown;
  };
  return (
    typeof v.name === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.type === 'string' &&
    typeof v.startLine === 'number' &&
    typeof v.endLine === 'number' &&
    typeof v.exported === 'boolean' &&
    Array.isArray(v.anchors) &&
    (v.priority === undefined || typeof v.priority === 'number')
  );
}

function parseStructuredPayload(
  raw: string,
): { content: string; budget?: number; structure?: StructureBlock[] } {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('payload must be a JSON object');
  }
  const obj = parsed as { content?: unknown; budget?: unknown; structure?: unknown };

  if (typeof obj.content !== 'string') {
    throw new Error('payload.content must be a string');
  }
  const content: string = obj.content;

  let budget: number | undefined;
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== 'number') {
      throw new Error('payload.budget must be a number');
    }
    budget = obj.budget;
  }

  let structure: StructureBlock[] | undefined;
  if (obj.structure !== undefined) {
    if (!Array.isArray(obj.structure)) {
      throw new Error('payload.structure must be an array');
    }
    // Validate each element against the StructureBlock shape rather than
    // casting the whole array. This narrows `unknown[]` to `StructureBlock[]`
    // through a real runtime type guard, not a type assertion.
    const validated: StructureBlock[] = [];
    for (let i = 0; i < obj.structure.length; i++) {
      const entry: unknown = obj.structure[i];
      if (!isStructureBlock(entry)) {
        throw new Error(`payload.structure[${i}] is not a valid StructureBlock`);
      }
      validated.push(entry);
    }
    structure = validated;
  }

  if (budget !== undefined) {
    return { content, budget, structure };
  }
  return { content, structure };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --help / -h
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Unknown args
  if (args.unknown.length > 0) {
    process.stderr.write(
      `toon: error: unrecognized arguments: ${args.unknown.join(' ')}\n`,
    );
    process.exit(2);
  }

  // Read stdin
  const raw = await readAllStdin();
  if (raw.trim() === '') {
    process.stderr.write('toon: error: no input on stdin\n');
    process.exit(1);
  }

  if (args.structured) {
    // Structured mode: {content, budget, structure}
    let payload: { content: string; budget?: number; structure?: StructureBlock[] };
    try {
      payload = parseStructuredPayload(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`toon --structured: invalid JSON on stdin: ${msg}\n`);
      process.exit(1);
    }

    const { content, structure } = payload;
    const budget =
      args.budget !== null
        ? args.budget
        : (payload.budget ?? content.length);

    let result: string;
    if (structure !== undefined && structure.length > 0) {
      result = compressSourceStructured(content, budget, structure);
    } else {
      result = compressString(content, budget);
    }

    process.stdout.write(result);
  } else {
    // Default pipeline mode
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }

    const result = compress(data, args.budget);

    if (typeof result === 'string') {
      process.stdout.write(result);
    } else {
      process.stdout.write(JSON.stringify(result, (_key, value: unknown) => {
        if (typeof value === 'bigint') {
          return String(value);
        }
        return value;
      }));
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`toon: fatal: ${msg}\n`);
  process.exit(1);
});
