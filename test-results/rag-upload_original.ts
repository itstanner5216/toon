#!/usr/bin/env node
/**
 * rag-upload.ts — CLI tool to ingest files/directories into the PGVector store.
 *
 * TypeScript port of pgvector-upload with improvements:
 *   - Native async/await concurrency (no GIL)
 *   - Symbol-aware chunking via Zenith tree-sitter
 *   - Three-text model (semantic/lexical/display)
 *   - Circuit-breaker rate limiter
 *   - Incremental sync with hash comparison
 *
 * Usage:
 *   rag-upload /path/to/project
 *   rag-upload /path/to/project --sync
 *   rag-upload /path/to/project --sync --dry-run
 *   rag-upload /path/to/project --sync --force
 *   rag-upload /path/to/project --status
 *   rag-upload /path/to/project --compact
 *   rag-upload /path/to/project --json
 */

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join, relative, extname, resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, type RagConfig } from "../lib/config.js";
import { chunkFile, type ChunkResult } from "../lib/chunker.js";
import { resolveProjectRoot, getProjectId } from "../utils/project-scope.js";
import { createVectorDB } from "../lib/db-adapter.js";
import {
  getExistingSourceHashes,
  insertEmbeddingBatch,
  deleteEmbeddingsForDocs,
  type EmbeddingInsertItem,
} from "../lib/schema.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface SyncAction {
  absPath: string;
  relPath: string;
  hash: string;
  action: "new" | "updated" | "forced" | "incomplete" | "oversized";
}

interface StoreSourceInfo {
  content_hash: string;
  chunk_count: number | null;
  max_chunk_chars?: number | null;
}

interface ProgressState {
  totalFiles: number;
  filesDone: number;
  filesOk: number;
  filesFailed: number;
  filesSkipped: number;
  chunksOk: number;
  chunksFailed: number;
  chunksTotal: number;
  bytesProcessed: number;
  startTime: number;
  failedFiles: Array<{ path: string; ok: number; total: number; errors: string[] }>;
}

type Verbosity = "json" | "compact" | "verbose" | "normal";

// ═══════════════════════════════════════════════════════════════════════════════
// Colors
// ═══════════════════════════════════════════════════════════════════════════════

const NO_COLOR = !process.stdout.isTTY || !!process.env.NO_COLOR;

const c = NO_COLOR
  ? { green: "", red: "", yellow: "", cyan: "", blue: "", magenta: "", dim: "", reset: "", bold: "", italic: "" }
  : {
      green: "\x1b[92m", red: "\x1b[91m", yellow: "\x1b[93m", cyan: "\x1b[96m",
      blue: "\x1b[94m", magenta: "\x1b[95m", dim: "\x1b[2m", reset: "\x1b[0m",
      bold: "\x1b[1m", italic: "\x1b[3m",
    };

// ═══════════════════════════════════════════════════════════════════════════════
// Formatting Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function typeBadge(contentType: string, language = ""): string {
  const badges: Record<string, string> = {
    code: `${c.magenta}CODE${c.reset}`,
    config: `${c.blue}CONF${c.reset}`,
    markdown: `${c.cyan}MD${c.reset}`,
    text: `${c.dim}TEXT${c.reset}`,
  };
  let badge = badges[contentType] ?? `${c.dim}${contentType || "?"}${c.reset}`;
  if (language && contentType === "code") badge = `${c.magenta}${language}${c.reset}`;
  return `[${badge}]`;
}

function statusIcon(status: string): string {
  const icons: Record<string, string> = {
    new: `${c.green}+${c.reset}`, updated: `${c.yellow}↻${c.reset}`,
    unchanged: `${c.dim}=${c.reset}`, stale: `${c.red}✗${c.reset}`,
    ok: `${c.green}✓${c.reset}`, fail: `${c.red}✗${c.reset}`,
    skip: `${c.dim}⊘${c.reset}`, abort: `${c.red}⊘${c.reset}`,
    incomplete: `${c.yellow}◐${c.reset}`, oversized: `${c.yellow}⚠${c.reset}`,
  };
  return icons[status] ?? "?";
}

function sizeFmt(bytes: number): string {
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (Math.abs(bytes) < 1024) return unit === "B" ? `${bytes}${unit}` : `${bytes.toFixed(1)}${unit}`;
    bytes /= 1024;
  }
  return `${bytes.toFixed(1)}TB`;
}

function durationFmt(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function progressBar(current: number, total: number, width = 30): string {
  const pct = total === 0 ? 1 : Math.min(current / total, 1);
  const filled = Math.round(pct * width);
  const color = pct >= 1 ? c.green : pct >= 0.5 ? c.yellow : c.cyan;
  return `${color}${"█".repeat(filled)}${"░".repeat(width - filled)}${c.reset} ${(pct * 100).toFixed(1)}% (${current}/${total})`;
}

function truncPath(p: string, max = 60): string {
  return p.length <= max ? p : "…" + p.slice(-(max - 1));
}

// ═══════════════════════════════════════════════════════════════════════════════
// File Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function fileSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

function detectContentType(filePath: string, cfg: RagConfig): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext === "md") return "markdown";
  if (cfg.codeExtensions.has(ext)) return "code";
  if (cfg.configExtensions.has(ext)) return "config";
  return "text";
}

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    py: "python", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    java: "java", go: "go", rs: "rust", c: "c", cpp: "cpp", cc: "cpp", h: "c", hpp: "cpp",
    cs: "csharp", rb: "ruby", php: "php", swift: "swift", kt: "kotlin", scala: "scala",
    sh: "shell", bash: "shell", zsh: "shell", sql: "sql", yml: "yaml", yaml: "yaml",
    json: "json", toml: "toml", md: "markdown",
  };
  return map[ext] || "text";
}

// ═══════════════════════════════════════════════════════════════════════════════
// File Collection
// ═══════════════════════════════════════════════════════════════════════════════

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".env", ".tox",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build", ".next",
  ".nuxt", ".output", "vendor", "target", ".gradle", ".idea", ".vscode",
  ".svn", ".hg", "coverage", ".turbo", ".cache", "bower_components", ".eggs",
  ".copilot", ".obsidian", ".claude", ".chroma_db", ".hive", "codex",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Gemfile.lock",
  "poetry.lock", "composer.lock", "Cargo.lock", "go.sum",
  ".env", "cacert.pem", ".gitconfig", ".ragconfig",
]);

function collectFiles(rootPath: string, extensions: Set<string>, maxBytes: number): string[] {
  const absRoot = resolve(rootPath);
  if (!statSync(absRoot).isDirectory()) return [absRoot];

  const files: string[] = [];
  const CRITICAL = new Set(["Dockerfile", "docker-compose.yml", "package.json", "pyproject.toml", "Makefile"]);

  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }

    for (const name of entries.sort()) {
      const fullPath = join(dir, name);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.endsWith(".egg-info")) walk(fullPath);
      } else if (stat.isFile()) {
        if (!CRITICAL.has(name) && SKIP_FILES.has(name)) continue;
        if (maxBytes > 0 && stat.size > maxBytes) continue;
        const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
        if (extensions.has(ext)) files.push(fullPath);
      }
    }
  }

  walk(absRoot);
  return files.sort();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rate Limiter
// ═══════════════════════════════════════════════════════════════════════════════

class RateLimitAbort extends Error {
  constructor() { super("Rate limit abort — operation cancelled"); this.name = "RateLimitAbort"; }
}

class RateLimiter {
  private startTime = Date.now();
  private callTimes: number[] = [];
  private rateLimitHits = 0;
  private cooldownTaken = false;
  private aborted = false;
  private cfg: RagConfig;

  constructor(cfg: RagConfig) { this.cfg = cfg; }

  private inWarmup(): boolean {
    return (Date.now() - this.startTime) < this.cfg.rateWarmupSeconds * 1000;
  }

  private currentDelay(): number {
    const escalated = this.rateLimitHits >= this.cfg.rateLimitEscalateAfter;
    if (escalated) {
      return this.inWarmup() ? this.cfg.rateLimitEscalatedInitial : this.cfg.rateLimitEscalatedSustained;
    }
    return this.inWarmup() ? this.cfg.rateDelayInitial : this.cfg.rateDelaySustained;
  }

  reportRateLimit(): void {
    this.rateLimitHits++;
    if (this.cooldownTaken) {
      this.aborted = true;
      console.error(`\n  ${c.red}🛑 Rate limited again after cooldown. Aborting.${c.reset}\n`);
      return;
    }
    if (this.rateLimitHits >= this.cfg.rateLimitCooldownAfter) {
      this.cooldownTaken = true;
      console.error(`\n  ${c.yellow}⚠ ${this.rateLimitHits} rate limits — cooldown ${this.cfg.rateLimitCooldownSecs}s...${c.reset}\n`);
    } else if (this.rateLimitHits >= this.cfg.rateLimitEscalateAfter) {
      console.error(`  ${c.yellow}⚠ ${this.rateLimitHits} rate limits — escalating delay to ${this.currentDelay()}s${c.reset}`);
    }
  }

  isAborted(): boolean { return this.aborted; }

  async acquire(): Promise<void> {
    if (this.aborted) throw new RateLimitAbort();

    // Cooldown pause
    if (this.cooldownTaken && this.rateLimitHits >= this.cfg.rateLimitCooldownAfter) {
      await sleep(this.cfg.rateLimitCooldownSecs * 1000);
      this.callTimes = [];
    }

    const now = Date.now();
    this.callTimes = this.callTimes.filter((t) => t > now - 60_000);

    // Per-minute cap
    if (this.callTimes.length >= this.cfg.rateMaxPerMinute) {
      const wait = 60_000 - (now - this.callTimes[0]) + 100;
      if (wait > 0) await sleep(wait);
      if (this.aborted) throw new RateLimitAbort();
      this.callTimes = this.callTimes.filter((t) => t > Date.now() - 60_000);
    }

    // Inter-call delay
    if (this.callTimes.length > 0) {
      const last = this.callTimes[this.callTimes.length - 1];
      const gap = last + this.currentDelay() * 1000 - Date.now();
      if (gap > 0) await sleep(gap);
      if (this.aborted) throw new RateLimitAbort();
    }

    this.callTimes.push(Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// API Calls
// ═══════════════════════════════════════════════════════════════════════════════

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
      const sorted = (data.data as { index: number; embedding: number[] }[]).sort((a, b) => a.index - b.index);
      return sorted.map((item) => item.embedding);
    } catch (e) {
      if (e instanceof RateLimitAbort) throw e;
      if (attempt < cfg.maxRetries - 1) {
        await sleep(Math.min(cfg.retryBackoffBase ** attempt, cfg.retryBackoffMax) * 1000);
      } else throw e;
    }
  }
  throw new RateLimitAbort();
}

// Wire-shape interfaces — the JSON HTTP responses we expect from
// the Zenith-RAG / pgvector server. Keeping these typed eliminates
// the prior `as any` casts on fetch results.
interface EmbeddingItemPayload {
  content: string;
  semantic_content: string;
  lexical_content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

interface StoreSourcesResponse {
  sources?: Record<string, StoreSourceInfo | string>;
}

interface DeleteDocResponse {
  deleted?: number;
}

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
  const data = (await resp.json()) as StoreSourcesResponse;
  const sources = data.sources ?? {};
  const result = new Map<string, StoreSourceInfo>();
  for (const [k, v] of Object.entries(sources)) {
    if (typeof v === "object" && v !== null) {
      result.set(k, v as StoreSourceInfo);
    } else {
      result.set(k, { content_hash: String(v), chunk_count: null });
    }
  }
  return result;
}

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
    const body = (await resp.json()) as DeleteDocResponse;
    return body.deleted ?? 0;
  } catch { return 0; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ingestion Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

async function ingestFile(
  filePath: string,
  relPath: string,
  repoRoot: string,
  projectId: string,
  contentHash: string,
  storeId: string,
  batchSize: number,
  cfg: RagConfig,
  rateLimiter: RateLimiter,
  verbosity: Verbosity,
  directDb?: import("../lib/db-adapter.js").VectorStoreDB
): Promise<{ ok: number; total: number; errors: string[] }> {
  // Chunk the file
  let chunks: ChunkResult[];
  try {
    chunks = await chunkFile(filePath, { maxChunkChars: cfg.codeChunkMaxChars, repoRoot, projectId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: 0, total: 0, errors: [msg] };
  }

  if (chunks.length === 0) return { ok: 0, total: 0, errors: [] };

  if (verbosity === "verbose") {
    const ct = detectContentType(filePath, cfg);
    const badge = typeBadge(ct, detectLanguage(filePath));
    console.log(`    ${badge} ${chunks.length} chunks → ${Math.ceil(chunks.length / batchSize)} batch(es)`);
  }

  let ok = 0;
  const errors: string[] = [];

  // Process in batches
  for (let i = 0; i < chunks.length; i += batchSize) {
    if (rateLimiter.isAborted()) {
      errors.push("aborted");
      break;
    }

    const batch = chunks.slice(i, i + batchSize);
    const semanticTexts = batch.map((ch) => ch.semanticContent);

    try {
      const embeddings = await getEmbeddingsBatch(semanticTexts, cfg, rateLimiter);

      const items = batch.map((ch, j) => ({
        content: ch.content,
        semantic_content: ch.semanticContent,
        lexical_content: ch.lexicalContent,
        embedding: embeddings[j],
        metadata: {
          ...ch.metadata,
          repo_root: repoRoot,
          project_id: projectId,
          doc_path: relPath,
          source: relPath,
          content_hash: contentHash,
          chunk: i + j + 1,
          total_chunks: chunks.length,
          embedding_model: cfg.embeddingModel,
        } as Record<string, unknown>,
      }));

      if (directDb) {
        const dbItems: EmbeddingInsertItem[] = items.map((it) => ({
          content: it.content,
          semantic_content: it.semantic_content,
          lexical_content: it.lexical_content,
          embedding: it.embedding,
          metadata: it.metadata,
        }));
        await insertEmbeddingBatch(directDb, storeId, dbItems);
      } else {
        await addEmbeddingsBatch(items, storeId, cfg);
      }
      ok += batch.length;

      if (verbosity === "verbose") {
        console.log(`    ${statusIcon("ok")} batch ${Math.floor(i / batchSize) + 1} (${batch.length} chunks)`);
      }
    } catch (e) {
      if (e instanceof RateLimitAbort) {
        errors.push("aborted");
        break;
      }
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { ok, total: chunks.length, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sync Logic
// ═══════════════════════════════════════════════════════════════════════════════

async function computeSyncPlan(
  files: string[],
  repoRoot: string,
  projectId: string,
  storeId: string,
  cfg: RagConfig,
  force: boolean,
  directDb?: import("../lib/db-adapter.js").VectorStoreDB
): Promise<{ toIngest: SyncAction[]; staleDocs: string[]; nNew: number; nUpdated: number; nUnchanged: number; nIncomplete: number }> {
  // Fetch existing source hashes — HTTP or direct-DB path
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

  const localByDoc = new Map<string, string>();
  for (const fp of files) localByDoc.set(relative(repoRoot, fp), fp);

  const toIngest: SyncAction[] = [];
  let nNew = 0, nUpdated = 0, nUnchanged = 0, nIncomplete = 0;

  for (const [rel, fp] of localByDoc) {
    const hash = fileSha256(fp);
    const info = existing.get(rel);

    if (!info) {
      nNew++;
      toIngest.push({ absPath: fp, relPath: rel, hash, action: "new" });
    } else if (info.content_hash !== hash || force) {
      nUpdated++;
      toIngest.push({ absPath: fp, relPath: rel, hash, action: force && info.content_hash === hash ? "forced" : "updated" });
    } else {
      // Check for incomplete uploads. Pass repoRoot/projectId so the
      // chunk count produced here is identical to the count rag-index
      // would compute when actually ingesting — otherwise files that
      // chunked differently under a different project root would be
      // flagged as incomplete on every sync.
      try {
        const expectedChunks = (
          await chunkFile(fp, {
            maxChunkChars: cfg.codeChunkMaxChars,
            repoRoot,
            projectId,
          })
        ).length;
        if (info.chunk_count !== null && expectedChunks > 0 && info.chunk_count < expectedChunks) {
          nIncomplete++;
          nUpdated++;
          toIngest.push({ absPath: fp, relPath: rel, hash, action: "incomplete" });
          continue;
        }
      } catch { /* ignore chunking errors during planning */ }
      nUnchanged++;
    }
  }

  const staleDocs = [...existing.keys()].filter((dp) => !localByDoc.has(dp));

  return { toIngest, staleDocs, nNew, nUpdated, nUnchanged, nIncomplete };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display
// ═══════════════════════════════════════════════════════════════════════════════

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

function printSummary(state: ProgressState, sync: boolean, nUnchanged: number, nUpdated: number, nNew: number, nDeleted: number) {
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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      store: { type: "string" },
      ext: { type: "string" },
      batch: { type: "string" },
      sync: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      compact: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      "direct-db": { type: "boolean", default: false },
      export: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`
  Usage: rag-upload <path> [options]

  Options:
    --sync          Incremental sync (skip unchanged)
    --force         Force re-upload all files
    --dry-run       Preview changes without uploading
    --status        Show current store contents
    --compact       Minimal output
    --verbose       Maximum detail
    --json          Machine-readable JSON output
    --confirm       Ask before starting
    --ext <exts>    File extensions (comma-separated)
    --batch <n>     Chunks per embedding call
    --store <id>    Vector store ID
    --export <file> Export sync plan to JSON
    --direct-db     Bypass HTTP server; write directly to Postgres via DATABASE_URL
`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const targetPath = resolve(positionals[0]);
  const storeId = values.store || cfg.defaultStoreId;
  const batchSize = values.batch ? Number(values.batch) : cfg.embedBatchSize;
  const sync = values.sync || values["dry-run"] || false;
  const force = values.force || false;
  const dryRun = values["dry-run"] || false;

  const verbosity: Verbosity = values.json ? "json" : values.compact ? "compact" : values.verbose ? "verbose" : "normal";

  // Resolve extensions
  let extensions: Set<string>;
  if (values.ext) {
    extensions = new Set(values.ext.split(",").map((e) => e.trim().toLowerCase()));
  } else {
    extensions = new Set([...cfg.defaultExtensions, ...cfg.codeExtensions, ...cfg.configExtensions]);
  }

  // Detect project
  const repoRoot = resolveProjectRoot(targetPath) || targetPath;
  const projectId = getProjectId(repoRoot) ?? repoRoot;

  // Direct-DB connection (optional). Wrapped in try/finally below so
  // every exit path — clean returns, errors caught upstream, and
  // process.exit calls — always closes the pool. pg's pool.end() is
  // not idempotent, so we MUST NOT also close it inside the try
  // block; the finally is the single point of teardown.
  const useDirectDb = values["direct-db"] || false;
  const directDb = useDirectDb ? createVectorDB({ databaseUrl: cfg.databaseUrl }) : undefined;

  try {

  // Collect files
  const scanRoot = statSync(targetPath).isDirectory() ? targetPath : dirname(targetPath);
  const files = collectFiles(scanRoot, extensions, cfg.maxFileBytes);

  if (files.length === 0) {
    if (verbosity === "json") { console.log(JSON.stringify({ error: "no matching files", files: 0 })); }
    else { console.log(`\n  ${c.yellow}No matching files found.${c.reset}\n`); }
    process.exitCode = 1;
    return;
  }

  // Status mode
  if (values.status) {
    await showStatus(storeId, projectId, files, repoRoot, cfg, directDb);
    return;
  }

  // Header
  if (verbosity !== "json") {
    printHeader(targetPath, files, storeId, { sync, force, dryRun, projectId, repoRoot, extensions, batchSize, cfg });
  }

  // Sync plan
  let toIngest: SyncAction[];
  let staleDocs: string[] = [];
  let nNew = 0, nUpdated = 0, nUnchanged = 0, nDeleted = 0, nIncomplete = 0;

  if (sync) {
    if (verbosity !== "json") console.log(`  ${c.dim}Comparing against store…${c.reset}`);
    const plan = await computeSyncPlan(files, repoRoot, projectId, storeId, cfg, force, directDb);
    toIngest = plan.toIngest;
    staleDocs = plan.staleDocs;
    nNew = plan.nNew;
    nUpdated = plan.nUpdated;
    nUnchanged = plan.nUnchanged;
    nIncomplete = plan.nIncomplete;

    if (verbosity !== "json") printSyncPlan(toIngest, staleDocs, nNew, nUpdated, nUnchanged, nIncomplete, cfg);

    if (values.export) {
      writeFileSync(values.export, JSON.stringify({
        mode: "sync", dry_run: dryRun, store_id: storeId, project_id: projectId,
        new: nNew, updated: nUpdated, incomplete: nIncomplete, unchanged: nUnchanged,
        stale: staleDocs.length,
        to_ingest: toIngest.map((a) => ({ path: a.relPath, action: a.action, hash: a.hash })),
        to_delete: staleDocs,
      }, null, 2));
      if (verbosity !== "json") console.log(`  ${c.green}Exported sync plan to ${values.export}${c.reset}`);
    }

    if (dryRun) {
      if (verbosity === "json") {
        console.log(JSON.stringify({ dry_run: true, new: nNew, updated: nUpdated, unchanged: nUnchanged, stale: staleDocs.length }));
      }
      return;
    }

    if (toIngest.length === 0 && staleDocs.length === 0) {
      if (verbosity === "json") console.log(JSON.stringify({ unchanged: nUnchanged, updated: 0, new: 0, deleted: 0, chunks_added: 0 }));
      return;
    }
  } else {
    toIngest = files.map((fp) => ({ absPath: fp, relPath: relative(repoRoot, fp), hash: "", action: "new" as const }));
  }

  // Confirmation
  if (values.confirm && process.stdin.isTTY && verbosity !== "json") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  ${c.bold}Proceed with ${toIngest.length} file(s)? [y/N] ${c.reset}`, resolve);
    });
    rl.close();
    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      console.log(`  ${c.dim}Cancelled.${c.reset}`);
      return;
    }
  }

  // Rate limiter
  const rateLimiter = new RateLimiter(cfg);

  // Delete stale docs
  if (staleDocs.length > 0) {
    if (directDb) {
      const deleted = await deleteEmbeddingsForDocs(directDb, storeId, projectId, staleDocs);
      nDeleted += staleDocs.length;
      if (verbosity === "verbose") console.log(`  ${statusIcon("stale")} ${c.dim}${staleDocs.length} stale doc(s)${c.reset} (deleted ${deleted} chunks)`);
    } else {
      for (const docPath of staleDocs) {
        const deleted = await deleteStoreDoc(storeId, docPath, cfg);
        nDeleted++;
        if (verbosity === "verbose") console.log(`  ${statusIcon("stale")} ${c.dim}${docPath}${c.reset} (deleted ${deleted} chunks)`);
      }
    }
  }

  // Delete old chunks for updated files
  if (sync) {
    const updatedPaths = toIngest
      .filter((item) => ["updated", "forced", "incomplete", "oversized"].includes(item.action))
      .map((item) => item.relPath);
    if (directDb) {
      if (updatedPaths.length > 0) {
        await deleteEmbeddingsForDocs(directDb, storeId, projectId, updatedPaths);
      }
    } else {
      for (const relPath of updatedPaths) {
        await deleteStoreDoc(storeId, relPath, cfg);
      }
    }
  }

  // Ingest
  const state: ProgressState = {
    totalFiles: toIngest.length, filesDone: 0, filesOk: 0, filesFailed: 0,
    filesSkipped: 0, chunksOk: 0, chunksFailed: 0, chunksTotal: 0,
    bytesProcessed: 0, startTime: Date.now(), failedFiles: [],
  };

  if (verbosity !== "json") console.log(`\n  ${c.bold}Uploading…${c.reset}\n`);

  // Process files with concurrency (limited)
  const concurrency = Math.min(toIngest.length, cfg.maxWorkersDir);
  const itemsWithSeq = toIngest.map((item, idx) => ({ ...item, seq: idx + 1 }));
  const queue = [...itemsWithSeq];
  const workers: Promise<void>[] = [];

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

