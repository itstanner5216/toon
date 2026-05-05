# TOON Compression Review — pgvector

## File Info
- Original: pgvector-upload.py — 90377 characters
- Level 1: pgvector-compressed.txt — 8992 characters (9.95% of original)
- Level 2: pgvector-compressed2.txt — 2999 characters (3.32% of original)
- Level 3: pgvector-compressed3.txt — 12999 characters (14.38% of original)

## Level 1 Review
**Compression ratio:** 9.95%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 3/10 | Preserves imports, `DEFAULTS`, `_AST_EXT_REMAP`, partial `RateLimiter.__init__`, partial `ProgressTracker.__init__`, and `main()`, but omits nearly every top-level function signature between config loading and `main()`. |
| Omission Clarity | 7/10 | Uses explicit markers such as `# ... [lines 344-1362 omitted]`, so the large cuts are visible, but the remaining snippets are sometimes nested after omitted blocks and can look syntactically misleading. |
| Critical Logic Preservation | 2/10 | Keeps the CLI parser and some configuration values, but drops the bodies/signatures for embedding calls, chunking, sync comparison, file collection, deletion, and upload execution. |
| Usability | 2/10 | A developer can infer this is a pgvector upload CLI and see many flags, but cannot safely integrate with the API, chunker, sync behavior, or rate-limit behavior from this version alone. |

**What survived well:**
The module docstring and CLI examples survived. Imports such as `httpx`, `ThreadPoolExecutor`, `Path`, and `ProjectRegistry` survived. Configuration structure survived through `DEFAULTS`, including `API_BASE`, `LITELLM_BASE`, `EMBEDDING_MODEL`, `CODE_EXTENSIONS`, `CONFIG_EXTENSIONS`, rate-limit values, worker counts, and chunk limits. `main()` preserves most argparse flag definitions including `--sync`, `--force`, `--dry-run`, `--status`, `--stats`, `--confirm`, `--compact`, `--verbose`, `--json`, and `--export`.

**What was lost that matters:**
The compressed version hides `get_embeddings_batch()`, `add_embedding()`, `add_embeddings_batch()`, `get_store_sources()`, `delete_store_doc()`, `find_repo_root()`, `detect_content_type()`, `detect_language()`, `build_chunk_records()`, `collect_files()`, `_process_batch()`, `ingest_file()`, `_compute_sync_plan()`, and all display helpers except through calls. It also loses the important `RateLimiter.report_rate_limit()` and `RateLimiter.acquire()` logic that escalates delays, takes cooldowns, and aborts after repeated 429s. The AST fallback path through `chunk_file_ast()` and `build_chunk_representations()` is not usable from the compressed file.

**Verdict:** Level 1 is honest about large omissions but too aggressive for a developer-facing integration summary. It preserves the command-line surface better than the runtime contract.

## Level 2 Review
**Compression ratio:** 3.32%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 1/10 | Keeps imports, two constructor bodies, and a tiny `main()` skeleton, but removes almost all constants, functions, class methods, and parser details. |
| Omission Clarity | 5/10 | The file uses line-count omission markers, but the remaining `main()` fragment has dangling control-flow context and repeated bare `return` lines that do not explain what was removed. |
| Critical Logic Preservation | 0/10 | Embedding calls, store writes, chunking, sync planning, file traversal, error handling, status output, JSON export, and upload loops are all missing. |
| Usability | 0/10 | This is not sufficient to call, modify, or integrate with the script. It mainly tells the reader that a pgvector CLI exists. |

**What survived well:**
The shebang, early CLI usage lines, imports, `ProjectRegistry`, `TYPE_CHECKING`, `RateLimiter.__init__`, `ProgressTracker.__init__`, and the `def main() -> None` line survived. It also preserves that `args.dry_run` sets `args.sync`, and that output verbosity depends on `args.json`.

**What was lost that matters:**
The actual configuration map in `DEFAULTS` is gone. `load_config()`, API constants such as `DEFAULT_STORE_ID` and `EMBED_BATCH_SIZE`, all chunking functions, all HTTP calls, `RateLimitAbort`, the non-constructor `RateLimiter` methods, `collect_files()`, `ingest_file()`, and `_compute_sync_plan()` are omitted. `main()` no longer shows what arguments exist, how files are discovered, how status/stats/sync modes branch, or how upload work is submitted.

**Verdict:** Level 2 is effectively an outline with a few constructors. It compresses hard, but removes the information that makes this file understandable.

## Level 3 Review
**Compression ratio:** 14.38%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 4/10 | Preserves imports, config constants, constructors, and a larger `main()` body, but still omits most top-level function and method signatures. |
| Omission Clarity | 7/10 | Large cuts are labeled with line ranges, including `# ... [lines 344-1362 omitted]` and `# ... [lines 1377-2065 omitted]`, though some omitted spans hide many unrelated APIs behind one marker. |
| Critical Logic Preservation | 3/10 | Retains argument parsing, config loading, file discovery calls, sync-plan export shape, and dry-run branching, but loses the actual embedding, chunking, rate-limit, deletion, status, upload, and summary implementations. |
| Usability | 3/10 | Useful for understanding the CLI entry point and configuration knobs, but not enough to implement against the upload pipeline or diagnose behavior. |

**What survived well:**
Level 3 keeps the full CLI usage header, all imports, `_AST_EXT_REMAP`, `CONFIG_PATH`, nearly the full `DEFAULTS` map, many derived constants such as `RATE_MAX_PER_MINUTE`, `EMBED_BATCH_SIZE`, `MAX_WORKERS_DIR`, and `RETRY_BACKOFF_MAX`, plus a substantial `main()` parser block. It also preserves the sync-plan JSON shape with fields like `dry_run`, `store_id`, `project_id`, `new`, `updated`, `incomplete`, `unchanged`, `stale`, `to_ingest`, and `to_delete`.

**What was lost that matters:**
The function inventory is still mostly absent: `get_embeddings_batch()`, `add_embeddings_batch()`, `get_store_sources()`, `delete_store_doc()`, `detect_symbol_and_chunk_type()`, `chunk_code_records()`, `_split_oversized_block()`, `chunk_config_records()`, `paragraph_records()`, `_apply_headers()`, `build_chunk_records()`, `collect_files()`, `_process_batch()`, `ingest_file()`, `_start_timer_thread()`, and `_compute_sync_plan()` are hidden behind broad omissions. The non-obvious logic for 429 escalation/cooldown, AST chunker fallback, semantic/lexical/display content representation, stale-doc deletion, and incomplete upload detection is not available.

**Verdict:** Level 3 is the best of the three for this file, but it is still an entry-point/config summary rather than a usable compression of the implementation. The broad omission ranges hide exactly the behavior a maintainer would need to understand.

## Overall Assessment
Level 3 has the best balance because it preserves the CLI contract and configuration surface while still reducing the file to 14.38% of the original. TOON does reasonably well at showing that this is a configurable pgvector upload CLI with sync, dry-run, status, stats, JSON, and export modes. It does poorly at preserving a symbol map: most function signatures are omitted, and large unrelated regions are collapsed into a few markers. For a 2426-line operational script, the review needs at least the top-level function signatures and short summaries for `RateLimiter`, `build_chunk_records()`, `ingest_file()`, `_process_batch()`, and `_compute_sync_plan()`; otherwise the compressed output hides the critical implementation shape.
