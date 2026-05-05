# storage/manifest.py
"""
SQLite manifest database for RAG document tracking.

Tracks document metadata, chunks, embeddings, and ingest jobs.
Provides the source of truth for document lifecycle management
while vectors are stored in Qdrant.
"""

import sqlite3
import json
import uuid
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# Data Transfer Objects
# -----------------------------------------------------------------------------


@dataclass
class DocumentRef:
    """Reference to a document for ingestion."""
    path: str
    mime_type: str
    scope: str
    source_mtime: datetime
    file_hash: str
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class ChunkRecord:
    """Record of a document chunk."""
    doc_id: str
    chunk_index: int
    offset_start: int
    offset_end: int
    chunk_hash: str
    token_count: int
    extractor: str
    extractor_version: str
    scope: str


@dataclass
class EmbeddingRecord:
    """Record of a chunk embedding."""
    chunk_id: str
    embedding_model: str
    embedding_model_version: str
    qdrant_point_id: str


# -----------------------------------------------------------------------------
# Schema Definitions
# -----------------------------------------------------------------------------


SCHEMA_VERSION = 1

CREATE_DOCUMENTS_TABLE = """
CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    mime_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    source_mtime TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    metadata TEXT,
    ingested_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
);
"""

CREATE_CHUNKS_TABLE = """
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    offset_start INTEGER NOT NULL,
    offset_end INTEGER NOT NULL,
    chunk_hash TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    extractor TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);
"""

CREATE_EMBEDDINGS_TABLE = """
CREATE TABLE IF NOT EXISTS embeddings (
    embedding_id TEXT PRIMARY KEY,
    chunk_id TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_model_version TEXT NOT NULL,
    embedded_at TEXT NOT NULL,
    qdrant_point_id TEXT NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
);
"""

CREATE_INGEST_JOBS_TABLE = """
CREATE TABLE IF NOT EXISTS ingest_jobs (
    job_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    docs_processed INTEGER NOT NULL DEFAULT 0,
    chunks_created INTEGER NOT NULL DEFAULT 0,
    embeddings_created INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
);
"""

CREATE_SCHEMA_VERSION_TABLE = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
"""

# Indexes for frequently queried columns
CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scope);",
    "CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);",
    "CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);",
    "CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);",
    "CREATE INDEX IF NOT EXISTS idx_chunks_scope ON chunks(scope);",
    "CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(chunk_hash);",
    "CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);",
    "CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(embedding_model, embedding_model_version);",
    "CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(status);",
]


# -----------------------------------------------------------------------------
# ManifestDB Class
# -----------------------------------------------------------------------------


class ManifestDB:
    """
    SQLite manifest database for RAG document tracking.

    Provides CRUD operations for documents, chunks, embeddings, and ingest jobs.
    Maintains referential integrity with foreign key constraints and cascade deletes.
    """

    def __init__(self, db_path: str):
        """
        Initialize the manifest database.

        Args:
            db_path: Path to SQLite database file. Use ":memory:" for testing.
        """
        self.db_path = db_path
        self._persistent_conn: Optional[sqlite3.Connection] = None

        # Create parent directory if needed
        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        else:
            # For in-memory databases, maintain a persistent connection
            # since each new connection would create a fresh empty database
            self._persistent_conn = sqlite3.connect(":memory:")
            self._persistent_conn.row_factory = sqlite3.Row
            self._persistent_conn.execute("PRAGMA foreign_keys = ON")

        # Initialize schema
        self._init_schema()
        logger.info(f"ManifestDB initialized at {db_path}")

    @contextmanager
    def _get_connection(self):
        """Get a database connection with proper settings."""
        if self._persistent_conn is not None:
            # Use persistent connection for in-memory databases
            try:
                yield self._persistent_conn
                self._persistent_conn.commit()
            except Exception:
                self._persistent_conn.rollback()
                raise
        else:
            # Create new connection for file-based databases
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def _utcnow(self) -> datetime:
        """Get current UTC datetime (timezone-aware)."""
        return datetime.now(timezone.utc)

    def close(self):
        """Close the database connection (for in-memory databases)."""
        if self._persistent_conn is not None:
            self._persistent_conn.close()
            self._persistent_conn = None

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - closes connection."""
        self.close()
        return False

    def _init_schema(self):
        """Initialize or migrate the database schema."""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Create schema version table first
            cursor.execute(CREATE_SCHEMA_VERSION_TABLE)

            # Check current schema version
            cursor.execute("SELECT MAX(version) FROM schema_version")
            row = cursor.fetchone()
            current_version = row[0] if row[0] is not None else 0

            if current_version < SCHEMA_VERSION:
                logger.info(f"Migrating schema from v{current_version} to v{SCHEMA_VERSION}")
                self._apply_migrations(cursor, current_version)
                cursor.execute(
                    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                    (SCHEMA_VERSION, self._utcnow().isoformat())
                )

    def _apply_migrations(self, cursor: sqlite3.Cursor, from_version: int):
        """Apply schema migrations."""
        if from_version < 1:
            # Initial schema
            cursor.execute(CREATE_DOCUMENTS_TABLE)
            cursor.execute(CREATE_CHUNKS_TABLE)
            cursor.execute(CREATE_EMBEDDINGS_TABLE)
            cursor.execute(CREATE_INGEST_JOBS_TABLE)

            for index_sql in CREATE_INDEXES:
                cursor.execute(index_sql)

            logger.info("Applied schema v1: Initial tables and indexes")

    # -------------------------------------------------------------------------
    # Document Operations
    # -------------------------------------------------------------------------

    def add_document(self, doc: DocumentRef) -> str:
        """
        Add a document to the manifest.

        Args:
            doc: DocumentRef with document metadata

        Returns:
            Generated document ID (UUID)

        Raises:
            sqlite3.IntegrityError: If path already exists
        """
        doc_id = str(uuid.uuid4())

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO documents
                (doc_id, path, mime_type, scope, source_mtime, file_hash, metadata, ingested_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    doc_id,
                    doc.path,
                    doc.mime_type,
                    doc.scope,
                    doc.source_mtime.isoformat(),
                    doc.file_hash,
                    json.dumps(doc.metadata) if doc.metadata else None,
                    self._utcnow().isoformat(),
                    "pending"
                )
            )

        logger.debug(f"Added document {doc_id}: {doc.path}")
        return doc_id

    def get_document(self, doc_id: str) -> Optional[Dict]:
        """
        Get document by ID.

        Args:
            doc_id: Document UUID

        Returns:
            Document dict or None if not found
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM documents WHERE doc_id = ?",
                (doc_id,)
            )
            row = cursor.fetchone()

            if row:
                return self._row_to_document_dict(row)
            return None

    def get_document_by_path(self, path: str) -> Optional[Dict]:
        """
        Get document by file path.

        Args:
            path: File path (unique)

        Returns:
            Document dict or None if not found
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM documents WHERE path = ?",
                (path,)
            )
            row = cursor.fetchone()

            if row:
                return self._row_to_document_dict(row)
            return None

    def update_document_status(self, doc_id: str, status: str):
        """
        Update document status.

        Args:
            doc_id: Document UUID
            status: New status ('pending', 'ingested', 'failed', 'stale')
        """
        valid_statuses = {'pending', 'ingested', 'failed', 'stale'}
        if status not in valid_statuses:
            raise ValueError(f"Invalid status: {status}. Must be one of {valid_statuses}")

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE documents SET status = ? WHERE doc_id = ?",
                (status, doc_id)
            )

            if cursor.rowcount == 0:
                logger.warning(f"Document not found for status update: {doc_id}")
            else:
                logger.debug(f"Updated document {doc_id} status to {status}")

    def mark_document_stale(self, doc_id: str):
        """
        Mark document as stale (needs re-ingestion).

        Args:
            doc_id: Document UUID
        """
        self.update_document_status(doc_id, "stale")

    def list_documents(
        self,
        scope: Optional[str] = None,
        status: Optional[str] = None
    ) -> List[Dict]:
        """
        List documents with optional filtering.

        Args:
            scope: Filter by capability scope
            status: Filter by status

        Returns:
            List of document dicts
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()

            query = "SELECT * FROM documents WHERE 1=1"
            params = []

            if scope is not None:
                query += " AND scope = ?"
                params.append(scope)

            if status is not None:
                query += " AND status = ?"
                params.append(status)

            query += " ORDER BY ingested_at DESC"

            cursor.execute(query, params)
            rows = cursor.fetchall()

            return [self._row_to_document_dict(row) for row in rows]

    def delete_document(self, doc_id: str):
        """
        Delete document and cascade to chunks and embeddings.

        Args:
            doc_id: Document UUID
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM documents WHERE doc_id = ?",
                (doc_id,)
            )

            if cursor.rowcount > 0:
                logger.info(f"Deleted document {doc_id} (cascaded to chunks/embeddings)")
            else:
                logger.warning(f"Document not found for deletion: {doc_id}")

    def _row_to_document_dict(self, row: sqlite3.Row) -> Dict:
        """Convert a document row to a dictionary."""
        return {
            "doc_id": row["doc_id"],
            "path": row["path"],
            "mime_type": row["mime_type"],
            "scope": row["scope"],
            "source_mtime": datetime.fromisoformat(row["source_mtime"]),
            "file_hash": row["file_hash"],
            "metadata": json.loads(row["metadata"]) if row["metadata"] else None,
            "ingested_at": datetime.fromisoformat(row["ingested_at"]),
            "status": row["status"]
        }

    # -------------------------------------------------------------------------
    # Chunk Operations
    # -------------------------------------------------------------------------

    def add_chunk(self, chunk: ChunkRecord) -> str:
        """
        Add a chunk record.

        Args:
            chunk: ChunkRecord with chunk metadata

        Returns:
            Generated chunk ID (UUID)
        """
        chunk_id = str(uuid.uuid4())

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO chunks
                (chunk_id, doc_id, chunk_index, offset_start, offset_end,
                 chunk_hash, token_count, extractor, extractor_version, scope, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk_id,
                    chunk.doc_id,
                    chunk.chunk_index,
                    chunk.offset_start,
                    chunk.offset_end,
                    chunk.chunk_hash,
                    chunk.token_count,
                    chunk.extractor,
                    chunk.extractor_version,
                    chunk.scope,
                    self._utcnow().isoformat()
                )
            )

        logger.debug(f"Added chunk {chunk_id} for document {chunk.doc_id}")
        return chunk_id

    def get_chunks_for_document(self, doc_id: str) -> List[Dict]:
        """
        Get all chunks for a document.

        Args:
            doc_id: Document UUID

        Returns:
            List of chunk dicts ordered by chunk_index
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM chunks WHERE doc_id = ? ORDER BY chunk_index",
                (doc_id,)
            )
            rows = cursor.fetchall()

            return [self._row_to_chunk_dict(row) for row in rows]

    def get_chunk(self, chunk_id: str) -> Optional[Dict]:
        """
        Get chunk by ID.

        Args:
            chunk_id: Chunk UUID

        Returns:
            Chunk dict or None if not found
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM chunks WHERE chunk_id = ?",
                (chunk_id,)
            )
            row = cursor.fetchone()

            if row:
                return self._row_to_chunk_dict(row)
            return None

    def delete_chunks_for_document(self, doc_id: str):
        """
        Delete all chunks for a document.

        Note: This also cascades to embeddings via foreign key.

        Args:
            doc_id: Document UUID
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM chunks WHERE doc_id = ?",
                (doc_id,)
            )

            deleted = cursor.rowcount
            if deleted > 0:
                logger.debug(f"Deleted {deleted} chunks for document {doc_id}")

    def _row_to_chunk_dict(self, row: sqlite3.Row) -> Dict:
        """Convert a chunk row to a dictionary."""
        return {
            "chunk_id": row["chunk_id"],
            "doc_id": row["doc_id"],
            "chunk_index": row["chunk_index"],
            "offset_start": row["offset_start"],
            "offset_end": row["offset_end"],
            "chunk_hash": row["chunk_hash"],
            "token_count": row["token_count"],
            "extractor": row["extractor"],
            "extractor_version": row["extractor_version"],
            "scope": row["scope"],
            "created_at": datetime.fromisoformat(row["created_at"])
        }

    # -------------------------------------------------------------------------
    # Embedding Operations
    # -------------------------------------------------------------------------

    def add_embedding(self, embedding: EmbeddingRecord) -> str:
        """
        Add an embedding record.

        Args:
            embedding: EmbeddingRecord with embedding metadata

        Returns:
            Generated embedding ID (UUID)
        """
        embedding_id = str(uuid.uuid4())

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO embeddings
                (embedding_id, chunk_id, embedding_model, embedding_model_version,
                 embedded_at, qdrant_point_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    embedding_id,
                    embedding.chunk_id,
                    embedding.embedding_model,
                    embedding.embedding_model_version,
                    self._utcnow().isoformat(),
                    embedding.qdrant_point_id
                )
            )

        logger.debug(f"Added embedding {embedding_id} for chunk {embedding.chunk_id}")
        return embedding_id

    def get_embedding_for_chunk(self, chunk_id: str) -> Optional[Dict]:
        """
        Get embedding for a chunk.

        Args:
            chunk_id: Chunk UUID

        Returns:
            Embedding dict or None if not found
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM embeddings WHERE chunk_id = ?",
                (chunk_id,)
            )
            row = cursor.fetchone()

            if row:
                return self._row_to_embedding_dict(row)
            return None

    def has_embedding(self, chunk_id: str, model: str, version: str) -> bool:
        """
        Check if a chunk has an embedding for a specific model version.

        Args:
            chunk_id: Chunk UUID
            model: Embedding model name
            version: Model version

        Returns:
            True if embedding exists
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT 1 FROM embeddings
                WHERE chunk_id = ? AND embedding_model = ? AND embedding_model_version = ?
                """,
                (chunk_id, model, version)
            )
            row = cursor.fetchone()

            return row is not None

    def delete_embeddings_for_document(self, doc_id: str):
        """
        Delete all embeddings for a document's chunks.

        Args:
            doc_id: Document UUID
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                DELETE FROM embeddings
                WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)
                """,
                (doc_id,)
            )

            deleted = cursor.rowcount
            if deleted > 0:
                logger.debug(f"Deleted {deleted} embeddings for document {doc_id}")

    def _row_to_embedding_dict(self, row: sqlite3.Row) -> Dict:
        """Convert an embedding row to a dictionary."""
        return {
            "embedding_id": row["embedding_id"],
            "chunk_id": row["chunk_id"],
            "embedding_model": row["embedding_model"],
            "embedding_model_version": row["embedding_model_version"],
            "embedded_at": datetime.fromisoformat(row["embedded_at"]),
            "qdrant_point_id": row["qdrant_point_id"]
        }

    # -------------------------------------------------------------------------
    # Ingest Job Operations
    # -------------------------------------------------------------------------

    def start_ingest_job(self) -> str:
        """
        Create a new ingest job.

        Returns:
            Generated job ID (UUID)
        """
        job_id = str(uuid.uuid4())

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO ingest_jobs
                (job_id, started_at, status, docs_processed, chunks_created, embeddings_created)
                VALUES (?, ?, 'running', 0, 0, 0)
                """,
                (job_id, self._utcnow().isoformat())
            )

        logger.info(f"Started ingest job {job_id}")
        return job_id

    def update_ingest_job(
        self,
        job_id: str,
        docs: int,
        chunks: int,
        embeddings: int
    ):
        """
        Update ingest job progress.

        Args:
            job_id: Job UUID
            docs: Number of documents processed
            chunks: Number of chunks created
            embeddings: Number of embeddings created
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE ingest_jobs
                SET docs_processed = ?, chunks_created = ?, embeddings_created = ?
                WHERE job_id = ?
                """,
                (docs, chunks, embeddings, job_id)
            )

            if cursor.rowcount == 0:
                logger.warning(f"Ingest job not found for update: {job_id}")

    def complete_ingest_job(
        self,
        job_id: str,
        status: str,
        error: Optional[str] = None
    ):
        """
        Mark ingest job as completed.

        Args:
            job_id: Job UUID
            status: Final status ('completed', 'failed')
            error: Error message if failed
        """
        valid_statuses = {'completed', 'failed'}
        if status not in valid_statuses:
            raise ValueError(f"Invalid status: {status}. Must be one of {valid_statuses}")

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE ingest_jobs
                SET completed_at = ?, status = ?, error_message = ?
                WHERE job_id = ?
                """,
                (self._utcnow().isoformat(), status, error, job_id)
            )

            if cursor.rowcount == 0:
                logger.warning(f"Ingest job not found for completion: {job_id}")
            else:
                logger.info(f"Completed ingest job {job_id} with status {status}")

    def get_ingest_job(self, job_id: str) -> Optional[Dict]:
        """
        Get ingest job by ID.

        Args:
            job_id: Job UUID

        Returns:
            Job dict or None if not found
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM ingest_jobs WHERE job_id = ?",
                (job_id,)
            )
            row = cursor.fetchone()

            if row:
                return self._row_to_job_dict(row)
            return None

    def _row_to_job_dict(self, row: sqlite3.Row) -> Dict:
        """Convert a job row to a dictionary."""
        return {
            "job_id": row["job_id"],
            "started_at": datetime.fromisoformat(row["started_at"]),
            "completed_at": datetime.fromisoformat(row["completed_at"]) if row["completed_at"] else None,
            "status": row["status"],
            "docs_processed": row["docs_processed"],
            "chunks_created": row["chunks_created"],
            "embeddings_created": row["embeddings_created"],
            "error_message": row["error_message"]
        }

    # -------------------------------------------------------------------------
    # Query Operations
    # -------------------------------------------------------------------------

    def get_stale_documents(self) -> List[Dict]:
        """
        Get documents that need re-ingestion.

        Returns:
            List of document dicts with status='stale'
        """
        return self.list_documents(status="stale")

    def get_statistics(self) -> Dict:
        """
        Get database statistics.

        Returns:
            Dict with counts of documents, chunks, embeddings, and jobs
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()

            stats = {}

            # Document counts by status
            cursor.execute(
                """
                SELECT status, COUNT(*) as count
                FROM documents
                GROUP BY status
                """
            )
            doc_stats = {row["status"]: row["count"] for row in cursor.fetchall()}
            stats["documents"] = {
                "total": sum(doc_stats.values()),
                "by_status": doc_stats
            }

            # Document counts by scope
            cursor.execute(
                """
                SELECT scope, COUNT(*) as count
                FROM documents
                GROUP BY scope
                """
            )
            stats["documents"]["by_scope"] = {
                row["scope"]: row["count"] for row in cursor.fetchall()
            }

            # Chunk count
            cursor.execute("SELECT COUNT(*) as count FROM chunks")
            stats["chunks"] = cursor.fetchone()["count"]

            # Embedding count
            cursor.execute("SELECT COUNT(*) as count FROM embeddings")
            stats["embeddings"] = cursor.fetchone()["count"]

            # Job counts by status
            cursor.execute(
                """
                SELECT status, COUNT(*) as count
                FROM ingest_jobs
                GROUP BY status
                """
            )
            job_stats = {row["status"]: row["count"] for row in cursor.fetchall()}
            stats["ingest_jobs"] = {
                "total": sum(job_stats.values()),
                "by_status": job_stats
            }

            return stats

    def vacuum(self):
        """
        Optimize the database by reclaiming unused space.

        Should be called periodically after many deletions.
        """
        with self._get_connection() as conn:
            conn.execute("VACUUM")
            logger.info("Database vacuumed")
