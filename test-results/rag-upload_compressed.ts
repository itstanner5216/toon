# ... [152 lines omitted]
function detectContentType(filePath: string, cfg: RagConfig): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext === "md") return "markdown";
  if (cfg.codeExtensions.has(ext)) return "code";
  if (cfg.configExtensions.has(ext)) return "config";
  return "text";
}
# ... [148 lines omitted]
async function getEmbeddingsBatch(
  texts: string[],
  cfg: RagConfig,
  rateLimiter: RateLimiter
): Promise<number[][]> {
  for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
    if (rateLimiter.isAborted()) throw new RateLimitAbort();
    await rateLimiter.acquire();

    try {
      const resp = await fetch(`${cfg.litellmBase}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.litellmKey}` },
        body: JSON.stringify({ model: cfg.embeddingModel, input: texts }),
        signal: AbortSignal.timeout(120_000),
      });

      if (resp.status === 429 && attempt < cfg.maxRetries - 1) {
        rateLimiter.reportRateLimit();
        if (rateLimiter.isAborted()) throw new RateLimitAbort();
        await sleep(2 ** (attempt + 1) * 1000);
        continue;
      }

      if (!resp.ok) throw new Error(`Embedding API ${resp.status}: ${await resp.text()}`);

      const data = await resp.json();
# ... [31 lines omitted]
async function addEmbeddingsBatch(
  items: EmbeddingItemPayload[],
  storeId: string,
  cfg: RagConfig
): Promise<void> {
  for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
    try {
      const resp = await fetch(`${cfg.apiBase}/v1/vector_stores/${storeId}/embeddings/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ embeddings: items }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) throw new Error(`Store batch ${resp.status}: ${await resp.text()}`);
      return;
    } catch (e) {
      if (attempt < cfg.maxRetries - 1) {
        await sleep(Math.min(cfg.retryBackoffBase ** attempt, cfg.retryBackoffMax) * 1000);
      } else throw e;
    }
  }
}
async function getStoreSources(
  storeId: string,
  projectId: string | null,
  cfg: RagConfig
): Promise<Map<string, StoreSourceInfo>> {
  const url = new URL(`${cfg.apiBase}/v1/vector_stores/${storeId}/sources`);
  if (projectId) url.searchParams.set("project_id", projectId);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`GET sources failed (${resp.status}): ${await resp.text()}`);
  }
# ... [13 lines omitted]
async function deleteStoreDoc(storeId: string, docPath: string, cfg: RagConfig): Promise<number> {
  try {
    const url = new URL(`${cfg.apiBase}/v1/vector_stores/${storeId}/embeddings`);
    url.searchParams.set("doc_path", docPath);
    const resp = await fetch(url.toString(), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return 0;
# ... [177 lines omitted]
function printHeader(targetPath: string, files: string[], storeId: string, opts: {
  sync: boolean; force: boolean; dryRun: boolean; projectId: string; repoRoot: string;
  extensions: Set<string>; batchSize: number; cfg: RagConfig;
}) {
  console.log();
  console.log(`  ${c.bold}rag-upload${c.reset}  ${c.dim}${resolve(targetPath)}${c.reset}`);
  const parts = [`${files.length} file${files.length !== 1 ? "s" : ""}`, `store ${storeId.slice(0, 8)}…`];
  if (opts.sync) parts.push("sync mode");
  if (opts.force) parts.push("force");
  if (opts.dryRun) parts.push(`${c.yellow}dry-run${c.reset}`);
  console.log(`  ${c.dim}${parts.join(" · ")}${c.reset}`);
  console.log();
  console.log(`  ${c.dim}${"─".repeat(60)}${c.reset}`);
  console.log(`  ${c.cyan}Project:${c.reset}    ${opts.projectId}`);
  console.log(`  ${c.cyan}Root:${c.reset}       ${opts.repoRoot}`);
  console.log(`  ${c.cyan}Extensions:${c.reset} ${[...opts.extensions].sort().join(", ")}`);
  console.log(`  ${c.cyan}Batch:${c.reset}      ${opts.batchSize} chunks/call`);
  console.log(`  ${c.cyan}Model:${c.reset}      ${opts.cfg.embeddingModel}`);
  console.log(`  ${c.dim}${"─".repeat(60)}${c.reset}`);
  console.log();
}
function printSyncPlan(toIngest: SyncAction[], staleDocs: string[], nNew: number, nUpdated: number, nUnchanged: number, nIncomplete: number, cfg: RagConfig) {
  console.log(`  ${c.bold}Sync Plan${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log(`    ${statusIcon("new")} ${c.green}${nNew}${c.reset} new files`);
  console.log(`    ${statusIcon("updated")} ${c.yellow}${nUpdated}${c.reset} updated files`);
  if (nIncomplete > 0) console.log(`    ${statusIcon("incomplete")} ${c.yellow}${nIncomplete}${c.reset} incomplete`);
  console.log(`    ${statusIcon("unchanged")} ${c.dim}${nUnchanged}${c.reset} unchanged (skipped)`);
  console.log(`    ${statusIcon("stale")} ${c.red}${staleDocs.length}${c.reset} stale (will delete)`);
  console.log(`  ${c.dim}${"─".repeat(50)}${c.reset}`);

  if (toIngest.length > 0) {
    console.log();
    for (const item of toIngest.slice(0, 20)) {
      const icon = statusIcon(item.action === "new" ? "new" : "updated");
      const ct = detectContentType(item.absPath, cfg);
      const badge = typeBadge(ct, detectLanguage(item.absPath));
      console.log(`    ${icon} ${badge} ${c.cyan}${truncPath(item.relPath, 50)}${c.reset}  ${c.dim}${sizeFmt(fileSize(item.absPath))}${c.reset}`);
    }
    if (toIngest.length > 20) console.log(`    ${c.dim}… and ${toIngest.length - 20} more${c.reset}`);
  }

  if (staleDocs.length > 0) {
    console.log();
    for (const doc of staleDocs.slice(0, 10)) {
      console.log(`    ${statusIcon("stale")} ${c.dim}${truncPath(doc, 50)}${c.reset}`);
    }
    if (staleDocs.length > 10) console.log(`    ${c.dim}… and ${staleDocs.length - 10} more${c.reset}`);
  }

  console.log();
  const totalAction = toIngest.length + staleDocs.length;
  if (totalAction === 0) {
    console.log(`  ${c.green}${c.bold}✓ Nothing to do — all files up to date.${c.reset}`);
  } else {
    console.log(`  ${c.bold}${toIngest.length}${c.reset} files to embed, ${c.bold}${staleDocs.length}${c.reset} to delete`);
  }
  console.log();
}
# ... [1 lines omitted]
  const elapsed = (Date.now() - state.startTime) / 1000;
  console.log();
  console.log(`  ${c.bold}${"═".repeat(60)}${c.reset}`);
  console.log(`  ${c.bold}Upload Complete${c.reset}  ${c.dim}${durationFmt(elapsed)}${c.reset}`);
  console.log(`  ${c.bold}${"═".repeat(60)}${c.reset}`);
  console.log();

  const fileParts: string[] = [];
  if (state.filesOk > 0) fileParts.push(`${c.green}${state.filesOk} succeeded${c.reset}`);
  if (state.filesSkipped > 0) fileParts.push(`${c.dim}${state.filesSkipped} skipped${c.reset}`);
  if (state.filesFailed > 0) fileParts.push(`${c.red}${state.filesFailed} failed${c.reset}`);
  console.log(`  ${c.bold}Files${c.reset}  ${fileParts.join(" · ")}`);
  console.log(`  ${c.bold}Chunks${c.reset} ${progressBar(state.chunksOk, state.chunksTotal)}`);

  if (state.chunksOk > 0) {
    const rate = state.chunksOk / elapsed;
    console.log(`    ${c.dim}${rate.toFixed(1)} chunks/sec · ${sizeFmt(state.bytesProcessed)} processed${c.reset}`);
  }

  if (sync) {
    const syncParts: string[] = [];
    if (nNew > 0) syncParts.push(`${c.green}${nNew} new${c.reset}`);
    if (nUpdated > 0) syncParts.push(`${c.yellow}${nUpdated} updated${c.reset}`);
    if (nUnchanged > 0) syncParts.push(`${c.dim}${nUnchanged} unchanged${c.reset}`);
    if (nDeleted > 0) syncParts.push(`${c.red}${nDeleted} deleted${c.reset}`);
    console.log(`  ${c.bold}Sync${c.reset}   ${syncParts.join(" · ")}`);
  }
  console.log();

  if (state.failedFiles.length > 0) {
    console.log(`  ${c.red}${c.bold}⚠ Errors (${state.failedFiles.length} files)${c.reset}`);
    for (const f of state.failedFiles.slice(0, 10)) {
      console.log(`    ${c.red}✗${c.reset} ${c.cyan}${f.path}${c.reset} (${f.ok}/${f.total})`);
      const unique = [...new Set(f.errors.filter((e) => e !== "aborted"))].slice(0, 2);
      for (const e of unique) console.log(`         ${c.dim}${e.slice(0, 100)}${c.reset}`);
    }
    console.log(`\n  ${c.dim}Tip: re-run with --sync to retry failed files${c.reset}\n`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Status Mode
// ═══════════════════════════════════════════════════════════════════════════════
async function showStatus(
  storeId: string, projectId: string, files: string[], repoRoot: string,
  cfg: RagConfig, directDb?: import("../lib/db-adapter.js").VectorStoreDB
) {
  console.log(`\n  ${c.bold}Store Status${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(60)}${c.reset}`);
  console.log(`  ${c.cyan}Store:${c.reset}   ${storeId}`);
  console.log(`  ${c.cyan}Project:${c.reset} ${projectId}`);
  console.log();

  let existing: Map<string, StoreSourceInfo>;
  if (directDb) {
    const dbMap = await getExistingSourceHashes(directDb, storeId, projectId);
    existing = new Map<string, StoreSourceInfo>();
    for (const [k, v] of dbMap) {
      existing.set(k, { content_hash: v.content_hash, chunk_count: v.chunk_count });
    }
  } else {
    existing = await getStoreSources(storeId, projectId, cfg);
  }
  if (existing.size === 0) {
    console.log(`  ${c.dim}(empty — no documents in store)${c.reset}\n`);
    return;
  }

  let totalChunks = 0;
  for (const info of existing.values()) totalChunks += info.chunk_count || 0;
  console.log(`  ${c.bold}${existing.size}${c.reset} documents, ${c.bold}${totalChunks}${c.reset} total chunks`);

  const localByDoc = new Map<string, string>();
  for (const fp of files) localByDoc.set(relative(repoRoot, fp), fp);

  // Per-document listing sorted by path
  const docEntries: Array<{ docPath: string; info: StoreSourceInfo; status: string }> = [];
  const statusCounts: Record<string, number> = {};
  for (const [docPath, info] of existing) {
    const localPath = localByDoc.get(docPath);
    let status: string;
    if (!localPath) { status = "stale"; }
    else {
      const localHash = fileSha256(localPath);
      status = localHash === info.content_hash ? "unchanged" : "updated";
    }
    docEntries.push({ docPath, info, status });
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  docEntries.sort((a, b) => a.docPath.localeCompare(b.docPath));

  console.log();
  for (const entry of docEntries) {
    const chunks = entry.info.chunk_count ?? 0;
    console.log(`    ${statusIcon(entry.status)} ${c.cyan}${entry.docPath}${c.reset}  ${c.dim}(${chunks} chunk${chunks !== 1 ? "s" : ""})${c.reset}`);
  }

  // Aggregate summary
  console.log();
  for (const s of ["unchanged", "updated", "stale"]) {
    if (statusCounts[s]) console.log(`    ${statusIcon(s)} ${statusCounts[s]} ${s}`);
  }

  const missing = [...localByDoc.keys()].filter((rel) => !existing.has(rel));
  if (missing.length > 0) {
    console.log(`\n  ${c.yellow}${missing.length} local file(s) not yet in store${c.reset}`);
  }
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════
# ... [202 lines omitted]
  async function processNext() {
    while (queue.length > 0 && !rateLimiter.isAborted()) {
      const item = queue.shift()!;
      const hash = item.hash || fileSha256(item.absPath);

      if (verbosity === "normal") {
        const icon = statusIcon(item.action === "new" ? "new" : "updated");
        process.stdout.write(
          `  [${item.seq}/${state.totalFiles}] ` +
          `${icon} ${c.cyan}${truncPath(item.relPath, 55)}${c.reset}\n`
        );
      } else if (verbosity === "compact") {
        console.log(`  ${statusIcon(item.action === "new" ? "new" : "updated")} ${c.cyan}${item.relPath}${c.reset}`);
      } else if (verbosity === "verbose") {
        const ct = detectContentType(item.absPath, cfg);
        const badge = typeBadge(ct, detectLanguage(item.absPath));
        console.log(`  ${c.bold}${item.relPath}${c.reset}  ${badge}`);
      }

      try {
        const result = await ingestFile(
          item.absPath, item.relPath, repoRoot, projectId, hash,
          storeId, batchSize, cfg, rateLimiter, verbosity, directDb
        );

        state.filesDone++;
        state.chunksOk += result.ok;
        state.chunksTotal += result.total;
        state.chunksFailed += result.total - result.ok;
        state.bytesProcessed += fileSize(item.absPath);

        if (result.errors.length > 0) {
          state.filesFailed++;
          state.failedFiles.push({ path: item.relPath, ok: result.ok, total: result.total, errors: result.errors });
        } else if (result.total === 0) {
          state.filesSkipped++;
        } else {
          state.filesOk++;
        }

        if (verbosity === "compact" && result.ok > 0) {
          console.log(`    ${c.dim}${result.ok}/${result.total} chunks${c.reset}`);
        }
      } catch (e) {
        state.filesDone++;
        state.filesFailed++;
        const msg = e instanceof Error ? e.message : String(e);
        state.failedFiles.push({ path: item.relPath, ok: 0, total: 0, errors: [msg] });
        if (e instanceof RateLimitAbort) break;
      }
    }
  }

  // Use limited concurrency
  const workerCount = Math.min(concurrency, 8); // Cap actual concurrency
  for (let i = 0; i < workerCount; i++) workers.push(processNext());
  await Promise.all(workers);

  // Output
  if (verbosity === "json") {
    console.log(JSON.stringify({
      unchanged: nUnchanged, updated: nUpdated, new: nNew, deleted: nDeleted,
      chunks_added: state.chunksOk, chunks_failed: state.chunksFailed,
      files_processed: state.filesDone, files_ok: state.filesOk, files_failed: state.filesFailed,
      elapsed_seconds: Math.round((Date.now() - state.startTime) / 100) / 10,
      failed_files: state.failedFiles,
    }));
  } else if (rateLimiter.isAborted()) {
    console.log(`\n  ${c.red}${c.bold}⛔ Aborted due to excessive rate limiting.${c.reset}`);
    console.log(`  Stored ${c.green}${state.chunksOk}${c.reset}/${state.chunksTotal} chunks before stopping.`);
    console.log(`  ${c.dim}Tip: re-run with --sync to resume${c.reset}\n`);
  } else {
    printSummary(state, sync, nUnchanged, nUpdated, nNew, nDeleted);
  }

  if (rateLimiter.isAborted()) process.exitCode = 2;

  } finally {
    // Single point of directDb teardown — runs on normal completion,
    // every early return inside the try block, and any exception
    // bubbling up to main().catch below.
    if (directDb) await directDb.close();
  }
}

main().catch((e) => {
  console.error(`${c.red}Fatal: ${e instanceof Error ? e.message : String(e)}${c.reset}`);
  process.exit(1);
});