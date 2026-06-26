#!/usr/bin/env python3
"""CLI tool to ingest files/directories into the pgvector store.

Usage:
  pgvector-upload /path/to/file.md
  pgvector-upload /path/to/directory
  pgvector-upload /path/to/dir --ext md,txt,rst,org
  pgvector-upload /path/to/dir --sync              # incremental sync
  pgvector-upload /path/to/dir --sync --force       # force re-upload all
  pgvector-upload /path/to/dir --sync --dry-run     # preview what would change
  pgvector-upload /path/to/dir --status             # show store contents
  pgvector-upload /path/to/dir --compact            # minimal output
  pgvector-upload /path/to/dir --verbose            # maximum detail
  pgvector-upload /path/to/dir --json               # machine-readable JSON
  pgvector-upload /path/to/dir --confirm            # ask before uploading
  pgvector-upload /path/to/dir --export plan.json   # export sync plan to file

Config: reads from ~/.config/pgvector/config.env
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence, cast
import threading
import httpx
# ... [6 lines omitted]

try:
# ... [401 lines omitted]
def get_embeddings_batch(texts: list[str], retries: int | None = None) -> list[list[float]]:
    retries = retries or MAX_RETRIES
    for attempt in range(retries):
        if _rate_limiter.is_aborted():
            raise RateLimitAbort("Too many rate limits — operation cancelled")
        _rate_limiter.acquire()
        try:
            with httpx.Client(timeout=120.0) as client:
                resp = client.post(
                    f"{LITELLM_BASE}/v1/embeddings",
                    headers={"Authorization": f"Bearer {LITELLM_KEY}"},
                    json={"model": EMBEDDING_MODEL, "input": texts},
                )
                resp.raise_for_status()
                result = resp.json()
                sorted_data = sorted(result["data"], key=lambda x: x["index"])
                return [item["embedding"] for item in sorted_data]
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and attempt < retries - 1:
                _rate_limiter.report_rate_limit()
                if _rate_limiter.is_aborted():
                    raise RateLimitAbort("Too many rate limits — operation cancelled")
                wait = 2 ** (attempt + 1)
                safe_print(f"  {YELLOW}⏳ Rate limited, retrying in {wait}s...{RESET}")
                time.sleep(wait)
            else:
                raise
        except (httpx.RequestError, ConnectionError, OSError) as e:
            if attempt < retries - 1:
                wait = min(RETRY_BACKOFF_BASE ** attempt, RETRY_BACKOFF_MAX)
                safe_print(f"  {YELLOW}⏳ Embedding call failed ({e}), retry {attempt+1}/{retries} in {wait}s...{RESET}")
                time.sleep(wait)
            else:
                raise
    raise RateLimitAbort("Too many rate limits — operation cancelled")
def add_embedding(
    content: str,
    embedding: list[float],
    metadata: dict[str, object],
    store_id: str,
) -> str | None:
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            f"{API_BASE}/v1/vector_stores/{store_id}/embeddings",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json={"content": content, "embedding": embedding, "metadata": metadata},
        )
        resp.raise_for_status()
        return resp.json().get("id")  # type: ignore[no-any-return]
def add_embeddings_batch(
    items: list[dict[str, object]],
    store_id: str,
    retries: int | None = None,
) -> dict[str, object]:
    retries = retries or MAX_RETRIES
    for attempt in range(retries):
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(
                    f"{API_BASE}/v1/vector_stores/{store_id}/embeddings/batch",
                    headers={"Authorization": f"Bearer {API_KEY}"},
                    json={"embeddings": items},
                )
                resp.raise_for_status()
                return resp.json()  # type: ignore[no-any-return]
        except (httpx.RequestError, ConnectionError, OSError) as e:
            if attempt < retries - 1:
                wait = min(RETRY_BACKOFF_BASE ** attempt, RETRY_BACKOFF_MAX)
                safe_print(f"  {YELLOW}⏳ Store batch failed ({e}), retry {attempt+1}/{retries} in {wait}s...{RESET}")
                time.sleep(wait)
            else:
                raise
    raise RuntimeError("unreachable")
def get_store_sources(store_id: str, project_id: str | None = None) -> dict[str, dict[str, object]]:
    url = f"{API_BASE}/v1/vector_stores/{store_id}/sources"
    params = {"project_id": project_id} if project_id else None
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(url, headers={"Authorization": f"Bearer {API_KEY}"}, params=params)
            resp.raise_for_status()
            sources = resp.json().get("sources", {})
            result = {}
            for k, v in sources.items():
                if isinstance(v, dict):
                    result[k] = v
                else:
                    result[k] = {"content_hash": v, "chunk_count": None}
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.text
        try:
            msg = json.loads(body).get("detail", body)
        except json.JSONDecodeError:
            msg = body
        print(f"  {RED}ERROR: GET sources failed ({e.response.status_code}): {msg[:300]}{RESET}", file=sys.stderr)
        sys.exit(1)
    except (httpx.RequestError, ConnectionError, OSError) as e:
        print(f"  {RED}Connection failed: {e}{RESET}", file=sys.stderr)
        print(f"  {DIM}Is pgvector-api running at {API_BASE}?{RESET}", file=sys.stderr)
        sys.exit(1)
def delete_store_doc(store_id: str, doc_path: str) -> int:
    url = f"{API_BASE}/v1/vector_stores/{store_id}/embeddings"
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.request(
                "DELETE",
                url,
                headers={"Authorization": f"Bearer {API_KEY}"},
                params={"doc_path": doc_path},
            )
            resp.raise_for_status()
            return resp.json().get("deleted", 0)  # type: ignore[no-any-return]
    except httpx.HTTPStatusError as e:
        safe_print(f"  {RED}ERROR: DELETE failed for {doc_path}: {e.response.status_code}{RESET}")
        return 0


# ── File detection ──────────────────────────────────────────────────────────
# ... [955 lines omitted]
def _print_header(
    args: argparse.Namespace,
    files: list[str],
    extensions: set[str],
    repo_root: str,
    project_id: str,
    manifest: ProjectManifest | None,
) -> None:
    """Print a formatted header banner matching search tool style."""
    print()
    print(f"  {BOLD}pgvector-upload{RESET}  {DIM}{os.path.abspath(args.path)}{RESET}")

    parts = []
    parts.append(f"{len(files)} file{'s' if len(files) != 1 else ''}")
    parts.append(f"store {args.store[:8]}…")
    if args.sync:
        parts.append("sync mode")
    if args.force:
        parts.append("force")
    if args.dry_run:
        parts.append(f"{YELLOW}dry-run{RESET}")
    print(f"  {DIM}{' · '.join(parts)}{RESET}")

    # Detailed info
    print()
    print(f"  {DIM}{'─' * 60}{RESET}")
    print(f"  {CYAN}Project:{RESET}    {project_id}")
    print(f"  {CYAN}Root:{RESET}       {repo_root}")
    print(f"  {CYAN}Extensions:{RESET} {', '.join(sorted(extensions))}")
    print(f"  {CYAN}Batch:{RESET}      {args.batch} chunks/call")
    print(f"  {CYAN}Model:{RESET}      {EMBEDDING_MODEL}")
    rate_info = f"{RATE_MAX_PER_MINUTE}/min, {RATE_DELAY_INITIAL}s → {RATE_DELAY_SUSTAINED}s after {RATE_WARMUP_SECONDS:.0f}s"
    print(f"  {CYAN}Rate:{RESET}       {rate_info}")
    if manifest:
        print(f"  {CYAN}Manifest:{RESET}  {manifest.project_id} ({RAGCONFIG_PATH})")
    print(f"  {DIM}{'─' * 60}{RESET}")
    print()


# ── Display: file type breakdown ────────────────────────────────────────────
def _print_file_breakdown(files: list[str], repo_root: str) -> None:
    """Print a content-type and language breakdown of discovered files."""
    type_counts: dict[str, int] = defaultdict(int)
    lang_counts: dict[str, int] = defaultdict(int)
    ext_counts: dict[str, int] = defaultdict(int)
    total_bytes = 0

    for fp in files:
        ct = detect_content_type(fp)
        lang = detect_language(fp)
        ext = os.path.splitext(fp)[1].lstrip(".").lower()
        type_counts[ct] += 1
        if lang:
            lang_counts[lang] += 1
        if ext:
            ext_counts[ext] += 1
        total_bytes += file_size(fp)

    print(f"  {BOLD}File Breakdown{RESET}  ({_size_fmt(total_bytes)} total)")
    print()

    # Content types
    for ct, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        bar_len = int(count / len(files) * 30) if files else 0
        badge = _type_badge(ct, "")
        pct = count / len(files) * 100 if files else 0
        print(f"    {badge} {count:>4}  {'█' * bar_len}  {pct:.0f}%")

    # Top languages
    if lang_counts:
        print()
        top_langs = sorted(lang_counts.items(), key=lambda x: -x[1])[:8]
        for lang, count in top_langs:
            print(f"    {MAGENTA}{lang:<12}{RESET} {count}")
        if len(lang_counts) > 8:
            print(f"    {DIM}… and {len(lang_counts) - 8} more{RESET}")

    print()


# ── Display: sync plan ──────────────────────────────────────────────────────
# ... [55 lines omitted]
def _print_store_status(
    store_id: str,
    project_id: str,
    files: list[str],
    repo_root: str,
) -> None:
    """Show what's currently in the store (--status mode)."""
    print(f"\n  {BOLD}Store Status{RESET}")
    print(f"  {DIM}{'─' * 60}{RESET}")
    print(f"  {CYAN}Store:{RESET}   {store_id}")
    print(f"  {CYAN}Project:{RESET} {project_id or '(all)'}")
    print()

    existing = get_store_sources(store_id, project_id)

    if not existing:
        print(f"  {DIM}(empty — no documents in store){RESET}")
        print()
        return

    # Build local file index for comparison
    local_by_docpath: dict[str, str] = {}
    for fp in files:
        rel = os.path.relpath(fp, repo_root)
        local_by_docpath[rel] = fp

    type_counts: dict[str, int] = defaultdict(int)
    total_chunks = 0
    status_counts: dict[str, int] = defaultdict(int)
    docs_detail: list[tuple[str, int, str, str]] = []

    for doc_path, info in sorted(existing.items()):
        chunks: int = info.get("chunk_count") or 0  # type: ignore[assignment]
        total_chunks += chunks
        h = info.get("content_hash", "")

        # Determine status
        if doc_path in local_by_docpath:
            local_hash = file_sha256(local_by_docpath[doc_path])
            if local_hash == h:
                status = "unchanged"
            else:
                status = "updated"
        else:
            status = "stale"

        ext = os.path.splitext(doc_path)[1].lstrip(".").lower()
        ct = "code" if ext in CODE_EXTENSIONS else "config" if ext in CONFIG_EXTENSIONS else "markdown" if ext == "md" else "text"
        type_counts[ct] += 1
        status_counts[status] += 1
        docs_detail.append((doc_path, int(chunks), status, ct))

    print(f"  {BOLD}{len(existing)}{RESET} documents, {BOLD}{total_chunks}{RESET} total chunks")
    print()

    # Status breakdown
    for status in ("unchanged", "updated", "stale"):
        count = status_counts.get(status, 0)
        if count > 0:
            print(f"    {_status_icon(status)} {count} {status}")

    # Type breakdown
    print()
    for ct, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        badge = _type_badge(ct, "")
        print(f"    {badge} {count}")

    # File listing
    print()
    print(f"  {BOLD}Documents:{RESET}")
    for doc_path, chunks, status, ct in docs_detail[:30]:
        icon = _status_icon(status)
        badge = _type_badge(ct, "")
        chunks_str = f"{chunks} chunks" if chunks else "? chunks"
        print(f"    {icon} {badge} {CYAN}{_truncate_path(doc_path, 45)}{RESET}  {DIM}{chunks_str}{RESET}")
    if len(docs_detail) > 30:
        print(f"    {DIM}… and {len(docs_detail) - 30} more{RESET}")

    # Check for local files not in store
    missing = [rel for rel in local_by_docpath if rel not in existing]
    if missing:
        print()
        print(f"  {YELLOW}{len(missing)} local file(s) not yet in store:{RESET}")
        for rel in missing[:10]:
            ct = detect_content_type(local_by_docpath[rel])
            badge = _type_badge(ct, detect_language(local_by_docpath[rel]))
            print(f"    {_status_icon('new')} {badge} {CYAN}{_truncate_path(rel, 45)}{RESET}")
        if len(missing) > 10:
            print(f"    {DIM}… and {len(missing) - 10} more{RESET}")

    print()


# ── Display: final summary ──────────────────────────────────────────────────
def _print_summary(
    tracker: ProgressTracker,
    args: argparse.Namespace,
    n_unchanged: int = 0,
    n_updated: int = 0,
    n_new: int = 0,
    n_deleted: int = 0,
) -> None:
    """Print a rich final summary matching search tool quality."""
    elapsed = tracker.elapsed()

    print()
    print(f"  {BOLD}{'═' * 60}{RESET}")
    print(f"  {BOLD}Upload Complete{RESET}  {DIM}{_duration_fmt(elapsed)}{RESET}")
    print(f"  {BOLD}{'═' * 60}{RESET}")
    print()

    # File summary
    print(f"  {BOLD}Files{RESET}")
    parts = []
    if tracker.files_ok > 0:
        parts.append(f"{GREEN}{tracker.files_ok} succeeded{RESET}")
    if tracker.files_skipped > 0:
        parts.append(f"{DIM}{tracker.files_skipped} empty/skipped{RESET}")
    if tracker.files_failed > 0:
        parts.append(f"{RED}{tracker.files_failed} failed{RESET}")
    print(f"    {' · '.join(parts)}")

    # Chunk summary
    print()
    print(f"  {BOLD}Chunks{RESET}")
    bar = _progress_bar(tracker.chunks_ok, tracker.chunks_total, width=30)
    print(f"    {bar}")
    if tracker.chunks_ok > 0:
        rate = tracker.chunks_ok / elapsed if elapsed > 0 else 0
        print(f"    {DIM}{rate:.1f} chunks/sec · {_size_fmt(tracker.bytes_processed)} processed{RESET}")

    # Sync summary
    if args.sync:
        print()
        print(f"  {BOLD}Sync{RESET}")
        sync_parts = []
        if n_new > 0:
            sync_parts.append(f"{GREEN}{n_new} new{RESET}")
        if n_updated > 0:
            sync_parts.append(f"{YELLOW}{n_updated} updated{RESET}")
        if n_unchanged > 0:
            sync_parts.append(f"{DIM}{n_unchanged} unchanged{RESET}")
        if n_deleted > 0:
            sync_parts.append(f"{RED}{n_deleted} stale deleted{RESET}")
        print(f"    {' · '.join(sync_parts)}")

    print()
# ... [610 lines omitted]