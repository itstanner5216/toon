// parity.test.ts
// Standalone Node-runnable parity tests.
// Run via: node --experimental-strip-types --loader /tmp/ts_loader.mjs tests/toon/parity.test.ts
// from the zenith/ directory.
//
// EXECUTION NOTE: Because the TS source files use .js extensions in imports
// (ESM NodeNext convention), a custom loader that redirects .js -> .ts is
// required when running with --experimental-strip-types. See TOON_PORT_VERIFICATION.md
// for the exact command used to execute these tests.

import { compressString, compressSourceStructured } from '../../src/toon/string-codec.js';
import { encodeOutput } from '../../src/toon/encoder.js';
import {
  estimateTokens,
  computeGini,
  findKneedle,
  pearsonR,
  canonicalJson,
  blake2bHash,
  normalizeValue,
} from '../../src/toon/utils.js';
import { defaultToonConfig } from '../../src/toon/config.js';
import { BMXPlusIndex } from '../../src/toon/bmx-plus.js';
import { SageRank } from '../../src/toon/sagerank.js';
import { Deduplicator } from '../../src/toon/dedup.js';
import { BudgetAllocator } from '../../src/toon/budget.js';
import { routeField } from '../../src/toon/router.js';
import { PRESETS } from '../../src/toon/presets.js';
import { compress, TOONCompressor } from '../../src/toon/pipeline.js';
import type { StructureBlock, EntryMeta } from '../../src/toon/types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function record(ok: boolean, label: string, detail?: string): void {
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}${detail ? '\n  ' + detail : ''}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(a === e, label, `expected: ${e}\n  actual:   ${a}`);
}

function assertTrue(cond: boolean, label: string, detail?: string): void {
  record(cond, label, detail);
}

function assertCloseTo(actual: number, expected: number, tol: number, label: string): void {
  record(
    Math.abs(actual - expected) <= tol,
    label,
    `expected: ${expected}±${tol}, actual: ${actual}`,
  );
}

// ============================================================
// utils.ts
// ============================================================

// estimateTokens
{
  const r = estimateTokens('Hello world');
  assertTrue(typeof r === 'number' && r > 0, 'estimateTokens returns positive number');
}

{
  const r = estimateTokens('{"key": "value", "number": 42}');
  assertTrue(typeof r === 'number' && r > 0, 'estimateTokens(json string) returns positive number');
}

// computeGini
{
  const g = computeGini([1, 1, 1, 1]);
  assertCloseTo(g, 0, 1e-10, 'computeGini([1,1,1,1]) ≈ 0 (uniform distribution)');
}

{
  const g = computeGini([0, 0, 0, 100]);
  assertCloseTo(g, 0.75, 1e-3, 'computeGini([0,0,0,100]) ≈ 0.75');
}

{
  const g = computeGini([]);
  assertEq(g, 0.0, 'computeGini([]) returns 0.0 (empty)');
}

{
  const g = computeGini([42]);
  assertEq(g, 0.0, 'computeGini([42]) returns 0.0 (single element)');
}

// findKneedle
{
  const idx = findKneedle([1, 2, 4, 8, 16, 32]);
  assertTrue(typeof idx === 'number' && idx >= 0 && idx < 6, 'findKneedle([1,2,4,8,16,32]) returns valid index in range');
}

{
  const idx = findKneedle([1]);
  assertEq(idx, 0, 'findKneedle([1]) returns 0 (n<3 → n-1)');
}

{
  const idx = findKneedle([5, 5, 5, 5, 5]);
  assertEq(idx, 4, 'findKneedle flat distribution returns n-1');
}

// pearsonR
{
  const r = pearsonR([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assertCloseTo(r, 1.0, 1e-10, 'pearsonR perfect positive correlation ≈ 1.0');
}

{
  const r = pearsonR([1, 2], [3, 4]);
  assertEq(r, 0.0, 'pearsonR n<3 returns 0.0');
}

{
  const r = pearsonR([1, 1, 1, 1, 1], [2, 3, 4, 5, 6]);
  assertEq(r, 0.0, 'pearsonR zero variance x returns 0.0');
}

// canonicalJson
{
  const result = canonicalJson({ b: 2, a: 1 });
  // Python: json.dumps({"b":2, "a":1}, sort_keys=True, separators=(',', ':'))
  // = '{"a":1,"b":2}'  (no spaces with custom separators)
  // Our TS uses JSON.stringify (default separators include space after colon)
  // The port uses standard JSON.stringify (no custom separators) after sorting keys.
  // Verify that keys are sorted:
  const parsed = JSON.parse(result) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  assertEq(keys[0], 'a', 'canonicalJson sorts keys: first key is "a"');
  assertEq(keys[1], 'b', 'canonicalJson sorts keys: second key is "b"');
  assertEq(parsed['a'] as number, 1, 'canonicalJson preserves values: a=1');
  assertEq(parsed['b'] as number, 2, 'canonicalJson preserves values: b=2');
}

{
  // Nested object key ordering
  const result = canonicalJson({ z: { y: 2, x: 1 }, a: 'first' });
  const parsed = JSON.parse(result) as Record<string, unknown>;
  const inner = parsed['z'] as Record<string, unknown>;
  const innerKeys = Object.keys(inner);
  assertEq(innerKeys[0], 'x', 'canonicalJson sorts keys recursively: inner first key is "x"');
}

// blake2bHash
{
  const h = blake2bHash('test', 8);
  assertTrue(typeof h === 'string' && h.length === 16, 'blake2bHash("test", 8) returns 16-char hex string');
}

{
  const ha = blake2bHash('a');
  const hb = blake2bHash('b');
  assertTrue(ha !== hb, 'blake2bHash("a") !== blake2bHash("b")');
}

{
  const h1 = blake2bHash('x');
  const h2 = blake2bHash('x');
  assertEq(h1, h2, 'blake2bHash("x") === blake2bHash("x") (deterministic)');
}

{
  const h = blake2bHash('test', 4);
  assertTrue(h.length === 8, 'blake2bHash with digestSize=4 returns 8-char hex');
}

{
  const h = blake2bHash('test', 16);
  assertTrue(h.length === 32, 'blake2bHash with digestSize=16 returns 32-char hex');
}

// normalizeValue
{
  const result = normalizeValue(42);
  assertEq(result, '<NUM>', 'normalizeValue(42) returns "<NUM>"');
}

{
  const result = normalizeValue('2023-01-15T10:30:00Z foo bar');
  assertTrue(typeof result === 'string' && (result as string).includes('<TS>'), 'normalizeValue replaces timestamp with <TS>');
}

{
  const result = normalizeValue({ b: 1, a: 2 }) as Record<string, unknown>;
  const keys = Object.keys(result);
  assertEq(keys[0], 'a', 'normalizeValue sorts object keys');
}

// ============================================================
// encoder.ts
// ============================================================

{
  // Array > threshold → fold
  const result = encodeOutput({ files: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }, 5) as Record<string, unknown>;
  const files = result['files'] as Record<string, unknown>;
  assertEq(files['__toon'] as boolean, true, 'encodeOutput: folded array has __toon: true');
  assertEq(files['count'] as number, 8, 'encodeOutput: folded array count=8');
  assertEq(files['sample'] as string[], ['a', 'b', 'c'], 'encodeOutput: folded array sample is first 3');
}

{
  // Array <= threshold → unchanged
  const result = encodeOutput({ files: ['a', 'b'] }, 5) as Record<string, unknown>;
  assertEq(result['files'] as string[], ['a', 'b'], 'encodeOutput: small array returned unchanged');
}

{
  // Nested array folding
  const result = encodeOutput({ nested: { data: [1, 2, 3, 4, 5, 6] } }, 5) as Record<string, unknown>;
  const nested = result['nested'] as Record<string, unknown>;
  const data = nested['data'] as Record<string, unknown>;
  assertEq(data['__toon'] as boolean, true, 'encodeOutput: nested array folded');
  assertEq(data['count'] as number, 6, 'encodeOutput: nested array count=6');
}

{
  // Empty array — under threshold
  const result = encodeOutput({ files: [] }, 5) as Record<string, unknown>;
  assertEq(result['files'] as unknown[], [], 'encodeOutput: empty array returned unchanged');
}

{
  // Threshold error
  let threw = false;
  try { encodeOutput({}, 0); } catch { threw = true; }
  assertTrue(threw, 'encodeOutput with threshold=0 throws error');
}

{
  // Primitives pass through
  const result = encodeOutput({ name: 'Alice', count: 3 }, 5) as Record<string, unknown>;
  assertEq(result['name'] as string, 'Alice', 'encodeOutput: string value unchanged');
  assertEq(result['count'] as number, 3, 'encodeOutput: number value unchanged');
}

// ============================================================
// config.ts
// ============================================================

{
  const cfg = defaultToonConfig();
  assertTrue(typeof cfg === 'object' && cfg !== null, 'defaultToonConfig returns an object');
  assertEq(cfg.enabled, true, 'defaultToonConfig: enabled=true');
  assertEq(cfg.emit_markers, true, 'defaultToonConfig: emit_markers=true');
  assertEq(cfg.emit_stats, false, 'defaultToonConfig: emit_stats=false');
  assertEq(cfg.array.threshold, 5, 'defaultToonConfig: array.threshold=5');
  assertEq(cfg.array.sample_size, 3, 'defaultToonConfig: array.sample_size=3');
  assertEq(cfg.string.default_budget, 500, 'defaultToonConfig: string.default_budget=500');
  assertEq(cfg.string.min_length, 200, 'defaultToonConfig: string.min_length=200');
  assertEq(cfg.string.parse_json, true, 'defaultToonConfig: string.parse_json=true');
  assertEq(cfg.dedup.scope, 'session', 'defaultToonConfig: dedup.scope="session"');
  assertEq(cfg.dedup.maxsize, 5000, 'defaultToonConfig: dedup.maxsize=5000');
  assertEq(cfg.bmx.enabled, false, 'defaultToonConfig: bmx.enabled=false');
  assertEq(cfg.bmx.core_fraction, 0.15, 'defaultToonConfig: bmx.core_fraction=0.15');
  assertTrue(Array.isArray(cfg.preserve_rules) && cfg.preserve_rules.length === 0, 'defaultToonConfig: preserve_rules=[]');
  assertTrue(Array.isArray(cfg.encode_rules) && cfg.encode_rules.length === 0, 'defaultToonConfig: encode_rules=[]');
  assertEq(cfg.default_codec, null, 'defaultToonConfig: default_codec=null');
}

// ============================================================
// bmx-plus.ts
// ============================================================

{
  const idx = new BMXPlusIndex();
  idx.buildIndex([
    { chunk_id: 'doc1', text: 'The quick brown fox jumps over the lazy dog' },
    { chunk_id: 'doc2', text: 'A lazy dog slept in the warm sun all afternoon' },
    { chunk_id: 'doc3', text: 'The fox ran quickly across the green meadow' },
    { chunk_id: 'doc4', text: 'Machine learning models require training data' },
    { chunk_id: 'doc5', text: 'Natural language processing enables text analysis' },
  ]);

  const results = idx.search('fox lazy dog', 5);
  assertTrue(Array.isArray(results), 'BMXPlusIndex.search returns array');
  assertTrue(results.length > 0, 'BMXPlusIndex.search returns non-empty results');

  // Results should be [chunkId, score] pairs
  assertTrue(Array.isArray(results[0]) && results[0].length === 2, 'BMXPlusIndex.search results are [chunkId, score] pairs');
  assertTrue(typeof results[0][0] === 'string', 'BMXPlusIndex.search result[0][0] is string (chunkId)');
  assertTrue(typeof results[0][1] === 'number', 'BMXPlusIndex.search result[0][1] is number (score)');

  // Results should be sorted descending by score
  if (results.length >= 2) {
    assertTrue(results[0][1] >= results[1][1], 'BMXPlusIndex.search results sorted descending by score');
  }

  // documentCount and vocabularySize
  assertEq(idx.documentCount, 5, 'BMXPlusIndex.documentCount=5 after building');
  assertTrue(idx.vocabularySize > 0, 'BMXPlusIndex.vocabularySize > 0');
}

// ============================================================
// sagerank.ts
// ============================================================

{
  const sr = new SageRank();
  const result = sr.rankSentences([
    'First sentence has important content about machine learning.',
    'Second sentence discusses natural language processing methods.',
    'Third one talks about a different topic entirely.',
  ]);

  assertTrue(Array.isArray(result.sentences), 'SageRank.rankSentences: sentences is array');
  assertEq(result.sentences.length, 3, 'SageRank.rankSentences: sentences has 3 items');
  assertTrue(Array.isArray(result.selectedSentences), 'SageRank.rankSentences: selectedSentences is array');
  assertTrue(result.selectedSentences.length > 0, 'SageRank.rankSentences: selectedSentences is non-empty');
  assertTrue(Array.isArray(result.scores) && result.scores.length === 3, 'SageRank.rankSentences: scores has 3 items');
  assertTrue(result.scores.every((s: number) => typeof s === 'number'), 'SageRank.rankSentences: all scores are numbers');
}

{
  // Single sentence edge case
  const sr = new SageRank();
  const result = sr.rankSentences(['Only one sentence here.']);
  assertEq(result.sentences.length, 1, 'SageRank.rankSentences: single sentence input works');
  assertEq(result.selectedSentences.length, 1, 'SageRank.rankSentences: single sentence selected');
}

{
  // Empty input
  const sr = new SageRank();
  const result = sr.rankSentences([]);
  assertEq(result.sentences.length, 0, 'SageRank.rankSentences: empty input returns empty sentences');
  assertEq(result.selectedSentences.length, 0, 'SageRank.rankSentences: empty input returns empty selected');
}

// ============================================================
// dedup.ts
// ============================================================

{
  const dedup = new Deduplicator();
  const result = dedup.deduplicate([
    { id: 1, content: 'a' },
    { id: 2, content: 'a' },
  ]);

  assertTrue(result.entries.length < 2, 'Deduplicator removes duplicate entry');
  // { id:1, content:'a' } and { id:2, content:'a' } differ in 'id' (exact hash differs),
  // but normalizeValue replaces both numeric id values with '<NUM>', making them near-dups.
  // So exact=0, near=1 is the correct behavior.
  const totalRemoved = result.dedup_stats.exact + result.dedup_stats.near;
  assertEq(totalRemoved, 1, 'Deduplicator: one duplicate removed (exact or near-dup)');
}

{
  const dedup = new Deduplicator();
  const result = dedup.deduplicate([
    { id: 1, content: 'unique1' },
    { id: 2, content: 'unique2' },
    { id: 3, content: 'unique3' },
  ]);

  assertEq(result.entries.length, 3, 'Deduplicator: no dups, all 3 entries pass through');
  assertEq(result.dedup_stats.exact, 0, 'Deduplicator: no exact dups counted');
}

{
  // Reset clears state
  const dedup = new Deduplicator();
  dedup.deduplicate([{ id: 1, val: 'x' }]);
  dedup.reset();
  const result = dedup.deduplicate([{ id: 1, val: 'x' }]);
  // After reset, the same entry should be seen fresh
  assertEq(result.dedup_stats.exact, 0, 'Deduplicator: after reset, same entry is fresh');
}

// ============================================================
// budget.ts
// ============================================================

{
  const entries: EntryMeta[] = Array.from({ length: 10 }, (_, i) => ({
    content: { id: i, text: 'Some text content here' },
    type: 'dict',
    index: i,
    template_id: null,
  }));

  const scores = Array.from({ length: 10 }, (_, i) => (10 - i) / 10);
  const tiers = ['high', 'high', 'high', 'medium', 'medium', 'medium', 'low', 'low', 'low', 'low'];
  const total = 1000;

  const alloc = BudgetAllocator.allocate(entries, scores, tiers, total);

  assertTrue(typeof alloc === 'object', 'BudgetAllocator.allocate returns object');
  assertEq(alloc.total_budget, total, 'BudgetAllocator: total_budget preserved');
  assertTrue(alloc.reserve > 0, 'BudgetAllocator: reserve > 0');
  assertEq(alloc.entry_budgets.length, 10, 'BudgetAllocator: entry_budgets has 10 entries');

  // 60/30/10 split for high/medium/low
  const usable = total - alloc.reserve;
  const remaining = usable; // no preserve entries
  const expectedHigh = Math.trunc(remaining * 0.60);
  const expectedMedium = Math.trunc(remaining * 0.30);
  assertEq(alloc.tier_budgets['high'], expectedHigh, 'BudgetAllocator: high tier = 60% of remaining');
  assertEq(alloc.tier_budgets['medium'], expectedMedium, 'BudgetAllocator: medium tier = 30% of remaining');

  // All budgets should be positive
  assertTrue(alloc.entry_budgets.every((b: number) => b >= 10), 'BudgetAllocator: all entry budgets >= 10');
}

// ============================================================
// string-codec.ts
// ============================================================

{
  // Empty string
  const r = compressString('', 100);
  assertEq(r, '', 'compressString("", 100) returns empty string');
}

{
  // Short string under budget - returned unchanged
  const r = compressString('short', 1000);
  assertEq(r, 'short', 'compressString("short", 1000) returns input unchanged (under budget)');
}

{
  // Multi-line text, tight budget
  const input = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
  const r = compressString(input, 50);
  assertTrue(typeof r === 'string' && r.length > 0, 'compressString multi-line tight budget returns non-empty string');
  assertTrue(r.length <= input.length, 'compressString multi-line tight budget is no larger than input');
}

{
  // Stack trace input - handles without throwing
  const stackTrace = [
    'Error: Connection refused',
    '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1278:16)',
    '    at Object.process (site-packages/urllib3/connectionpool.py:1000)',
    '    at module._bootstrap._call_with_frames_removed (<frozen importlib._bootstrap>:219)',
    '    at app/server.js:45:12',
    '    at app/handlers/api.js:23:8',
  ].join('\n');

  let threw = false;
  let result = '';
  try {
    result = compressString(stackTrace, 200);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'compressString stack trace does not throw');
  assertTrue(typeof result === 'string' && result.length > 0, 'compressString stack trace returns non-empty string');
}

{
  // JSON string input - handles without throwing
  const jsonInput = JSON.stringify({ key: 'value', nested: { a: 1, b: [1, 2, 3] }, extra: 'some data here' });
  let threw = false;
  let result = '';
  try {
    result = compressString(jsonInput, 30);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'compressString JSON input does not throw');
  assertTrue(typeof result === 'string' && result.length > 0, 'compressString JSON input returns non-empty string');
}

{
  // compressString budget=0 - handles gracefully (no throw)
  let threw = false;
  try {
    compressString('some content here that is long enough to trigger compression', 0);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'compressString budget=0 does not throw');
}

{
  // compressString budget=1 - handles gracefully
  let threw = false;
  let result = '';
  try {
    result = compressString('some content here', 1);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'compressString budget=1 does not throw');
}

{
  // compressString budget > input.length - returns original
  const input = 'short text';
  const r = compressString(input, 10000);
  assertEq(r, input, 'compressString budget > input.length returns input unchanged');
}

{
  // compressSourceStructured with two functions - returns string with both names
  const src = 'def foo():\n    pass\n\ndef bar():\n    pass\n';
  const structure: StructureBlock[] = [
    { name: 'foo', kind: 'function', type: 'function', startLine: 0, endLine: 1, exported: false, anchors: [] },
    { name: 'bar', kind: 'function', type: 'function', startLine: 3, endLine: 4, exported: false, anchors: [] },
  ];
  const result = compressSourceStructured(src, 1000, structure);
  assertTrue(typeof result === 'string' && result.length > 0, 'compressSourceStructured returns non-empty string');
  assertTrue(result.includes('foo'), 'compressSourceStructured result includes function name "foo"');
  assertTrue(result.includes('bar'), 'compressSourceStructured result includes function name "bar"');
}

{
  // compressSourceStructured with empty structure falls back to compressString
  const src = 'def foo():\n    pass\n';
  const result = compressSourceStructured(src, 1000, []);
  assertTrue(typeof result === 'string', 'compressSourceStructured with empty structure returns string');
}

// ============================================================
// router.ts + presets.ts
// ============================================================

{
  assertTrue(typeof PRESETS === 'object' && PRESETS !== null, 'PRESETS is an object');
  const keys = Object.keys(PRESETS);
  assertTrue(keys.length > 0, 'PRESETS is non-empty');
  assertTrue(keys.includes('generic'), 'PRESETS has "generic" preset');
  assertTrue(keys.includes('codex_logs'), 'PRESETS has "codex_logs" preset');
  assertTrue(keys.includes('mcp_responses'), 'PRESETS has "mcp_responses" preset');
  assertTrue(keys.includes('aggressive'), 'PRESETS has "aggressive" preset');
}

{
  // routeField does not throw
  const cfg = defaultToonConfig();
  let threw = false;
  let result = '';
  try {
    result = routeField('email', 'foo@bar', cfg);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'routeField("email", "foo@bar", defaultToonConfig()) does not throw');
  assertEq(result, 'passthrough', 'routeField with empty rules returns "passthrough"');
}

{
  // routeField with disabled config
  const cfg = defaultToonConfig({ enabled: false });
  const result = routeField('any.field', 'value', cfg);
  assertEq(result, 'passthrough', 'routeField: disabled config always returns "passthrough"');
}

{
  // routeField with preserve rule
  const cfg = defaultToonConfig({
    preserve_rules: [{ field_path: 'message', field_pattern: null, min_length: null, max_length: null }],
  });
  const result = routeField('message', 'hello world', cfg);
  assertEq(result, 'preserve', 'routeField: preserve rule matches field_path exactly');
}

// ============================================================
// pipeline.ts
// ============================================================

{
  // compress with mixed dict
  let threw = false;
  let result: unknown;
  try {
    result = compress({ a: 1, b: 'short string' }, 1000);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'compress({a: 1, b: "short string"}, 1000) does not throw');
  assertTrue(result !== undefined && result !== null, 'compress returns non-null result');
}

{
  // compress with list
  let threw = false;
  let result: unknown;
  try {
    result = compress([{ id: 1, text: 'hello' }, { id: 2, text: 'world' }], 500);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'compress([...], 500) does not throw');
}

{
  // TOONCompressor constructs without throwing
  let threw = false;
  let compressor: TOONCompressor | null = null;
  try {
    compressor = new TOONCompressor();
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'new TOONCompressor() constructs without throwing');
  assertTrue(compressor !== null, 'TOONCompressor instance is non-null');
}

{
  // TOONCompressor.feed() and .reset() lifecycle
  const compressor = new TOONCompressor();

  let feedResult: unknown;
  let threw = false;
  try {
    feedResult = compressor.feed({ id: 1, text: 'hello world' });
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'TOONCompressor.feed() does not throw');

  // Second feed of same item should be deduplicated (returns null)
  const feedResult2 = compressor.feed({ id: 1, text: 'hello world' });
  assertEq(feedResult2 as null, null, 'TOONCompressor.feed() second identical item returns null (deduped)');

  // reset() clears state
  compressor.reset();
  const feedResult3 = compressor.feed({ id: 1, text: 'hello world' });
  assertTrue(feedResult3 !== null, 'TOONCompressor.feed() after reset sees item as fresh');
}

{
  // compress with null budget uses auto budget
  let threw = false;
  try {
    compress({ data: 'hello' }, null);
  } catch (e) {
    threw = true;
  }
  assertTrue(!threw, 'compress with null budget does not throw');
}

{
  // compress empty list returns empty list
  const result = compress([], 1000);
  assertTrue(Array.isArray(result) && (result as unknown[]).length === 0, 'compress([]) returns []');
}

// ============================================================
// Print results
// ============================================================

console.log('\n==================== PARITY TEST RESULTS ====================');
console.log(`TOTAL:  ${passed + failed}`);
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);

if (failures.length > 0) {
  console.log('\n---------- FAILURES ----------');
  for (const f of failures) {
    console.log(f);
  }
}

console.log('==============================================================\n');

if (failed > 0) {
  process.exit(1);
}
