; =============================================================================
; Tree-sitter Query Language — references.scm
; =============================================================================

; Node type used inside a pattern (reference to a grammar node)
(named_node
  name: (identifier) @name.reference.node) @reference.node

; Capture used in a predicate argument (reference to a previously-named capture)
(predicate
  (capture
    (identifier) @name.reference.capture) @reference.capture)

; Anonymous node literal  →  "keyword"
(anonymous_node
  (string) @name.reference.literal) @reference.literal

