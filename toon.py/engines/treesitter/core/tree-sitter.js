// ---------------------------------------------------------------------------
// tree-sitter.js — Shared tree-sitter module for symbol-aware tools
//
// Provides:
//   1. Lazy initialization of web-tree-sitter WASM runtime
//   2. Grammar loading by file extension (cached after first load)
//   3. Query file loading (.scm patterns) per language
//   4. getSymbols()      — extract symbols (definitions + references) from source
//   5. getDefinitions()  — convenience: only definitions
//   6. getSymbolSummary()— count symbols by type for a file
//   7. findSymbol()      — find a specific symbol by name, with disambiguation
//   8. isSupported()     — check if tree-sitter supports a file extension
//
// Grammars:  ./grammars/grammars/tree-sitter-{lang}.wasm
// Queries:   ./grammars/queries/{lang}-tags.scm
// Runtime:   ./grammars/tree-sitter.wasm
//
// All loading is lazy. Nothing is loaded until first use.
// Language objects and compiled queries are cached permanently.
// Parsed symbols are cached by source hash (LRU, 100 entries).
// ---------------------------------------------------------------------------

import { Parser, Language as TSLanguage, Query as TSQuery } from 'web-tree-sitter';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const GRAMMARS_DIR = path.join(__dirname, '..', 'grammars', 'grammars');
const QUERIES_DIR  = path.join(__dirname, '..', 'grammars', 'queries');
const TS_WASM_PATH = path.join(__dirname, '..', 'grammars', 'tree-sitter.wasm');

// ---------------------------------------------------------------------------
// Extension → language mapping
// ---------------------------------------------------------------------------

const EXT_TO_LANG = {
    // JavaScript / TypeScript
    '.js':   'javascript',
    '.mjs':  'javascript',
    '.cjs':  'javascript',
    '.jsx':  'javascript',
    '.ts':   'typescript',
    '.mts':  'typescript',
    '.cts':  'typescript',
    '.tsx':  'tsx',
    // Python
    '.py':   'python',
    '.pyi':  'python',
    // Shell
    '.sh':   'bash',
    '.bash': 'bash',
    '.zsh':  'bash',
    // Go
    '.go':   'go',
    // Rust
    '.rs':   'rust',
    // Java
    '.java': 'java',
    // C / C++
    '.c':    'c',
    '.h':    'c',
    '.cpp':  'cpp',
    '.cc':   'cpp',
    '.cxx':  'cpp',
    '.hpp':  'cpp',
    '.hh':   'cpp',
    '.hxx':  'cpp',
    // C#
    '.cs':   'csharp',
    // Kotlin
    '.kt':   'kotlin',
    '.kts':  'kotlin',
    // PHP
    '.php':  'php',
    // Ruby
    '.rb':     'ruby',
    '.rake':   'ruby',
    '.gemspec': 'ruby',
    // Swift
    '.swift': 'swift',
    // Web
    '.css':   'css',
    '.scss':  'scss',
    '.html':  'html',
    '.htm':   'html',
    '.svelte': 'svelte',
    '.vue':   'vue',
    // Data formats
    '.json':  'json',
    '.jsonc': 'json',
    '.yaml':  'yaml',
    '.yml':   'yaml',
    '.sql':   'sql',
    '.toml':  'toml',
    '.xml':   'xml',
    // Config / infra
    '.tf':        'hcl',
    '.hcl':       'hcl',
    '.dockerfile': 'dockerfile',
    '.proto':     'proto',
    '.prisma':    'prisma',
    '.graphql':   'graphql',
    '.gql':       'graphql',
    '.ini':       'ini',
    // Scripting
    '.lua':   'lua',
    '.pl':    'perl',
    '.pm':    'perl',
    '.r':     'r',
    '.R':     'r',
    // Documentation
    '.md':    'markdown',
    '.mdx':   'markdown',
};

/**
 * Get the tree-sitter language name for a file path.
 * Returns null if the extension is not supported.
 */
export function getLangForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXT_TO_LANG[ext] || null;
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions() {
    return Object.keys(EXT_TO_LANG);
}

/**
 * Check if a file can be parsed by tree-sitter.
 */
export function isSupported(filePath) {
    return getLangForFile(filePath) !== null;
}

// ---------------------------------------------------------------------------
// Initialization & caching
// ---------------------------------------------------------------------------

let _initPromise = null;
const _languageCache = new Map();       // lang name → Language object (or null)
const _queryStringCache = new Map();    // lang name → raw .scm string (or null)
const _compiledQueryCache = new Map();  // lang name → Query object (or null)
const _localsQueryCache = new Map();      // lang → raw locals .scm string
const _injectionsQueryCache = new Map();  // lang → raw injections .scm string
const _compiledLocalsCache = new Map();   // lang → compiled locals Query
const _compiledInjectionsCache = new Map(); // lang → compiled injections Query

// Symbol cache: hash(source) → Symbol[]
const SYMBOL_CACHE_MAX = 100;
const _symbolCache = new Map();         // hash → { symbols, ts }

/**
 * Initialize the tree-sitter WASM runtime. Idempotent.
 */
async function ensureInit() {
    if (!_initPromise) {
        _initPromise = Parser.init({
            locateFile: () => TS_WASM_PATH,
        });
    }
    return _initPromise;
}

/**
 * Load a Language grammar (WASM), cached permanently.
 * Returns null if the grammar file doesn't exist.
 */
async function loadLanguage(langName) {
    if (_languageCache.has(langName)) {
        return _languageCache.get(langName);
    }

    await ensureInit();

    const wasmPath = path.join(GRAMMARS_DIR, `tree-sitter-${langName}.wasm`);
    try {
        await fs.access(wasmPath);
    } catch {
        _languageCache.set(langName, null);
        return null;
    }

    try {
        const language = await TSLanguage.load(wasmPath);
        _languageCache.set(langName, language);
        return language;
    } catch (err) {
        console.error(`Failed to load grammar for ${langName}:`, err.message);
        _languageCache.set(langName, null);
        return null;
    }
}

/**
 * Load the combined tags query string for a language.
 * Tries new subdirectory structure first (definitions.scm + references.scm),
 * falls back to flat {lang}-tags.scm. Cached permanently.
 */
async function loadQueryString(langName) {
    if (_queryStringCache.has(langName)) {
        return _queryStringCache.get(langName);
    }

    // Try new subdirectory structure first
    const langDir = path.join(QUERIES_DIR, langName);
    try {
        const parts = [];
        for (const file of ['definitions.scm', 'references.scm']) {
            try {
                const content = await fs.readFile(path.join(langDir, file), 'utf-8');
                parts.push(content.trim());
            } catch {
                // File doesn't exist, skip
            }
        }
        if (parts.length > 0) {
            const combined = parts.join('\n\n') + '\n';
            _queryStringCache.set(langName, combined);
            return combined;
        }
    } catch {
        // Directory doesn't exist, fall through
    }

    // Fallback: flat {lang}-tags.scm
    const scmPath = path.join(QUERIES_DIR, `${langName}-tags.scm`);
    try {
        const content = await fs.readFile(scmPath, 'utf-8');
        _queryStringCache.set(langName, content);
        return content;
    } catch {
        _queryStringCache.set(langName, null);
        return null;
    }
}

/**
 * Load a specific query file (locals.scm or injections.scm) from subdirectory.
 */
async function loadQueryFile(langName, queryType) {
    const cache = queryType === 'locals' ? _localsQueryCache : _injectionsQueryCache;
    if (cache.has(langName)) {
        return cache.get(langName);
    }

    const scmPath = path.join(QUERIES_DIR, langName, `${queryType}.scm`);
    try {
        const content = await fs.readFile(scmPath, 'utf-8');
        cache.set(langName, content);
        return content;
    } catch {
        cache.set(langName, null);
        return null;
    }
}

/**
 * Get a compiled locals Query object. Cached permanently.
 */
async function getCompiledLocalsQuery(langName) {
    if (_compiledLocalsCache.has(langName)) {
        return _compiledLocalsCache.get(langName);
    }

    const language = await loadLanguage(langName);
    if (!language) {
        _compiledLocalsCache.set(langName, null);
        return null;
    }

    const queryString = await loadQueryFile(langName, 'locals');
    if (!queryString) {
        _compiledLocalsCache.set(langName, null);
        return null;
    }

    try {
        const query = new TSQuery(language, queryString);
        _compiledLocalsCache.set(langName, query);
        return query;
    } catch (err) {
        console.error(`Failed to compile locals query for ${langName}:`, err.message);
        _compiledLocalsCache.set(langName, null);
        return null;
    }
}

/**
 * Get a compiled injections Query object. Cached permanently.
 */
async function getCompiledInjectionsQuery(langName) {
    if (_compiledInjectionsCache.has(langName)) {
        return _compiledInjectionsCache.get(langName);
    }

    const language = await loadLanguage(langName);
    if (!language) {
        _compiledInjectionsCache.set(langName, null);
        return null;
    }

    const queryString = await loadQueryFile(langName, 'injections');
    if (!queryString) {
        _compiledInjectionsCache.set(langName, null);
        return null;
    }

    try {
        const query = new TSQuery(language, queryString);
        _compiledInjectionsCache.set(langName, query);
        return query;
    } catch (err) {
        console.error(`Failed to compile injections query for ${langName}:`, err.message);
        _compiledInjectionsCache.set(langName, null);
        return null;
    }
}

/**
 * Get a compiled Query object for a language. Cached permanently.
 * Returns null if language or query unavailable.
 */
async function getCompiledQuery(langName) {
    if (_compiledQueryCache.has(langName)) {
        return _compiledQueryCache.get(langName);
    }

    const language = await loadLanguage(langName);
    if (!language) {
        _compiledQueryCache.set(langName, null);
        return null;
    }

    const queryString = await loadQueryString(langName);
    if (!queryString) {
        _compiledQueryCache.set(langName, null);
        return null;
    }

    try {
        const query = new TSQuery(language, queryString);
        _compiledQueryCache.set(langName, query);
        return query;
    } catch (err) {
        console.error(`Failed to compile query for ${langName}:`, err.message);
        _compiledQueryCache.set(langName, null);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Symbol cache helpers
// ---------------------------------------------------------------------------

function sourceHash(source) {
    return createHash('md5').update(source).digest('hex');
}

function getCachedSymbols(hash) {
    const entry = _symbolCache.get(hash);
    if (entry) {
        entry.ts = Date.now(); // touch for LRU
        return entry.symbols;
    }
    return null;
}

function setCachedSymbols(hash, symbols) {
    // Evict oldest if at capacity
    if (_symbolCache.size >= SYMBOL_CACHE_MAX) {
        let oldestKey = null, oldestTs = Infinity;
        for (const [key, val] of _symbolCache) {
            if (val.ts < oldestTs) {
                oldestTs = val.ts;
                oldestKey = key;
            }
        }
        if (oldestKey) _symbolCache.delete(oldestKey);
    }
    _symbolCache.set(hash, { symbols, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Symbol
 * @property {string}  name     - Symbol identifier (e.g. 'sendMessage')
 * @property {string}  kind     - 'def' or 'ref'
 * @property {string}  type     - Symbol type: 'function', 'class', 'method',
 *                                'interface', 'type', 'enum', 'module',
 *                                'call', 'key', 'section', 'selector', etc.
 * @property {number}  line     - 1-based start line of the identifier
 * @property {number}  endLine  - 1-based end line of the full definition body
 * @property {number}  column   - 0-based column of the identifier
 */

/**
 * Extract all symbols from source code.
 *
 * Uses query.matches() to properly pair @name.definition.* captures with
 * their sibling @definition.* captures, giving us both the symbol name
 * and its full body extent.
 *
 * @param {string} source   - the source code
 * @param {string} langName - tree-sitter language name
 * @param {Object} [options]
 * @param {string} [options.nameFilter]   - substring filter on symbol name (case-insensitive)
 * @param {string} [options.kindFilter]   - 'def' or 'ref'
 * @param {string} [options.typeFilter]   - 'function', 'class', 'method', etc.
 * @param {string[]} [options.excludeNames] - exact names to exclude
 * @returns {Promise<Symbol[] | null>} null if language not supported or no query
 */
export async function getSymbols(source, langName, options = {}) {
    // Check cache first
    const hash = sourceHash(langName + ':' + source);
    const cached = getCachedSymbols(hash);
    if (cached) {
        return applyFilters(cached, options);
    }

    const language = await loadLanguage(langName);
    if (!language) return null;

    const query = await getCompiledQuery(langName);
    if (!query) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    // Use matches() to get grouped captures per pattern match.
    // Each match contains both @name.definition.X and @definition.X captures.
    const matches = query.matches(tree.rootNode);
    const symbols = [];
    const seen = new Set();

    for (const match of matches) {
        const { captures } = match;

        // Find the name capture and the definition/reference body capture
        let nameCapture = null;
        let bodyCapture = null;

        for (const cap of captures) {
            if (cap.name.startsWith('name.')) {
                nameCapture = cap;
            } else if (cap.name.startsWith('definition.') || cap.name.startsWith('reference.')) {
                bodyCapture = cap;
            }
        }

        if (!nameCapture) continue;

        const tag = nameCapture.name;
        let kind, type;
        if (tag.startsWith('name.definition.')) {
            kind = 'def';
            type = tag.slice('name.definition.'.length);
        } else if (tag.startsWith('name.reference.')) {
            kind = 'ref';
            type = tag.slice('name.reference.'.length);
        } else {
            continue;
        }

        const name = nameCapture.node.text;
        const line = nameCapture.node.startPosition.row + 1;
        const column = nameCapture.node.startPosition.column;

        // endLine comes from the body capture if available, otherwise from
        // the name capture's own end (single-line symbol)
        let endLine;
        if (bodyCapture) {
            endLine = bodyCapture.node.endPosition.row + 1;
        } else {
            endLine = nameCapture.node.endPosition.row + 1;
        }

        // Dedup by name:kind:line
        const key = `${name}:${kind}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);

        symbols.push({ name, kind, type, line, endLine, column });
    }

    // Clean up parse tree and parser (query is cached, don't delete it)
    tree.delete();
    parser.delete();

    // Sort by line number
    symbols.sort((a, b) => a.line - b.line);

    // Cache the full unfiltered result
    setCachedSymbols(hash, symbols);

    return applyFilters(symbols, options);
}

/**
 * Apply optional filters to a symbol list.
 */
function applyFilters(symbols, options) {
    if (!options.kindFilter && !options.nameFilter && !options.typeFilter && !options.excludeNames) {
        return symbols;
    }

    return symbols.filter(sym => {
        if (options.kindFilter && sym.kind !== options.kindFilter) return false;
        if (options.typeFilter && sym.type !== options.typeFilter) return false;
        if (options.nameFilter && !sym.name.toLowerCase().includes(options.nameFilter.toLowerCase())) return false;
        if (options.excludeNames && options.excludeNames.includes(sym.name)) return false;
        return true;
    });
}

/**
 * Get only definitions from source code.
 * Convenience wrapper around getSymbols with kindFilter='def'.
 */
export async function getDefinitions(source, langName, options = {}) {
    return getSymbols(source, langName, { ...options, kindFilter: 'def' });
}

/**
 * Get a summary count of symbols by type for a file.
 *
 * @param {string} source   - the source code
 * @param {string} langName - tree-sitter language name
 * @returns {Promise<{ defs: Object, refs: Object, defTotal: number, refTotal: number } | null>}
 */
export async function getSymbolSummary(source, langName) {
    const symbols = await getSymbols(source, langName);
    if (!symbols) return null;

    const defs = {};
    const refs = {};
    let defTotal = 0, refTotal = 0;

    for (const sym of symbols) {
        if (sym.kind === 'def') {
            defs[sym.type] = (defs[sym.type] || 0) + 1;
            defTotal++;
        } else {
            refs[sym.type] = (refs[sym.type] || 0) + 1;
            refTotal++;
        }
    }

    return { defs, refs, defTotal, refTotal };
}

/**
 * Format a symbol summary as a compact string for directory listings.
 * E.g. "3 functions, 1 class, 2 methods" — definitions only.
 * Returns null if no definitions found or language not supported.
 */
export async function getSymbolSummaryString(source, langName) {
    const summary = await getSymbolSummary(source, langName);
    if (!summary || summary.defTotal === 0) return null;

    const parts = [];
    // Ordered by typical importance
    const order = ['class', 'interface', 'type', 'enum', 'function', 'method', 'module',
                   'key', 'section', 'selector', 'keyframes', 'media',
                   'variable', 'constant', 'property', 'object', 'mixin', 'extension',
                   'macro', 'resource', 'output', 'provider', 'local'];
    const used = new Set();

    for (const t of order) {
        if (summary.defs[t]) {
            const count = summary.defs[t];
            const label = count === 1 ? t : pluralize(t);
            parts.push(`${count} ${label}`);
            used.add(t);
        }
    }

    // Any remaining types not in the order list
    for (const [t, count] of Object.entries(summary.defs)) {
        if (used.has(t)) continue;
        const label = count === 1 ? t : pluralize(t);
        parts.push(`${count} ${label}`);
    }

    return parts.length > 0 ? parts.join(', ') : null;
}

function pluralize(type) {
    if (type.endsWith('s')) return type + 'es';
    if (type.endsWith('y')) return type.slice(0, -1) + 'ies';
    return type + 's';
}

/**
 * Find a specific symbol by name in source code.
 *
 * Supports dot-qualified names like "MyClass.sendMessage" — splits on '.'
 * and checks that the symbol named 'sendMessage' is contained within
 * a symbol named 'MyClass'.
 *
 * If multiple matches exist and nearLine is provided, sorts by proximity.
 * Otherwise returns all matches (caller decides whether to reject or pick).
 *
 * @param {string} source      - the source code
 * @param {string} langName    - tree-sitter language name
 * @param {string} symbolName  - exact name or dot-qualified name
 * @param {Object} [options]
 * @param {string} [options.kindFilter] - 'def' or 'ref' (default: 'def')
 * @param {number} [options.nearLine]   - prefer match closest to this line
 * @returns {Promise<Symbol[] | null>}  matched symbols sorted by relevance, or null
 */
export async function findSymbol(source, langName, symbolName, options = {}) {
    const kindFilter = options.kindFilter || 'def';

    // Handle dot-qualified names: "MyClass.sendMessage"
    const parts = symbolName.split('.');
    const targetName = parts[parts.length - 1];  // innermost name
    const parentNames = parts.slice(0, -1);       // qualifying parents

    const allSymbols = await getSymbols(source, langName, { kindFilter });
    if (!allSymbols) return null;

    // Find direct matches on the target name
    let matches = allSymbols.filter(s => s.name === targetName);

    // If qualified, filter to only those nested inside the parent symbol(s)
    if (parentNames.length > 0 && matches.length > 0) {
        // For each parent level, find the parent symbol and check containment
        const allDefs = kindFilter === 'def' ? allSymbols :
            await getSymbols(source, langName, { kindFilter: 'def' });
        if (!allDefs) return matches; // can't verify parents, return unfiltered

        matches = matches.filter(sym => {
            let current = sym;
            // Walk outward through parent qualifiers
            for (let i = parentNames.length - 1; i >= 0; i--) {
                const parentName = parentNames[i];
                // Find a definition that contains current's line range
                const parent = allDefs.find(d =>
                    d.name === parentName &&
                    d.line <= current.line &&
                    d.endLine >= current.endLine &&
                    d !== current
                );
                if (!parent) return false;
                current = parent;
            }
            return true;
        });
    }

    // Sort by proximity to nearLine if specified
    if (matches.length > 1 && options.nearLine) {
        matches.sort((a, b) =>
            Math.abs(a.line - options.nearLine) - Math.abs(b.line - options.nearLine)
        );
    }

    return matches;
}

/**
 * Get symbols for a file by path. Reads the file, detects language, parses.
 * Convenience wrapper that handles the full file → symbols pipeline.
 *
 * @param {string} filePath - absolute path to the file
 * @param {Object} [options] - same options as getSymbols
 * @returns {Promise<Symbol[] | null>}
 */
export async function getFileSymbols(filePath, options = {}) {
    const langName = getLangForFile(filePath);
    if (!langName) return null;

    let source;
    try {
        source = await fs.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }

    return getSymbols(source, langName, options);
}

/**
 * Get symbol summary string for a file by path.
 * Returns null if unsupported or no definitions found.
 */
export async function getFileSymbolSummary(filePath) {
    const langName = getLangForFile(filePath);
    if (!langName) return null;

    let source;
    try {
        const stat = await fs.stat(filePath);
        // Skip large files — parsing a 2MB file for a directory listing isn't worth it
        if (stat.size > 256 * 1024) return null;
        source = await fs.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }

    return getSymbolSummaryString(source, langName);
}

/**
 * Check if tree-sitter is available (runtime can init, grammars exist).
 */
export async function treeSitterAvailable() {
    try {
        await ensureInit();
        const files = await fs.readdir(GRAMMARS_DIR);
        return files.some(f => f.endsWith('.wasm'));
    } catch {
        return false;
    }
}

/**
 * Parse source code and check for syntax errors.
 * Returns an array of { line, column } for each ERROR node found.
 * Returns null if the language is not supported.
 * Returns empty array if no errors detected.
 *
 * @param {string} source   - the source code to check
 * @param {string} langName - tree-sitter language name
 * @returns {Promise<Array<{line: number, column: number}> | null>}
 */
export async function checkSyntaxErrors(source, langName) {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    try {
        if (!tree.rootNode.hasError()) {
            return [];
        }

        const errors = [];
        const MAX_ERRORS = 10;

        function walk(node) {
            if (errors.length >= MAX_ERRORS) return;
            if (node.type === 'ERROR' || node.isMissing()) {
                errors.push({
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                });
            }
            for (let i = 0; i < node.childCount; i++) {
                if (errors.length >= MAX_ERRORS) return;
                walk(node.child(i));
            }
        }

        walk(tree.rootNode);
        return errors;
    } finally {
        tree.delete();
        parser.delete();
    }
}

/**
 * Extract scope information using a locals.scm query.
 *
 * @param {string} source   - the source code
 * @param {string} langName - tree-sitter language name
 * @returns {Promise<Array<{startLine, endLine, type, bindings}> | null>}
 */
export async function getScopes(source, langName) {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const query = await getCompiledLocalsQuery(langName);
    if (!query) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    try {
        const captures = query.captures(tree.rootNode);
        const scopes = [];

        // First pass: build scope objects for every @scope capture
        for (const { name, node } of captures) {
            if (name === 'scope') {
                scopes.push({
                    startLine: node.startPosition.row + 1,
                    endLine:   node.endPosition.row + 1,
                    type:      node.type,
                    bindings:  [],
                });
            }
        }

        // Second pass: assign definitions/parameters/references to innermost scope
        for (const { name, node } of captures) {
            if (name !== 'local.definition' && name !== 'local.parameter' && name !== 'local.reference') {
                continue;
            }
            const capLine = node.startPosition.row + 1;
            let best = null;
            let bestRange = Infinity;
            for (const scope of scopes) {
                if (capLine >= scope.startLine && capLine <= scope.endLine) {
                    const range = scope.endLine - scope.startLine;
                    if (range < bestRange) {
                        bestRange = range;
                        best = scope;
                    }
                }
            }
            if (best) {
                best.bindings.push({ name: node.text, kind: name, line: capLine });
            }
        }

        return scopes;
    } finally {
        tree.delete();
        parser.delete();
    }
}

/**
 * Extract language injection regions using an injections.scm query.
 *
 * @param {string} source   - the source code
 * @param {string} langName - tree-sitter language name
 * @returns {Promise<Array<{language, startLine, endLine, content}> | null>}
 */
export async function getInjections(source, langName) {
    const language = await loadLanguage(langName);
    if (!language) return null;

    const query = await getCompiledInjectionsQuery(langName);
    if (!query) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);

    try {
        const matches = query.matches(tree.rootNode);
        const injections = [];

        for (const match of matches) {
            let langNode    = null;
            let contentNode = null;

            for (const { name, node } of match.captures) {
                if (name === 'injection.language') langNode    = node;
                if (name === 'injection.content')  contentNode = node;
            }

            if (!contentNode) continue;

            injections.push({
                language:  langNode ? langNode.text.toLowerCase() : null,
                startLine: contentNode.startPosition.row + 1,
                endLine:   contentNode.endPosition.row + 1,
                content:   contentNode.text,
            });
        }

        return injections;
    } finally {
        tree.delete();
        parser.delete();
    }
}
