; =============================================================================
; Tree-sitter Query Language — definitions.scm
; Tree-sitter grammar: tree-sitter-query / tree-sitter-tsq
; CONSERVATIVE: node names may vary; using the tree-sitter-query grammar names.
; =============================================================================

; A named node pattern  →  (node_type)
; The node type identifier is the "definition" of a pattern match.
(named_node
  name: (identifier) @name.definition.node) @definition.node

; A capture  →  @capture_name
; Captures are the primary definitional construct in .scm files.
(capture
  (identifier) @name.definition.capture) @definition.capture

; A field definition  →  field: pattern
(field_definition
  name: (identifier) @name.definition.field) @definition.field

