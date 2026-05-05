import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { randomBytes, createHash } from 'crypto';
import { getProjectContext } from '../core/project-context.js';
import {
    getDb, indexDirectory, ensureIndexFresh, indexFile,
    impactQuery, getSessionId, findRepoRoot, snapshotSymbol,
    getVersionHistory, getVersionText,
} from '../core/symbol-index.js';
import {
    getLangForFile, findSymbol, getSymbolStructure, checkSyntaxErrors,
} from '../core/tree-sitter.js';
import { applyEditList, syntaxWarn } from '../core/edit-engine.js';
import { normalizeLineEndings } from '../core/lib.js';

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

const MAX_CHARS = Number(process.env.REFACTOR_MAX_CHARS) || 30000;
const DEFAULT_CONTEXT = 5;
const MAX_CONTEXT_LINES = Math.min(30, Number(process.env.REFACTOR_MAX_CONTEXT) || 30);

// ---------------------------------------------------------------------------
// Module-level caches (per-process, keyed by `${repoRoot}::${sessionId}`)
// ---------------------------------------------------------------------------

const _loadCache = new Map();
// Reserved for Task 2.1 (apply/reapply) — declared now so Wave 2 only extends.
const _payloadCache = new Map();
// Keyed by `${repoRoot}::${sessionId}::${symbolName}`. Locks a group after 1 failed retry.
const _retryState = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    if (typeof a === 'object') {
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
        return true;
    }
    return false;
}

function findModal(items) {
    // items: array of structures (may contain null). Returns the non-null structure
    // that occurs most often by deep equality. Null if all entries are null.
    const buckets = [];
    for (const s of items) {
        if (s === null || s === undefined) continue;
        let hit = null;
        for (const b of buckets) {
            if (deepEqual(b.sample, s)) { hit = b; break; }
        }
        if (hit) hit.count++;
        else buckets.push({ sample: s, count: 1 });
    }
    if (!buckets.length) return null;
    buckets.sort((a, b) => b.count - a.count);
    return buckets[0].sample;
}

function firstDiffReason(modal, s) {
    if (!modal || !s) return null;
    if (!deepEqual(modal.params, s.params)) return 'param shape differs';
    if (!deepEqual(modal.returnKind, s.returnKind)) return 'return type differs';
    if (!deepEqual(modal.parentKind, s.parentKind)) return 'parent scope differs';
    if (!deepEqual(modal.decorators, s.decorators)) return 'decorators differ';
    if (!deepEqual(modal.modifiers, s.modifiers)) return 'modifiers differ';
    return null;
}

// Parses:
//   validateCard 1,2,3 ack:3
//   function validateCard(card) { ... }
//
//   chargeStripe 1,2
//   function chargeStripe(card, amount) { ... }
//
// Returns: [{symbol, indices: number[], ack: number[], body: string}, ...]
function parsePayload(payload) {
    const groups = [];
    const blocks = payload.split(/\n(?=[A-Za-z_$][\w$.]*\s+\d)/);
    for (const block of blocks) {
        const nl = block.indexOf('\n');
        if (nl === -1) continue;
        const header = block.slice(0, nl).trim();
        const body = block.slice(nl + 1).replace(/\n+$/, '');
        const m = header.match(/^([A-Za-z_$][\w$.]*)\s+([\d,\s]+?)(?:\s+ack:([\d,\s]+))?$/);
        if (!m) continue;
        const symbol = m[1];
        const indices = m[2].split(',').map(s => Number(s.trim())).filter(Number.isFinite);
        const ack = m[3] ? m[3].split(',').map(s => Number(s.trim())).filter(Number.isFinite) : [];
        groups.push({ symbol, indices, ack, body });
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(server, ctx) {
    server.registerTool("refactor_batch", {
        title: "Refactor Batch",
        description: "Apply one edit pattern across multiple similar symbols, with rollback. Core pipeline: loadDiff (symbol bodies + context) → apply (write edits). query is optional — you can skip it and call loadDiff directly with explicit {symbol, file} pairs if you already know the targets (e.g. from search_files). After a successful apply: reapply sends the same cached edit to new targets, restore rolls back any symbol to a prior snapshot. Every apply/reapply/restore snapshots pre-edit text automatically. No default mode — mode is always required.",
        inputSchema: z.object({
            mode: z.enum(["query", "loadDiff", "apply", "reapply", "restore", "history"]).describe(
                "Required. query: impact analysis — who calls/is called by a symbol. loadDiff: load symbol bodies with surrounding context into a diff you edit and send back. apply: write the edited diff. reapply: apply a previously successful edit pattern to new targets. restore: rollback a symbol to a snapshotted version. history: list available version snapshots for a symbol."
            ),
            target: z.string().optional().describe("query: The symbol name to analyze for impact. Returns numbered list of callers (forward) or callees (reverse) grouped by file. Optional step — you can skip query entirely and go straight to loadDiff with explicit {symbol, file} pairs."),
            fileScope: z.string().optional().describe("query: Repo-relative file path. Required when target has definitions in multiple files — the server will list them and ask you to pick."),
            direction: z.enum(["forward", "reverse"]).default("forward").describe("query: forward = which symbols call target (blast radius). reverse = what does target call (dependencies)."),
            depth: z.number().int().min(1).max(5).default(1).describe("query: How many hops to traverse the call graph. 1 = direct callers/callees only."),
            selection: z.array(z.union([
                z.number().int().min(1),
                z.object({ symbol: z.string(), file: z.string().optional() }),
            ])).optional().describe("loadDiff: Which symbols to load. Either numeric indices from a prior query result, or explicit {symbol, file?} pairs. You can skip query and go straight to loadDiff with explicit pairs."),
            contextLines: z.number().int().min(0).max(MAX_CONTEXT_LINES).default(DEFAULT_CONTEXT).describe("loadDiff: How many lines above and below each symbol body to include as read-only context. Context lines are marked with │ so you can distinguish them from the editable body."),
            loadMore: z.boolean().default(false).describe("loadDiff: When a prior loadDiff was truncated at the char budget, call loadDiff again with loadMore=true to get the next page."),
            payload: z.string().optional().describe("apply: The edited diff you're sending back. Format: one or more groups, each starting with a header line 'symbolName idx1,idx2 [ack:N]' followed by the new function body on subsequent lines. Example: 'validateCard 1,2,3 ack:3\\nfunction validateCard(card) { ... }'. Indices match the [N] tags from loadDiff output."),
            dryRun: z.boolean().default(false).describe("apply/reapply/restore: Validate everything (syntax gate, outlier checks, char budget) without writing any files. Returns what would happen."),
            symbolGroup: z.string().optional().describe("reapply: The symbol name from a prior successful apply. The server caches the edit body and reuses it on newTargets."),
            newTargets: z.array(z.union([
                z.string(),
                z.object({ symbol: z.string(), file: z.string().optional() }),
            ])).optional().describe("reapply: Symbols to apply the cached edit pattern to. Same format as loadDiff selection — names or {symbol, file?} pairs."),
            ack: z.array(z.number().int().min(1)).optional().describe("reapply: When the server flags structurally different targets as outliers, provide their indices here to acknowledge and proceed anyway."),
            symbol: z.string().optional().describe("restore/history: The symbol name. restore rolls it back to a prior snapshot; history lists available snapshots."),
            file: z.string().optional().describe("restore/history: File containing the symbol. Required for restore, optional filter for history."),
            version: z.number().int().min(0).optional().describe("restore: Which version index to restore (from history output). Omit to list available versions instead of restoring."),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true }
    }, async (args) => {
        const pc = getProjectContext(ctx);

        // =================================================================
        // QUERY
        // =================================================================
        if (args.mode === 'query') {
            if (!args.target) {
                return { content: [{ type: 'text', text: 'target required for query.' }] };
            }
            const repoRoot = pc.getRoot(args.fileScope);
            if (!repoRoot) throw new Error("No project root.");

            const db = getDb(repoRoot);
            const count = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
            if (count === 0) {
                await indexDirectory(db, repoRoot, repoRoot, { maxFiles: 5000 });
            } else {
                // Fire-and-forget freshness refresh; don't block the query.
                (async () => {
                    try {
                        const rows = db.prepare('SELECT path FROM files').all();
                        const abs = rows.map(r => path.join(repoRoot, r.path));
                        await ensureIndexFresh(db, repoRoot, abs);
                    } catch { /* best-effort */ }
                })();
            }

            let relScope;
            if (args.fileScope) {
                const absScope = await ctx.validatePath(args.fileScope);
                relScope = path.relative(repoRoot, absScope);
            }

            const result = impactQuery(db, args.target, {
                file: relScope,
                depth: args.depth,
                direction: args.direction,
            });

            if (result.disambiguate) {
                return { content: [{ type: 'text', text: 'Multiple definitions:\n' + result.definitions.join('\n') }] };
            }

            const sessionId = ctx.sessionId || getSessionId();
            const cacheKey = `${repoRoot}::${sessionId}`;
            _loadCache.set(cacheKey, {
                results: result.results,
                remaining: [],
                contextLines: null,
            });

            if (!result.results.length) {
                return { content: [{ type: 'text', text: 'No references.' }] };
            }

            const lines = result.results.map((r, i) => {
                const idx = i + 1;
                if (args.direction === 'forward') {
                    return `${idx}) ${r.name}[${r.refCount}x] (${r.filePath})`;
                }
                return `${idx}) ${r.name}[${r.callCount}x]`;
            });
            lines.push(`${result.results.length} total`);
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // =================================================================
        // LOAD
        // =================================================================
        if (args.mode === 'loadDiff') {
            if (!args.selection?.length && !args.loadMore) {
                return { content: [{ type: 'text', text: 'selection required for loadDiff (or use loadMore=true to continue).' }] };
            }
            const repoRoot = pc.getRoot();
            if (!repoRoot) throw new Error("No project root.");
            const db = getDb(repoRoot);
            const sessionId = ctx.sessionId || getSessionId();
            const cacheKey = `${repoRoot}::${sessionId}`;
            const cached = _loadCache.get(cacheKey);

            let workList;
            let contextLines;

            if (args.loadMore) {
                if (!cached || !cached.remaining.length) {
                    return { content: [{ type: 'text', text: 'Nothing to continue.' }] };
                }
                workList = cached.remaining.slice();
                contextLines = cached.contextLines ?? DEFAULT_CONTEXT;
            } else {
                contextLines = args.contextLines ?? DEFAULT_CONTEXT;
                workList = [];
                for (const entry of args.selection) {
                    if (typeof entry === 'number') {
                        if (!cached || !cached.results || !cached.results.length) {
                            return { content: [{ type: 'text', text: 'Run query first.' }] };
                        }
                        const r = cached.results[entry - 1];
                        if (!r) continue;
                        if (!r.filePath) {
                            // Reverse query result — resolve definition file from index.
                            const defRows = db.prepare(
                                "SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = 'def'"
                            ).all(r.name);
                            for (const row of defRows) {
                                workList.push({ symbol: r.name, filePath: row.file_path });
                            }
                            continue;
                        }
                        workList.push({ symbol: r.name, filePath: r.filePath });
                    } else {
                        let filePath = entry.file;
                        if (filePath && path.isAbsolute(filePath)) {
                            filePath = path.relative(repoRoot, filePath);
                        }
                        if (!filePath) {
                            // No file specified — resolve from index, same as reapply.
                            const defRows = db.prepare(
                                "SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = 'def'"
                            ).all(entry.symbol);
                            for (const row of defRows) {
                                workList.push({ symbol: entry.symbol, filePath: row.file_path });
                            }
                            continue;
                        }
                        workList.push({ symbol: entry.symbol, filePath });
                    }
                }
            }

            // -----------------------------------------------------------------
            // Walk the workList, gather symbol occurrences grouped by symbol name.
            // -----------------------------------------------------------------
            const occurrences = []; // { symbol, relFile, absPath, source, sourceLines, line, endLine }

            for (let i = 0; i < workList.length; i++) {
                const { symbol, filePath } = workList[i];
                if (!filePath) continue;
                const absPath = path.join(repoRoot, filePath);

                let validPath;
                try { validPath = await ctx.validatePath(absPath); } catch { continue; }

                let source;
                try { source = await fs.readFile(validPath, 'utf-8'); } catch { continue; }

                const langName = getLangForFile(validPath);
                if (!langName) continue;

                const matches = await findSymbol(source, langName, symbol, { kindFilter: 'def' });
                if (!matches || !matches.length) continue;

                const sourceLines = source.split('\n');
                for (const m of matches) {
                    occurrences.push({
                        symbol,
                        relFile: filePath,
                        absPath: validPath,
                        source,
                        sourceLines,
                        line: m.line,
                        endLine: m.endLine,
                        workIndex: i,
                    });
                }
            }

            // -----------------------------------------------------------------
            // Outlier flagging: modal structure per symbol-name group.
            // -----------------------------------------------------------------
            const flagByOccurrence = new Map();
            const modalBySymbol = new Map();
            const bySymbol = new Map();
            for (const occ of occurrences) {
                if (!bySymbol.has(occ.symbol)) bySymbol.set(occ.symbol, []);
                bySymbol.get(occ.symbol).push(occ);
            }
            for (const [symName, group] of bySymbol) {
                if (group.length < 2) continue;
                const structs = [];
                for (const occ of group) {
                    let s = null;
                    try {
                        const langName = getLangForFile(occ.absPath);
                        if (langName) s = await getSymbolStructure(occ.source, langName, occ.line, occ.endLine);
                    } catch { s = null; }
                    structs.push(s);
                }
                const modal = findModal(structs);
                if (!modal) continue;
                modalBySymbol.set(symName, modal);
                for (let i = 0; i < group.length; i++) {
                    const s = structs[i];
                    if (!s) continue;
                    if (deepEqual(s, modal)) continue;
                    const reason = firstDiffReason(modal, s);
                    if (reason) flagByOccurrence.set(group[i], reason);
                }
            }

            // -----------------------------------------------------------------
            // Emit blocks, honour MAX_CHARS without splitting a symbol.
            // -----------------------------------------------------------------
            const blocks = [];
            const fileCounts = new Map();
            let totalChars = 0;
            let cutAt = occurrences.length;
            const startIndex = args.loadMore ? (cached?.occurrences?.length || 0) : 0;

            for (let i = 0; i < occurrences.length; i++) {
                const occ = occurrences[i];
                const ctxAboveStart = Math.max(0, occ.line - 1 - contextLines);
                const bodyStart = occ.line - 1;
                const bodyEnd = occ.endLine;
                const ctxBelowEnd = Math.min(occ.sourceLines.length, occ.endLine + contextLines);

                const ctxAbove = occ.sourceLines.slice(ctxAboveStart, bodyStart).map(l => `│ ${l}`);
                const bodyLines = occ.sourceLines.slice(bodyStart, bodyEnd);
                const ctxBelow = occ.sourceLines.slice(bodyEnd, ctxBelowEnd).map(l => `│ ${l}`);
                const allLines = [...ctxAbove, ...bodyLines, ...ctxBelow];
                const body = allLines.join('\n');

                const flag = flagByOccurrence.get(occ);
                const globalIndex = startIndex + i + 1;
                const header = flag
                    ? `${occ.symbol} [${globalIndex}] ${occ.relFile} ⚠ ${flag}`
                    : `${occ.symbol} [${globalIndex}] ${occ.relFile}`;
                const block = `${header}\n${body}\n`;

                if (totalChars > 0 && (totalChars + block.length) > MAX_CHARS) {
                    cutAt = i;
                    break;
                }
                blocks.push(block);
                totalChars += block.length;
                fileCounts.set(occ.relFile, (fileCounts.get(occ.relFile) || 0) + 1);
            }

            // Remaining entries (not yet loaded) — carry forward unique workIndices after cutAt.
            const loadedWorkIndices = new Set(occurrences.slice(0, cutAt).map(o => o.workIndex));
            const remaining = [];
            for (let i = 0; i < workList.length; i++) {
                if (!loadedWorkIndices.has(i)) remaining.push(workList[i]);
            }

            const emittedOccurrences = occurrences.slice(0, cutAt).map((o, i) => ({
                index: startIndex + i + 1,
                symbol: o.symbol,
                absPath: o.absPath,
                relFile: o.relFile,
                line: o.line,
                endLine: o.endLine,
                flag: flagByOccurrence.get(o) || null,
            }));
            const priorOccurrences = (args.loadMore && Array.isArray(cached?.occurrences))
                ? cached.occurrences
                : [];

            _loadCache.set(cacheKey, {
                results: cached?.results || [],
                remaining,
                contextLines,
                occurrences: priorOccurrences.concat(emittedOccurrences),
                modalBySymbol,
            });

            if (!blocks.length) {
                return { content: [{ type: 'text', text: 'No symbols loaded.' }] };
            }

            const header = [...fileCounts.entries()]
                .map(([f, n]) => `${n} in ${f}`)
                .join(', ');
            let out = header + '\n' + blocks.join('\n');

            if (remaining.length > 0) {
                out += `\n[truncated] ${remaining.length} remaining. Call loadDiff with loadMore=true.`;
            }

            return { content: [{ type: 'text', text: out }] };
        }

        // =================================================================
        // APPLY
        // =================================================================
        if (args.mode === 'apply') {
            if (!args.payload) {
                return { content: [{ type: 'text', text: 'payload required for apply.' }] };
            }
            const repoRoot = pc.getRoot();
            if (!repoRoot) throw new Error("No project root.");
            const db = getDb(repoRoot);
            const sessionId = ctx.sessionId || getSessionId();
            const cacheKey = `${repoRoot}::${sessionId}`;
            const cached = _loadCache.get(cacheKey);

            const groups = parsePayload(args.payload);
            if (!groups.length) {
                return { content: [{ type: 'text', text: 'No diff loaded. Call loadDiff first.' }] };
            }

            // Source of truth: `occurrences` cached by the previous `load` call.
            if (!cached || !Array.isArray(cached.occurrences) || cached.occurrences.length === 0) {
                return { content: [{ type: 'text', text: 'No diff loaded. Call loadDiff first.' }] };
            }

            // Build symbolName -> [occurrence] map, preserving the indices load printed.
            const loadedSymbols = new Map();
            for (const occ of cached.occurrences) {
                if (!loadedSymbols.has(occ.symbol)) loadedSymbols.set(occ.symbol, []);
                loadedSymbols.get(occ.symbol).push(occ);
            }

            // Flag set: every cached occurrence with a `flag` is an outlier.
            const flaggedIndices = new Set();
            for (const occ of cached.occurrences) {
                if (occ.flag) flaggedIndices.add(occ.index);
            }

            // Gate: every payload group symbol must exist in the loaded set.
            for (const g of groups) {
                if (!loadedSymbols.has(g.symbol)) {
                    return { content: [{ type: 'text', text: `Unknown symbol: ${g.symbol}. Run loadDiff first.` }] };
                }
            }

            // Gate: outlier ack. Each flagged occurrence in a group must be in its ack list.
            const unackFlagged = [];
            for (const g of groups) {
                const acks = new Set(g.ack);
                for (const idx of g.indices) {
                    if (flaggedIndices.has(idx) && !acks.has(idx)) unackFlagged.push(idx);
                }
            }
            if (unackFlagged.length) {
                return { content: [{ type: 'text', text: `Flagged outliers require ack: ${unackFlagged.join(',')}` }] };
            }

            // Gate: char budget.
            let totalBudget = 0;
            for (const g of groups) totalBudget += g.body.length * g.indices.length;
            if (totalBudget > MAX_CHARS) {
                return { content: [{ type: 'text', text: 'Over char budget. Split the apply into smaller groups.' }] };
            }

            // Gate: syntax.
            for (const g of groups) {
                const occList = loadedSymbols.get(g.symbol);
                const firstOcc = occList.find(o => g.indices.includes(o.index)) || occList[0];
                if (!firstOcc) continue;
                const langName = getLangForFile(firstOcc.absPath);
                if (!langName) continue;
                try {
                    const errs = await checkSyntaxErrors(g.body, langName);
                    if (errs && errs.length) {
                        return { content: [{ type: 'text', text: `Syntax error in ${g.symbol}: line ${errs[0].line}:${errs[0].column}` }] };
                    }
                } catch { /* best-effort */ }
            }

            // Build per-file edit bundles.
            // fileBundles: Map<absPath, { edits: [...], disambiguations: Map, occMeta: [{group, occ}] }>
            const fileBundles = new Map();
            for (const g of groups) {
                const occList = loadedSymbols.get(g.symbol);
                const selected = occList.filter(o => g.indices.includes(o.index));
                for (const occ of selected) {
                    if (!fileBundles.has(occ.absPath)) {
                        fileBundles.set(occ.absPath, { edits: [], disambiguations: new Map(), occMeta: [], relFile: occ.relFile });
                    }
                    const bundle = fileBundles.get(occ.absPath);
                    const editIdx = bundle.edits.length;
                    bundle.edits.push({ mode: 'symbol', symbol: g.symbol, newText: g.body });
                    // Always set a disambiguation anchor so batches with multiple symbols work.
                    bundle.disambiguations.set(editIdx, { nearLine: occ.line });
                    bundle.occMeta.push({ group: g, occ });
                }
            }

            const failedGroupMessages = new Map(); // symbolName -> message
            let successfulGroupNames = new Set();
            let successfulFileCount = 0;
            let warningSuffix = '';

            for (const [absPath, bundle] of fileBundles) {
                let content;
                try { content = await fs.readFile(absPath, 'utf-8'); }
                catch (err) {
                    // Mark every group in this file as failed.
                    for (const { group } of bundle.occMeta) {
                        if (!failedGroupMessages.has(group.symbol)) {
                            const retryKey = `${repoRoot}::${sessionId}::${group.symbol}`;
                            const count = (_retryState.get(retryKey) || 0) + 1;
                            _retryState.set(retryKey, count);
                            if (count >= 2) {
                                failedGroupMessages.set(group.symbol, `Group ${group.symbol} locked. Use edit_file directly.`);
                            } else {
                                failedGroupMessages.set(group.symbol, `Group ${group.symbol} failed: ${err.message}. Retry once or use edit_file directly.`);
                            }
                        }
                    }
                    continue;
                }

                const result = await applyEditList(content, bundle.edits, {
                    filePath: absPath,
                    isBatch: bundle.edits.length > 1,
                    disambiguations: bundle.disambiguations,
                });

                if (result.errors && result.errors.length) {
                    // Determine which groups failed by mapping error indices to occMeta.
                    const failedEditIdx = new Set(result.errors.map(e => e.i));
                    const failedSymbolsInFile = new Set();
                    let firstErrMsgBySymbol = new Map();
                    for (let i = 0; i < bundle.occMeta.length; i++) {
                        if (failedEditIdx.has(i)) {
                            const sym = bundle.occMeta[i].group.symbol;
                            failedSymbolsInFile.add(sym);
                            if (!firstErrMsgBySymbol.has(sym)) {
                                const errRec = result.errors.find(e => e.i === i);
                                firstErrMsgBySymbol.set(sym, errRec?.msg || 'edit failed');
                            }
                        }
                    }
                    // Even a single failure in the bundle means we must not write this file
                    // (applyEditList returned a partially-applied workingContent, but we treat
                    // per-file as atomic: any failure => skip the write for this file).
                    for (const sym of failedSymbolsInFile) {
                        if (failedGroupMessages.has(sym)) continue;
                        const retryKey = `${repoRoot}::${sessionId}::${sym}`;
                        const count = (_retryState.get(retryKey) || 0) + 1;
                        _retryState.set(retryKey, count);
                        const errMsg = firstErrMsgBySymbol.get(sym) || 'edit failed';
                        if (count >= 2) {
                            failedGroupMessages.set(sym, `Group ${sym} locked. Use edit_file directly.`);
                        } else {
                            failedGroupMessages.set(sym, `Group ${sym} failed: ${errMsg}. Retry once or use edit_file directly.`);
                        }
                    }
                    // Also mark co-located groups that weren't the direct cause of failure.
                    for (const { group } of bundle.occMeta) {
                        if (!failedGroupMessages.has(group.symbol) && !failedSymbolsInFile.has(group.symbol)) {
                            failedGroupMessages.set(group.symbol, `Group ${group.symbol} skipped: co-located with failed group in same file.`);
                        }
                    }
                    // Skip write for this file. Successful groups in OTHER files are still written.
                    continue;
                }

                // Full-file syntax gate: reject before write if the spliced file has parse errors.
                try {
                    const fileLang = getLangForFile(absPath);
                    if (fileLang) {
                        const fullFileErrs = await checkSyntaxErrors(result.workingContent, fileLang);
                        if (fullFileErrs?.length) {
                            const locs = fullFileErrs.map(e => `${e.line}:${e.column}`).join(', ');
                            for (const { group } of bundle.occMeta) {
                                if (!failedGroupMessages.has(group.symbol)) {
                                    const retryKey = `${repoRoot}::${sessionId}::${group.symbol}`;
                                    const count = (_retryState.get(retryKey) || 0) + 1;
                                    _retryState.set(retryKey, count);
                                    if (count >= 2) {
                                        failedGroupMessages.set(group.symbol, `Group ${group.symbol} locked. Use edit_file directly.`);
                                    } else {
                                        failedGroupMessages.set(group.symbol, `Group ${group.symbol} failed: parse errors at ${locs}. Retry once or use edit_file directly.`);
                                    }
                                }
                            }
                            continue;
                        }
                    }
                } catch { /* best-effort — don't block on parse infra failure */ }

                if (args.dryRun) {
                    successfulFileCount++;
                    for (const { group } of bundle.occMeta) successfulGroupNames.add(group.symbol);
                    // Collect syntax warnings for dry-run report.
                    try {
                        const warn = await syntaxWarn(absPath, result.workingContent);
                        if (warn) warningSuffix += warn;
                    } catch { /* best-effort */ }
                    continue;
                }

                // Atomic write.
                const tempPath = `${absPath}.${randomBytes(16).toString('hex')}.tmp`;
                try {
                    await fs.writeFile(tempPath, result.workingContent, 'utf-8');
                    await fs.rename(tempPath, absPath);
                } catch (err) {
                    try { await fs.unlink(tempPath); } catch {}
                    for (const { group } of bundle.occMeta) {
                        if (failedGroupMessages.has(group.symbol)) continue;
                        const retryKey = `${repoRoot}::${sessionId}::${group.symbol}`;
                        const count = (_retryState.get(retryKey) || 0) + 1;
                        _retryState.set(retryKey, count);
                        if (count >= 2) {
                            failedGroupMessages.set(group.symbol, `Group ${group.symbol} locked. Use edit_file directly.`);
                        } else {
                            failedGroupMessages.set(group.symbol, `Group ${group.symbol} failed: ${err.message}. Retry once or use edit_file directly.`);
                        }
                    }
                    continue;
                }

                successfulFileCount++;
                for (const { group } of bundle.occMeta) successfulGroupNames.add(group.symbol);

                // Snapshot commits (best-effort).
                try {
                    const relPath = path.relative(repoRoot, absPath);
                    for (const snap of (result.pendingSnapshots || [])) {
                        snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line);
                    }
                } catch { /* best-effort */ }

                // Re-index (best-effort).
                try { await ensureIndexFresh(db, repoRoot, [absPath]); } catch { /* best-effort */ }

                // Syntax warning suffix.
                try {
                    const warn = await syntaxWarn(absPath, result.workingContent);
                    if (warn) warningSuffix += warn;
                } catch { /* best-effort */ }
            }

            // Populate payload cache for successful groups (for reapply). Never on dry-run.
            if (!args.dryRun) {
                for (const g of groups) {
                    if (successfulGroupNames.has(g.symbol) && !failedGroupMessages.has(g.symbol)) {
                        const modal = cached?.modalBySymbol?.get(g.symbol) || null;
                        _payloadCache.set(`${repoRoot}::${sessionId}::${g.symbol}`, { body: g.body, ack: g.ack, modalStructure: modal });
                    }
                }
            }

            if (failedGroupMessages.size) {
                const lines = [...failedGroupMessages.values()];
                if (successfulGroupNames.size) {
                    const okCount = [...successfulGroupNames].filter(s => !failedGroupMessages.has(s)).length;
                    if (okCount) lines.unshift(`Applied ${okCount} symbols across ${successfulFileCount} files.`);
                }
                return { content: [{ type: 'text', text: lines.join('\n') + warningSuffix }] };
            }

            if (args.dryRun) {
                const dryLines = [`Dry run: ${successfulGroupNames.size} symbols across ${successfulFileCount} files.`];
                // Report flagged outliers that were acknowledged.
                const ackedOutliers = [];
                for (const g of groups) {
                    for (const idx of g.ack) {
                        if (flaggedIndices.has(idx)) ackedOutliers.push(idx);
                    }
                }
                if (ackedOutliers.length) dryLines.push(`Acknowledged outliers: ${ackedOutliers.join(',')}`);
                if (warningSuffix) dryLines.push(warningSuffix.trim());
                return { content: [{ type: 'text', text: dryLines.join('\n') }] };
            }

            return { content: [{ type: 'text', text: `Applied ${successfulGroupNames.size} symbols across ${successfulFileCount} files.${warningSuffix}` }] };
        }

        // =================================================================
        // REAPPLY
        // =================================================================
        if (args.mode === 'reapply') {
            if (!args.symbolGroup) {
                return { content: [{ type: 'text', text: 'symbolGroup required for reapply.' }] };
            }
            if (!args.newTargets?.length) {
                return { content: [{ type: 'text', text: 'newTargets required for reapply.' }] };
            }
            const repoRoot = pc.getRoot();
            if (!repoRoot) throw new Error("No project root.");
            const db = getDb(repoRoot);
            const sessionId = ctx.sessionId || getSessionId();

            const payloadKey = `${repoRoot}::${sessionId}::${args.symbolGroup}`;
            const cachedPayload = _payloadCache.get(payloadKey);
            if (!cachedPayload) {
                return { content: [{ type: 'text', text: `No cached payload for ${args.symbolGroup}.` }] };
            }

            // Resolve new targets to occurrences.
            const targets = []; // { absPath, relFile, source, line, endLine }
            const skipped = [];
            for (const entry of args.newTargets) {
                let symName, file;
                if (typeof entry === 'string') { symName = entry; file = undefined; }
                else { symName = entry.symbol; file = entry.file; }

                // Candidate files: explicit file hint, else look up def occurrences from the symbol index.
                let candidateFiles;
                if (file) {
                    candidateFiles = [file];
                } else {
                    const rows = db.prepare(
                        "SELECT DISTINCT file_path FROM symbols WHERE name = ? AND kind = 'def'"
                    ).all(symName);
                    if (!rows.length) { skipped.push(symName); continue; }
                    candidateFiles = rows.map(r => r.file_path);
                }

                let addedAny = false;
                for (const cf of candidateFiles) {
                    const absPath = path.isAbsolute(cf) ? cf : path.join(repoRoot, cf);
                    let validPath;
                    try { validPath = await ctx.validatePath(absPath); } catch { continue; }
                    let source;
                    try { source = await fs.readFile(validPath, 'utf-8'); } catch { continue; }
                    const langName = getLangForFile(validPath);
                    if (!langName) continue;
                    const matches = await findSymbol(source, langName, symName, { kindFilter: 'def' });
                    if (!matches || !matches.length) continue;
                    for (const m of matches) {
                        targets.push({
                            symbol: symName,
                            absPath: validPath,
                            relFile: path.relative(repoRoot, validPath),
                            source,
                            line: m.line,
                            endLine: m.endLine,
                        });
                        addedAny = true;
                    }
                }
                if (!addedAny) skipped.push(symName);
            }

            if (!targets.length) {
                const suffix = skipped.length ? ` (skipped ${skipped.length})` : '';
                return { content: [{ type: 'text', text: `Reapplied 0 targets.${suffix}` }] };
            }

            // Outlier flagging: compare new targets against the ORIGINAL baseline
            // structure (cached from the initial loadDiff). If no baseline is cached
            // (single-symbol apply), fall back to comparing targets to each other.
            const structs = [];
            for (const t of targets) {
                let s = null;
                try {
                    const langName = getLangForFile(t.absPath);
                    if (langName) s = await getSymbolStructure(t.source, langName, t.line, t.endLine);
                } catch { s = null; }
                structs.push(s);
            }
            {
                const baseline = cachedPayload.modalStructure;
                const modal = baseline || (targets.length >= 2 ? findModal(structs) : null);
                if (modal) {
                    const ackSet = new Set(args.ack || []);
                    const flagged = [];
                    for (let i = 0; i < targets.length; i++) {
                        const s = structs[i];
                        if (!s) continue;
                        if (!deepEqual(s, modal) && !ackSet.has(i + 1)) flagged.push(i + 1);
                    }
                    if (flagged.length) {
                        return { content: [{ type: 'text', text: `Flagged outliers require ack: ${flagged.join(',')}` }] };
                    }
                }
            }

            // Syntax gate on the cached body (language of first target).
            try {
                const langName = getLangForFile(targets[0].absPath);
                if (langName) {
                    const errs = await checkSyntaxErrors(cachedPayload.body, langName);
                    if (errs && errs.length) {
                        return { content: [{ type: 'text', text: `Syntax error in ${args.symbolGroup}: line ${errs[0].line}:${errs[0].column}` }] };
                    }
                }
            } catch { /* best-effort */ }

            // Char budget.
            if (cachedPayload.body.length * targets.length > MAX_CHARS) {
                return { content: [{ type: 'text', text: 'Over char budget. Split the apply into smaller groups.' }] };
            }

            // Build per-file bundles.
            const fileBundles = new Map();
            for (const t of targets) {
                if (!fileBundles.has(t.absPath)) {
                    fileBundles.set(t.absPath, { edits: [], disambiguations: new Map(), occMeta: [] });
                }
                const bundle = fileBundles.get(t.absPath);
                const editIdx = bundle.edits.length;
                bundle.edits.push({ mode: 'symbol', symbol: t.symbol, newText: cachedPayload.body });
                bundle.disambiguations.set(editIdx, { nearLine: t.line });
                bundle.occMeta.push(t);
            }

            let reappliedCount = 0;
            let reapplyFailedCount = 0;
            let warningSuffix = '';

            for (const [absPath, bundle] of fileBundles) {
                let content;
                try { content = await fs.readFile(absPath, 'utf-8'); } catch { reapplyFailedCount += bundle.occMeta.length; continue; }
                const result = await applyEditList(content, bundle.edits, {
                    filePath: absPath,
                    isBatch: bundle.edits.length > 1,
                    disambiguations: bundle.disambiguations,
                });
                if (result.errors && result.errors.length) { reapplyFailedCount += bundle.occMeta.length; continue; }

                // Full-file syntax gate before write.
                try {
                    const fileLang = getLangForFile(absPath);
                    if (fileLang) {
                        const fullFileErrs = await checkSyntaxErrors(result.workingContent, fileLang);
                        if (fullFileErrs?.length) { reapplyFailedCount += bundle.occMeta.length; continue; }
                    }
                } catch { /* best-effort */ }

                if (args.dryRun) {
                    reappliedCount += bundle.occMeta.length;
                    continue;
                }

                const tempPath = `${absPath}.${randomBytes(16).toString('hex')}.tmp`;
                try {
                    await fs.writeFile(tempPath, result.workingContent, 'utf-8');
                    await fs.rename(tempPath, absPath);
                } catch {
                    try { await fs.unlink(tempPath); } catch {}
                    reapplyFailedCount += bundle.occMeta.length;
                    continue;
                }
                reappliedCount += bundle.occMeta.length;

                try {
                    const relPath = path.relative(repoRoot, absPath);
                    for (const snap of (result.pendingSnapshots || [])) {
                        snapshotSymbol(db, snap.symbol, relPath, snap.originalText, sessionId, snap.line);
                    }
                } catch { /* best-effort */ }
                try { await ensureIndexFresh(db, repoRoot, [absPath]); } catch { /* best-effort */ }
                try {
                    const warn = await syntaxWarn(absPath, result.workingContent);
                    if (warn) warningSuffix += warn;
                } catch { /* best-effort */ }
            }

            const skippedSuffix = skipped.length ? ` (skipped ${skipped.length})` : '';
            const failedSuffix = reapplyFailedCount ? ` (${reapplyFailedCount} failed)` : '';
            if (args.dryRun) {
                return { content: [{ type: 'text', text: `Dry run: ${reappliedCount} targets.${skippedSuffix}${failedSuffix}` }] };
            }
            return { content: [{ type: 'text', text: `Reapplied ${reappliedCount} targets.${skippedSuffix}${failedSuffix}${warningSuffix}` }] };
        }

        // =================================================================
        // HISTORY
        // =================================================================
        if (args.mode === 'history') {
            if (!args.symbol) {
                return { content: [{ type: 'text', text: 'symbol required for history.' }] };
            }
            const repoRoot = pc.getRoot(args.file);
            if (!repoRoot) throw new Error("No project root.");
            const db = getDb(repoRoot);
            const sessionId = ctx.sessionId || getSessionId();

            let relPath = null;
            if (args.file) {
                const absPath = await ctx.validatePath(args.file);
                relPath = path.relative(repoRoot, absPath);
            }

            const rows = getVersionHistory(db, args.symbol, sessionId, relPath);
            if (!rows.length) {
                return { content: [{ type: 'text', text: `No version history for ${args.symbol}.` }] };
            }
            const lines = rows.map((r, i) => `v${i} ${r.file_path} ${r.text_hash?.slice(0, 8) || '?'} ${new Date(r.created_at).toISOString()}`);
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // =================================================================
        // RESTORE
        // =================================================================
        if (args.mode === 'restore') {
            if (!args.symbol) {
                return { content: [{ type: 'text', text: 'symbol required for restore.' }] };
            }
            if (!args.file) {
                return { content: [{ type: 'text', text: 'file required for restore.' }] };
            }

            const absPath = await ctx.validatePath(args.file);
            const repoRoot = findRepoRoot(absPath) || pc.getRoot();
            if (!repoRoot) throw new Error("No project root.");
            const db = getDb(repoRoot);
            const sessionId = ctx.sessionId || getSessionId();
            const relPath = path.relative(repoRoot, absPath);

            // If no version specified, list available versions.
            if (args.version === undefined) {
                const rows = getVersionHistory(db, args.symbol, sessionId, relPath);
                if (!rows.length) {
                    return { content: [{ type: 'text', text: `No version history for ${args.symbol} in ${relPath}.` }] };
                }
                const lines = rows.map((r, i) => `v${i} ${r.text_hash?.slice(0, 8) || '?'} ${new Date(r.created_at).toISOString()}`);                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            const history = getVersionHistory(db, args.symbol, sessionId, relPath);
            const versionEntry = history?.[args.version];
            if (!versionEntry) {
                return { content: [{ type: 'text', text: `${args.symbol}: version ${args.version} not found. ${history.length} versions available.` }] };
            }
            const restoredText = getVersionText(db, versionEntry.id);
            if (!restoredText) {
                return { content: [{ type: 'text', text: `${args.symbol}: version ${args.version} text missing.` }] };
            }

            let content;
            try {
                content = normalizeLineEndings(await fs.readFile(absPath, 'utf-8'));
            } catch {
                return { content: [{ type: 'text', text: `${args.symbol}: file not found — ${relPath}.` }] };
            }

            // Staleness check: if the file changed since our last index (e.g. after
            // a prior apply), warn the model so it can verify compatibility.
            let fileChanged = false;
            try {
                const curHash = createHash('md5').update(content).digest('hex');
                const stored = db.prepare('SELECT hash FROM files WHERE path = ?').get(relPath);
                if (stored && stored.hash !== curHash) fileChanged = true;
            } catch { /* best-effort */ }

            const langName = getLangForFile(absPath);
            if (!langName) {
                return { content: [{ type: 'text', text: `${args.symbol}: unsupported language for ${relPath}.` }] };
            }

            const matches = await findSymbol(content, langName, args.symbol, { kindFilter: 'def' });
            if (!matches?.length) {
                return { content: [{ type: 'text', text: `${args.symbol}: not found in ${relPath}.` }] };
            }

            // Disambiguate: multiple matches → try stored line, then fall back to
            // body-similarity (the version text itself is the best fingerprint if the
            // symbol moved lines but its body hasn't been edited again).
            let sym = matches[0];
            if (matches.length > 1) {
                // First try exact line match from snapshot.
                if (versionEntry.line) {
                    const byLine = matches.find(m => m.line === versionEntry.line);
                    if (byLine) { sym = byLine; }
                }
                // If line didn't match (symbol moved), compare current body to
                // the restored text — the closest match is likely the right target.
                if (!versionEntry.line || sym === matches[0]) {
                    const contentLines = content.split('\n');
                    let bestOverlap = -1;
                    for (const m of matches) {
                        const curBody = contentLines.slice(m.line - 1, m.endLine).join('\n');
                        // Simple: count shared lines between current body and restored text.
                        const curSet = new Set(curBody.split('\n').map(l => l.trim()));
                        const resLines = restoredText.split('\n').map(l => l.trim());
                        let overlap = 0;
                        for (const rl of resLines) { if (curSet.has(rl)) overlap++; }
                        if (overlap > bestOverlap) { bestOverlap = overlap; sym = m; }
                    }
                }
            }

            const lines = content.split('\n');
            const currentText = lines.slice(sym.line - 1, sym.endLine).join('\n');
            lines.splice(sym.line - 1, sym.endLine - (sym.line - 1), ...restoredText.split('\n'));
            const newContent = lines.join('\n');

            const staleWarning = fileChanged
                ? ' ⚠ File modified since last apply — verify surrounding code for compatibility.'
                : '';

            // Syntax check the result.
            let syntaxWarning = '';
            try {
                const errs = await checkSyntaxErrors(newContent, langName);
                if (errs?.length) {
                    syntaxWarning = ` ⚠ Parse errors at ${errs.map(e => `${e.line}:${e.column}`).join(', ')}`;
                }
            } catch { /* best-effort */ }

            if (args.dryRun) {
                return { content: [{ type: 'text', text: `Dry run: would restore ${args.symbol} to v${args.version}.${staleWarning}${syntaxWarning}` }] };
            }

            // Snapshot current text before overwriting (so this restore is itself restorable).
            try {
                snapshotSymbol(db, args.symbol, relPath, currentText, sessionId, sym.line);
            } catch { /* best-effort */ }

            // Atomic write.
            const tempPath = `${absPath}.${randomBytes(16).toString('hex')}.tmp`;
            try {
                await fs.writeFile(tempPath, newContent, 'utf-8');
                await fs.rename(tempPath, absPath);
            } catch (err) {
                try { await fs.unlink(tempPath); } catch {}
                return { content: [{ type: 'text', text: `Restore failed: ${err.message}` }] };
            }

            // Re-index.
            try { await indexFile(db, repoRoot, absPath); } catch { /* best-effort */ }

            return { content: [{ type: 'text', text: `${args.symbol}: restored to v${args.version}.${staleWarning}${syntaxWarning}` }] };
        }

        throw new Error('Invalid mode.');
    });
}
