// Source / AST contracts for the pure-source route.
//
// These four shapes are the interface the consumer (Zenith-MCP) and Kimi fill
// in: line-ranged structure blocks + anchors, and the call-graph edges that
// feed SageRank.rankWithAST. Everything else this file used to hold (ToonConfig
// + the codec/router config shapes, the dedup shapes incl. EntryMeta, the
// pipeline shapes, the encoder array/template markers + type guards) belonged
// to the deleted log/data pipeline and has been removed.

export interface StructureBlock {
  name: string;
  kind: string;
  type: string;
  startLine: number;     // 0-based (NOT start_line)
  endLine: number;       // 0-based inclusive (NOT end_line)
  exported: boolean;
  anchors: Anchor[];
  priority?: number;
}

export interface Anchor {
  startLine: number;
  endLine: number;
  kind: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// AST-aware SageRank edges
// ---------------------------------------------------------------------------

/**
 * Represents a directed edge in the AST call/reference graph.
 * Used to augment SageRank's text-similarity graph with structural relationships.
 */
export interface ASTEdge {
  /** Source block index (the caller/referencer) */
  from: number;
  /** Target block index (the callee/referenced) */
  to: number;
  /** Edge weight (1.0 for calls, 0.5 for type refs, etc.) */
  weight: number;
  /** Edge type for debugging/analysis */
  kind?: 'call' | 'reference' | 'type_ref' | 'import' | 'inherit';
}

/**
 * Result from building AST edges for a set of blocks.
 */
export interface ASTEdgeResult {
  /** Edges between blocks in this file */
  edges: ASTEdge[];
  /** Names of external symbols referenced (not defined in this file) */
  externalRefs: string[];
  /** Statistics */
  stats: {
    totalEdges: number;
    callEdges: number;
    typeRefEdges: number;
  };
}
