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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
from project_registry import ProjectRegistry

if TYPE_CHECKING:
    from project_registry import ProjectManifest

try:
    from chunker_ast import chunk_file_ast, prepend_context_header, build_chunk_representations
    _AST_CHUNKER_AVAILABLE = True
except ImportError:
    _AST_CHUNKER_AVAILABLE = False

    def prepend_context_header(
        chunk_text: str,
        filepath: str | None = None,
        symbol: str | None = None,
        language: str | None = None,
    ) -> str:
        if filepath and (filepath.startswith("/") or (len(filepath) >= 2 and filepath[1] == ":")):
            filepath = os.path.basename(filepath)
        parts: list[str] = []
        if filepath:
            parts.append(f"File: {filepath}")
        if symbol:
            parts.append(f"Symbol: {symbol}")
        if language:
            parts.append(f"Language: {language}")
        if not parts:
            return chunk_text
        header = " | ".join(parts)
        return f"# {header}\n{chunk_text}"

    def build_chunk_representations(
        chunk_text: str,
        doc_path: str | None = None,
        symbol: str | None = None,
        language: str | None = None,
    ) -> dict[str, str]:
        """Fallback when chunker_ast is unavailable - uses prepend_context_header."""
        headerless = chunk_text
        with_header = prepend_context_header(chunk_text, doc_path, symbol, language)
        return {
            "raw": headerless,
            "semantic": headerless,
            "lexical": with_header,
            "display": with_header,
        }

_AST_EXT_REMAP: dict[str, str] = {
    # JSX/TSX: detect_language() generalizes these to "javascript"/"typescript",
    # but those grammars reject JSX syntax. Map to the JSX-aware grammar keys.
    "jsx": "jsx",
    "tsx": "tsx",
    # Markdown/CSS/YAML/JSON: not in CODE_EXTENSIONS; route to their AST keys.
    "md": "markdown",
    "css": "css",
    "yaml": "yaml",
    "yml": "yml",
    "json": "json",
    # Shell scripts
    "sh": "bash",
    "bash": "bash",
    "zsh": "bash",
}

CONFIG_PATH = os.path.expanduser("~/.config/pgvector/config.env")

DEFAULTS = {
    "API_BASE": "http://localhost:8200",
    "API_KEY": "",
    "DEFAULT_STORE_ID": "49e09fac-3634-4df4-9837-f90a237cb7a8",
    "RAGCONFIG_PATH": os.path.expanduser("~/.ragconfig"),
    "LITELLM_BASE": "http://localhost:4000",
    "LITELLM_KEY": "",
    "EMBEDDING_MODEL": "voyage-4-large",
    "MAX_CHUNK_CHARS": "1500",
    "MAX_RETRIES": "5",
    "EMBED_BATCH_SIZE": "48",
    "RATE_DELAY_INITIAL": "0.3",
    "RATE_DELAY_SUSTAINED": "0.5",
    "RATE_WARMUP_SECONDS": "60",
    "RATE_MAX_PER_MINUTE": "200",
    "RATE_LIMIT_ESCALATE_AFTER": "3",
    "RATE_LIMIT_ESCALATED_INITIAL": "1.0",
    "RATE_LIMIT_ESCALATED_SUSTAINED": "2.0",
    "RATE_LIMIT_COOLDOWN_AFTER": "16",
    "RATE_LIMIT_COOLDOWN_SECS": "60",
    "DEFAULT_EXTENSIONS": "md,txt,rst,org",
    "CODE_EXTENSIONS": "py,js,ts,tsx,jsx,java,go,rs,c,cc,cpp,h,hpp,cs,rb,php,swift,kt,kts,scala,sh,bash,zsh,sql",
    "CONFIG_EXTENSIONS": "yml,yaml,json,toml,ini,cfg,conf,env,properties,xml",
    "MAX_WORKERS_FILE": "8",
    "MAX_WORKERS_DIR": "120",
    "CODE_CHUNK_MAX_LINES": "20",
    "CODE_CHUNK_MAX_CHARS": "750",
    "CONFIG_CHUNK_MAX_LINES": "20",
    "CONFIG_CHUNK_MAX_CHARS": "750",
    "MAX_FILE_BYTES": "204800",
    "RETRY_BACKOFF_BASE": "2",
    "RETRY_BACKOFF_MAX": "10",
    "MCP_TRANSPORT": "sse",
    "MCP_HOST": "127.0.0.1",
    "MCP_PORT": "8090",
}


def load_config() -> dict[str, str]:
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    cfg[key.strip()] = val.strip().strip('"').strip("'")
    return cfg


_CFG = load_config()
API_BASE = _CFG["API_BASE"]
API_KEY = _CFG["API_KEY"]
DEFAULT_STORE_ID = _CFG["DEFAULT_STORE_ID"]
RAGCONFIG_PATH = _CFG["RAGCONFIG_PATH"]
LITELLM_BASE = _CFG["LITELLM_BASE"]
LITELLM_KEY = _CFG["LITELLM_KEY"]
EMBEDDING_MODEL = _CFG["EMBEDDING_MODEL"]
MAX_CHUNK_CHARS = int(_CFG["MAX_CHUNK_CHARS"])
MAX_RETRIES = int(_CFG["MAX_RETRIES"])
DEFAULT_EXTENSIONS = set(_CFG["DEFAULT_EXTENSIONS"].split(","))
CODE_EXTENSIONS = {e.strip().lower() for e in _CFG["CODE_EXTENSIONS"].split(",") if e.strip()}
CONFIG_EXTENSIONS = {e.strip().lower() for e in _CFG["CONFIG_EXTENSIONS"].split(",") if e.strip()}
RATE_DELAY_INITIAL = float(_CFG["RATE_DELAY_INITIAL"])
RATE_DELAY_SUSTAINED = float(_CFG["RATE_DELAY_SUSTAINED"])
RATE_WARMUP_SECONDS = float(_CFG["RATE_WARMUP_SECONDS"])
RATE_MAX_PER_MINUTE = int(_CFG["RATE_MAX_PER_MINUTE"])
EMBED_BATCH_SIZE = int(_CFG["EMBED_BATCH_SIZE"])
MAX_WORKERS_FILE = int(_CFG["MAX_WORKERS_FILE"])
MAX_WORKERS_DIR = int(_CFG["MAX_WORKERS_DIR"])
CODE_CHUNK_MAX_LINES = int(_CFG["CODE_CHUNK_MAX_LINES"])
CODE_CHUNK_MAX_CHARS = int(_CFG["CODE_CHUNK_MAX_CHARS"])
CONFIG_CHUNK_MAX_LINES = int(_CFG["CONFIG_CHUNK_MAX_LINES"])
CONFIG_CHUNK_MAX_CHARS = int(_CFG["CONFIG_CHUNK_MAX_CHARS"])
MAX_FILE_BYTES = int(_CFG["MAX_FILE_BYTES"])
RATE_LIMIT_ESCALATE_AFTER = int(_CFG["RATE_LIMIT_ESCALATE_AFTER"])
RATE_LIMIT_COOLDOWN_AFTER = int(_CFG["RATE_LIMIT_COOLDOWN_AFTER"])
RATE_LIMIT_ESCALATED_INITIAL = float(_CFG["RATE_LIMIT_ESCALATED_INITIAL"])
RATE_LIMIT_ESCALATED_SUSTAINED = float(_CFG["RATE_LIMIT_ESCALATED_SUSTAINED"])
RATE_LIMIT_COOLDOWN_SECS = float(_CFG["RATE_LIMIT_COOLDOWN_SECS"])
RETRY_BACKOFF_BASE = int(_CFG["RETRY_BACKOFF_BASE"])
RETRY_BACKOFF_MAX = float(_CFG["RETRY_BACKOFF_MAX"])

# ── Colors ──────────────────────────────────────────────────────────────────

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BLUE = "\033[94m"
MAGENTA = "\033[95m"
DIM = "\033[2m"
RESET = "\033[0m"
BOLD = "\033[1m"
UNDERLINE = "\033[4m"
BG_DARK = "\033[48;5;236m"
ITALIC = "\033[3m"

# Disable colors if not a TTY or NO_COLOR is set
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    GREEN = RED = YELLOW = CYAN = BLUE = MAGENTA = ""
    DIM = RESET = BOLD = UNDERLINE = BG_DARK = ITALIC = ""

_print_lock = threading.Lock()


def safe_print(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


# ── Formatting helpers (mirroring pgvector-search) ──────────────────────────


def _type_badge(content_type: str, language: str = "") -> str:
    """Colored badge for content type."""
    badges = {
        "code": f"{MAGENTA}CODE{RESET}",
        "config": f"{BLUE}CONF{RESET}",
        "markdown": f"{CYAN}MD{RESET}",
        "text": f"{DIM}TEXT{RESET}",
    }
    badge = badges.get(content_type, f"{DIM}{content_type or '?'}{RESET}")
    if language and content_type == "code":
        badge = f"{MAGENTA}{language}{RESET}"
    return f"[{badge}]"


def _progress_bar(current: int, total: int, width: int = 30, label: str = "") -> str:
    """Visual progress bar."""
    if total == 0:
        pct = 1.0
    else:
        pct = min(current / total, 1.0)
    filled = int(pct * width)
    bar = "█" * filled + "░" * (width - filled)
    pct_str = f"{pct * 100:5.1f}%"
    count_str = f"{current}/{total}"
    if pct >= 1.0:
        color = GREEN
    elif pct >= 0.5:
        color = YELLOW
    else:
        color = CYAN
    label_str = f"  {label}" if label else ""
    return f"{color}{bar}{RESET} {pct_str} ({count_str}){label_str}"


def _size_fmt(num_bytes: float) -> str:
    """Human-readable file size."""
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:.1f}{unit}" if unit != "B" else f"{num_bytes:.0f}{unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f}TB"


def _duration_fmt(seconds: float) -> str:
    """Human-readable duration."""
    if seconds < 60:
        return f"{seconds:.0f}s"
    m, s = divmod(int(seconds), 60)
    if m < 60:
        return f"{m}m {s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m {s:02d}s"


def _status_icon(status: str) -> str:
    """Colored status icon."""
    icons = {
        "new": f"{GREEN}+{RESET}",
        "updated": f"{YELLOW}↻{RESET}",
        "unchanged": f"{DIM}={RESET}",
        "stale": f"{RED}✗{RESET}",
        "deleted": f"{RED}✗{RESET}",
        "incomplete": f"{YELLOW}◐{RESET}",
        "oversized": f"{YELLOW}⚠{RESET}",
        "ok": f"{GREEN}✓{RESET}",
        "fail": f"{RED}✗{RESET}",
        "skip": f"{DIM}⊘{RESET}",
        "abort": f"{RED}⊘{RESET}",
    }
    return icons.get(status, "?")


def _truncate_path(path: str, max_len: int = 60) -> str:
    """Truncate a path for display, keeping the tail."""
    if len(path) <= max_len:
        return path
    return "…" + path[-(max_len - 1):]


# ── Registry ────────────────────────────────────────────────────────────────


def load_project_registry(config_path: str) -> ProjectRegistry:
    return ProjectRegistry.load(config_path)


def file_sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def file_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


# ── Rate limiter ────────────────────────────────────────────────────────────


class RateLimitAbort(Exception):
    """Raised when too many 429s — signals all threads to stop."""
    pass


class RateLimiter:
    """Thread-safe rate limiter with circuit breaker for 429 protection.

    Stages:
      1. Normal — uses RATE_DELAY_INITIAL / RATE_DELAY_SUSTAINED
      2. Escalated (after ESCALATE_AFTER 429s) — uses ESCALATED_INITIAL / ESCALATED_SUSTAINED
      3. Cooldown (after COOLDOWN_AFTER 429s) — pauses for COOLDOWN_SECS
      4. Abort (any 429 after cooldown) — raises RateLimitAbort
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._start_time = time.monotonic()
        self._call_times: list[float] = []
        self._rate_limit_hits = 0
        self._cooldown_taken = False
        self._aborted = False
        self._pause_until = 0.0
        self._pause_label = ""

    def _in_warmup(self) -> bool:
        return (time.monotonic() - self._start_time) < RATE_WARMUP_SECONDS

    def _current_delay(self) -> float:
        escalated = self._rate_limit_hits >= RATE_LIMIT_ESCALATE_AFTER
        in_warmup = self._in_warmup()
        if escalated:
            return RATE_LIMIT_ESCALATED_INITIAL if in_warmup else RATE_LIMIT_ESCALATED_SUSTAINED
        return RATE_DELAY_INITIAL if in_warmup else RATE_DELAY_SUSTAINED

    def report_rate_limit(self) -> None:
        with self._lock:
            self._rate_limit_hits += 1
            hits = self._rate_limit_hits

            if self._cooldown_taken:
                self._aborted = True
                safe_print(
                    f"\n  {RED}🛑 Rate limited again after cooldown break. "
                    f"Aborting to protect your account.{RESET}\n"
                )
                return

            if hits >= RATE_LIMIT_COOLDOWN_AFTER:
                self._cooldown_taken = True
                safe_print(
                    f"\n  {YELLOW}⚠  {hits} rate limits hit — taking "
                    f"{RATE_LIMIT_COOLDOWN_SECS:.0f}s cooldown break...{RESET}\n"
                )
                self._pause_label = "⚠  RATE LIMITED — cooldown"
                self._pause_until = time.monotonic() + RATE_LIMIT_COOLDOWN_SECS
                self._lock.release()
                time.sleep(RATE_LIMIT_COOLDOWN_SECS)
                self._lock.acquire()
                self._pause_until = 0.0
                self._pause_label = ""
                self._call_times.clear()
                safe_print(f"  {CYAN}↻ Resuming after cooldown...{RESET}")
            elif hits >= RATE_LIMIT_ESCALATE_AFTER:
                delay = self._current_delay()
                safe_print(
                    f"  {YELLOW}⚠  {hits} rate limits — escalating delay to {delay}s between calls{RESET}"
                )

    def is_aborted(self) -> bool:
        with self._lock:
            return self._aborted

    def acquire(self) -> None:
        with self._lock:
            if self._aborted:
                raise RateLimitAbort("Too many rate limits — operation cancelled")

            now = time.monotonic()
            self._call_times = [t for t in self._call_times if t > now - 60.0]

            if len(self._call_times) >= RATE_MAX_PER_MINUTE:
                wait = 60.0 - (now - self._call_times[0]) + 0.1
                if wait > 0:
                    safe_print(f"  {YELLOW}⏳ Minute cap ({RATE_MAX_PER_MINUTE}/min), pausing {wait:.0f}s...{RESET}")
                    self._pause_label = f"⏳ RATE CAP — {RATE_MAX_PER_MINUTE}/min limit"
                    self._pause_until = time.monotonic() + wait
                    self._lock.release()
                    time.sleep(wait)
                    self._lock.acquire()
                    self._pause_until = 0.0
                    self._pause_label = ""
                    if self._aborted:
                        raise RateLimitAbort("Too many rate limits — operation cancelled")
                    now = time.monotonic()
                    self._call_times = [t for t in self._call_times if t > now - 60.0]

            if self._call_times:
                last = self._call_times[-1]
                scheduled = max(last + self._current_delay(), now)
                self._call_times.append(scheduled)
                gap = scheduled - now
                if gap > 0:
                    if gap >= 2.0:
                        self._pause_label = "⧖ RATE DELAY"
                        self._pause_until = scheduled
                    self._lock.release()
                    time.sleep(gap)
                    self._lock.acquire()
                    if gap >= 2.0:
                        self._pause_until = 0.0
                        self._pause_label = ""
                    if self._aborted:
                        raise RateLimitAbort("Too many rate limits — operation cancelled")
            else:
                self._call_times.append(now)


_rate_limiter = RateLimiter()


# ── API calls ───────────────────────────────────────────────────────────────


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


def find_repo_root(path: str) -> str:
    path = os.path.abspath(path)
    if os.path.isfile(path):
        path = os.path.dirname(path)
    current = path
    while True:
        if os.path.isdir(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return path
        current = parent


def detect_content_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    if ext == "md":
        return "markdown"
    if ext in CODE_EXTENSIONS:
        return "code"
    if ext in CONFIG_EXTENSIONS:
        return "config"
    return "text"


def detect_language(path: str) -> str:
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    mapping: dict[str, str] = {
        "py": "python", "js": "javascript", "jsx": "javascript",
        "ts": "typescript", "tsx": "typescript", "java": "java",
        "go": "go", "rs": "rust", "c": "c", "cc": "cpp", "cpp": "cpp",
        "h": "c", "hpp": "cpp", "cs": "csharp", "rb": "ruby",
        "php": "php", "swift": "swift", "kt": "kotlin", "kts": "kotlin",
        "scala": "scala", "sh": "shell", "bash": "shell", "zsh": "shell",
        "sql": "sql", "yml": "yaml", "yaml": "yaml", "json": "json",
        "toml": "toml", "ini": "ini", "cfg": "config", "conf": "config",
        "env": "dotenv", "properties": "properties", "xml": "xml",
        "md": "markdown",
    }
    return mapping.get(ext, "text")


def detect_symbol_and_chunk_type(line: str) -> tuple[str, str | None]:
    patterns = [
        (r"^\s*async\s+def\s+([A-Za-z_]\w*)", "function"),
        (r"^\s*def\s+([A-Za-z_]\w*)", "function"),
        (r"^\s*class\s+([A-Za-z_]\w*)", "class"),
        (r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)", "function"),
        (r"^\s*(?:export\s+)?class\s+([A-Za-z_]\w*)", "class"),
        (r"^\s*(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(", "function"),
        (r"^\s*(?:interface|type|enum)\s+([A-Za-z_]\w*)", "type"),
        (r"^\s*func\s+([A-Za-z_]\w*)", "function"),
        (r"^\s*type\s+([A-Za-z_]\w*)\s+struct", "struct"),
        (r"^\s*impl\s+([A-Za-z_]\w*)", "impl"),
    ]
    for pattern, chunk_type in patterns:
        match = re.match(pattern, line)
        if match:
            return chunk_type, match.group(1)
    return "code_block", None


# ── Chunking ────────────────────────────────────────────────────────────────


def _build_chunk_record(
    text: str,
    start_line: int,
    end_line: int,
    metadata: dict[str, Any],
) -> dict[str, object]:
    stripped = text.strip()
    content_type = metadata.get("content_type", "text")
    if content_type == "code":
        limit = CODE_CHUNK_MAX_CHARS
    elif content_type == "config":
        limit = CONFIG_CHUNK_MAX_CHARS
    else:
        limit = MAX_CHUNK_CHARS
    return {
        "text": stripped,
        "metadata": {
            **metadata,
            "start_line": start_line,
            "end_line": end_line,
            "chunk_chars": len(stripped),
            "chunk_limit": limit,
        },
    }


def chunk_markdown(text: str) -> list[str]:
    sections = re.split(r"(?=^## )", text, flags=re.MULTILINE)
    chunks: list[str] = []
    for section in sections:
        section = section.strip()
        if not section:
            continue
        if len(section) <= MAX_CHUNK_CHARS:
            chunks.append(section)
        else:
            parts = re.split(r"(?=^\d+\. \*\*)", section, flags=re.MULTILINE)
            current = ""
            for part in parts:
                if len(current) + len(part) > MAX_CHUNK_CHARS and current:
                    chunks.append(current.strip())
                    current = part
                else:
                    current += part
            if current.strip():
                chunks.append(current.strip())
    return chunks


def chunk_plain_text(text: str) -> list[str]:
    paragraphs = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        # Hard-split paragraphs that exceed the limit on their own
        if len(para) > MAX_CHUNK_CHARS:
            if current.strip():
                chunks.append(current.strip())
                current = ""
            for i in range(0, len(para), MAX_CHUNK_CHARS):
                chunks.append(para[i:i + MAX_CHUNK_CHARS])
            continue
        if len(current) + len(para) + 2 > MAX_CHUNK_CHARS and current:
            chunks.append(current.strip())
            current = para
        else:
            current = f"{current}\n\n{para}" if current else para
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _indent_level(line: str) -> int:
    """Return the indentation level (number of leading spaces, tabs=4)."""
    count = 0
    for ch in line:
        if ch == ' ':
            count += 1
        elif ch == '\t':
            count += 4
        else:
            break
    return count


def chunk_code_records(
    text: str,
    base_metadata: dict[str, Any],
) -> list[dict[str, object]]:
    """Scope-aware fallback code chunker.

    Improvements over naive line-count splitting:
    1. Tracks indentation to avoid splitting inside a block (function/class body)
    2. Prefers breaking at blank lines or dedent boundaries
    3. When forced to split oversized blocks, finds the nearest blank line
       to the midpoint rather than cutting at an arbitrary character offset
    """
    lines = text.splitlines()
    records: list[dict[str, object]] = []
    current_lines: list[str] = []
    start_line = 1
    current_type = "module_header"
    current_symbol: str | None = None

    def flush(end_line: int) -> None:
        nonlocal current_lines, start_line, current_type, current_symbol
        chunk_text = "\n".join(current_lines).strip()
        if not chunk_text:
            current_lines = []
            current_type = "code_block"
            current_symbol = None
            return

        if len(chunk_text) <= CODE_CHUNK_MAX_CHARS:
            records.append(
                _build_chunk_record(chunk_text, start_line, end_line, {
                    **base_metadata, "chunk_type": current_type, "symbol_name": current_symbol,
                })
            )
        else:
            _split_oversized_block(
                current_lines, start_line, current_type, current_symbol,
                base_metadata, records,
            )
        current_lines = []
        current_type = "code_block"
        current_symbol = None

    for index, line in enumerate(lines, start=1):
        chunk_type, symbol_name = detect_symbol_and_chunk_type(line)
        projected_text = "\n".join(current_lines + [line])

        is_new_symbol = bool(current_lines) and symbol_name is not None and _indent_level(line) == 0
        at_size_limit = (
            bool(current_lines)
            and len(projected_text) > CODE_CHUNK_MAX_CHARS
        )
        at_soft_limit = (
            bool(current_lines)
            and len(current_lines) >= CODE_CHUNK_MAX_LINES
            and (line.strip() == "" or _indent_level(line) == 0)
        )

        if is_new_symbol or at_size_limit or at_soft_limit:
            if at_size_limit and not is_new_symbol and len(current_lines) > 3:
                search_start = max(0, len(current_lines) - len(current_lines) // 3)
                best_break = None
                for j in range(len(current_lines) - 1, search_start - 1, -1):
                    if current_lines[j].strip() == "":
                        best_break = j
                        break
                if best_break is not None and best_break > 0:
                    keep = current_lines[:best_break]
                    remainder = current_lines[best_break:]
                    current_lines = keep
                    flush(start_line + len(keep) - 1)
                    start_line = start_line + len(keep)
                    current_lines = remainder
                    current_type = chunk_type if symbol_name else "code_block"
                    current_symbol = symbol_name
                    current_lines.append(line)
                    continue

            flush(index - 1)
            start_line = index
            current_type = chunk_type
            current_symbol = symbol_name
        elif not current_lines and symbol_name is not None:
            current_type = chunk_type
            current_symbol = symbol_name

        current_lines.append(line)

    if current_lines:
        flush(len(lines))

    return records


def _split_oversized_block(
    block_lines: list[str],
    block_start_line: int,
    chunk_type: str,
    symbol: str | None,
    base_metadata: dict[str, Any],
    records: list[dict[str, object]],
) -> None:
    """Split a block that exceeds CODE_CHUNK_MAX_CHARS into sub-chunks.

    Strategy:
    1. Find blank-line positions within the block
    2. Greedily accumulate lines until approaching the char limit
    3. Break at the nearest blank line before the limit
    4. If no blank lines exist, break at the nearest low-indent line
    5. Last resort: hard split at char boundary (minified code)
    """
    sub_lines: list[str] = []
    sub_start = block_start_line

    for line in block_lines:
        projected = "\n".join(sub_lines + [line])
        if len(projected) > CODE_CHUNK_MAX_CHARS and sub_lines:
            break_at = len(sub_lines)
            for j in range(len(sub_lines) - 1, max(0, len(sub_lines) // 2) - 1, -1):
                if sub_lines[j].strip() == "":
                    break_at = j
                    break
                if _indent_level(sub_lines[j]) == 0 and j > 0:
                    break_at = j
                    break

            emit = sub_lines[:break_at] if break_at < len(sub_lines) else sub_lines
            remainder = sub_lines[break_at:] if break_at < len(sub_lines) else []

            chunk_text = "\n".join(emit).strip()
            if chunk_text:
                end = sub_start + len(emit) - 1
                records.append(
                    _build_chunk_record(chunk_text, sub_start, end, {
                        **base_metadata, "chunk_type": chunk_type, "symbol_name": symbol,
                    })
                )
            sub_start = sub_start + len(emit)
            sub_lines = remainder + [line]
        else:
            sub_lines.append(line)

    if sub_lines:
        chunk_text = "\n".join(sub_lines).strip()
        if chunk_text:
            if len(chunk_text) > CODE_CHUNK_MAX_CHARS:
                for ci in range(0, len(chunk_text), CODE_CHUNK_MAX_CHARS):
                    fragment = chunk_text[ci:ci + CODE_CHUNK_MAX_CHARS]
                    records.append(
                        _build_chunk_record(fragment, sub_start, sub_start + len(sub_lines) - 1, {
                            **base_metadata, "chunk_type": chunk_type, "symbol_name": symbol,
                        })
                    )
            else:
                records.append(
                    _build_chunk_record(chunk_text, sub_start, sub_start + len(sub_lines) - 1, {
                        **base_metadata, "chunk_type": chunk_type, "symbol_name": symbol,
                    })
                )


def chunk_config_records(
    text: str,
    base_metadata: dict[str, Any],
) -> list[dict[str, object]]:
    lines = text.splitlines()
    records: list[dict[str, object]] = []
    current_lines: list[str] = []
    start_line = 1

    def flush(end_line: int) -> None:
        nonlocal current_lines, start_line
        chunk_text = "\n".join(current_lines).strip()
        if not chunk_text:
            current_lines = []
            return
        # Hard-split if the accumulated chunk exceeds the limit
        if len(chunk_text) > CONFIG_CHUNK_MAX_CHARS:
            for i in range(0, len(chunk_text), CONFIG_CHUNK_MAX_CHARS):
                records.append(
                    _build_chunk_record(chunk_text[i:i + CONFIG_CHUNK_MAX_CHARS], start_line, end_line, {
                        **base_metadata, "chunk_type": "config_block", "symbol_name": None,
                    })
                )
        else:
            records.append(
                _build_chunk_record(chunk_text, start_line, end_line, {
                    **base_metadata, "chunk_type": "config_block", "symbol_name": None,
                })
            )
        current_lines = []

    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        is_section = bool(re.match(r"^\[.*\]$", stripped)) or bool(re.match(r"^[A-Za-z0-9_.-]+\s*:\s*$", stripped))
        projected = "\n".join(current_lines + [line])

        if current_lines and (
            stripped == "" or is_section
            or len(current_lines) >= CONFIG_CHUNK_MAX_LINES
            or len(projected) > CONFIG_CHUNK_MAX_CHARS
        ):
            flush(index - 1)
            start_line = index
            if stripped == "":
                continue

        current_lines.append(line)

    if current_lines:
        flush(len(lines))

    return records


def paragraph_records(
    text: str,
    base_metadata: dict[str, Any],
    chunk_type: str,
) -> list[dict[str, object]]:
    # Pre-expand any single line longer than MAX_CHUNK_CHARS into multiple lines
    raw_lines = text.splitlines()
    lines: list[str] = []
    for raw in raw_lines:
        if len(raw) > MAX_CHUNK_CHARS:
            for i in range(0, len(raw), MAX_CHUNK_CHARS):
                lines.append(raw[i:i + MAX_CHUNK_CHARS])
        else:
            lines.append(raw)
    records: list[dict[str, object]] = []
    current_lines: list[str] = []
    current_chars = 0
    chunk_start = 1
    pending_blank = False

    def flush(end_line: int) -> None:
        nonlocal current_lines, current_chars, chunk_start, pending_blank
        chunk_text = "\n".join(current_lines).strip()
        if chunk_text:
            records.append(
                _build_chunk_record(chunk_text, chunk_start, end_line, {
                    **base_metadata, "chunk_type": chunk_type, "symbol_name": None,
                })
            )
        current_lines = []
        current_chars = 0
        pending_blank = False

    for index, line in enumerate(lines, start=1):
        is_blank = line.strip() == ""
        is_section = line.startswith("## ")

        if is_blank:
            pending_blank = True
            continue

        if is_section and current_lines:
            flush(index - 1)
            chunk_start = index

        addition = (2 + len(line)) if current_lines else len(line)

        if current_lines and current_chars + addition > MAX_CHUNK_CHARS:
            flush(index - 1)
            chunk_start = index

        if not current_lines:
            chunk_start = index

        if pending_blank and current_lines:
            current_lines.append("")
            current_chars += 1

        current_lines.append(line)
        current_chars += len(line) + 1
        pending_blank = False

    if current_lines:
        flush(len(lines))

    return records


def _apply_headers(
    records: list[dict[str, object]],
    filepath: str,
    base_metadata: dict[str, Any],
) -> list[dict[str, object]]:
    """Apply context headers to chunk records using three-text representation.

    Transforms each record from {"text": str, "metadata": dict} shape
    to {"semantic_content": str, "lexical_content": str, "display_content": str, "metadata": dict}.
    """
    language = base_metadata.get("language")
    transformed: list[dict[str, object]] = []
    for record in records:
        raw_meta = record.get("metadata")
        meta: dict[str, object] = dict(cast("dict[str, object]", raw_meta)) if raw_meta else {}
        symbol: str | None = str(meta.get("symbol_name")) if meta.get("symbol_name") else None

        # Build all text representations
        reps = build_chunk_representations(
            chunk_text=str(record.get("text", "")),
            doc_path=filepath,
            symbol=symbol,
            language=language if isinstance(language, str) else None,
        )

        # Update chunk_chars to reflect raw (headerless) length
        meta["chunk_chars"] = len(reps["raw"])

        transformed.append({
            "semantic_content": reps["semantic"],
            "lexical_content": reps["lexical"],
            "display_content": reps["display"],
            "metadata": meta,
        })
    return transformed


def build_chunk_records(
    path: str,
    source: str,
    repo_root: str,
    project_id: str,
    content_hash: str | None = None,
) -> list[dict[str, object]]:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        text = text.replace("\x00", "")
    except (OSError, IOError) as e:
        safe_print(f"  {YELLOW}⚠ Skipping unreadable file {path}: {e}{RESET}")
        return []
    if not text.strip():
        return []

    extension = os.path.splitext(path)[1].lstrip(".").lower()
    content_type = detect_content_type(path)
    base_metadata = {
        "repo_root": repo_root,
        "project_id": project_id,
        "source": source,
        "doc_path": source,
        "language": detect_language(path),
        "extension": extension,
        "content_type": content_type,
    }
    if content_hash is not None:
        base_metadata["content_hash"] = content_hash

    if content_type == "code":
        if _AST_CHUNKER_AVAILABLE:
            ast_language = _AST_EXT_REMAP.get(extension, base_metadata.get("language", ""))
            ast_chunks = chunk_file_ast(
                source=text,
                language=ast_language,
                max_chars=CODE_CHUNK_MAX_CHARS,
                filepath=path,
            )
            if ast_chunks is not None:
                records: list[dict[str, object]] = []
                for c in ast_chunks:
                    reps = build_chunk_representations(
                        chunk_text=c.text,
                        doc_path=source,
                        symbol=c.symbol,
                        language=ast_language,
                    )
                    records.append({
                        "semantic_content": reps["semantic"],
                        "lexical_content": reps["lexical"],
                        "display_content": reps["display"],
                        "metadata": {
                            **base_metadata,
                            "chunk_type": c.chunk_type,
                            "symbol_name": c.symbol,
                            "start_line": c.start_line,
                            "end_line": c.end_line,
                            "chunk_chars": len(reps["raw"]),
                            "chunk_limit": CODE_CHUNK_MAX_CHARS,
                        },
                    })
                return records
        # Line-based code fallback
        records = chunk_code_records(text, base_metadata)
        return _apply_headers(records, source, base_metadata)

    if content_type == "config":
        if _AST_CHUNKER_AVAILABLE:
            ast_language = _AST_EXT_REMAP.get(extension, "")
            if ast_language:
                ast_chunks = chunk_file_ast(
                    source=text,
                    language=ast_language,
                    max_chars=MAX_CHUNK_CHARS,
                    filepath=path,
                )
                if ast_chunks is not None:
                    records = []
                    for c in ast_chunks:
                        reps = build_chunk_representations(
                            chunk_text=c.text,
                            doc_path=source,
                            symbol=c.symbol,
                            language=ast_language,
                        )
                        records.append({
                            "semantic_content": reps["semantic"],
                            "lexical_content": reps["lexical"],
                            "display_content": reps["display"],
                            "metadata": {
                                **base_metadata,
                                "chunk_type": c.chunk_type,
                                "symbol_name": c.symbol,
                                "start_line": c.start_line,
                                "end_line": c.end_line,
                                "chunk_chars": len(reps["raw"]),
                                "chunk_limit": CONFIG_CHUNK_MAX_CHARS,
                            },
                        })
                    return records
        records = chunk_config_records(text, base_metadata)
        return _apply_headers(records, source, base_metadata)

    if content_type == "markdown":
        if _AST_CHUNKER_AVAILABLE:
            ast_chunks = chunk_file_ast(
                source=text,
                language="markdown",
                max_chars=MAX_CHUNK_CHARS,
                filepath=path,
            )
            if ast_chunks is not None:
                records = []
                for c in ast_chunks:
                    reps = build_chunk_representations(
                        chunk_text=c.text,
                        doc_path=source,
                        symbol=c.symbol,
                        language="markdown",
                    )
                    records.append({
                        "semantic_content": reps["semantic"],
                        "lexical_content": reps["lexical"],
                        "display_content": reps["display"],
                        "metadata": {
                            **base_metadata,
                            "chunk_type": c.chunk_type,
                            "symbol_name": c.symbol,
                            "start_line": c.start_line,
                            "end_line": c.end_line,
                            "chunk_chars": len(reps["raw"]),
                            "chunk_limit": MAX_CHUNK_CHARS,
                        },
                    })
                return records
        records = paragraph_records(text, base_metadata, "markdown_section")
        return _apply_headers(records, source, base_metadata)

    # text / CSS / other: try AST first if extension is in remap
    if _AST_CHUNKER_AVAILABLE:
        ast_language = _AST_EXT_REMAP.get(extension, "")
        if ast_language:
            ast_chunks = chunk_file_ast(
                source=text,
                language=ast_language,
                max_chars=MAX_CHUNK_CHARS,
                filepath=path,
            )
            if ast_chunks is not None:
                records = []
                for c in ast_chunks:
                    reps = build_chunk_representations(
                        chunk_text=c.text,
                        doc_path=source,
                        symbol=c.symbol,
                        language=ast_language,
                    )
                    records.append({
                        "semantic_content": reps["semantic"],
                        "lexical_content": reps["lexical"],
                        "display_content": reps["display"],
                        "metadata": {
                            **base_metadata,
                            "chunk_type": c.chunk_type,
                            "symbol_name": c.symbol,
                            "start_line": c.start_line,
                            "end_line": c.end_line,
                            "chunk_chars": len(reps["raw"]),
                            "chunk_limit": MAX_CHUNK_CHARS,
                        },
                    })
                return records
    records = paragraph_records(text, base_metadata, "text_paragraph")
    return _apply_headers(records, source, base_metadata)


# ── File collection ─────────────────────────────────────────────────────────


SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", ".env",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "dist", "build", ".next", ".nuxt", ".output",
    "vendor", "target", ".gradle", ".idea", ".vscode",
    ".svn", ".hg", "coverage", ".turbo", ".cache",
    "bower_components", ".eggs",
    ".copilot", ".obsidian", ".infio_json_db", "_infio_prompts", "copilot",
    ".claude", ".chroma_db", ".hive",
    "codex",
}

SKIP_FILES = {
    "litellm-config.yaml", "vertex-sa-key.json",
    ".claude.json", ".claude.json.new_backup",
    ".boto", ".bashrc", ".bash_logout", ".bash_history",
    ".aiderignore", ".aider.model.settings.yml", ".aider.model.metadata.json",
    ".aider.input.history", ".aider.conf.yml", ".aider.chat.history.md",
    "workspace.json", "package-lock.json", "cacert.pem",
    ".wget-hsts", ".wezterm.lua", ".python_history", ".profile",
    ".pcr-stats.json", ".nvidia-settings-rc", ".npmrc", ".node_repl_history",
    ".litellm-poller.conf", ".gitconfig", ".ragconfig",
    ".env",
    "AnythingLLMDesktop.AppImage",
    "ptyxis-dconf-backup-20260310-180850.ini",
    "tree-sitter-sql-0.1.0.tgz",
    "Link to environment.d",
    # Lockfiles — no semantic search value
    "pnpm-lock.yaml", "yarn.lock", "Gemfile.lock",
    "poetry.lock", "composer.lock", "Cargo.lock", "go.sum",
    # Known build artifacts / minified bundles
    "main.js", "main.min.js",
    "swagger-ui-bundle.js", "swagger-ui-bundle.min.js",
    "pyodide.asm.js",
}


def collect_files(path: str, extensions: set[str]) -> list[str]:
    if os.path.isfile(path):
        return [path]
    files: list[str] = []
    CRITICAL_FILES = {
        "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
        "package.json", "pyproject.toml", "requirements.txt",
        ".env.example", "Makefile", "justfile",
    }
    for root, dirs, names in os.walk(path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.endswith(".egg-info")]
        for name in sorted(names):
            if name not in CRITICAL_FILES and name in SKIP_FILES:
                continue
            fp = os.path.join(root, name)
            if MAX_FILE_BYTES > 0 and os.path.getsize(fp) > MAX_FILE_BYTES:
                continue
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if ext in extensions:
                files.append(fp)
    return sorted(files)


# ── Batch processing ────────────────────────────────────────────────────────


def _process_batch(
    batch_chunks: Sequence[dict[str, object] | str],
    batch_indices: list[int],
    total: int,
    fname: str,
    store_id: str,
) -> list[tuple[int, bool, str]]:
    """Process a batch with three-text representation.

    Embeds the semantic text but stores the lexical text in the database
    for BMX/BM25 retrieval.
    """
    results: list[tuple[int, bool, str]] = []
    try:
        if _rate_limiter.is_aborted():
            for idx in batch_indices:
                results.append((idx, False, "aborted"))
            return results
        chunk_records: list[dict[str, object]] = []
        for chunk in batch_chunks:
            if isinstance(chunk, dict):
                chunk_records.append(chunk)
            else:
                chunk_records.append({"text": chunk, "metadata": {}})

        # Extract semantic text for embedding generation (headerless)
        texts_for_embedding: list[str] = [
            str(chunk.get("semantic_content", chunk.get("text", "")))
            for chunk in chunk_records
        ]
        embeddings = get_embeddings_batch(texts_for_embedding)
        if len(embeddings) != len(chunk_records):
            raise ValueError(
                f"embedding count mismatch: expected {len(chunk_records)}, got {len(embeddings)}"
            )
        items: list[dict[str, object]] = []
        for chunk_record, emb, idx in zip(chunk_records, embeddings, batch_indices):
            meta: dict[str, object] = dict(cast("dict[str, object]", chunk_record.get("metadata") or {}))

            # Set up metadata for storage
            meta.setdefault("source", fname)
            meta.setdefault("doc_path", fname)
            meta["chunk"] = idx + 1
            meta["total_chunks"] = total
            meta.setdefault("chunk_chars", len(str(chunk_record.get("semantic_content", chunk_record.get("text", "")))))
            meta["embedding_model"] = EMBEDDING_MODEL

            items.append({
                "content": str(chunk_record.get("display_content", chunk_record.get("text", ""))),
                "semantic_content": str(chunk_record.get("semantic_content", "")),
                "lexical_content": str(chunk_record.get("lexical_content", "")),
                "embedding": emb,
                "metadata": meta,
            })
        add_embeddings_batch(items, store_id)
        for idx in batch_indices:
            results.append((idx, True, ""))
    except RateLimitAbort:
        for idx in batch_indices:
            if not any(r[0] == idx for r in results):
                results.append((idx, False, "aborted"))
    except Exception as e:
        for idx in batch_indices:
            if not any(r[0] == idx for r in results):
                results.append((idx, False, str(e)))
    return results


# ── Progress tracker ────────────────────────────────────────────────────────


class ProgressTracker:
    """Thread-safe progress tracking for the upload pipeline."""

    def __init__(self, total_files: int, total_chunks_estimate: int = 0) -> None:
        self._lock = threading.Lock()
        self.total_files = total_files
        self.total_chunks_estimate = total_chunks_estimate
        self.files_done = 0
        self.files_ok = 0
        self.files_failed = 0
        self.files_skipped = 0
        self.chunks_ok = 0
        self.chunks_failed = 0
        self.chunks_total = 0
        self.failed_files: list[tuple[str, int, int, list[str]]] = []
        self.bytes_processed = 0
        self._start_time = time.monotonic()

    def record_file(
        self,
        rel_path: str,
        ok_chunks: int,
        total_chunks: int,
        errors: list[str],
        file_bytes: int = 0,
    ) -> None:
        with self._lock:
            self.files_done += 1
            self.chunks_ok += ok_chunks
            self.chunks_total += total_chunks
            self.chunks_failed += (total_chunks - ok_chunks)
            self.bytes_processed += file_bytes
            if errors:
                self.files_failed += 1
                self.failed_files.append((rel_path, ok_chunks, total_chunks, errors))
            elif total_chunks == 0:
                self.files_skipped += 1
            else:
                self.files_ok += 1

    def elapsed(self) -> float:
        return time.monotonic() - self._start_time

    def rate(self) -> float:
        """Chunks per second."""
        e = self.elapsed()
        return self.chunks_ok / e if e > 0 else 0

    def eta(self) -> float | None:
        """Estimated seconds remaining."""
        if self.files_done == 0:
            return None
        rate = self.files_done / self.elapsed()
        remaining = self.total_files - self.files_done
        return remaining / rate if rate > 0 else None

    def summary_line(self) -> str:
        """One-line progress summary."""
        with self._lock:
            eta = self.eta()
            eta_str = f"  ETA {_duration_fmt(eta)}" if eta and eta > 0 else ""
            return (
                f"  {_progress_bar(self.files_done, self.total_files)}"
                f"  {GREEN}{self.chunks_ok}{RESET} chunks"
                f"  {_duration_fmt(self.elapsed())}{eta_str}"
            )


# ── Ingest single file ─────────────────────────────────────────────────────


def ingest_file(
    path: str,
    store_id: str,
    batch_size: int,
    display_name: str | None = None,
    repo_root: str | None = None,
    project_id: str | None = None,
    content_hash: str | None = None,
    verbosity: str = "normal",
) -> tuple[int, int, list[str]]:
    """Ingest one file. Returns (ok_chunks, total_chunks, errors)."""
    if display_name:
        fname = display_name
    elif repo_root:
        fname = os.path.relpath(path, repo_root)
    else:
        fname = os.path.basename(path)
    quiet = verbosity == "json"
    compact = verbosity == "compact"

    try:
        if content_hash is None:
            content_hash = file_sha256(path)
        chunks = build_chunk_records(
            path, fname, repo_root or os.path.dirname(path),
            project_id or os.path.basename(os.path.dirname(path)),
            content_hash=content_hash,
        )
    except Exception as exc:
        err_msg = f"{type(exc).__name__}: {exc}"
        if not quiet:
            safe_print(f"    {_status_icon('fail')} failed to read/chunk — {DIM}{err_msg}{RESET}")
        return 0, 0, [err_msg]

    if not chunks:
        if not quiet and not compact:
            safe_print(f"    {DIM}(empty, skipped){RESET}")
        return 0, 0, []

    # Split into batches
    batches: list[tuple[list[dict[str, object]], list[int]]] = []
    for i in range(0, len(chunks), batch_size):
        bc = chunks[i:i + batch_size]
        bi = list(range(i, i + len(bc)))
        batches.append((bc, bi))

    if not quiet and not compact:
        content_type = detect_content_type(path)
        language = detect_language(path)
        badge = _type_badge(content_type, language)
        safe_print(f"    {badge} {len(chunks)} chunks → {len(batches)} batch(es)")

    ok = 0
    errors = []

    if len(batches) == 1:
        for idx, success, err in _process_batch(batches[0][0], batches[0][1], len(chunks), fname, store_id):
            if success:
                ok += 1
                if not quiet and not compact:
                    safe_print(f"    {_status_icon('ok')} chunk {idx + 1}/{len(chunks)} ({len(str(chunks[idx]['text']))} chars)")
            elif err == "aborted":
                errors.append(err)
                if not quiet:
                    safe_print(f"    {_status_icon('abort')} chunk {idx + 1}/{len(chunks)} — skipped (aborted)")
            else:
                errors.append(err)
                if not quiet:
                    safe_print(f"    {_status_icon('fail')} chunk {idx + 1}/{len(chunks)} — {DIM}{err}{RESET}")
    else:
        with ThreadPoolExecutor(max_workers=min(len(batches), MAX_WORKERS_FILE)) as pool:
            futures = {
                pool.submit(_process_batch, bc, bi, len(chunks), fname, store_id): bi
                for bc, bi in batches
            }
            for future in as_completed(futures):
                for idx, success, err in future.result():
                    if success:
                        ok += 1
                        if not quiet and not compact:
                            safe_print(f"    {_status_icon('ok')} chunk {idx + 1}/{len(chunks)} ({len(str(chunks[idx]['text']))} chars)")
                    elif err == "aborted":
                        errors.append(err)
                        if not quiet:
                            safe_print(f"    {_status_icon('abort')} chunk {idx + 1}/{len(chunks)} — skipped (aborted)")
                    else:
                        errors.append(err)
                        if not quiet:
                            safe_print(f"    {_status_icon('fail')} chunk {idx + 1}/{len(chunks)} — {DIM}{err}{RESET}")

    return ok, len(chunks), errors


# ── Display: header ─────────────────────────────────────────────────────────


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


def _print_sync_plan(
    to_ingest: list[tuple[str, str, str, str]],
    n_new: int,
    n_updated: int,
    n_unchanged: int,
    stale_docs: list[str],
    n_incomplete: int = 0,
) -> None:
    """Print a detailed sync plan."""
    print(f"  {BOLD}Sync Plan{RESET}")
    print(f"  {DIM}{'─' * 50}{RESET}")
    print(f"    {_status_icon('new')} {GREEN}{n_new}{RESET} new files")
    print(f"    {_status_icon('updated')} {YELLOW}{n_updated}{RESET} updated files")
    if n_incomplete > 0:
        print(f"    {_status_icon('incomplete')} {YELLOW}{n_incomplete}{RESET} incomplete (interrupted uploads)")
    print(f"    {_status_icon('unchanged')} {DIM}{n_unchanged}{RESET} unchanged (skipped)")
    print(f"    {_status_icon('stale')} {RED}{len(stale_docs)}{RESET} stale (will delete)")
    print(f"  {DIM}{'─' * 50}{RESET}")

    # Show details for actions
    if to_ingest:
        print()
        shown = 0
        for fp, rel, h, action in to_ingest[:20]:
            icon = _status_icon('new') if action == "new" else _status_icon('updated')
            ct = detect_content_type(fp)
            badge = _type_badge(ct, detect_language(fp))
            sz = _size_fmt(file_size(fp))
            print(f"    {icon} {badge} {CYAN}{_truncate_path(rel, 50)}{RESET}  {DIM}{sz}{RESET}")
            shown += 1
        if len(to_ingest) > 20:
            print(f"    {DIM}… and {len(to_ingest) - 20} more files{RESET}")

    if stale_docs:
        print()
        for doc in stale_docs[:10]:
            print(f"    {_status_icon('stale')} {DIM}{_truncate_path(doc, 50)}{RESET}")
        if len(stale_docs) > 10:
            print(f"    {DIM}… and {len(stale_docs) - 10} more stale docs{RESET}")

    print()

    # Total estimate
    total_action = len(to_ingest) + len(stale_docs)
    if total_action == 0:
        print(f"  {GREEN}{BOLD}✓ Nothing to do — all files up to date.{RESET}")
    else:
        print(f"  {BOLD}{len(to_ingest)}{RESET} files to embed, "
              f"{BOLD}{len(stale_docs)}{RESET} to delete")
    print()


# ── Display: store status ──────────────────────────────────────────────────


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


def _print_failure_report(
    failed_files: list[tuple[str, int, int, list[str]]],
) -> None:
    """Print a formatted summary of files that had upload errors."""
    total_failed = sum(1 for f in failed_files if f[1] == 0)
    partial_failed = sum(1 for f in failed_files if 0 < f[1] < f[2])

    print(f"  {RED}{BOLD}⚠ Upload Errors ({len(failed_files)} file{'s' if len(failed_files) != 1 else ''}){RESET}")
    print(f"  {DIM}{'─' * 50}{RESET}")

    if total_failed:
        print(f"    {RED}✗ {total_failed} completely failed{RESET}")
    if partial_failed:
        print(f"    {YELLOW}◐ {partial_failed} partially uploaded{RESET}")
    print()

    dirs_seen: dict[str, int] = {}
    for fpath, ok, total, errs in failed_files:
        if ok == 0:
            status = f"{RED}✗ 0/{total}{RESET}"
        else:
            status = f"{YELLOW}◐ {ok}/{total}{RESET}"

        ct = detect_content_type(fpath)
        badge = _type_badge(ct, detect_language(fpath))
        print(f"    {status}  {badge} {CYAN}{fpath}{RESET}")

        unique_errs = sorted(set(e for e in errs if e != "aborted"))
        for e in unique_errs[:3]:
            print(f"           {DIM}{e}{RESET}")
        if len(unique_errs) > 3:
            print(f"           {DIM}… and {len(unique_errs) - 3} more error(s){RESET}")

        d = os.path.dirname(fpath)
        if d:
            dirs_seen[d] = dirs_seen.get(d, 0) + 1

    if dirs_seen:
        print()
        print(f"    {BOLD}Directories with failures:{RESET}")
        for d, count in sorted(dirs_seen.items(), key=lambda x: -x[1]):
            print(f"      {DIM}{d}/{RESET} ({count} file{'s' if count != 1 else ''})")

    print()

    # Retry hint
    print(f"  {DIM}Tip: re-run with --sync to retry only failed/missing files{RESET}")
    print(f"  {DIM}     or --sync --force to re-upload everything{RESET}")
    print()


# ── Display: stats ──────────────────────────────────────────────────────────


def _print_upload_stats(files: list[str], repo_root: str) -> int:
    """Print pre-upload stats: chunk estimates, size distribution, etc."""
    print(f"  {BOLD}Pre-Upload Analysis{RESET}")
    print(f"  {DIM}{'─' * 50}{RESET}")

    total_chunks = 0
    total_bytes = 0
    file_stats: list[tuple[str, str, int, int]] = []
    type_chunks: dict[str, int] = defaultdict(int)

    for fp in files:
        rel = os.path.relpath(fp, repo_root)
        ct = detect_content_type(fp)
        sz = file_size(fp)
        total_bytes += sz

        # Quick chunk estimate (actually build them for accuracy)
        try:
            chunks = build_chunk_records(
                fp, rel, repo_root,
                os.path.basename(repo_root.rstrip(os.sep)),
            )
            n = len(chunks)
        except Exception:
            n = 0

        total_chunks += n
        type_chunks[ct] += n
        file_stats.append((rel, ct, sz, n))

    print(f"    Total files:  {BOLD}{len(files)}{RESET}")
    print(f"    Total size:   {BOLD}{_size_fmt(total_bytes)}{RESET}")
    print(f"    Total chunks: {BOLD}{total_chunks}{RESET} (estimated)")
    print()

    # Chunks per type
    print(f"    {BOLD}Chunks by Type:{RESET}")
    for ct, count in sorted(type_chunks.items(), key=lambda x: -x[1]):
        badge = _type_badge(ct, "")
        bar_len = int(count / max(total_chunks, 1) * 25)
        print(f"      {badge} {count:>5}  {'█' * bar_len}")

    # Size distribution histogram
    sizes = [s[2] for s in file_stats if s[2] > 0]
    if sizes:
        print()
        print(f"    {BOLD}File Size Distribution:{RESET}")
        buckets = [
            ("< 1KB", 0, 1024),
            ("1-10KB", 1024, 10240),
            ("10-100KB", 10240, 102400),
            ("100KB-1MB", 102400, 1048576),
            ("> 1MB", 1048576, float("inf")),
        ]
        for label, lo, hi in buckets:
            count = sum(1 for s in sizes if lo <= s < hi)
            if count > 0:
                bar_len = int(count / len(sizes) * 25)
                print(f"      {DIM}{label:>10}{RESET} {count:>4}  {'█' * bar_len}")

    # Estimated time
    if total_chunks > 0:
        # Rough estimate: ~2 chunks/sec sustained
        est_secs = total_chunks / 2
        print()
        print(f"    {DIM}Estimated time: ~{_duration_fmt(est_secs)} "
              f"(at ~2 chunks/sec sustained){RESET}")

    # Top files by chunk count
    top = sorted(file_stats, key=lambda x: -x[3])[:10]
    if top and top[0][3] > 0:
        print()
        print(f"    {BOLD}Largest Files (by chunks):{RESET}")
        for rel, ct, sz, n in top:
            if n == 0:
                break
            badge = _type_badge(ct, "")
            print(f"      {badge} {n:>4} chunks  {_size_fmt(sz):>8}  {CYAN}{_truncate_path(rel, 40)}{RESET}")

    print()
    return total_chunks


# ── Timer thread ────────────────────────────────────────────────────────────


def _start_timer_thread(
    tracker: ProgressTracker,
    stop_event: threading.Event,
) -> threading.Thread:
    """Background thread for elapsed time, ETA, and rate-limit pause display."""
    def _timer_loop() -> None:
        last_progress_print = -15
        while not stop_event.wait(1):
            now = time.monotonic()
            elapsed = tracker.elapsed()

            pause_until = _rate_limiter._pause_until
            pause_label = _rate_limiter._pause_label
            if pause_until > now:
                remaining = int(pause_until - now) + 1
                bar = "═" * min(remaining, 40)
                with _print_lock:
                    sys.stdout.write(
                        f"\r  {YELLOW}{BOLD}{pause_label}: {remaining:>3}s  {bar}{RESET}   "
                    )
                    sys.stdout.flush()
            elif int(elapsed) - last_progress_print >= 15:
                last_progress_print = int(elapsed)
                safe_print(tracker.summary_line())

    t = threading.Thread(target=_timer_loop, daemon=True)
    t.start()
    return t


# ── Sync logic ──────────────────────────────────────────────────────────────


def _compute_sync_plan(
    files: list[str],
    repo_root: str,
    project_id: str,
    store_id: str,
    force: bool = False,
) -> tuple[
    list[tuple[str, str, str, str]],
    list[str],
    int,
    int,
    int,
    int,
]:
    """Compare local files against store. Returns (to_ingest, stale_docs, counters).

    to_ingest: list of (abs_path, rel_path, hash, action)
    stale_docs: list of doc_paths to delete
    """
    existing = get_store_sources(store_id, project_id)

    local_by_docpath = {}
    for fp in files:
        rel = os.path.relpath(fp, repo_root)
        local_by_docpath[rel] = fp

    to_ingest = []
    n_new = n_updated = n_unchanged = n_incomplete = 0

    for rel, fp in local_by_docpath.items():
        h = file_sha256(fp)
        info = existing.get(rel)

        if info is None:
            n_new += 1
            to_ingest.append((fp, rel, h, "new"))
        elif info["content_hash"] != h or force:
            n_updated += 1
            action = "forced" if info["content_hash"] == h else "updated"
            to_ingest.append((fp, rel, h, action))
        else:
            # Hash matches — check for oversized chunks from old config/bug
            ext = os.path.splitext(rel)[1].lstrip(".").lower()
            if ext in CODE_EXTENSIONS or ext in CONFIG_EXTENSIONS:
                current_limit = CODE_CHUNK_MAX_CHARS if ext in CODE_EXTENSIONS else CONFIG_CHUNK_MAX_CHARS
            else:
                current_limit = MAX_CHUNK_CHARS
            stored_max: int | None = info.get("max_chunk_chars")  # type: ignore[assignment]
            if stored_max is not None and stored_max > current_limit:
                n_updated += 1
                to_ingest.append((fp, rel, h, "oversized"))
                continue

            # Verify chunk count hasn't drifted
            expected = len(build_chunk_records(
                fp, rel, repo_root,
                project_id or os.path.basename(repo_root.rstrip(os.sep)),
                content_hash=h,
            ))
            stored: int | None = info.get("chunk_count")  # type: ignore[assignment]
            if stored is not None and expected > 0 and stored < expected:
                n_incomplete += 1
                n_updated += 1
                to_ingest.append((fp, rel, h, "incomplete"))
            else:
                n_unchanged += 1

    stale_docs = [dp for dp in existing if dp not in local_by_docpath]

    return to_ingest, stale_docs, n_new, n_updated, n_unchanged, n_incomplete


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Upload files to the pgvector store",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  pgvector-upload /path/to/project                    # upload all matching files
  pgvector-upload /path/to/project --sync             # incremental sync
  pgvector-upload /path/to/project --sync --dry-run   # preview changes
  pgvector-upload /path/to/project --sync --force     # force re-upload all
  pgvector-upload /path/to/project --status           # show store contents
  pgvector-upload /path/to/project --stats            # pre-upload analysis
  pgvector-upload /path/to/project --compact          # minimal output
  pgvector-upload /path/to/project --confirm          # confirm before starting
  pgvector-upload /path/to/project --export plan.json # export sync plan
        """,
    )
    parser.add_argument("path", help="File or directory to ingest")
    parser.add_argument("--store", default=DEFAULT_STORE_ID, help="Vector store ID")
    parser.add_argument("--ext", default=",".join(DEFAULT_EXTENSIONS),
                        help="File extensions to include (default: md,txt,rst,org)")
    parser.add_argument("--batch", type=int, default=EMBED_BATCH_SIZE,
                        help=f"Chunks per embedding API call (default: {EMBED_BATCH_SIZE})")
    parser.add_argument(
        "--sync", action="store_true",
        help="Incremental sync: skip unchanged files, re-embed changed, delete stale",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Force re-upload all files even if hash matches",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be done without actually uploading (implies --sync)",
    )
    parser.add_argument(
        "--status", action="store_true",
        help="Show current store contents and exit",
    )
    parser.add_argument(
        "--stats", action="store_true",
        help="Show pre-upload analysis (chunk estimates, size distribution)",
    )
    parser.add_argument(
        "--confirm", action="store_true",
        help="Ask for confirmation before starting the upload",
    )
    parser.add_argument(
        "--compact", action="store_true",
        help="Minimal output (one line per file)",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Maximum detail (show every chunk)",
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output machine-readable JSON summary",
    )
    parser.add_argument(
        "--export", default=None,
        help="Export sync plan or results to JSON file",
    )
    args = parser.parse_args()

    if args.dry_run:
        args.sync = True

    # Determine verbosity
    if args.json:
        verbosity = "json"
    elif args.compact:
        verbosity = "compact"
    elif args.verbose:
        verbosity = "verbose"
    else:
        verbosity = "normal"

    batch_size = args.batch
    is_dir = os.path.isdir(args.path)
    registry = load_project_registry(RAGCONFIG_PATH)
    manifest = registry.find_project(args.path)
    repo_root = manifest.project_root if manifest else find_repo_root(args.path)
    project_id = manifest.project_id if manifest else os.path.basename(repo_root.rstrip(os.sep))
    extensions = {e.strip().lower() for e in args.ext.split(",")}

    if manifest:
        exclude_names = set(manifest.exclude or [])
        discovered_files = collect_files(repo_root, extensions)
        files = sorted(
            fp for fp in discovered_files
            if not any(part in exclude_names for part in Path(fp).parts)
        )
    else:
        files = collect_files(args.path, extensions)

    if not files:
        if not args.json:
            print(f"\n  {YELLOW}No matching files found.{RESET}")
            print(f"  {DIM}Extensions: {', '.join(sorted(extensions))}{RESET}")
            print(f"  {DIM}Path: {os.path.abspath(args.path)}{RESET}")
            print()
        else:
            print(json.dumps({"error": "no matching files found", "files": 0}))
        sys.exit(1)

    # ── Status mode ─────────────────────────────────────────────────────
    if args.status:
        _print_store_status(args.store, project_id, files, repo_root)
        return

    # ── Header ──────────────────────────────────────────────────────────
    if verbosity != "json":
        _print_header(args, files, extensions, repo_root, project_id, manifest)

    # ── File breakdown ──────────────────────────────────────────────────
    if verbosity not in ("json", "compact"):
        _print_file_breakdown(files, repo_root)

    # ── Stats mode ──────────────────────────────────────────────────────
    total_chunks_estimate = 0
    if args.stats:
        total_chunks_estimate = _print_upload_stats(files, repo_root)
        if not args.sync and not args.dry_run:
            # stats-only mode: just show analysis and exit
            if not args.confirm:
                return

    # ── Sync plan ───────────────────────────────────────────────────────
    n_unchanged = n_updated = n_new = n_deleted = n_incomplete = 0

    if args.sync:
        if verbosity != "json":
            safe_print(f"  {DIM}Comparing against store…{RESET}")

        to_ingest, stale_docs, n_new, n_updated, n_unchanged, n_incomplete = \
            _compute_sync_plan(files, repo_root, project_id, args.store, args.force)

        if verbosity != "json":
            _print_sync_plan(to_ingest, n_new, n_updated, n_unchanged, stale_docs, n_incomplete)

        # Export sync plan
        if args.export:
            plan = {
                "mode": "sync",
                "dry_run": args.dry_run,
                "store_id": args.store,
                "project_id": project_id,
                "new": n_new,
                "updated": n_updated,
                "incomplete": n_incomplete,
                "unchanged": n_unchanged,
                "stale": len(stale_docs),
                "to_ingest": [
                    {"path": rel, "action": action, "hash": h, "size": file_size(fp)}
                    for fp, rel, h, action in to_ingest
                ],
                "to_delete": stale_docs,
            }
            with open(args.export, "w", encoding="utf-8") as f:
                json.dump(plan, f, indent=2)
            if verbosity != "json":
                safe_print(f"  {GREEN}Exported sync plan to {args.export}{RESET}")

        # Dry run: stop here
        if args.dry_run:
            if verbosity == "json":
                print(json.dumps({
                    "dry_run": True,
                    "new": n_new,
                    "updated": n_updated,
                    "incomplete": n_incomplete,
                    "unchanged": n_unchanged,
                    "stale": len(stale_docs),
                    "files_to_process": len(to_ingest),
                }))
            return

        if not to_ingest and not stale_docs:
            if verbosity == "json":
                print(json.dumps({
                    "unchanged": n_unchanged, "updated": 0, "new": 0,
                    "deleted": 0, "chunks_added": 0, "chunks_failed": 0,
                }))
            return
    else:
        # Full upload mode — treat all files as to_ingest
        to_ingest = [
            (fp, os.path.relpath(fp, repo_root), "", "full")
            for fp in files
        ]
        stale_docs = []

    # ── Confirmation ────────────────────────────────────────────────────
    if args.confirm and sys.stdin.isatty() and verbosity != "json":
        total_action = len(to_ingest) + len(stale_docs)
        print(f"  {BOLD}About to process {total_action} action(s). Continue? [y/N]{RESET} ", end="")
        try:
            answer = input().strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            answer = ""
        if answer not in ("y", "yes"):
            print(f"  {DIM}Cancelled.{RESET}")
            return

    # ── Delete stale docs ───────────────────────────────────────────────
    if stale_docs:
        for doc_path in stale_docs:
            deleted = delete_store_doc(args.store, doc_path)
            n_deleted += 1
            if verbosity not in ("json", "compact"):
                safe_print(f"  {_status_icon('stale')} {DIM}{doc_path}{RESET} (deleted {deleted} chunks)")
            elif verbosity == "compact":
                safe_print(f"  {_status_icon('stale')} {doc_path}")

    # ── Delete old chunks for updated files ─────────────────────────────
    if args.sync:
        for fp, rel, h, action in to_ingest:
            if action in ("updated", "forced", "incomplete", "oversized"):
                deleted = delete_store_doc(args.store, rel)
                if verbosity not in ("json", "compact"):
                    safe_print(f"  {_status_icon('updated')} {CYAN}{rel}{RESET} ({action}, deleted {deleted} old chunks)")

    # ── Progress tracker ────────────────────────────────────────────────
    tracker = ProgressTracker(len(to_ingest), total_chunks_estimate)

    _timer_stop = threading.Event()
    _timer_thread = None
    if verbosity not in ("json", "compact"):
        _timer_thread = _start_timer_thread(tracker, _timer_stop)

    # ── Ingest files ────────────────────────────────────────────────────
    if verbosity != "json":
        print()
        safe_print(f"  {BOLD}Uploading…{RESET}")
        print()

    if len(to_ingest) > 1 and is_dir:
        with ThreadPoolExecutor(max_workers=min(len(to_ingest), MAX_WORKERS_DIR)) as pool:
            futures = {}
            for fp, rel, h, action in to_ingest:
                if verbosity == "compact":
                    safe_print(f"  {_status_icon('new' if action == 'new' else 'updated')} {CYAN}{rel}{RESET}")
                elif verbosity not in ("json",):
                    ct = detect_content_type(fp)
                    badge = _type_badge(ct, detect_language(fp))
                    safe_print(f"  {BOLD}{rel}{RESET}  {badge}")

                content_hash = h or file_sha256(fp)
                futures[pool.submit(
                    ingest_file, fp, args.store, batch_size, rel,
                    repo_root, project_id, content_hash, verbosity,
                )] = (rel, fp)

            for future in as_completed(futures):
                rel, fp = futures[future]
                try:
                    ok, total, errs = future.result()
                except Exception as exc:
                    ok, total, errs = 0, 0, [f"{type(exc).__name__}: {exc}"]
                tracker.record_file(rel, ok, total, errs, file_size(fp))
                if verbosity == "compact" and ok > 0:
                    safe_print(f"    {DIM}{ok}/{total} chunks{RESET}")
                elif verbosity not in ("json", "compact"):
                    safe_print("")
    else:
        for fp, rel, h, action in to_ingest:
            if verbosity == "compact":
                safe_print(f"  {_status_icon('new' if action == 'new' else 'updated')} {CYAN}{rel}{RESET}")
            elif verbosity != "json":
                ct = detect_content_type(fp)
                badge = _type_badge(ct, detect_language(fp))
                safe_print(f"  {BOLD}{rel}{RESET}  {badge}")

            content_hash = h or file_sha256(fp)
            try:
                ok, total, errs = ingest_file(
                    fp, args.store, batch_size, rel,
                    repo_root, project_id, content_hash, verbosity,
                )
            except Exception as exc:
                ok, total, errs = 0, 0, [f"{type(exc).__name__}: {exc}"]
            tracker.record_file(rel, ok, total, errs, file_size(fp))
            if verbosity == "compact" and ok > 0:
                safe_print(f"    {DIM}{ok}/{total} chunks{RESET}")
            elif verbosity not in ("json", "compact"):
                safe_print("")

    # ── Stop timer ──────────────────────────────────────────────────────
    _timer_stop.set()
    if _timer_thread is not None:
        _timer_thread.join(timeout=2)

    # ── JSON output ─────────────────────────────────────────────────────
    if verbosity == "json":
        result = {
            "unchanged": n_unchanged if args.sync else 0,
            "updated": n_updated if args.sync else 0,
            "new": n_new if args.sync else 0,
            "deleted": n_deleted if args.sync else 0,
            "chunks_added": tracker.chunks_ok,
            "chunks_failed": tracker.chunks_failed,
            "files_processed": tracker.files_done,
            "files_ok": tracker.files_ok,
            "files_failed": tracker.files_failed,
            "elapsed_seconds": round(tracker.elapsed(), 2),
            "failed_files": [
                {"file": f[0], "ok": f[1], "total": f[2], "errors": list(set(f[3]))}
                for f in tracker.failed_files
            ],
        }
        print(json.dumps(result))
        if _rate_limiter.is_aborted():
            sys.exit(2)
        return

    # ── Abort handling ──────────────────────────────────────────────────
    if _rate_limiter.is_aborted():
        print()
        print(f"  {RED}{BOLD}⛔ Aborted due to excessive rate limiting.{RESET}")
        print(f"  Stored {GREEN}{tracker.chunks_ok}{RESET}/{tracker.chunks_total} chunks before stopping.")
        print(f"  {DIM}Remaining chunks were skipped to protect your account.{RESET}")
        print()
        if tracker.failed_files:
            _print_failure_report(tracker.failed_files)
        print(f"  {DIM}Tip: re-run with --sync to resume where you left off{RESET}")
        print()
        sys.exit(2)

    # ── Summary ─────────────────────────────────────────────────────────
    _print_summary(tracker, args, n_unchanged, n_updated, n_new, n_deleted)

    # ── Failure report ──────────────────────────────────────────────────
    if tracker.failed_files:
        _print_failure_report(tracker.failed_files)

    # ── Export results ──────────────────────────────────────────────────
    if args.export and not args.sync:
        # For non-sync mode, export results
        result = {
            "mode": "upload",
            "store_id": args.store,
            "project_id": project_id,
            "files_processed": tracker.files_done,
            "chunks_added": tracker.chunks_ok,
            "chunks_failed": tracker.chunks_failed,
            "elapsed_seconds": round(tracker.elapsed(), 2),
            "failed_files": [
                {"file": f[0], "ok": f[1], "total": f[2], "errors": list(set(f[3]))}
                for f in tracker.failed_files
            ],
        }
        with open(args.export, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print(f"  {GREEN}Exported results to {args.export}{RESET}")
        print()


if __name__ == "__main__":
    main()
