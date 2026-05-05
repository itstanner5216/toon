// Ported from: toon/string_codec.py
// Python line count: 977
// Port verification: dispatch order (source → stack → JSON → log → truncate), all 6 compressors, structure-aware compression, doc-block stripping

import { blake2bHash, NORMALIZERS } from './utils.js';
import type { StructureBlock, Anchor } from './types.js';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

// Python: re.compile(r'\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b', re.IGNORECASE)
const _LOG_SEVERITY_RE =
  /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/i;

// Python: re.compile(r'^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}', re.MULTILINE)
const _TIMESTAMP_LINE_RE = /^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}/;

const _ERROR_KEYWORDS: ReadonlySet<string> = new Set([
  'error', 'fatal', 'critical', 'exception', 'traceback',
  'caused by', 'failed', 'killed', 'oom', 'panic', 'crash', 'abort',
]);

// Python: re.compile(r'^\s+(at\s+|File\s+")', re.MULTILINE)
const _FRAME_RE = /^\s+(at\s+|File\s+")/;

// Python: re.compile(r'(java\.|javax\.|sun\.|org\.springframework\.|org\.python\.|importlib\.|_bootstrap|site-packages)')
const _USER_FRAME_EXCLUDES =
  /(java\.|javax\.|sun\.|org\.springframework\.|org\.python\.|importlib\.|_bootstrap|site-packages)/;

// ---------------------------------------------------------------------------
// Source code detection patterns
// ---------------------------------------------------------------------------

const _ENTRY_POINT_NAMES: ReadonlySet<string> = new Set([
  '__init__', '__call__', '__enter__', '__exit__',
  '__aenter__', '__aexit__', '__str__', '__repr__',
  '__len__', '__iter__', '__next__', '__getitem__', '__setitem__', '__contains__',
  'main', 'run', 'start', 'stop', 'close', 'open', 'setup', 'teardown', 'reset',
  'compress', 'decompress', 'encode', 'decode',
  'search', 'query', 'find', 'get', 'fetch',
  'build', 'build_index', 'index', 'add', 'remove', 'update', 'delete',
  'handle', 'on_call_tool', 'execute', 'process', 'dispatch', 'call', 'invoke',
  'create', 'insert', 'save', 'load', 'read', 'write',
  'connect', 'disconnect', 'send', 'receive', 'listen',
  'validate', 'parse', 'serialize', 'deserialize', 'from_dict', 'to_dict',
  'feed', 'transform', 'apply', 'fit', 'predict',
  'register', 'unregister', 'subscribe', 'unsubscribe',
  'allocate', 'score', 'rank', 'deduplicate',
]);

const _DUNDER_KEEPERS: ReadonlySet<string> = new Set([
  '__init__', '__call__', '__enter__', '__exit__', '__aenter__', '__aexit__',
  '__str__', '__repr__', '__len__', '__iter__', '__next__',
  '__getitem__', '__setitem__', '__contains__',
]);

// Python:
// r'^(?:(?:async\s+)?def\s+(\w+)|class\s+(\w+)|(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?class\s+(\w+)|(?:export\s+)?(?:interface|type|enum)\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())'
const _DEF_RE = /^(?:(?:async\s+)?def\s+(\w+)|class\s+(\w+)|(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?class\s+(\w+)|(?:export\s+)?(?:interface|type|enum)\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())/;

// Python: r'^\s*(?:from\s+\S|\bimport\s|\brequire\(|export\s*\{)'
const _SOURCE_IMPORT_RE = /^\s*(?:from\s+\S|\bimport\s|\brequire\(|export\s*\{)/;

// Python: r'^\s*@\w+'
const _DECORATOR_RE = /^\s*@\w+/;

// Python: r'^\s*(?:\*\s*)?@(?:param|returns?|type|template|typedef|property|throws?)\b'
const _DOC_TAG_RE = /^\s*(?:\*\s*)?@(?:param|returns?|type|template|typedef|property|throws?)\b/;

const _MIN_OMISSION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Content Type Detection
// ---------------------------------------------------------------------------

function _isStackTrace(text: string): boolean {
  // Python: bool(_STACK_TRACE_RE.search(text[:2000]))
  // The Python regex uses MULTILINE, so ^ matches start of each line.
  // Equivalent: search in first 2000 chars. We check for the patterns.
  // The Python regex has ^\s+at\s+ and ^\s+File\s+" with MULTILINE, meaning
  // they match at start of any line. In JS, we handle by searching the substring.
  const sample = text.slice(0, 2000);
  // Test for single-line patterns first
  if (/(Traceback|Exception|Error|Caused by:)/.test(sample)) {
    return true;
  }
  // Test for frame patterns (^\s+at\s+ and ^\s+File\s+" with MULTILINE)
  if (/^\s+at\s+/m.test(sample) || /^\s+File\s+"/m.test(sample)) {
    return true;
  }
  return false;
}

function _isJsonString(text: string): boolean {
  // Python: stripped.startswith('{') or stripped.startswith('[') and len(stripped) > 2
  const stripped = text.trim();
  return (stripped.startsWith('{') || stripped.startsWith('[')) && stripped.length > 2;
}

function _isLogOutput(text: string): boolean {
  // Python: lines = text.split('\n', 20)  — splits at most 20 times → up to 21 parts
  const lines = text.split('\n', 21).slice(0, 21);
  let tsCount = 0;
  let sevCount = 0;
  for (const line of lines) {
    if (_TIMESTAMP_LINE_RE.test(line)) tsCount++;
    if (_LOG_SEVERITY_RE.test(line)) sevCount++;
  }
  return tsCount >= 3 || sevCount >= 3;
}

function _isSourceCode(text: string): boolean {
  // Python: for line in text.split('\n', 50) — split at most 50 times → up to 51 parts
  let score = 0;
  const lines = text.split('\n', 51).slice(0, 51);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    if (s.startsWith('import ') || s.startsWith('from ')) {
      score += 2;
    } else if (_DEF_RE.test(s)) {
      score += 3;
    } else if (s.startsWith('export ') || s.startsWith('require(')) {
      score += 2;
    } else if (s.startsWith('const ') || s.startsWith('let ') || s.startsWith('var ')) {
      score += 1;
    } else if (s.startsWith('"""') || s.startsWith("'''")) {
      score += 1;
    }
  }
  return score >= 5;
}

function _isCommentOnlyLine(line: string): boolean {
  const stripped = line.trim();
  return (
    !stripped ||
    stripped.startsWith('/*') ||
    stripped.startsWith('/**') ||
    stripped.startsWith('*/') ||
    stripped.startsWith('*') ||
    stripped.startsWith('//') ||
    stripped.startsWith('#')
  );
}

// ---------------------------------------------------------------------------
// Stack Trace Compression
// ---------------------------------------------------------------------------

function _compressStackTrace(text: string, budget: number, maxUserFrames: number): string {
  const lines = text.split('\n');
  // priority_lines: [priority, index, line]
  const priorityLines: Array<[number, number, string]> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    if (!stripped) continue;

    const lower = stripped.toLowerCase();

    // Priority 1: Exception headers (always keep)
    if (lower.includes('exception') || lower.includes('error:') || lower.includes('caused by:')) {
      priorityLines.push([1000.0 - i * 0.01, i, line]);
      continue;
    }

    // Priority 2: Stack frames (user-code vs library)
    if (_FRAME_RE.test(line)) {
      if (!_USER_FRAME_EXCLUDES.test(stripped)) {
        // User-code frame: high priority, inversely proportional to depth
        const positionScore = 1.0 / Math.max(1, i);
        priorityLines.push([100.0 * positionScore, i, line]);
      } else {
        // Library frame: low priority
        priorityLines.push([1.0 / Math.max(1, i), i, line]);
      }
      continue;
    }

    // Priority 3: Other content
    priorityLines.push([0.1, i, line]);
  }

  // Sort by priority descending, greedily select within budget
  priorityLines.sort((a, b) => b[0] - a[0]);
  const selected: Array<[number, string]> = [];
  let used = 0;
  let userFrameCount = 0;

  for (const [pri, idx, line] of priorityLines) {
    const lineLen = line.length + 1; // +1 for newline
    if (used + lineLen > budget) continue;

    // Cap user frames at maxUserFrames
    if (pri >= 1.0 && pri < 100.0) {
      // Library frame scored by 1/position — not a user frame
      // no-op
    } else if (pri >= 100.0 && pri < 1000.0) {
      // User-code frame range
      if (userFrameCount >= maxUserFrames) continue;
      userFrameCount++;
    }
    selected.push([idx, line]);
    used += lineLen;
  }

  // Restore original line order
  selected.sort((a, b) => a[0] - b[0]);
  let result = selected.map(([, line]) => line).join('\n');
  const omitted = lines.length - selected.length;
  if (omitted > 0) {
    result += `\n... [${omitted} frames omitted]`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// JSON Compression
// ---------------------------------------------------------------------------

function _compressJson(obj: unknown, budget: number, depth: number): string {
  if (budget <= 0) {
    const typeName = obj === null ? 'NoneType' : Array.isArray(obj) ? 'list' : typeof obj === 'object' ? 'dict' : typeof obj;
    return `"...(${typeName} at depth ${depth})"`;
  }

  const depthBudget = depth > 0 ? Math.floor(budget * Math.pow(0.5, depth)) : budget;

  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const dict = obj as Record<string, unknown>;
    if (depth >= 3) {
      return JSON.stringify({
        '__keys': Object.keys(dict).sort(),
        '__depth': depth,
        '__omitted': Object.keys(dict).length,
      });
    }

    const resultParts: string[] = [];
    let remaining = depthBudget;

    const important = new Set([
      'error', 'message', 'status', 'code', 'type',
      'id', 'name', 'result', 'output',
    ]);

    const sortedKeys = Object.keys(dict).sort((a, b) => {
      const aScore = important.has(a.toLowerCase()) ? 0 : 1;
      const bScore = important.has(b.toLowerCase()) ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    for (const key of sortedKeys) {
      if (remaining <= 20) {
        resultParts.push(`  "...": "(${Object.keys(dict).length - resultParts.length} more keys)"`);
        break;
      }
      const val = dict[key];
      // Skip nulls and empty collections when budget is tight
      if (remaining < depthBudget * 0.5) {
        if (val === null || val === undefined) continue;
        if (Array.isArray(val) && val.length === 0) continue;
        if (typeof val === 'object' && val !== null && !Array.isArray(val) && Object.keys(val).length === 0) continue;
      }
      const valStr = _compressJson(val, Math.floor(remaining / 2), depth + 1);
      const entry = `  ${JSON.stringify(key)}: ${valStr}`;
      resultParts.push(entry);
      remaining -= entry.length;
    }

    return '{\n' + resultParts.join(',\n') + '\n}';

  } else if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';

    if (obj.length <= 5) {
      const items = obj.map((item) =>
        _compressJson(item, Math.floor(depthBudget / Math.max(1, obj.length)), depth + 1)
      );
      return '[' + items.join(', ') + ']';
    } else {
      // Check homogeneity across first 5 items
      const types = new Set(obj.slice(0, 5).map((item) => {
        if (item === null) return 'NoneType';
        if (Array.isArray(item)) return 'list';
        return typeof item === 'object' ? 'dict' : typeof item;
      }));

      if (types.size === 1) {
        const head = _compressJson(obj[0], Math.floor(depthBudget / 3), depth + 1);
        return `[${head}, "... (${obj.length - 1} more similar items)"]`;
      } else {
        const head = obj.slice(0, 3).map((item) =>
          _compressJson(item, Math.floor(depthBudget / 8), depth + 1)
        );
        const tail = obj.slice(-2).map((item) =>
          _compressJson(item, Math.floor(depthBudget / 8), depth + 1)
        );
        const mid = `"... (${obj.length - 5} more items)"`;
        return '[' + head.join(', ') + ', ' + mid + ', ' + tail.join(', ') + ']';
      }
    }

  } else {
    // Python: json.dumps(obj, default=str)
    let s: string;
    if (obj === null || obj === undefined) {
      s = 'null';
    } else if (typeof obj === 'boolean') {
      s = obj ? 'true' : 'false';
    } else if (typeof obj === 'number') {
      s = JSON.stringify(obj);
    } else if (typeof obj === 'string') {
      s = JSON.stringify(obj);
    } else {
      // default=str fallback
      s = JSON.stringify(String(obj));
    }
    if (s.length > depthBudget) {
      // Python: json.dumps(str(obj)[:depth_budget - 10] + '...')
      const objStr = String(obj === null || obj === undefined ? 'None' : obj);
      return JSON.stringify(objStr.slice(0, depthBudget - 10) + '...');
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Log Compression
// ---------------------------------------------------------------------------

function _compressLog(text: string, budget: number): string {
  const lines = text.split('\n');

  const high: Array<[number, string]> = [];
  const medium: Array<[number, string]> = [];
  const low: Array<[number, string]> = [];

  // Normalize + hash for dedup
  const seenNormalized = new Map<string, number[]>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    if (!stripped) continue;

    // Normalize for dedup
    let normalized = stripped;
    for (const [reFn, token] of NORMALIZERS) {
      normalized = normalized.replace(reFn(), token);
    }
    const normHash = blake2bHash(normalized);

    if (!seenNormalized.has(normHash)) {
      seenNormalized.set(normHash, []);
    }
    // has() guard is 2 lines above — safe to unwrap
    const groupEntry = seenNormalized.get(normHash);
    if (groupEntry === undefined) continue; // unreachable, satisfies TS
    groupEntry.push(i);

    // Only keep first and last of each normalized group
    const group = groupEntry;
    if (group.length > 2 && i !== group[0]) {
      // Not first — only keep if it's currently the last
      continue;
    }

    // Classify by severity
    const lower = stripped.toLowerCase();
    if ([..._ERROR_KEYWORDS].some((kw) => lower.includes(kw))) {
      high.push([i, line]);
    } else if (
      _LOG_SEVERITY_RE.test(stripped) &&
      ['warn', 'timeout', 'retry', 'refused', 'denied'].some((kw) => lower.includes(kw))
    ) {
      medium.push([i, line]);
    } else {
      low.push([i, line]);
    }
  }

  // Assemble within budget, HIGH first
  const resultLines: Array<[number, string]> = [];
  let remaining = budget;

  // Count markers for deduplicated lines
  const countMarkers = new Map<string, number>();
  for (const [normHash, indices] of seenNormalized.entries()) {
    if (indices.length > 2) {
      countMarkers.set(normHash, indices.length);
    }
  }

  for (const priorityGroup of [high, medium, low]) {
    for (const [idx, line] of priorityGroup) {
      const lineBudget = line.length + 1;
      if (remaining < lineBudget) break;
      resultLines.push([idx, line]);
      remaining -= lineBudget;
    }
  }

  // Sort by original position and format
  resultLines.sort((a, b) => a[0] - b[0]);
  const outputParts: string[] = [];

  for (const [, line] of resultLines) {
    const stripped = line.trim();
    let normalized = stripped;
    for (const [reFn, token] of NORMALIZERS) {
      normalized = normalized.replace(reFn(), token);
    }
    const normHash = blake2bHash(normalized);
    const count = countMarkers.get(normHash);
    if (count !== undefined) {
      outputParts.push(`${line}  [repeated ${count} times]`);
    } else {
      outputParts.push(line);
    }
  }

  const omitted = lines.length - resultLines.length;
  let result = outputParts.join('\n');
  if (omitted > 0) {
    result += `\n... [${omitted} log lines omitted]`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Source Code Compression (unstructured path)
// ---------------------------------------------------------------------------

function _compressSourceCode(text: string, budget: number): string {
  const lines = text.split('\n');
  const n = lines.length;

  // Find and cap module-level docstring
  let i = 0;
  while (i < n && !lines[i].trim()) i++;

  const modDocIndices: number[] = [];
  const MOD_DOC_CAP = 5;
  if (i < n) {
    const s = lines[i].trim();
    if (s.startsWith('"""') || s.startsWith("'''")) {
      const marker = s.slice(0, 3);
      modDocIndices.push(i);
      // Python: not (s.count(marker) >= 2 and len(s) > 3) => multi-line
      const countMarker = s.split(marker).length - 1;
      if (!(countMarker >= 2 && s.length > 3)) {
        let j = i + 1;
        while (j < n) {
          modDocIndices.push(j);
          if (lines[j].trim().endsWith(marker) && j > i) break;
          j++;
        }
      }
    }
  }

  const modDocSet = new Set(modDocIndices);
  const modDocKeep = modDocIndices.slice(0, MOD_DOC_CAP);
  const modDocOmitted = modDocIndices.length - modDocKeep.length;

  // Parse lines into anchor groups
  const alwaysLines: number[] = [];
  interface AnchorGroup {
    sigLine: number;
    decoratorLines: number[];
    name: string;
    priority: number;
    bodyLines: number[];
  }
  const anchorGroups: AnchorGroup[] = [];
  let pendingDecorators: number[] = [];
  let currentGroup: AnchorGroup | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (modDocSet.has(idx)) continue;
    const stripped = line.trim();

    if (!stripped) {
      if (currentGroup !== null) {
        currentGroup.bodyLines.push(idx);
      }
      continue;
    }

    if (_SOURCE_IMPORT_RE.test(line)) {
      alwaysLines.push(idx);
      currentGroup = null;
      pendingDecorators = [];
      continue;
    }

    if (_DECORATOR_RE.test(line)) {
      pendingDecorators.push(idx);
      continue;
    }

    const m = _DEF_RE.exec(stripped);
    if (m) {
      const name = m.slice(1).find((g) => g !== undefined) ?? '';
      const indent = line.length - line.trimStart().length;
      const isDunder = _DUNDER_KEEPERS.has(name);
      const isPrivate = name.startsWith('_') && !isDunder;
      const isEntry = _ENTRY_POINT_NAMES.has(name.toLowerCase());
      const priority = (isEntry ? 300 : !isPrivate ? 200 : 100) - indent * 0.5;

      currentGroup = {
        sigLine: idx,
        decoratorLines: [...pendingDecorators],
        name,
        priority,
        bodyLines: [],
      };
      anchorGroups.push(currentGroup);
      pendingDecorators = [];
      continue;
    }

    if (currentGroup !== null) {
      currentGroup.bodyLines.push(idx);
    } else {
      if (pendingDecorators.length > 0) {
        alwaysLines.push(...pendingDecorators);
        pendingDecorators = [];
      }
      alwaysLines.push(idx);
    }
  }

  // Build mandatory set
  const mandatory = new Set<number>(modDocKeep);
  for (const al of alwaysLines) mandatory.add(al);
  for (const g of anchorGroups) {
    mandatory.add(g.sigLine);
    for (const dl of g.decoratorLines) mandatory.add(dl);
    // First non-blank body line if it looks like a docstring
    for (const li of g.bodyLines) {
      if (!lines[li].trim()) continue;
      const s = lines[li].trim();
      if (s.startsWith('"""') || s.startsWith("'''") || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) {
        mandatory.add(li);
      }
      break; // only check the very first non-blank body line
    }
  }

  const lc = (idx: number): number => lines[idx].length + 1;

  let mandatoryChars = 0;
  for (const mi of mandatory) mandatoryChars += lc(mi);
  if (modDocOmitted > 0) mandatoryChars += 50;
  let remaining = Math.max(0, budget - mandatoryChars);

  // Fill bodies by priority
  const includedBody = new Set<number>();
  const MARKER_COST = 45;

  const sortedGroups = [...anchorGroups].sort((a, b) => b.priority - a.priority);
  for (const group of sortedGroups) {
    if (remaining <= 0) break;
    const body = group.bodyLines.filter((li) => !mandatory.has(li));
    if (body.length === 0) continue;

    const bodyChars = body.reduce((sum, li) => sum + lc(li), 0);
    if (bodyChars <= remaining) {
      for (const li of body) includedBody.add(li);
      remaining -= bodyChars;
    } else {
      // Fit lines from the top of the body, leave room for omission marker
      let used = 0;
      for (const li of body) {
        const cost = lc(li);
        if (used + cost + MARKER_COST > remaining) break;
        includedBody.add(li);
        used += cost;
      }
      remaining -= used;
    }
  }

  // Reconstruct in original line order
  const allIncluded = new Set<number>([...mandatory, ...includedBody]);
  const result: string[] = [];

  // Module docstring block
  for (const idx of modDocKeep) result.push(lines[idx]);
  if (modDocOmitted > 0) {
    result.push(`# ... [${modDocOmitted} docstring lines omitted]`);
  }

  // Scan remaining lines in order, inserting omission markers at cut points
  let pendingBlanks: string[] = [];
  let omitCount = 0;
  let omitIndent = '    ';

  for (let idx = 0; idx < lines.length; idx++) {
    if (modDocSet.has(idx)) continue;
    const line = lines[idx];

    if (!line.trim()) {
      pendingBlanks.push(line);
      continue;
    }

    if (allIncluded.has(idx)) {
      if (omitCount > 0) {
        result.push(`${omitIndent}# ... [${omitCount} lines omitted]`);
        omitCount = 0;
      }
      result.push(...pendingBlanks);
      pendingBlanks = [];
      result.push(line);
      omitIndent = ' '.repeat(line.length - line.trimStart().length + 4);
    } else {
      pendingBlanks = []; // discard blanks belonging to omitted section
      omitCount++;
    }
  }

  if (omitCount > 0) {
    result.push(`${omitIndent}# ... [${omitCount} lines omitted]`);
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Structured Source Compression (tree-sitter metadata path)
// ---------------------------------------------------------------------------

function _stripDocBlocksBeforeBlocks(
  lines: string[],
  topLevelLines: number[],
  structure: StructureBlock[],
): number[] {
  const topLevelSet = new Set(topLevelLines);
  const remove = new Set<number>();

  for (const block of structure) {
    let scan = block.startLine - 1;
    const span: number[] = [];
    let hasDocTags = false;

    while (scan >= 0 && topLevelSet.has(scan) && _isCommentOnlyLine(lines[scan])) {
      span.push(scan);
      if (_DOC_TAG_RE.test(lines[scan])) {
        hasDocTags = true;
      }
      scan--;
    }

    if (hasDocTags) {
      for (const s of span) remove.add(s);
    }
  }

  return topLevelLines.filter((idx) => !remove.has(idx));
}

function _compressSourceStructured(
  text: string,
  budget: number,
  structure: StructureBlock[],
): string {
  const lines = text.split('\n');
  const n = lines.length;

  if (structure.length === 0) {
    return compressString(text, budget);
  }

  if (budget >= text.length) {
    return text;
  }

  // Score each block — mutate a local copy to avoid affecting caller
  // Python mutates block dicts in place; we do the same with a working copy
  const workingStructure: Array<StructureBlock & { priority: number }> = structure.map((block) => {
    const name = (block.name ?? '').trim();
    const exported = block.exported ?? false;
    let priority: number;

    if (name === '__main__' || name.startsWith('test_') || name.startsWith('Test')) {
      priority = 10;
    } else if (_ENTRY_POINT_NAMES.has(name.toLowerCase()) || _DUNDER_KEEPERS.has(name) || exported) {
      priority = 300;
    } else if (name.startsWith('_')) {
      priority = 100;
    } else {
      priority = 200;
    }

    return { ...block, priority };
  });

  // Identify lines that belong to at least one block
  const allBlockLines = new Set<number>();
  for (const block of workingStructure) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    for (let ln = start; ln <= end; ln++) {
      allBlockLines.add(ln);
    }
  }

  // Top-level lines (imports, constants, module-level code) → always first
  const resultLines = new Map<number, string>();
  let topLevelLines = Array.from({ length: n }, (_, i) => i).filter((i) => !allBlockLines.has(i));
  topLevelLines = _stripDocBlocksBeforeBlocks(lines, topLevelLines, workingStructure);

  // Fix 1: reclassify `if __name__ == '__main__':` block
  const mainStart = topLevelLines.find((i) => lines[i].trim().startsWith('if __name__')) ?? null;
  if (mainStart !== null) {
    const mainLines = topLevelLines.filter((i) => i >= mainStart);
    topLevelLines = topLevelLines.filter((i) => i < mainStart);
    workingStructure.push({
      type: 'main_block',
      name: '__main__',
      kind: 'main_block',
      startLine: mainStart,
      endLine: mainLines[mainLines.length - 1],
      exported: false,
      anchors: [],
      priority: 10,
    });
  }

  // Fix 2: Hard budget cap on top-level lines (40% of budget max)
  const topLevelCap = Math.floor(budget * 40 / 100);
  const topLevelCost = topLevelLines.reduce((sum, i) => sum + lines[i].length + 1, 0);
  if (topLevelCost > topLevelCap) {
    const importSet = new Set(topLevelLines.filter((i) => _SOURCE_IMPORT_RE.test(lines[i])));
    const importCost = [...importSet].reduce((sum, i) => sum + lines[i].length + 1, 0);
    let rem = topLevelCap - importCost;
    const kept: number[] = [...importSet];
    for (const i of topLevelLines) {
      if (importSet.has(i)) continue;
      const cost = lines[i].length + 1;
      if (rem <= 0) break;
      kept.push(i);
      rem -= cost;
    }
    topLevelLines = kept.sort((a, b) => a - b);
  }

  for (const i of topLevelLines) {
    resultLines.set(i, lines[i]);
  }
  let used = topLevelLines.reduce((sum, i) => sum + lines[i].length + 1, 0);

  // Fill blocks by priority, highest first
  const sortedBlocks = [...workingStructure].sort((a, b) => b.priority - a.priority);

  const lineCost = (idx: number): number => lines[idx].length + 1;

  const renderedSignature = (idx: number): string => lines[idx] + `  # L${idx + 1}`;

  const renderedSignatureCost = (idx: number): number => renderedSignature(idx).length + 1;

  for (const block of sortedBlocks) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    if (start > end) continue;

    // Only charge for lines not already included
    const newIndices = Array.from({ length: end - start + 1 }, (_, k) => start + k)
      .filter((i) => !resultLines.has(i));
    if (newIndices.length === 0) continue;

    const sigText = renderedSignature(start);
    const sigSize = renderedSignatureCost(start);
    const newSize = sigSize + newIndices.filter((i) => i !== start).reduce((sum, i) => sum + lineCost(i), 0);
    const rangeMarker = `    # ... [lines ${start + 2}-${end + 1} omitted]`;
    const rangeMarkerCost = rangeMarker.length + 1;

    if (used + newSize <= budget) {
      // Full block fits — annotate signature with 1-based line number
      for (const i of newIndices) {
        resultLines.set(i, lines[i]);
      }
      resultLines.set(start, sigText);
      used += newSize;
    } else if (!resultLines.has(start) && used + sigSize + rangeMarkerCost <= budget) {
      const bodyIndices = newIndices.filter((i) => i !== start);
      const anchorSpecs = [...(block.anchors ?? [])].sort(
        (a: Anchor, b: Anchor) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          return (a.startLine ?? start) - (b.startLine ?? start);
        }
      );

      const selectedSet = new Set<number>();
      let selectedBodyCost = 0;
      const anchorPriorityByLine = new Map<number, number>();
      const remaining = budget - used - sigSize;

      const bodyRenderCost = (indices: Set<number> | number[]): number => {
        const sortedIndices = [...indices].sort((a, b) => a - b);
        if (sortedIndices.length === 0) return 0;

        let cost = 0;
        let prevIdx = start;
        for (const idx of sortedIndices) {
          if (idx > prevIdx + 1 && (idx - prevIdx - 1) >= _MIN_OMISSION_THRESHOLD) {
            const indent = ' '.repeat(lines[idx].length - lines[idx].trimStart().length);
            const gapMarker = `${indent}# ... [lines ${prevIdx + 2}-${idx} omitted]`;
            cost += gapMarker.length + 1;
          }
          cost += lineCost(idx);
          prevIdx = idx;
        }
        return cost;
      };

      const tryAddRange = (indices: number[], priority?: number): boolean => {
        if (indices.length === 0) return false;

        const newLocal = indices.filter((idx) => !selectedSet.has(idx));
        if (newLocal.length === 0) return false;

        const newCost = newLocal.reduce((sum, idx) => sum + lineCost(idx), 0);
        const candidateCost = selectedBodyCost + newCost;
        if (candidateCost > remaining) return false;

        for (const idx of newLocal) {
          selectedSet.add(idx);
          if (priority !== undefined) {
            anchorPriorityByLine.set(idx, Math.max(anchorPriorityByLine.get(idx) ?? priority, priority));
          }
        }
        selectedBodyCost = candidateCost;
        return true;
      };

      for (const anchor of anchorSpecs) {
        const anchorStart = Math.max(start + 1, Math.min(end, anchor.startLine ?? (start + 1)));
        const anchorEnd = Math.max(anchorStart, Math.min(end, anchor.endLine ?? anchorStart));
        tryAddRange(
          Array.from({ length: anchorEnd - anchorStart + 1 }, (_, k) => anchorStart + k)
            .filter((idx) => bodyIndices.includes(idx)),
          anchor.priority,
        );
      }

      if (bodyRenderCost(selectedSet) > remaining) {
        const removable = [...anchorPriorityByLine.keys()].sort((a, b) => {
          const pa = anchorPriorityByLine.get(a) ?? 0;
          const pb = anchorPriorityByLine.get(b) ?? 0;
          if (pa !== pb) return pa - pb;
          return b - a;
        });
        while (removable.length > 0 && bodyRenderCost(selectedSet) > remaining) {
          const toRemove = removable.shift();
          if (toRemove === undefined) break;
          selectedSet.delete(toRemove);
        }
        selectedBodyCost = [...selectedSet].reduce((sum, idx) => sum + lineCost(idx), 0);
      }

      // Use any leftover budget to fill local context in source order
      for (const idx of bodyIndices) {
        if (selectedSet.has(idx)) continue;
        const candidate = new Set(selectedSet);
        candidate.add(idx);
        if (bodyRenderCost(candidate) > remaining) break;
        selectedSet.add(idx);
        selectedBodyCost += lineCost(idx);
      }

      if (selectedSet.size > 0) {
        const omittedLines = bodyIndices.filter((idx) => !selectedSet.has(idx));
        let omittedCount = omittedLines.length;
        if (omittedCount > 0 && omittedCount < _MIN_OMISSION_THRESHOLD) {
          const candidate = new Set(selectedSet);
          for (const idx of omittedLines) candidate.add(idx);
          if (bodyRenderCost(candidate) <= remaining) {
            for (const idx of omittedLines) {
              selectedSet.add(idx);
              selectedBodyCost += lineCost(idx);
            }
            omittedCount = 0;
          }
        }

        const finalBody = [...selectedSet].sort((a, b) => a - b);
        const bodyCost = bodyRenderCost(finalBody);

        resultLines.set(start, sigText);
        for (const idx of finalBody) {
          resultLines.set(idx, lines[idx]);
        }
        used += sigSize + bodyCost;
        continue;
      }

      // Signature + range omission marker
      resultLines.set(start, sigText);
      const markerLine = start + 1;
      if (markerLine <= end && !resultLines.has(markerLine)) {
        resultLines.set(markerLine, rangeMarker);
        used += sigSize + rangeMarkerCost;
      } else {
        used += sigSize;
      }
    }
    // else: budget exhausted, block entirely omitted
  }

  // Reassemble in original line order with gap markers
  if (resultLines.size >= 2) {
    const tinyGapLines = new Set<number>();
    const sortedKeys = [...resultLines.keys()].sort((a, b) => a - b);
    let prev = sortedKeys[0];
    for (let ki = 1; ki < sortedKeys.length; ki++) {
      const ln = sortedKeys[ki];
      const gap = ln - prev - 1;
      if (gap > 0 && gap < _MIN_OMISSION_THRESHOLD) {
        for (let g = prev + 1; g < ln; g++) tinyGapLines.add(g);
      }
      prev = ln;
    }

    for (const idx of [...tinyGapLines].sort((a, b) => a - b)) {
      if (!resultLines.has(idx) && used + lineCost(idx) <= budget) {
        resultLines.set(idx, lines[idx]);
        used += lineCost(idx);
      }
    }
  }

  const output: string[] = [];
  const sortedKeys = [...resultLines.keys()].sort((a, b) => a - b);
  let prev = -1;
  let actualUsed = 0;

  for (const ln of sortedKeys) {
    const lineText = resultLines.get(ln) ?? '';
    const lineSize = lineText.length + 1;
    if (prev >= 0 && ln > prev + 1) {
      const prevContent = output.length > 0 ? output[output.length - 1] : '';
      if (!prevContent.includes('# ...') && (ln - prev - 1) >= _MIN_OMISSION_THRESHOLD) {
        const indent = ' '.repeat(lineText.length - lineText.trimStart().length);
        const gapMarker = `${indent}# ... [lines ${prev + 2}-${ln} omitted]`;
        const gapMarkerSize = gapMarker.length + 1;
        if (actualUsed + gapMarkerSize + lineSize <= budget) {
          output.push(gapMarker);
          actualUsed += gapMarkerSize;
        }
      }
    }
    if (actualUsed + lineSize > budget) break;
    output.push(lineText);
    actualUsed += lineSize;
    prev = ln;
  }

  return output.join('\n');
}

// ---------------------------------------------------------------------------
// Default: Content-Aware Truncation
// ---------------------------------------------------------------------------

function _contentAwareTruncate(text: string, budget: number): string {
  // Detect if error/result info is at the tail
  const tail20pct = text.slice(Math.floor(text.length * 0.8));
  const tailHasError = [..._ERROR_KEYWORDS].some((kw) => tail20pct.toLowerCase().includes(kw));

  const head10pct = text.slice(0, Math.max(1, Math.floor(text.length * 0.1)));
  const headHasStructure = head10pct.split('\n').length - 1 < 3 && head10pct.includes(':');

  let headRatio: number;
  if (tailHasError) {
    headRatio = 0.4;
  } else if (headHasStructure) {
    headRatio = 0.8;
  } else {
    headRatio = 0.5;
  }

  const marker = '\n...[content truncated]...\n';
  const usable = budget - marker.length;
  if (usable <= 0) {
    return text.slice(0, budget);
  }
  const headBudget = Math.floor(usable * headRatio);
  const tailBudget = usable - headBudget;

  return text.slice(0, headBudget) + marker + text.slice(-tailBudget);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compress a string using content-type detection and type-specific strategies.
 *
 * Dispatch order (follows Python source exactly):
 *   1. _isSourceCode (import/def patterns are unambiguous structural signals)
 *   2. _isStackTrace
 *   3. _isJsonString → parse + _compressJson
 *   4. _isLogOutput
 *   5. _contentAwareTruncate (fallback)
 */
export function compressString(text: string, budget: number, maxUserFrames = 10): string {
  if (text.length <= budget) return text;

  if (_isSourceCode(text)) {
    return _compressSourceCode(text, budget);
  }

  if (_isStackTrace(text)) {
    return _compressStackTrace(text, budget, maxUserFrames);
  }

  if (_isJsonString(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      return _compressJson(parsed, budget, 0);
    } catch (e: unknown) {
      if (e instanceof SyntaxError || e instanceof RangeError) {
        // json.JSONDecodeError / RecursionError equivalents — fall through
      } else {
        throw e;
      }
    }
  }

  if (_isLogOutput(text)) {
    return _compressLog(text, budget);
  }

  return _contentAwareTruncate(text, budget);
}

/**
 * Compress source code using pre-parsed tree-sitter block structure.
 *
 * structure contains StructureBlock items with camelCase fields:
 *   startLine (0-based), endLine (0-based inclusive), name, type, exported, anchors
 */
export function compressSourceStructured(
  text: string,
  budget: number,
  structure: StructureBlock[],
): string {
  return _compressSourceStructured(text, budget, structure);
}
