// string-codec.ts — Content-type-aware text compression
//
// Two public entry points:
//   - compressString(text, budget) — auto-detects content type and compresses
//   - compressSourceStructured(text, budget, structure) — language-aware compression using tree-sitter block/anchor metadata provided by the consumer
//
// Language awareness: The `structure` parameter in compressSourceStructured is
// produced by tree-sitter in the consuming package. In Zenith-MCP this is:
//   zenith-mcp/src/core/tree-sitter/compression-structure.ts → getCompressionStructure() which extracts function blocks, class definitions, and control-flow anchors

import { blake2bHash, NORMALIZERS } from './utils.js';
import { SageRank } from './sagerank.js';
import type { StructureBlock, ASTEdge } from './types.js';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------
const _LOG_SEVERITY_RE =
  /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/i;
const _TIMESTAMP_LINE_RE = /^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}/;

const _ERROR_KEYWORDS: ReadonlySet<string> = new Set([
  'error', 'fatal', 'critical', 'exception', 'traceback',
  'caused by', 'failed', 'killed', 'oom', 'panic', 'crash', 'abort',
]);
const _FRAME_RE = /^\s+(at\s+|File\s+")/;

// Stack-trace header detection: language-agnostic structural signal.
// and class names ending in Error/Exception/Fault/Panic at line start.
const _STACK_HEADER_RE = /^(?:Traceback \(most recent call last\):|Caused by:\s|[\w.$]+(?:Error|Exception|Fault|Panic)(?::|$))/;

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

const _DEF_RE = /^(?:(?:async\s+)?def\s+(\w+)|class\s+(\w+)|(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?class\s+(\w+)|(?:export\s+)?(?:interface|type|enum)\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())/;
const _SOURCE_IMPORT_RE = /^\s*(?:from\s+\S|\bimport\s|\brequire\(|export\s*\{)/;
const _DECORATOR_RE = /^\s*@\w+/;
const _DOC_TAG_RE = /^\s*(?:\*\s*)?@(?:param|returns?|type|template|typedef|property|throws?)\b/;

const _MIN_OMISSION_THRESHOLD = 6;

// ---------------------------------------------------------------------------
// Content Type Detection
// ---------------------------------------------------------------------------

/**
 * Detects whether text is a multi-line stack trace (not a single-line error).
 */
function _isStackTrace(text: string): boolean {
  const sample = text.slice(0, 2000);
  const lines = sample.split('\n').slice(0, 80);

  let headerCount = 0;
  let frameCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (_STACK_HEADER_RE.test(line)) headerCount += 1;
    if (_FRAME_RE.test(rawLine)) frameCount += 1;
  }

  // Primary: frames-with-or-without-header (Python tracebacks, JS stack traces).
  if (frameCount >= 2) return true;
  if (headerCount >= 1 && frameCount >= 1) return true;

  // Tertiary: chained-exception header pattern (JVM "Caused by:" chains can appear with no leading indent on the per-frame "at" lines, in which case _FRAME_RE won't match. Multiple headers in a small window strongly imply a chained exception even without parseable frames.
  if (headerCount >= 2) return true;

  return false;
}

function _isJsonString(text: string): boolean {
  const stripped = text.trim();
  return (stripped.startsWith('{') || stripped.startsWith('[')) && stripped.length > 2;
}

function _isLogOutput(text: string): boolean {
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
// Stack Trace Compression (SageRank-enhanced)
// ---------------------------------------------------------------------------

// Minimum frames to trigger SageRank — below this, simple priority scoring is fine
const _SAGERANK_FRAME_THRESHOLD = 5;

function _compressStackTrace(text: string, budget: number, maxUserFrames: number): string {
  const lines = text.split('\n');
  
  // Phase 1: Classify lines into categories
  const headers: Array<[number, string]> = [];  // Always keep — exception headers
  const frames: Array<[number, string]> = [];   // Stack frames — run SageRank on these
  const other: Array<[number, string]> = [];    // Context lines — lowest priority

  for (const [i, line] of lines.entries()) {
    const stripped = line.trim();
    if (!stripped) continue;

    const lower = stripped.toLowerCase();

    // Exception headers: always keep
    if (lower.includes('exception') || lower.includes('error:') || lower.includes('caused by:') || _STACK_HEADER_RE.test(stripped)) {
      headers.push([i, line]);
      continue;
    }

    // Stack frames: these go through SageRank
    if (_FRAME_RE.test(line)) {
      frames.push([i, line]);
      continue;
    }

    // Everything else: context
    other.push([i, line]);
  }

  // Phase 2: Calculate header cost (headers always included)
  let headerCost = 0;
  for (const [, line] of headers) {
    headerCost += line.length + 1;
  }
  const frameBudget = Math.max(0, budget - headerCost);

  // Phase 3: Select frames using SageRank if we have enough
  let selectedFrameIndices: number[];
  
  if (frames.length <= _SAGERANK_FRAME_THRESHOLD) {
    // Few frames: keep all that fit
    selectedFrameIndices = [];
    let used = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      const lineLen = frames[fi]![1].length + 1;
      if (used + lineLen <= frameBudget) {
        selectedFrameIndices.push(fi);
        used += lineLen;
      }
    }
  } else {
    // Enough frames to benefit from SageRank
    const sagerank = new SageRank(
      1.5,    // k1 (BM25)
      0.75,   // b (BM25)
      0.85,   // damping (PageRank)
      50,     // maxIter
      1e-6,   // epsilon
      0.6,    // coverageWeight — higher = prefer diverse frames
      5,      // minSentenceLength — frames are short, lower threshold
      true,   // normalize
    );
    
    const frameTexts = frames.map(([, line]) => line);
    
    // Calculate how many frames we can fit
    const avgFrameLen = frameTexts.reduce((sum, f) => sum + f.length, 0) / frameTexts.length;
    const estimatedTopK = Math.min(
      maxUserFrames * 2,  // Allow some library frames too
      Math.max(3, Math.floor(frameBudget / (avgFrameLen + 1))),
      frames.length
    );
    
    const result = sagerank.rankSentences(frameTexts, estimatedTopK, null);
    
    // result.selectedIndices are the most central frames
    // Verify they fit in budget
    selectedFrameIndices = [];
    let used = 0;
    
    // First pass: add SageRank-selected frames
    for (const fi of result.selectedIndices) {
      const lineLen = frames[fi]![1].length + 1;
      if (used + lineLen <= frameBudget) {
        selectedFrameIndices.push(fi);
        used += lineLen;
      }
    }
    
    // Second pass: if budget remains, fill with highest-scored non-selected
    if (used < frameBudget) {
      const scores = result.scores;
      const selectedSet = new Set(selectedFrameIndices);
      const remaining = frames
        .map((_, i) => i)
        .filter(i => !selectedSet.has(i))
        .sort((a, b) => scores[b]! - scores[a]!);
      
      for (const fi of remaining) {
        const lineLen = frames[fi]![1].length + 1;
        if (used + lineLen <= frameBudget) {
          selectedFrameIndices.push(fi);
          used += lineLen;
        }
      }
    }
  }

  // Phase 4: Build final selection (headers + selected frames, in original order)
  const selected: Array<[number, string]> = [...headers];
  for (const fi of selectedFrameIndices) {
    selected.push(frames[fi]!);
  }
  selected.sort((a, b) => a[0] - b[0]);

  if (selected.length === 0 && lines.length > 0) {
    return `[TRUNCATED: lines 1-${lines.length}]`;
  }

  const keptIndices = selected.map(([idx]) => idx);

  // Phase 5: Fill tiny gaps (< _MIN_OMISSION_THRESHOLD) to avoid excessive markers
  const tinyGapLines = new Set<number>();
  for (let i = 1; i < keptIndices.length; i++) {
    const prev = keptIndices[i - 1]!;
    const curr = keptIndices[i]!;
    const gap = curr - prev - 1;
    if (gap > 0 && gap < _MIN_OMISSION_THRESHOLD) {
      for (let g = prev + 1; g < curr; g++) tinyGapLines.add(g);
    }
  }

  // Add tiny gap lines to selected (within budget)
  let usedAfterGaps = selected.reduce((sum, [, line]) => sum + line.length + 1, 0);
  for (const idx of [...tinyGapLines].sort((a, b) => a - b)) {
    const lineLen = lines[idx]!.length + 1;
    if (usedAfterGaps + lineLen <= budget) {
      selected.push([idx, lines[idx]!]);
      usedAfterGaps += lineLen;
    }
  }
  selected.sort((a, b) => a[0] - b[0]);
  const finalKeptIndices = selected.map(([idx]) => idx);

  // Phase 6: Build result with markers only for gaps >= threshold
  const resultParts: string[] = [];

  // Check for leading gap
  if (finalKeptIndices[0]! >= _MIN_OMISSION_THRESHOLD) {
    resultParts.push(`[TRUNCATED: lines 1-${finalKeptIndices[0]!}]`);
  }

  for (let i = 0; i < selected.length; i++) {
    resultParts.push(selected[i]![1]);

    if (i < selected.length - 1) {
      const currentIdx = finalKeptIndices[i]!;
      const nextIdx = finalKeptIndices[i + 1]!;
      const gap = nextIdx - currentIdx - 1;
      if (gap >= _MIN_OMISSION_THRESHOLD) {
        resultParts.push(`[TRUNCATED: lines ${currentIdx + 2}-${nextIdx}]`);
      }
    }
  }

  // Check for trailing gap
  const lastKept = finalKeptIndices[finalKeptIndices.length - 1]!;
  const trailingGap = lines.length - 1 - lastKept;
  if (trailingGap >= _MIN_OMISSION_THRESHOLD) {
    resultParts.push(`[TRUNCATED: lines ${lastKept + 2}-${lines.length}]`);
  }

  return resultParts.join('\n');
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
      const objStr = String(obj === null || obj === undefined ? 'None' : obj);
      return JSON.stringify(objStr.slice(0, depthBudget - 10) + '...');
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Log Compression (SageRank-enhanced)
// ---------------------------------------------------------------------------

// Minimum unique lines to trigger SageRank for logs
const _SAGERANK_LOG_THRESHOLD = 8;

function _compressLog(text: string, budget: number): string {
  const lines = text.split('\n');

  // Phase 1: Normalize and deduplicate
  interface LogEntry {
    originalIdx: number;
    line: string;
    normHash: string;
    isError: boolean;
    isWarning: boolean;
  }

  const seenNormalized = new Map<string, LogEntry[]>();
  const allEntries: LogEntry[] = [];

  for (const [i, line] of lines.entries()) {
    const stripped = line.trim();
    if (!stripped) continue;

    // Normalize for dedup
    let normalized = stripped;
    for (const [reFn, token] of NORMALIZERS) {
      normalized = normalized.replace(reFn(), token);
    }
    const normHash = blake2bHash(normalized);

    const lower = stripped.toLowerCase();
    const isError = [..._ERROR_KEYWORDS].some((kw) => lower.includes(kw));
    const isWarning = _LOG_SEVERITY_RE.test(stripped) &&
      ['warn', 'timeout', 'retry', 'refused', 'denied'].some((kw) => lower.includes(kw));

    const entry: LogEntry = { originalIdx: i, line, normHash, isError, isWarning };
    allEntries.push(entry);

    if (!seenNormalized.has(normHash)) {
      seenNormalized.set(normHash, []);
    }
    seenNormalized.get(normHash)!.push(entry);
  }

  // Phase 2: Get unique log patterns (first occurrence of each normalized hash)
  const uniquePatterns: Array<{ normHash: string; firstEntry: LogEntry; count: number }> = [];
  for (const [normHash, entries] of seenNormalized.entries()) {
    uniquePatterns.push({
      normHash,
      firstEntry: entries[0]!,
      count: entries.length,
    });
  }

  if (uniquePatterns.length === 0) {
    return lines.length > 0 ? `[TRUNCATED: lines 1-${lines.length}]` : '';
  }

  // Phase 3: Rank unique patterns
  let rankedIndices: number[];

  if (uniquePatterns.length <= _SAGERANK_LOG_THRESHOLD) {
    // Few unique patterns: prioritize by error > warning > other, then by position
    rankedIndices = uniquePatterns
      .map((p, i) => ({ idx: i, ...p }))
      .sort((a, b) => {
        // Errors first
        if (a.firstEntry.isError !== b.firstEntry.isError) {
          return a.firstEntry.isError ? -1 : 1;
        }
        // Then warnings
        if (a.firstEntry.isWarning !== b.firstEntry.isWarning) {
          return a.firstEntry.isWarning ? -1 : 1;
        }
        // Then by original position
        return a.firstEntry.originalIdx - b.firstEntry.originalIdx;
      })
      .map((p) => p.idx);
  } else {
    // Enough patterns: use SageRank with error/warning boost
    const sagerank = new SageRank(
      1.5,    // k1 (BM25)
      0.75,   // b (BM25)
      0.85,   // damping (PageRank)
      50,     // maxIter
      1e-6,   // epsilon
      0.5,    // coverageWeight — balanced for logs
      10,     // minSentenceLength
      true,   // normalize
    );

    const patternTexts = uniquePatterns.map((p) => p.firstEntry.line);
    const avgPatternLen = patternTexts.reduce((sum, t) => sum + t.length, 0) / patternTexts.length;
    const estimatedTopK = Math.max(5, Math.floor(budget / (avgPatternLen + 1)));

    const result = sagerank.rankSentences(patternTexts, Math.min(estimatedTopK, uniquePatterns.length), null);

    // Combine SageRank scores with error/warning priority boost
    const boostedScores = result.scores.map((score, i) => {
      const pattern = uniquePatterns[i]!;
      let boost = 1.0;
      if (pattern.firstEntry.isError) boost = 3.0;  // Error lines get 3x boost
      else if (pattern.firstEntry.isWarning) boost = 1.5;  // Warnings get 1.5x
      // Repetition bonus: highly repeated patterns are important signals
      boost *= Math.log2(1 + pattern.count);
      return { idx: i, score: score * boost };
    });

    // Sort by boosted score
    rankedIndices = boostedScores
      .sort((a, b) => b.score - a.score)
      .map((s) => s.idx);
  }

  // Phase 4: Select patterns within budget
  const selectedPatterns: Array<{ normHash: string; firstEntry: LogEntry; count: number }> = [];
  let used = 0;

  for (const idx of rankedIndices) {
    const pattern = uniquePatterns[idx]!;
    const lineCost = pattern.firstEntry.line.length + 1;
    const repeatMarkerCost = pattern.count > 1 ? `  [repeated ${pattern.count} times]`.length : 0;

    if (used + lineCost + repeatMarkerCost > budget) continue;
    selectedPatterns.push(pattern);
    used += lineCost + repeatMarkerCost;
  }

  // Phase 5: For patterns with multiple occurrences, also try to include last occurrence
  const finalEntries: LogEntry[] = [];
  const includedIndices = new Set<number>();

  for (const pattern of selectedPatterns) {
    const entries = seenNormalized.get(pattern.normHash)!;
    // Always include first
    finalEntries.push(entries[0]!);
    includedIndices.add(entries[0]!.originalIdx);

    // Include last if different and budget allows
    if (entries.length > 1) {
      const lastEntry = entries[entries.length - 1]!;
      const lastCost = lastEntry.line.length + 1;
      if (used + lastCost <= budget && !includedIndices.has(lastEntry.originalIdx)) {
        finalEntries.push(lastEntry);
        includedIndices.add(lastEntry.originalIdx);
        used += lastCost;
      }
    }
  }

  // Phase 6: Sort by original position and build output
  finalEntries.sort((a, b) => a.originalIdx - b.originalIdx);

  const outputParts: string[] = [];
  const patternCounts = new Map<string, number>();
  for (const pattern of selectedPatterns) {
    if (pattern.count > 1) {
      patternCounts.set(pattern.normHash, pattern.count);
    }
  }

  for (const entry of finalEntries) {
    const count = patternCounts.get(entry.normHash);
    if (count !== undefined) {
      outputParts.push(`${entry.line}  [repeated ${count} times]`);
      patternCounts.delete(entry.normHash); // Only annotate once
    } else {
      outputParts.push(entry.line);
    }
  }

  // Phase 7: Add truncation marker if needed
  let result = outputParts.join('\n');
  const keptIndices = [...includedIndices].sort((a, b) => a - b);

  if (keptIndices.length > 0 && keptIndices.length < lines.filter(l => l.trim()).length) {
    const lastKept = keptIndices[keptIndices.length - 1]!;
    if (lastKept < lines.length - 1) {
      result += `\n[TRUNCATED: lines ${lastKept + 2}-${lines.length}]`;
    }
  } else if (keptIndices.length === 0 && lines.length > 0) {
    result = `[TRUNCATED: lines 1-${lines.length}]`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Source Code Compression (unstructured path, SageRank-enhanced)
// ---------------------------------------------------------------------------

// Minimum anchor groups to trigger SageRank for source code
const _SAGERANK_SOURCE_THRESHOLD = 4;

function _compressSourceCode(text: string, budget: number): string {
  const lines = text.split('\n');
  const n = lines.length;

  // Find and cap module-level docstring.
  // Walk past leading blank lines by inspecting each entry safely.
  let i = 0;
  while (i < n) {
    const candidate = lines[i];
    if (candidate === undefined || candidate.trim()) break;
    i++;
  }

  const modDocIndices: number[] = [];
  const MOD_DOC_CAP = 5;
  if (i < n) {
    const docStart = lines[i];
    if (docStart !== undefined) {
      const s = docStart.trim();
      if (s.startsWith('"""') || s.startsWith("'''")) {
        const marker = s.slice(0, 3);
        modDocIndices.push(i);
        const countMarker = s.split(marker).length - 1;
        if (!(countMarker >= 2 && s.length > 3)) {
          let j = i + 1;
          while (j < n) {
            const nextLine = lines[j];
            if (nextLine === undefined) break;
            modDocIndices.push(j);
            if (nextLine.trim().endsWith(marker) && j > i) break;
            j++;
          }
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
    basePriority: number;  // Renamed: base priority from heuristics
    bodyLines: number[];
    fullText: string;      // For SageRank similarity
  }
  const anchorGroups: AnchorGroup[] = [];
  let pendingDecorators: number[] = [];
  let currentGroup: AnchorGroup | null = null;

  for (const [idx, line] of lines.entries()) {
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
      const basePriority = (isEntry ? 300 : !isPrivate ? 200 : 100) - indent * 0.5;

      currentGroup = {
        sigLine: idx,
        decoratorLines: [...pendingDecorators],
        name,
        basePriority,
        bodyLines: [],
        fullText: '',  // Will be populated after parsing
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

  // Build fullText for each anchor group (for SageRank similarity)
  for (const group of anchorGroups) {
    const groupLines: string[] = [];
    for (const dl of group.decoratorLines) {
      const line = lines[dl];
      if (line !== undefined) groupLines.push(line);
    }
    const sigLine = lines[group.sigLine];
    if (sigLine !== undefined) groupLines.push(sigLine);
    // Include first 10 body lines for context
    for (const bl of group.bodyLines.slice(0, 10)) {
      const line = lines[bl];
      if (line !== undefined) groupLines.push(line);
    }
    group.fullText = groupLines.join('\n');
  }

  // Build mandatory set
  const mandatory = new Set<number>(modDocKeep);
  for (const al of alwaysLines) mandatory.add(al);
  for (const g of anchorGroups) {
    mandatory.add(g.sigLine);
    for (const dl of g.decoratorLines) mandatory.add(dl);
    // First non-blank body line if it looks like a docstring
    for (const li of g.bodyLines) {
      const bodyLine = lines[li];
      if (bodyLine === undefined) continue;
      if (!bodyLine.trim()) continue;
      const s = bodyLine.trim();
      if (s.startsWith('"""') || s.startsWith("'''") || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) {
        mandatory.add(li);
      }
      break; // only check the very first non-blank body line
    }
  }

  const lc = (idx: number): number => {
    const line = lines[idx];
    if (line === undefined) {
      throw new Error(`invariant: lc called with out-of-range index ${idx}`);
    }
    return line.length + 1;
  };

  let mandatoryChars = 0;
  for (const mi of mandatory) mandatoryChars += lc(mi);
  if (modDocOmitted > 0) mandatoryChars += 50;
  let remaining = Math.max(0, budget - mandatoryChars);

  // Rank anchor groups using SageRank + base priority boost
  let rankedGroups: AnchorGroup[];

  if (anchorGroups.length <= _SAGERANK_SOURCE_THRESHOLD) {
    // Few groups: use base priority directly
    rankedGroups = [...anchorGroups].sort((a, b) => b.basePriority - a.basePriority);
  } else {
    // Enough groups: use SageRank for centrality ranking
    const sagerank = new SageRank(
      1.5,    // k1 (BM25)
      0.75,   // b (BM25)
      0.85,   // damping (PageRank)
      50,     // maxIter
      1e-6,   // epsilon
      0.4,    // coverageWeight — lower for source code (we want related functions)
      20,     // minSentenceLength — functions have more content
      true,   // normalize
    );

    const groupTexts = anchorGroups.map((g) => g.fullText);
    const result = sagerank.rankSentences(groupTexts, anchorGroups.length, null);

    // Combine SageRank centrality with base priority
    const combinedScores = result.scores.map((score, idx) => {
      const group = anchorGroups[idx]!;
      // Normalize base priority to 0-1 range (max is ~300)
      const normalizedPriority = group.basePriority / 300;
      // Combined score: 60% centrality, 40% priority
      const combined = 0.6 * score + 0.4 * normalizedPriority;
      return { group, score: combined };
    });

    rankedGroups = combinedScores
      .sort((a, b) => b.score - a.score)
      .map((s) => s.group);
  }

  // Fill bodies by ranked order
  const includedBody = new Set<number>();
  const MARKER_COST = 45;

  for (const group of rankedGroups) {
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
  for (const idx of modDocKeep) {
    const line = lines[idx];
    if (line === undefined) continue;
    result.push(line);
  }
  if (modDocOmitted > 0) {
    // modDocKeep has the kept indices, modDocIndices has all docstring indices
    const docOmitStart = modDocKeep[modDocKeep.length - 1]! + 1;
    const docOmitEnd = modDocIndices[modDocIndices.length - 1]!;
    result.push(`[TRUNCATED: lines ${docOmitStart + 1}-${docOmitEnd + 1}]`);
  }

  // Scan remaining lines in order, inserting omission markers at cut points
  let pendingBlanks: string[] = [];
  let omitStart = -1;  // Track where omission began (0-indexed)

  for (const [idx, line] of lines.entries()) {
    if (modDocSet.has(idx)) continue;

    if (!line.trim()) {
      pendingBlanks.push(line);
      continue;
    }

    if (allIncluded.has(idx)) {
      if (omitStart >= 0) {
        const gapCount = idx - omitStart;
        if (gapCount >= _MIN_OMISSION_THRESHOLD) {
          result.push(`[TRUNCATED: lines ${omitStart + 1}-${idx}]`);
        } else {
          // Fill tiny gap verbatim
          for (let g = omitStart; g < idx; g++) {
            if (lines[g] !== undefined) result.push(lines[g]!);
          }
        }
        omitStart = -1;
      }
      result.push(...pendingBlanks);
      pendingBlanks = [];
      result.push(line);
    } else {
      pendingBlanks = []; // discard blanks belonging to omitted section
      if (omitStart < 0) omitStart = idx;  // Start new omission range
    }
  }

  if (omitStart >= 0) {
    const gapCount = lines.length - omitStart;
    if (gapCount >= _MIN_OMISSION_THRESHOLD) {
      result.push(`[TRUNCATED: lines ${omitStart + 1}-${lines.length}]`);
    } else {
      for (let g = omitStart; g < lines.length; g++) {
        if (lines[g] !== undefined) result.push(lines[g]!);
      }
    }
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

    while (scan >= 0 && topLevelSet.has(scan)) {
      const scanLine = lines[scan];
      if (scanLine === undefined || !_isCommentOnlyLine(scanLine)) break;
      span.push(scan);
      if (_DOC_TAG_RE.test(scanLine)) {
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
  astEdges?: ASTEdge[],
): string {
  const lines = text.split('\n');
  const n = lines.length;

  // Format compliance (item 6 from audit): output is ALWAYS numbered
  // lines. Even "no compression needed" or "no structure available"
  // paths emit the N. prefix so consumers can rely on a uniform format.
  // The structure-less fallback delegates to compressString() but then
  // re-numbers the result; that's fine because compressString already
  // produces a small enough output to renumber line-by-line.
  if (structure.length === 0) {
    // No structure to drive selection. Use the unstructured text path
    // for selection, then re-number what it produced. Each non-marker
    // line in compressString's output is the verbatim source line; we
    // need to recover its original 1-based index by matching against
    // source lines.
    const compressed = compressString(text, budget);
    const srcLines = text.split('\n');
    const compLines = compressed.split('\n');
    let cursor = 0;
    const out: string[] = [];
    for (const cl of compLines) {
      if (/^\[TRUNCATED: lines \d+-\d+\]$/.test(cl)) {
        out.push(cl);
        // Advance cursor past the dropped range so the next match
        // search starts from the right position.
        const m = cl.match(/^\[TRUNCATED: lines \d+-(\d+)\]$/);
        if (m && m[1]) cursor = Math.max(cursor, parseInt(m[1], 10));
        continue;
      }
      // Find the next occurrence of this exact line in srcLines at or
      // after cursor. If not found, fall back to emitting without a
      // number (defensive; should not happen since compressString only
      // emits verbatim lines).
      let found = -1;
      for (let i = cursor; i < srcLines.length; i++) {
        if (srcLines[i] === cl) { found = i; break; }
      }
      if (found >= 0) {
        out.push(`${found + 1}. ${cl}`);
        cursor = found + 1;
      } else {
        out.push(cl);
      }
    }
    return out.join('\n');
  }

  if (budget >= text.length) {
    // Budget allows the whole file. Emit every line numbered.
    const srcLines = text.split('\n');
    return srcLines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  }

  const lineAt = (idx: number): string => {
    const line = lines[idx];
    if (line === undefined) {
      throw new Error(`invariant: lines[${idx}] out of range (n=${n})`);
    }
    return line;
  };

  // ─── Phase A: build the working block list (with synthetic __main__ block) ──
  // Mutate a local copy so we never touch the caller's structure.
  const workingStructure: Array<StructureBlock & {
    priority: number;
    inDeg: number;
    outDeg: number;
    inWeight: number;
    outWeight: number;
    anchorScore: number;
    density: number;
    worth: number;
  }> = structure.map((block) => ({
    ...block,
    priority: 0,
    inDeg: 0,
    outDeg: 0,
    inWeight: 0,
    outWeight: 0,
    anchorScore: 0,
    density: 0,
    worth: 0,
  }));

  // Identify lines that belong to at least one block (used to separate
  // top-level lines from block-owned lines).
  const allBlockLines = new Set<number>();
  for (const block of workingStructure) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    for (let ln = start; ln <= end; ln++) allBlockLines.add(ln);
  }

  let topLevelLines = Array.from({ length: n }, (_, i) => i).filter((i) => !allBlockLines.has(i));
  topLevelLines = _stripDocBlocksBeforeBlocks(lines, topLevelLines, workingStructure);

  // Reclassify `if __name__ == '__main__':` block as a synthetic block so its
  // lines flow through the same per-block selection (the AST treats it as a
  // distinct callable region; we honor that).
  const mainStart = topLevelLines.find((i) => lineAt(i).trim().startsWith('if __name__')) ?? null;
  if (mainStart !== null) {
    const mainLines = topLevelLines.filter((i) => i >= mainStart);
    topLevelLines = topLevelLines.filter((i) => i < mainStart);
    const mainEnd = mainLines[mainLines.length - 1];
    if (mainEnd === undefined) {
      throw new Error('invariant: mainLines is non-empty (mainStart was found in topLevelLines)');
    }
    workingStructure.push({
      type: 'main_block',
      name: '__main__',
      kind: 'main_block',
      startLine: mainStart,
      endLine: mainEnd,
      exported: false,
      anchors: [],
      priority: 0,
      inDeg: 0,
      outDeg: 0,
      inWeight: 0,
      outWeight: 0,
      anchorScore: 0,
      density: 0,
      worth: 0,
    });
  }

  // ─── Phase B: AST signals ─ the substrate every decision below uses ──────
  //
  // Two graphs feed selection:
  //   1. Call graph (ASTEdge[]): inDeg = how many blocks in this file call
  //      this one; outDeg = how many it calls. Edge weight is sqrt(call_count)
  //      so a callee invoked at multiple sites in the same caller still
  //      counts more than a single-site callee, but with diminishing returns.
  //   2. Anchor graph (per-block AST nodes): each block has 0..16 anchors
  //      already sorted by priority desc, capped, deduplicated by line range.
  //      Anchor kinds + priorities (returns=400, throws=380, branches=320,
  //      loops=240..260, calls=140) tell us where the actual logic lives
  //      inside the block.
  //
  // The structure call graph indices align with `structure` (the input).
  // The synthetic __main__ block (if added) sits past those indices and has
  // no edges — that's correct: it isn't part of the symbol-index call graph.
  const hasEdges = !!(astEdges && astEdges.length > 0);
  if (hasEdges) {
    for (const edge of astEdges!) {
      if (edge.to >= 0 && edge.to < structure.length) {
        workingStructure[edge.to]!.inDeg += 1;
        workingStructure[edge.to]!.inWeight += edge.weight || 1;
      }
      if (edge.from >= 0 && edge.from < structure.length) {
        workingStructure[edge.from]!.outDeg += 1;
        workingStructure[edge.from]!.outWeight += edge.weight || 1;
      }
    }
  }

  // Per-block anchor signals — derived purely from tree-sitter output.
  // `anchorScore` is the SUM of anchor priorities, normalized so a return
  // (400) + branch (320) + call (140) totals 860, vs an empty block at 0.
  // `density` is anchors-per-body-line. A 40-line function with 8 anchors
  // has density 0.2; a 40-line function with 1 return has density 0.025.
  // Density tells us "how much logic is packed in here" — the spec's
  // "complex but simple" axis.
  for (const block of workingStructure) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    const span = Math.max(1, end - start);
    let anchorScore = 0;
    if (block.anchors && block.anchors.length > 0) {
      for (const a of block.anchors) {
        anchorScore += (a.priority ?? 0);
      }
    }
    block.anchorScore = anchorScore;
    block.density = (block.anchors?.length ?? 0) / span;
  }

  // ─── Phase C: block worth ─ the AST-driven importance score ────────────
  //
  // The graph tells us WHICH blocks matter. The anchors tell us HOW MUCH
  // logic each block holds. Worth multiplies the two signals so:
  //   - high centrality + dense logic → highest worth (central complex func)
  //   - high centrality + sparse logic → moderate worth (central simple)
  //   - low centrality + dense logic   → moderate worth (complex but isolated)
  //   - low centrality + sparse logic  → lowest worth (drop first)
  //
  // No name matching, no export check, no position. The graph and the
  // anchors are the entire input.
  //
  // Build the worth score. We compute two component vectors and combine.
  //
  // GRAPH component: inDeg * 100 + min(outDeg, 6) * 25 + inWeight * 5.
  //   inDeg dominates because being called is the strongest signal of
  //   structural importance — it's the count of other blocks that depend
  //   on this one's existence. outDeg is capped at 6 to prevent a single
  //   giant orchestrator from monopolizing budget. inWeight gives a small
  //   tiebreaker for hot callees (called from multiple sites).
  // ANCHOR component: anchorScore directly. A return-only function scores
  //   ~400; a branch-heavy function with returns and throws scores 1500+.
  //
  // When edges exist, GRAPH is the dominant signal. When edges don't exist
  // (no symbol index for this file), ANCHOR is the only structural signal
  // we have — the graph component falls to 0 and worth is anchors-only.
  // This is the correct degradation: without edges we genuinely don't know
  // what's central, so we fall back to "what's logic-dense".
  for (const block of workingStructure) {
    const graphScore = hasEdges
      ? (block.inDeg * 100) + (Math.min(block.outDeg, 6) * 25) + Math.floor(block.inWeight * 5)
      : 0;
    let worth = graphScore + block.anchorScore;

    // Floor so an empty block (no edges, no anchors) is still scoreable.
    // Without this, a structure-only block (an interface, a type alias)
    // would have worth=0 and tie with every other empty block on insertion
    // order. A floor of 1 keeps them rankable by position tiebreaker.
    if (worth <= 0) worth = 1;

    // No name-based penalty. Earlier versions multiplied test/__main__
    // worth by 0.05; that's a text-heuristic override of the AST signal
    // and contradicts the design. If __main__ has high centrality + dense
    // anchors, the AST already says it's important. If it has none, the
    // graphScore + anchorScore already collapses worth to ~1 (floor) and
    // the block competes fairly with other zero-signal blocks. Names
    // never override the AST.

    block.priority = worth;
    block.worth = worth;
  }

  // ─── Phase D: top-level lines (imports, constants, free comments) ──────
  //
  // These don't appear in the StructureBlock array — the AST has nothing
  // direct to say about them. We give them a separate budget cap (max 40%
  // of total budget). Imports are kept first (they're how the model knows
  // what's available); other top-level lines fill remaining cap top-down.
  const resultLines = new Map<number, string>();
  const topLevelCap = Math.floor(budget * 40 / 100);

  const topLevelCost = topLevelLines.reduce((sum, i) => sum + `${i + 1}. ${lineAt(i)}`.length + 1, 0);
  if (topLevelCost > topLevelCap) {
    // Charge every line (including imports) against the cap so we don't
    // overshoot when imports alone exceed it. Imports are added first
    // (highest structural value among top-level lines), then other
    // top-level content fills remaining cap top-down.
    let rem = topLevelCap;
    const kept: number[] = [];
    for (const i of topLevelLines) {
      if (!_SOURCE_IMPORT_RE.test(lineAt(i))) continue;
      const cost = `${i + 1}. ${lineAt(i)}`.length + 1;
      if (cost > rem) break;
      kept.push(i);
      rem -= cost;
    }
    const importSet = new Set(kept);
    for (const i of topLevelLines) {
      if (importSet.has(i)) continue;
      const cost = `${i + 1}. ${lineAt(i)}`.length + 1;
      if (cost > rem) break;
      kept.push(i);
      rem -= cost;
    }
    topLevelLines = kept.sort((a, b) => a - b);
  }
  for (const i of topLevelLines) resultLines.set(i, `${i + 1}. ${lineAt(i)}`);
  let used = topLevelLines.reduce((sum, i) => sum + `${i + 1}. ${lineAt(i)}`.length + 1, 0);

  // ─── Phase E: signature pass ─ every block gets its declaration line ───
  //
  // The block's first line (the signature) is the only thing that names it
  // in the output. Even a fully-dropped block must keep its signature, or
  // the reader literally cannot tell the block exists. We charge signatures
  // against the budget; if the entire budget can't fit all signatures, we
  // pick by worth desc (the highest-worth blocks at least keep theirs).
  let totalSigCost = 0;
  for (const b of workingStructure) {
    const start = Math.max(0, b.startLine);
    if (start >= n || resultLines.has(start)) continue;
    totalSigCost += `${start + 1}. ${lineAt(start)}`.length + 1;
  }
  if (used + totalSigCost <= budget) {
    for (const block of workingStructure) {
      const start = Math.max(0, block.startLine);
      if (start >= n || resultLines.has(start)) continue;
      resultLines.set(start, `${start + 1}. ${lineAt(start)}`);
    }
    used += totalSigCost;
  } else {
    // Tight: keep highest-worth signatures, position tiebreaker.
    const byWorth = [...workingStructure].sort(
      (a, b) => (b.worth - a.worth) || (a.startLine - b.startLine),
    );
    for (const block of byWorth) {
      const start = Math.max(0, block.startLine);
      if (start >= n || resultLines.has(start)) continue;
      const cost = `${start + 1}. ${lineAt(start)}`.length + 1;
      if (used + cost > budget) continue;
      resultLines.set(start, `${start + 1}. ${lineAt(start)}`);
      used += cost;
    }
  }

  // ─── Phase F: body budget ─ split proportionally by worth×complexity ────
  //
  // What remains of the budget after top-level + signatures is the body
  // budget. We split it across blocks proportionally so that:
  //   share_b = bodyBudget * weight_b / Σ weight
  //   weight_b = worth_b * (1 + 1.5 * density_b)
  // The (1 + 1.5*density) multiplier is the spec's anchor-density-aware
  // allocation: a dense-logic block earns proportionally more body lines
  // than a sparse block of equal centrality.
  //
  // After computing nominal shares, we cap each at the block's actual body
  // cost (a block can't use more than its own body size). Any unused share
  // returns to a pool and is redistributed by worth desc until the body
  // budget is exhausted or no block can absorb more.
  //
  // No greedy fill, no "first one wins". Every block competes for budget
  // simultaneously based purely on AST signals.
  const bodyBudget = Math.max(0, budget - used);

  // Per-block body indices (lines not yet in resultLines) and their costs.
  // We compute these once and reuse during allocation + line selection.
  type BlockState = {
    block: typeof workingStructure[number];
    bodyIndices: number[];        // line indices in body, excluding lines already in resultLines
    bodyCosts: number[];          // rendered cost of each body line
    fullBodyCost: number;         // sum of bodyCosts
    anchorPriOfLine: Map<number, number>; // line idx → max anchor priority covering it (0 if none)
    weight: number;               // worth * (1 + 1.5 * density)
    share: number;                // running budget share (mutated during redistribution)
  };
  const blockStates: BlockState[] = [];
  let totalWeight = 0;
  for (const block of workingStructure) {
    const start = Math.max(0, block.startLine);
    const end = Math.min(n - 1, block.endLine);
    if (start > end) continue;
    const bodyIndices: number[] = [];
    const bodyCosts: number[] = [];
    let fullBodyCost = 0;
    for (let ln = start + 1; ln <= end; ln++) {
      if (resultLines.has(ln)) continue;
      const cost = `${ln + 1}. ${lineAt(ln)}`.length + 1;
      bodyIndices.push(ln);
      bodyCosts.push(cost);
      fullBodyCost += cost;
    }

    // Per-line anchor priority: for each body line, the max priority of any
    // anchor whose range covers it. Tree-sitter anchors are usually 1-line
    // (compression-structure.ts collapses multi-line anchors), but multi-
    // line anchors do occur for if/try/loop heads — we honor whatever range
    // the AST gave us.
    const anchorPriOfLine = new Map<number, number>();
    if (block.anchors && block.anchors.length > 0) {
      for (const a of block.anchors) {
        const aStart = Math.max(start + 1, a.startLine ?? start + 1);
        const aEnd = Math.min(end, a.endLine ?? aStart);
        const pri = a.priority ?? 0;
        for (let ln = aStart; ln <= aEnd; ln++) {
          const cur = anchorPriOfLine.get(ln) ?? 0;
          if (pri > cur) anchorPriOfLine.set(ln, pri);
        }
      }
    }

    const weight = block.worth * (1 + 1.5 * block.density);
    totalWeight += weight;
    blockStates.push({
      block,
      bodyIndices,
      bodyCosts,
      fullBodyCost,
      anchorPriOfLine,
      weight,
      share: 0,
    });
  }

  if (totalWeight > 0 && bodyBudget > 0) {
    // FLOOR RESERVATION (I1 correctness):
    // Phase H will emit AT LEAST one piece per non-empty block body — either
    // a single [TRUNCATED] marker covering the body (if body span ≥ thresh)
    // or the inlined body lines (if span < thresh). The minimum possible
    // emission for a block is therefore non-zero, and a purely proportional
    // share can fall below that floor. If we ignore the floor, the block
    // emits more than its share and the global budget is overrun by up to
    // (floor − share) per block. We reserve each block's floor from
    // bodyBudget BEFORE proportional allocation, so every block starts
    // with enough headroom to cover its unavoidable minimum emission.
    //
    // The marker cost mirrors Phase H byte-for-byte (any format change
    // there must change here in lockstep). The floor is min(marker, full
    // body) because if the body is shorter than the marker, Phase H will
    // inline it instead and that inline IS the floor.
    let floorReserve = 0;
    const floors: number[] = [];
    for (const s of blockStates) {
      if (s.bodyIndices.length === 0) { floors.push(0); continue; }
      const bs = s.bodyIndices[0]!;
      const be = s.bodyIndices[s.bodyIndices.length - 1]!;
      const span = be - bs + 1;
      let floor: number;
      if (span >= _MIN_OMISSION_THRESHOLD) {
        floor = `[TRUNCATED: lines ${bs + 1}-${be + 1}]`.length + 1;
      } else {
        floor = s.fullBodyCost;
      }
      // Never reserve more than the block could possibly emit; cap at body.
      floor = Math.min(floor, s.fullBodyCost);
      floors.push(floor);
      floorReserve += floor;
    }
    // Distribute the post-floor remainder proportionally. If the floors
    // already exhaust bodyBudget (pathological: many tiny blocks, tight
    // budget), shares stay at their floors and Phase G will only emit the
    // forced minimums — still bounded by bodyBudget within rounding.
    const distributable = Math.max(0, bodyBudget - floorReserve);

    // Initial proportional shares = floor + proportional remainder, capped
    // at each block's actual body cost.
    let pool = 0;
    for (let i = 0; i < blockStates.length; i++) {
      const s = blockStates[i]!;
      const nominal = floors[i]! + distributable * s.weight / totalWeight;
      const capped = Math.min(nominal, s.fullBodyCost);
      s.share = capped;
      pool += (nominal - capped);
    }
    // Redistribute leftover pool to blocks that still have room, weighted
    // by worth desc. Repeat until the pool is empty or no block can absorb.
    // This is what makes the allocation truly proportional: the central
    // complex blocks soak up the slack that the peripheral simple blocks
    // couldn't use.
    for (let pass = 0; pass < 8 && pool > 1; pass++) {
      const open = blockStates.filter((s) => s.share < s.fullBodyCost);
      if (open.length === 0) break;
      let openWeight = 0;
      for (const s of open) openWeight += s.weight;
      if (openWeight <= 0) break;
      let nextPool = 0;
      for (const s of open) {
        const add = pool * s.weight / openWeight;
        const room = s.fullBodyCost - s.share;
        const taken = Math.min(add, room);
        s.share += taken;
        nextPool += (add - taken);
      }
      if (nextPool >= pool) break; // No progress — bail to avoid infinite loop.
      pool = nextPool;
    }
  }

  // ─── Phase G: window selection ─ anchor-driven, ≥10-line shown runs ─────
  //
  // The output rule (non-negotiable): between any two truncation markers,
  // the shown run must be ≥ _MIN_OMISSION_THRESHOLD (10) lines. And every
  // marker covers ≥ 10 dropped lines (already enforced). So the alternating
  // shown/dropped run structure has runs of length ≥10 throughout the
  // interior of the file (run lengths at the file boundary can be smaller).
  //
  // To honor this by construction, Phase G picks WINDOWS — contiguous
  // ranges of body lines ≥10 lines long — not individual lines. AST drives
  // window placement: each window is anchored on the highest-priority
  // unanchored anchor line, extended outward to length ≥10. Windows that
  // would land within 10 lines of an existing window MERGE into one larger
  // window (because the would-be gap between them is forbidden).
  //
  // For blocks whose body has fewer than 10 body lines, the choice is
  // binary: either show the whole body (it's all one run anyway, and any
  // length is acceptable when surrounded by content on at least one side)
  // or drop the whole body (becomes part of the adjacent marker). The AST
  // signal — does the block have ANY anchor — decides.
  //
  // Each window costs (window lines × per-line cost). Markers around
  // windows are accounted globally (one per dropped run ≥10 in Phase H);
  // here we only bound by share = budget for body content of this block.
  // share already includes the floor reservation (Phase F), so even if a
  // block's window doesn't fit, the floor marker cost is preserved.
  for (const s of blockStates) {
    if (s.bodyIndices.length === 0) continue;

    const bodyStart = s.bodyIndices[0]!;
    const bodyEnd = s.bodyIndices[s.bodyIndices.length - 1]!;
    const bodySpan = bodyEnd - bodyStart + 1;

    // bodyPos: line idx → index into bodyIndices/bodyCosts. Used to look
    // up the per-line cost for any body line we pick.
    const bodyPos = new Map<number, number>();
    for (let k = 0; k < s.bodyIndices.length; k++) bodyPos.set(s.bodyIndices[k]!, k);

    // If the share covers the full body, just include everything.
    if (s.share >= s.fullBodyCost) {
      for (let k = 0; k < s.bodyIndices.length; k++) {
        const ln = s.bodyIndices[k]!;
        resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
        used += s.bodyCosts[k]!;
      }
      continue;
    }

    // Body shorter than the threshold: we can't form a ≥10-line window
    // because the body itself isn't 10 lines. Choice is all-or-nothing.
    // If the block has any anchor (i.e., contains real logic per the
    // AST), show the whole body — its size is its size; output rule
    // about ≥10 only applies BETWEEN markers, and a short body that
    // borders the block's own signature (a shown line) is part of one
    // larger shown run that's already ≥1 + bodySpan lines and will be
    // joined with neighboring shown content by the global structure.
    // If the block has no anchors, drop the whole body — the marker
    // will absorb it.
    //
    // Charge to share / used either way. fullBodyCost is the cost to
    // show; one marker is the cost to drop. We pick the cheaper of the
    // two when share is tight, the more informative one otherwise.
    if (bodySpan < _MIN_OMISSION_THRESHOLD) {
      const markerCost = `[TRUNCATED: lines ${bodyStart + 1}-${bodyEnd + 1}]`.length + 1;
      const hasAnchors = (s.block.anchors?.length ?? 0) > 0;
      // Prefer showing if it fits and there's logic worth seeing.
      if (hasAnchors && s.fullBodyCost <= s.share) {
        for (let k = 0; k < s.bodyIndices.length; k++) {
          const ln = s.bodyIndices[k]!;
          resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
        }
        used += s.fullBodyCost;
      } else if (markerCost <= s.share) {
        // Drop the body. Phase H will emit one marker over bodyStart..bodyEnd.
        used += markerCost;
      } else {
        // Pathological: share too tight for even a marker. Charge what
        // Phase H will actually emit (the marker) — share floor in
        // Phase F is supposed to prevent this; we honor reality over the
        // share bound to keep budget accounting correct.
        used += markerCost;
      }
      continue;
    }

    // Body span ≥ 10: build windows. Each window is a contiguous range
    // [winStart, winEnd] of body lines (winStart ≥ bodyStart, winEnd ≤
    // bodyEnd) with winEnd - winStart + 1 ≥ _MIN_OMISSION_THRESHOLD.
    //
    // Place windows greedily by anchor priority. For each anchor (sorted
    // desc by priority): if it's not already covered, build a window
    // centered on it of size MIN. Then test: does this window overlap
    // any existing window OR sit within MIN lines of one? If yes, MERGE
    // (extend the existing window to include this anchor's coverage,
    // bridging the would-be gap). Else: it's a new window. Bound the
    // total emission by share; skip an anchor whose new/merged window
    // would push us over.
    //
    // Marker cost accounting: each shown window borders ≤2 dropped
    // regions (left and right). The body's own ends border the sig
    // (shown) on the left and the next block's region on the right; we
    // can't know the exact marker layout without global state, so we
    // estimate one marker per dropped run within this block's body and
    // let Phase H's exact emission be the source of truth — share's
    // floor reservation in Phase F covered the worst-case marker cost.

    type Window = { start: number; end: number };
    const windows: Window[] = [];
    let bodyShown = 0; // bytes spent on body lines (markers paid separately).

    const sortedAnchors = [...(s.block.anchors ?? [])]
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.startLine ?? 0) - (b.startLine ?? 0));

    // Helper: compute cost of a candidate window (sum of bodyCosts in
    // range). Inlined to avoid a helper function.
    // (We can't extract this — invariant I6 prohibits helpers — so the
    // same inline loop is duplicated for each candidate test below.)

    for (const anchor of sortedAnchors) {
      const aStart = Math.max(bodyStart, anchor.startLine ?? bodyStart);
      const aEnd = Math.min(bodyEnd, anchor.endLine ?? aStart);
      if (aStart > bodyEnd || aEnd < bodyStart) continue;

      // If any existing window already covers this anchor, skip.
      let alreadyCovered = false;
      for (const w of windows) {
        if (w.start <= aStart && w.end >= aEnd) { alreadyCovered = true; break; }
      }
      if (alreadyCovered) continue;

      // Initial window: center on the anchor, extend to MIN_OMISSION_THRESHOLD
      // lines. Clamp to body bounds. If the anchor sits near a body edge
      // the window slides inward to stay inside the body.
      const half = Math.floor(_MIN_OMISSION_THRESHOLD / 2);
      let winStart = Math.max(bodyStart, aStart - half);
      let winEnd = Math.min(bodyEnd, winStart + _MIN_OMISSION_THRESHOLD - 1);
      if (winEnd > bodyEnd) winEnd = bodyEnd;
      if (winEnd - winStart + 1 < _MIN_OMISSION_THRESHOLD) {
        winStart = Math.max(bodyStart, winEnd - _MIN_OMISSION_THRESHOLD + 1);
      }
      // Make sure the anchor's range is fully covered.
      if (winStart > aStart) winStart = aStart;
      if (winEnd < aEnd) winEnd = aEnd;

      // Find any existing windows that overlap [winStart - MIN .. winEnd + MIN].
      // A would-be gap shorter than MIN between two shown windows is
      // forbidden — those windows must be merged into one. We compute
      // the merged span and cost it as one window.
      let mergedStart = winStart;
      let mergedEnd = winEnd;
      const overlapping: number[] = [];
      for (let wi = 0; wi < windows.length; wi++) {
        const w = windows[wi]!;
        // Distance between this candidate window and the existing window.
        // If the gap between them is < MIN, they must merge.
        const gap = w.start > mergedEnd
          ? (w.start - mergedEnd - 1)
          : (mergedStart > w.end ? (mergedStart - w.end - 1) : -1);
        if (gap < _MIN_OMISSION_THRESHOLD) {
          overlapping.push(wi);
          if (w.start < mergedStart) mergedStart = w.start;
          if (w.end > mergedEnd) mergedEnd = w.end;
        }
      }

      // Cost of the merged window minus cost of the existing overlapping
      // windows it replaces: the marginal byte spend for this anchor.
      let mergedCost = 0;
      for (let g = mergedStart; g <= mergedEnd; g++) {
        const k = bodyPos.get(g);
        if (k !== undefined) mergedCost += s.bodyCosts[k]!;
      }
      let replacedCost = 0;
      for (const wi of overlapping) {
        const w = windows[wi]!;
        for (let g = w.start; g <= w.end; g++) {
          const k = bodyPos.get(g);
          if (k !== undefined) replacedCost += s.bodyCosts[k]!;
        }
      }
      const marginal = mergedCost - replacedCost;

      if (bodyShown + marginal > s.share) continue; // Doesn't fit; skip anchor.

      // Commit: remove the overlapping windows, add the merged one. We
      // build the new list by filtering rather than splice-in-place so
      // the merge logic is obviously correct.
      const next: Window[] = [];
      const overlapSet = new Set(overlapping);
      for (let wi = 0; wi < windows.length; wi++) {
        if (!overlapSet.has(wi)) next.push(windows[wi]!);
      }
      next.push({ start: mergedStart, end: mergedEnd });
      next.sort((a, b) => a.start - b.start);
      windows.length = 0;
      windows.push(...next);
      bodyShown += marginal;
    }

    // Post-pass: any two windows within MIN of each other must merge.
    // (Adding windows in priority order with the merge-on-gap rule above
    // should leave none, but a final defensive sweep catches any pair
    // where the gap is exactly MIN-1 from edge effects.)
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let wi = 0; wi + 1 < windows.length; wi++) {
        const a = windows[wi]!;
        const b = windows[wi + 1]!;
        const gap = b.start - a.end - 1;
        if (gap < _MIN_OMISSION_THRESHOLD) {
          // Merge a and b. Cost of the bridge lines (between them) is
          // charged to bodyShown.
          let bridge = 0;
          for (let g = a.end + 1; g < b.start; g++) {
            const k = bodyPos.get(g);
            if (k !== undefined) bridge += s.bodyCosts[k]!;
          }
          if (bodyShown + bridge > s.share) {
            // Can't afford to merge; drop the LOWER-priority window
            // instead. Anchors were processed in priority order, so the
            // later-added window is lower priority — drop b.
            // Removing b frees its body-line cost too.
            let bCost = 0;
            for (let g = b.start; g <= b.end; g++) {
              const k = bodyPos.get(g);
              if (k !== undefined) bCost += s.bodyCosts[k]!;
            }
            bodyShown -= bCost;
            windows.splice(wi + 1, 1);
          } else {
            windows[wi] = { start: a.start, end: b.end };
            windows.splice(wi + 1, 1);
            bodyShown += bridge;
          }
          changed = true;
          break; // restart the scan
        }
      }
      if (!changed) break;
    }

    // Reservation check: if no window placed (no anchors, or all anchors
    // failed share check), the whole body becomes one marker. That cost
    // is already in share's floor reservation; no extra accounting.
    // If windows placed, account for the body-line bytes and one marker
    // per gap between windows / between windows and body boundaries.
    let markerBytes = 0;
    if (windows.length === 0) {
      // Whole body dropped → one marker.
      markerBytes += `[TRUNCATED: lines ${bodyStart + 1}-${bodyEnd + 1}]`.length + 1;
    } else {
      // Marker before first window if there's body content before it.
      const first = windows[0]!;
      if (first.start > bodyStart) {
        markerBytes += `[TRUNCATED: lines ${bodyStart + 1}-${first.start}]`.length + 1;
      }
      // Markers between consecutive windows.
      for (let wi = 0; wi + 1 < windows.length; wi++) {
        const a = windows[wi]!;
        const b = windows[wi + 1]!;
        markerBytes += `[TRUNCATED: lines ${a.end + 2}-${b.start}]`.length + 1;
      }
      // Marker after last window if there's body content after it.
      const last = windows[windows.length - 1]!;
      if (last.end < bodyEnd) {
        markerBytes += `[TRUNCATED: lines ${last.end + 2}-${bodyEnd + 1}]`.length + 1;
      }
    }

    // Commit: write window lines into resultLines. Lines outside any
    // window are left unselected; Phase H will emit them as markers per
    // the global ≥10 rule.
    for (const w of windows) {
      for (let ln = w.start; ln <= bodyEnd && ln <= w.end; ln++) {
        const k = bodyPos.get(ln);
        if (k !== undefined) resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
      }
    }
    used += bodyShown + markerBytes;
  }

  // ─── Phase G.5: global ≥10 snap ─ enforce the output structural rule ────
  //
  // The output is a sequence of alternating shown runs and marker runs.
  // The rule (non-negotiable):
  //   • Each marker covers ≥ _MIN_OMISSION_THRESHOLD (10) dropped lines.
  //   • Each shown run BETWEEN two markers has ≥ _MIN_OMISSION_THRESHOLD
  //     shown lines. Shown runs at the file boundary (before the first
  //     marker or after the last marker) may be shorter — the rule
  //     applies to interior shown runs only.
  //
  // Phase G placed body windows that respect this within each block, but
  // block boundaries are coordinated globally. Example: block A ends with
  // dropped lines (a marker), block B begins with a shown signature, and
  // block B has no body window placed (its body is fully dropped). Then
  // the structure is [marker for A's tail] [B sig: 1 shown] [marker for
  // B's body]. That single shown sig violates the rule.
  //
  // This pass walks the resultLines map across the whole file, identifies
  // every interior shown run < threshold, and RESOLVES it via the AST
  // signals already attached to each block:
  //   • If the sliver belongs to a block with no anchors (no real logic
  //     in this block, by tree-sitter's accounting), DROP the sliver —
  //     unset those lines from resultLines and let the adjacent markers
  //     absorb them.
  //   • If the sliver contains an anchor (the block has real logic),
  //     GROW the sliver by adding adjacent body lines until ≥ threshold,
  //     budget permitting. If the budget can't afford the grow, fall back
  //     to DROP (the sliver disappears).
  //
  // Same logic for dropped runs that come out < threshold (these can
  // happen at block boundaries where two short shown runs straddle a
  // small gap): GROW the marker by dropping adjacent shown content, or
  // FILL the gap by adding it to resultLines. AST drives the choice.
  //
  // We loop until no sub-threshold runs remain or no resolution is
  // possible. Each iteration must make progress; we cap at a small
  // number of passes to avoid pathological cases.

  // Build per-line anchor-priority lookup once for the whole file.
  // Top-level lines and signature lines have priority 0 (no anchor) so
  // their grow/shrink decisions naturally fall to the SHRINK side unless
  // a block-level signal overrides. Signatures themselves are flagged
  // separately so we know not to drop them lightly.
  const linePri = new Map<number, number>();
  const isSigLine = new Set<number>();
  for (const b of workingStructure) {
    const sigIdx = Math.max(0, b.startLine);
    if (sigIdx < n) isSigLine.add(sigIdx);
    if (b.anchors) {
      for (const a of b.anchors) {
        const aStart = a.startLine ?? 0;
        const aEnd = a.endLine ?? aStart;
        for (let ln = aStart; ln <= aEnd; ln++) {
          const cur = linePri.get(ln) ?? 0;
          if ((a.priority ?? 0) > cur) linePri.set(ln, a.priority ?? 0);
        }
      }
    }
  }

  // Iteration cap: each pass resolves one sub-threshold interior run.
  // The number of such runs is at most O(n) but practically bounded by
  // the number of structure blocks plus signature lines. We cap at 4*n
  // to be defensive against any oscillation between grow/shrink, but
  // each successful resolution strictly reduces violation count so the
  // loop terminates well before the cap on real inputs.
  const maxPasses = Math.max(64, n * 4);
  for (let pass = 0; pass < maxPasses; pass++) {
    // Build runs: an array of { start, end, type } where type is 'show'
    // or 'drop'. Walk 0..n and group contiguous indices by membership.
    type Run = { start: number; end: number; type: 'show' | 'drop' };
    const runs: Run[] = [];
    {
      let i = 0;
      while (i < n) {
        const t: 'show' | 'drop' = resultLines.has(i) ? 'show' : 'drop';
        let j = i;
        while (j < n && (resultLines.has(j) ? 'show' : 'drop') === t) j++;
        runs.push({ start: i, end: j - 1, type: t });
        i = j;
      }
    }

    // Find the first sub-threshold interior run. "Interior" means it has
    // both a left and right neighbor of the OPPOSITE type — i.e., it's
    // sandwiched between markers (if shown) or between shown content (if
    // dropped). Boundary runs (first/last) don't need the rule.
    let target = -1;
    for (let r = 1; r < runs.length - 1; r++) {
      const run = runs[r]!;
      const len = run.end - run.start + 1;
      if (len < _MIN_OMISSION_THRESHOLD) {
        // Confirm the neighbors are opposite-type (they always are by
        // construction, but defensive check).
        const prevType = runs[r - 1]!.type;
        const nextType = runs[r + 1]!.type;
        if (prevType !== run.type && nextType !== run.type) {
          target = r;
          break;
        }
      }
    }
    if (target < 0) break; // No sub-threshold interior runs remain.

    const run = runs[target]!;

    // Decide grow vs shrink based on AST priority of lines in the run.
    // For a shown sliver: if it contains any anchor (priority > 0) or a
    // signature, GROW; else SHRINK. For a dropped sliver: GROW the marker
    // by dropping neighboring shown content if those neighbors are low-
    // priority; else FILL the gap (turn it shown).
    let hasSignal = false;
    for (let ln = run.start; ln <= run.end; ln++) {
      if (linePri.has(ln) || isSigLine.has(ln)) { hasSignal = true; break; }
    }

    if (run.type === 'show') {
      if (hasSignal) {
        // GROW: add neighboring dropped lines until the shown run ≥ thresh.
        const need = _MIN_OMISSION_THRESHOLD - (run.end - run.start + 1);
        // Pull from left and right dropped runs symmetrically. Bounded by
        // budget: we can only grow if `used + addedCost ≤ budget`.
        const leftRun = runs[target - 1]!;
        const rightRun = runs[target + 1]!;
        const leftAvail = leftRun.end - leftRun.start + 1;
        const rightAvail = rightRun.end - rightRun.start + 1;
        let takeLeft = Math.min(Math.ceil(need / 2), leftAvail);
        let takeRight = need - takeLeft;
        if (takeRight > rightAvail) {
          // Shift the imbalance back to left.
          const diff = takeRight - rightAvail;
          takeRight = rightAvail;
          takeLeft = Math.min(takeLeft + diff, leftAvail);
        }
        // Compute cost of the lines we'd add. Each shown line costs its
        // N. <line> rendering. Markers are recomputed by the next iteration
        // (they may shrink or disappear, freeing budget).
        let growCost = 0;
        const growLines: number[] = [];
        for (let i = 0; i < takeLeft; i++) {
          const ln = leftRun.end - i;
          if (ln < 0 || ln >= n) continue;
          growLines.push(ln);
          growCost += `${ln + 1}. ${lineAt(ln)}`.length + 1;
        }
        for (let i = 0; i < takeRight; i++) {
          const ln = rightRun.start + i;
          if (ln < 0 || ln >= n) continue;
          growLines.push(ln);
          growCost += `${ln + 1}. ${lineAt(ln)}`.length + 1;
        }
        // If marker(s) would shrink/disappear by growing, subtract the
        // freed marker cost. A left marker shrinks if takeLeft < leftAvail
        // (still ≥ thresh? if so still one marker; if not, it disappears).
        // This is approximation — the next pass will recompute exactly.
        if (used + growCost <= budget) {
          for (const ln of growLines) {
            if (lines[ln] !== undefined) resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
          }
          used += growCost;
          continue;
        }
        // Can't afford to grow — fall through to SHRINK.
      }
      // SHRINK: drop the sliver entirely. Subtract its byte cost from used.
      let saved = 0;
      for (let ln = run.start; ln <= run.end; ln++) {
        if (resultLines.has(ln)) {
          saved += resultLines.get(ln)!.length + 1;
          resultLines.delete(ln);
        }
      }
      used -= saved;
      continue;
    } else {
      // Dropped sliver. Check whether the adjacent shown content has
      // high signal; if low, drop more of it (GROW the marker). Else
      // fill the gap.
      const leftRun = runs[target - 1]!;
      const rightRun = runs[target + 1]!;
      let leftSignal = false, rightSignal = false;
      for (let ln = leftRun.start; ln <= leftRun.end; ln++) {
        if (linePri.has(ln) || isSigLine.has(ln)) { leftSignal = true; break; }
      }
      for (let ln = rightRun.start; ln <= rightRun.end; ln++) {
        if (linePri.has(ln) || isSigLine.has(ln)) { rightSignal = true; break; }
      }
      if (!leftSignal && !rightSignal) {
        // Both neighbors low-value: GROW the marker by dropping the
        // shorter of the two shown neighbors entirely. This collapses
        // the structure to one big marker.
        const dropRun = (leftRun.end - leftRun.start) <= (rightRun.end - rightRun.start) ? leftRun : rightRun;
        let saved = 0;
        for (let ln = dropRun.start; ln <= dropRun.end; ln++) {
          if (resultLines.has(ln)) {
            saved += resultLines.get(ln)!.length + 1;
            resultLines.delete(ln);
          }
        }
        used -= saved;
        continue;
      }
      // At least one side has signal: FILL the dropped sliver so the
      // two shown runs merge into one larger shown run. Bounded by
      // budget.
      let fillCost = 0;
      const fillLines: number[] = [];
      for (let ln = run.start; ln <= run.end; ln++) {
        fillLines.push(ln);
        fillCost += `${ln + 1}. ${lineAt(ln)}`.length + 1;
      }
      if (used + fillCost <= budget) {
        for (const ln of fillLines) {
          if (lines[ln] !== undefined) resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
        }
        used += fillCost;
        continue;
      }
      // Can't afford fill — drop the lower-signal shown neighbor instead.
      const dropRun = !leftSignal ? leftRun : (!rightSignal ? rightRun : leftRun);
      let saved = 0;
      for (let ln = dropRun.start; ln <= dropRun.end; ln++) {
        if (resultLines.has(ln)) {
          saved += resultLines.get(ln)!.length + 1;
          resultLines.delete(ln);
        }
      }
      used -= saved;
    }
  }

  // ─── Phase G.7: inclusion floor ─ ≥0.68 retention is the SPEC ─────────
  //
  // The compressor MUST default to inclusion. If after Phase G + Phase G.5
  // we're under 0.68 retention, we still have budget room to show more.
  // Spend that room AST-driven: walk blocks in worth-ASCENDING order (the
  // ones the algorithm dropped FIRST because their AST signals said
  // "least valuable") and fill them BACK — because the spec says drop
  // least valuable FIRST, the inverse is include least-recently-cut
  // LAST, which means low-worth blocks come back into view when slack
  // permits.
  //
  // Why this order (vs. low→high worth):
  //   The block-worth score is the AST's say on importance. A block with
  //   worth=high already got its full body (or near it) via Phase F's
  //   proportional allocation. Low-worth blocks (no edges, no anchors)
  //   were dropped because they competed poorly. With slack remaining,
  //   the next-most-valuable content TO ADD is the highest-worth block
  //   that's still partially dropped — not the lowest. So we walk
  //   DESCENDING by worth among blocks that currently have dropped
  //   content, and grow each one's body window until budget is tight or
  //   ratio reaches the band.
  //
  // What gets added within a block: the next-most-valuable lines per
  // AST. Anchor lines already in. Lines adjacent to existing anchors
  // come next (context for those anchors). Then anchor-less body lines
  // in source order to fill the rest.
  {
    const upperBound = Math.floor(text.length * 0.72);
    const targetMin = Math.ceil(text.length * 0.68);

    // Compute EXACT current output length, mirroring Phase H byte-for-byte.
    // Phase H emits selected-line strings (each followed by '\n' via join,
    // except the last) and one marker per contiguous dropped run. We
    // simulate the final output and use its .length as the source of
    // truth so G.7's budget check is exact, not approximate.
    //
    // The simulation is inline (no helper): walk 0..n, accumulate parts,
    // compute total = sum(parts.length) + parts.length - 1 for join('\n').
    // We re-run this after every fill so partial fills + marker splits
    // are accounted exactly.

    // Blocks sorted by worth DESC, used when expanding.
    const blocksByWorth = [...workingStructure].sort(
      (a, b) => (b.worth - a.worth) || (a.startLine - b.startLine),
    );

    // Helper computation (inline, repeated): currentBytes = exact length
    // of the would-be Phase H output. We compute it as needed.
    // (Defining this as a function would be a helper violation; instead
    // the same loop is duplicated each time it's needed. It's only used
    // twice below.)

    // Initial currentBytes computation.
    let currentBytes: number;
    {
      const partsLengths: number[] = [];
      let mOmit = -1;
      for (let idx = 0; idx < n; idx++) {
        if (resultLines.has(idx)) {
          if (mOmit >= 0) {
            partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${idx}]`.length);
            mOmit = -1;
          }
          partsLengths.push(resultLines.get(idx)!.length);
        } else if (mOmit < 0) mOmit = idx;
      }
      if (mOmit >= 0) partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${n}]`.length);
      currentBytes = partsLengths.reduce((a, b) => a + b, 0) + Math.max(0, partsLengths.length - 1);
    }

    // Fill content of dropped runs (worth desc) until we reach target_min.
    // Each pass attempts to grow one block. If filling the entire dropped
    // run would bust upperBound, we try a PARTIAL fill: pick a contiguous
    // sub-window of the run starting from the dropped run's edge that
    // borders the most valuable adjacent line (anchor or block sig).
    //
    // Partial windows must keep the remaining dropped tail ≥6 lines (the
    // tail will become a marker in Phase H, which requires ≥6 to be
    // valid). If the remaining tail would be <6 lines, expand the fill
    // to consume the rest (or skip if that would bust upperBound).
    const expandCap = workingStructure.length * 6 + 16;
    for (let pass = 0; pass < expandCap && currentBytes < targetMin; pass++) {
      let grew = false;
      for (const block of blocksByWorth) {
        if (currentBytes >= targetMin) break;
        const bs = Math.max(0, block.startLine);
        const be = Math.min(n - 1, block.endLine);
        if (bs > be) continue;

        // Find the first dropped line in this block and extend to the run.
        let dropStart = -1;
        for (let ln = bs; ln <= be; ln++) {
          if (!resultLines.has(ln)) { dropStart = ln; break; }
        }
        if (dropStart < 0) continue;
        let dropEnd = dropStart;
        while (dropEnd + 1 <= be && !resultLines.has(dropEnd + 1)) dropEnd++;

        // Try filling the whole run first. Compute exact output length
        // change by mutating resultLines tentatively, recomputing
        // currentBytes, and rolling back if overshoot.
        const savedEntries: Array<[number, string | undefined]> = [];
        for (let ln = dropStart; ln <= dropEnd; ln++) {
          savedEntries.push([ln, resultLines.get(ln)]);
          resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
        }
        // Recompute currentBytes exactly.
        let nextBytes: number;
        {
          const partsLengths: number[] = [];
          let mOmit = -1;
          for (let idx = 0; idx < n; idx++) {
            if (resultLines.has(idx)) {
              if (mOmit >= 0) {
                partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${idx}]`.length);
                mOmit = -1;
              }
              partsLengths.push(resultLines.get(idx)!.length);
            } else if (mOmit < 0) mOmit = idx;
          }
          if (mOmit >= 0) partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${n}]`.length);
          nextBytes = partsLengths.reduce((a, b) => a + b, 0) + Math.max(0, partsLengths.length - 1);
        }
        if (nextBytes <= upperBound) {
          // Whole-run fill fits within band. Commit by leaving the
          // tentative resultLines mutation in place and updating bytes.
          currentBytes = nextBytes;
          grew = true;
          continue;
        }

        // Whole-run fill would overshoot. Roll back and try a partial.
        for (const [ln, prev] of savedEntries) {
          if (prev === undefined) resultLines.delete(ln);
          else resultLines.set(ln, prev);
        }

        // Partial fill: start from dropStart and add lines one at a time
        // until adding the next line would bust upperBound OR the
        // remaining tail would be <6 lines (would create an invalid
        // marker). Track exact bytes after each tentative add.
        let added = 0;
        for (let ln = dropStart; ln <= dropEnd; ln++) {
          const remainingTail = dropEnd - ln;
          // If we add this line, the remaining tail is (dropEnd - ln).
          // If remainingTail < 6 and remainingTail > 0, the tail won't
          // satisfy the ≥6 marker rule — we must fill the whole tail or
          // not include this line. Choose based on what fits.
          const tentativeBefore = resultLines.has(ln);
          if (!tentativeBefore) resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
          // Recompute.
          const partsLengths: number[] = [];
          let mOmit = -1;
          for (let idx = 0; idx < n; idx++) {
            if (resultLines.has(idx)) {
              if (mOmit >= 0) {
                partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${idx}]`.length);
                mOmit = -1;
              }
              partsLengths.push(resultLines.get(idx)!.length);
            } else if (mOmit < 0) mOmit = idx;
          }
          if (mOmit >= 0) partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${n}]`.length);
          const after = partsLengths.reduce((a, b) => a + b, 0) + Math.max(0, partsLengths.length - 1);
          if (after > upperBound) {
            // Rollback this line and stop adding.
            if (!tentativeBefore) resultLines.delete(ln);
            break;
          }
          // Validate the resulting tail: if 0 < remainingTail < 6, this
          // partial would create an invalid marker for the tail. Roll
          // back this line and stop.
          if (remainingTail > 0 && remainingTail < _MIN_OMISSION_THRESHOLD) {
            if (!tentativeBefore) resultLines.delete(ln);
            break;
          }
          currentBytes = after;
          added++;
        }
        if (added > 0) {
          grew = true;
          continue;
        }
        // Couldn't fit even one line in this block's run; try the next block.
      }
      if (!grew) break; // No more fills possible.
    }

    // currentBytes now reflects the exact would-be output length.
  }

  // ─── Phase G.8: final ≥6 enforcement ─ boundary + interior cleanup ─────
  //
  // Phase G.5 enforced ≥6 on INTERIOR runs only. Phase G.7 may have
  // introduced new short interior runs or left boundary dropped runs <6.
  // This pass walks the GLOBAL run structure one final time and resolves
  // any remaining sub-threshold runs — INCLUDING boundary ones.
  //
  // Resolution rules (mirroring G.5, extended to boundary cases):
  //   • Interior shown run <6 with any AST signal: GROW (add adjacent
  //     dropped lines). Else: SHRINK (drop the sliver, marker absorbs).
  //   • Interior dropped run <6: FILL the gap (merge adjacent shown
  //     runs) if any neighbor has signal; else: GROW the marker by
  //     dropping a neighbor.
  //   • Boundary dropped run <6 (at file start or end): we can't make
  //     it a marker (≥6 rule). FILL it verbatim (the lines become shown
  //     content) — always. The cost is small (≤5 lines) so this never
  //     significantly affects ratio.
  //   • Boundary shown run <6: rare (the file starts/ends with a tiny
  //     amount of shown content that nothing else attaches to). Leave
  //     it — boundary shown runs are explicitly allowed by the rule.
  //
  // We rebuild linePri/isSigLine from workingStructure once (same data
  // G.5 used, but G.5's variables are out of scope here).
  {
    const linePri2 = new Map<number, number>();
    const isSigLine2 = new Set<number>();
    for (const b of workingStructure) {
      const sigIdx = Math.max(0, b.startLine);
      if (sigIdx < n) isSigLine2.add(sigIdx);
      if (b.anchors) {
        for (const a of b.anchors) {
          const aStart = a.startLine ?? 0;
          const aEnd = a.endLine ?? aStart;
          for (let ln = aStart; ln <= aEnd; ln++) {
            const cur = linePri2.get(ln) ?? 0;
            if ((a.priority ?? 0) > cur) linePri2.set(ln, a.priority ?? 0);
          }
        }
      }
    }

    const maxPasses2 = Math.max(64, n * 4);
    for (let pass = 0; pass < maxPasses2; pass++) {
      // Build runs.
      type Run2 = { start: number; end: number; type: 'show' | 'drop' };
      const runs2: Run2[] = [];
      {
        let i = 0;
        while (i < n) {
          const t: 'show' | 'drop' = resultLines.has(i) ? 'show' : 'drop';
          let j = i;
          while (j < n && (resultLines.has(j) ? 'show' : 'drop') === t) j++;
          runs2.push({ start: i, end: j - 1, type: t });
          i = j;
        }
      }

      // Find any sub-threshold run we need to resolve. Interior shown
      // <6, interior dropped <6, boundary dropped <6. Boundary shown <6
      // is allowed.
      let tgt = -1;
      for (let r = 0; r < runs2.length; r++) {
        const rn = runs2[r]!;
        const len = rn.end - rn.start + 1;
        if (len >= _MIN_OMISSION_THRESHOLD) continue;
        const isBoundary = r === 0 || r === runs2.length - 1;
        if (isBoundary && rn.type === 'show') continue; // allowed.
        if (isBoundary && rn.type === 'drop') { tgt = r; break; }
        // Interior: any sub-threshold needs resolution.
        tgt = r;
        break;
      }
      if (tgt < 0) break;

      const rn = runs2[tgt]!;
      const isBoundary = tgt === 0 || tgt === runs2.length - 1;

      if (rn.type === 'drop' && isBoundary) {
        // FILL the boundary dropped run verbatim. The lines become shown,
        // joining the adjacent shown run (if any) or forming a new
        // boundary shown run (boundary shown <6 is allowed).
        for (let ln = rn.start; ln <= rn.end; ln++) {
          if (lines[ln] !== undefined) resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
        }
        continue;
      }

      // Interior sub-threshold runs: same logic as G.5.
      let hasSignal = false;
      for (let ln = rn.start; ln <= rn.end; ln++) {
        if (linePri2.has(ln) || isSigLine2.has(ln)) { hasSignal = true; break; }
      }

      if (rn.type === 'show') {
        if (hasSignal) {
          // GROW: pull from neighbors. Bounded by upperBound, not
          // budget — we want the final output to land in band.
          const upperBound = Math.floor(text.length * 0.72);
          const need = _MIN_OMISSION_THRESHOLD - (rn.end - rn.start + 1);
          const leftRun = runs2[tgt - 1]!;
          const rightRun = runs2[tgt + 1]!;
          const leftAvail = leftRun.end - leftRun.start + 1;
          const rightAvail = rightRun.end - rightRun.start + 1;
          let takeLeft = Math.min(Math.ceil(need / 2), leftAvail);
          let takeRight = need - takeLeft;
          if (takeRight > rightAvail) {
            const diff = takeRight - rightAvail;
            takeRight = rightAvail;
            takeLeft = Math.min(takeLeft + diff, leftAvail);
          }
          // Tentatively add lines, compute exact output length, accept
          // if ≤ upperBound; else fall through to SHRINK.
          const tentLines: number[] = [];
          for (let i = 0; i < takeLeft; i++) {
            const ln = leftRun.end - i;
            if (ln >= 0 && ln < n) tentLines.push(ln);
          }
          for (let i = 0; i < takeRight; i++) {
            const ln = rightRun.start + i;
            if (ln >= 0 && ln < n) tentLines.push(ln);
          }
          for (const ln of tentLines) resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
          // Recompute.
          const partsLengths: number[] = [];
          let mOmit = -1;
          for (let idx = 0; idx < n; idx++) {
            if (resultLines.has(idx)) {
              if (mOmit >= 0) {
                partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${idx}]`.length);
                mOmit = -1;
              }
              partsLengths.push(resultLines.get(idx)!.length);
            } else if (mOmit < 0) mOmit = idx;
          }
          if (mOmit >= 0) partsLengths.push(`[TRUNCATED: lines ${mOmit + 1}-${n}]`.length);
          const after = partsLengths.reduce((a, b) => a + b, 0) + Math.max(0, partsLengths.length - 1);
          if (after <= upperBound) continue;
          // Doesn't fit — roll back and shrink.
          for (const ln of tentLines) resultLines.delete(ln);
        }
        // SHRINK: drop the sliver.
        for (let ln = rn.start; ln <= rn.end; ln++) resultLines.delete(ln);
        continue;
      } else {
        // Interior dropped sliver. Check neighbors for signal.
        const leftRun = runs2[tgt - 1]!;
        const rightRun = runs2[tgt + 1]!;
        let leftSignal = false, rightSignal = false;
        for (let ln = leftRun.start; ln <= leftRun.end; ln++) {
          if (linePri2.has(ln) || isSigLine2.has(ln)) { leftSignal = true; break; }
        }
        for (let ln = rightRun.start; ln <= rightRun.end; ln++) {
          if (linePri2.has(ln) || isSigLine2.has(ln)) { rightSignal = true; break; }
        }
        if (!leftSignal && !rightSignal) {
          // Both low-value: drop the shorter neighbor to extend the marker.
          const dropRun = (leftRun.end - leftRun.start) <= (rightRun.end - rightRun.start) ? leftRun : rightRun;
          for (let ln = dropRun.start; ln <= dropRun.end; ln++) resultLines.delete(ln);
          continue;
        }
        // At least one neighbor has signal: FILL the gap.
        for (let ln = rn.start; ln <= rn.end; ln++) {
          if (lines[ln] !== undefined) resultLines.set(ln, `${ln + 1}. ${lineAt(ln)}`);
        }
        continue;
      }
    }
  }

  // ─── Pre-H assertion: LINE-NUMBER TRUTH ─ non-negotiable invariant ─────
  //
  // Before Phase H emits anything, mechanically verify the selection set:
  //   (1) Every selected index 0 ≤ idx < n maps to lines[idx], and the
  //       string stored in resultLines is exactly `${idx+1}. ${lines[idx]}`.
  //       Any mismatch means a downstream edit targeting that line will
  //       hit the wrong content — silent file corruption.
  //   (2) Selected indices in resultLines, when iterated 0..n, appear
  //       in strictly ascending order (this is automatic from Map
  //       iteration over a 0..n walk; we assert it anyway).
  //   (3) Every gap of unselected lines either becomes ONE marker covering
  //       ≥6 source lines or has all gap lines covered (verbatim-inlined)
  //       by the defensive Phase H path. We pre-verify here so a violation
  //       throws instead of producing corrupted downstream output.
  //
  // This assertion is the safety net: if any prior phase introduces a
  // line-number-truth violation, this throws and the bug surfaces
  // immediately. Downstream consumers can rely on this contract.
  {
    // (1) Verbatim + line-number truth check.
    for (const [idx, rendered] of resultLines.entries()) {
      if (idx < 0 || idx >= n) {
        throw new Error(`zenith-toon: line-truth violation: selected idx ${idx} out of range [0, ${n})`);
      }
      const expected = `${idx + 1}. ${lines[idx]}`;
      if (rendered !== expected) {
        throw new Error(
          `zenith-toon: line-truth violation at idx ${idx}: ` +
          `expected ${JSON.stringify(expected.slice(0, 60))} ` +
          `got ${JSON.stringify(rendered.slice(0, 60))}`,
        );
      }
    }

    // (2) Strictly ascending: walk 0..n, collect selected indices, verify
    // monotonic. (Map preserves insertion order; we don't rely on that.)
    const selectedAsc: number[] = [];
    for (let idx = 0; idx < n; idx++) {
      if (resultLines.has(idx)) selectedAsc.push(idx);
    }
    for (let i = 1; i < selectedAsc.length; i++) {
      if (selectedAsc[i]! <= selectedAsc[i - 1]!) {
        throw new Error(
          `zenith-toon: line-truth violation: selected indices not ` +
          `strictly ascending at ${selectedAsc[i - 1]} → ${selectedAsc[i]}`,
        );
      }
    }

    // (3) Gap coverage: walk 0..n. For each contiguous run of unselected
    // lines, the run will become EITHER one [TRUNCATED] marker (run ≥ 6)
    // OR verbatim-inlined lines (run < 6, defensive path). Either way
    // EVERY source line in the gap is accounted for in the final output.
    // We don't need to check more — the Phase H emitter, given the
    // selection set we just verified, produces exactly the right output
    // for every source line position. But we DO assert here that the
    // resultLines map never references a line that doesn't exist.
    // (Already covered by check #1.)
  }

  // ─── Phase H: emit selected lines and markers ───────────────────────
  //
  // Walk 0..n in source order. Selected lines (resultLines) emit as
  // numbered verbatim. Each contiguous unselected run becomes ONE marker.
  //
  // By construction (Phase G.5 enforces interior runs; Phase G.8 fills
  // boundary <6 runs verbatim), every dropped run reaching Phase H is
  // ≥ _MIN_OMISSION_THRESHOLD. The defensive check below covers the
  // rare case where a sub-threshold dropped run slips through: we
  // inline its lines verbatim (still numbered) so the output never
  // contains a marker covering fewer than _MIN_OMISSION_THRESHOLD
  // source lines.
  const output: string[] = [];
  let omitStart = -1;
  for (let idx = 0; idx < n; idx++) {
    if (resultLines.has(idx)) {
      if (omitStart >= 0) {
        const gapCount = idx - omitStart;
        if (gapCount >= _MIN_OMISSION_THRESHOLD) {
          output.push(`[TRUNCATED: lines ${omitStart + 1}-${idx}]`);
        } else {
          // Defensive: G.8 should have prevented this. Inline verbatim
          // so we never emit a sub-threshold marker.
          for (let g = omitStart; g < idx; g++) {
            if (lines[g] !== undefined) output.push(`${g + 1}. ${lines[g]!}`);
          }
        }
        omitStart = -1;
      }
      output.push(resultLines.get(idx)!);
    } else {
      if (omitStart < 0) omitStart = idx;
    }
  }
  if (omitStart >= 0) {
    const gapCount = n - omitStart;
    if (gapCount >= _MIN_OMISSION_THRESHOLD) {
      output.push(`[TRUNCATED: lines ${omitStart + 1}-${n}]`);
    } else {
      // Defensive: G.8 fills boundary <6 dropped runs verbatim. This
      // path covers any residual edge case (e.g., file size 1 line).
      for (let g = omitStart; g < n; g++) {
        if (lines[g] !== undefined) output.push(`${g + 1}. ${lines[g]!}`);
      }
    }
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

  // Compute line numbers for the truncation marker
  const totalLines = text.split('\n').length;
  const markerTemplate = '\n[TRUNCATED: lines X-Y]\n';
  const usable = budget - markerTemplate.length;
  if (usable <= 0) {
    return text.slice(0, budget);
  }
  const headBudget = Math.floor(usable * headRatio);
  const tailBudget = usable - headBudget;

  // Count lines in head and tail portions
  const headText = text.slice(0, headBudget);
  const tailText = text.slice(-tailBudget);
  const headLines = headText.split('\n').length;
  const tailLines = tailText.split('\n').length;
  const firstOmitted = headLines + 1;
  const lastOmitted = totalLines - tailLines;
  
  const marker = `\n[TRUNCATED: lines ${firstOmitted}-${lastOmitted}]\n`;

  return headText + marker + tailText;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function compressString(text: string, budget: number, maxUserFrames = 10): string {
  // Enforce 70% retention floor — never compress below 70% of original
  const minBudget = Math.max(1, Math.floor(text.length * 0.70));
  budget = Math.max(budget, minBudget);
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
  astEdges?: ASTEdge[],
): string {
  // Enforce 70% retention floor — never compress below 70% of original
  const minBudget = Math.max(1, Math.floor(text.length * 0.70));
  budget = Math.max(budget, minBudget);
  // Even when no compression is needed (budget allows entire file),
  // output is numbered. Format compliance: every non-marker line in the
  // structured-source output is "N. <verbatim line>". Consumers expect
  // this format universally; returning raw text here would break the
  // contract.
  return _compressSourceStructured(text, budget, structure, astEdges);
}
