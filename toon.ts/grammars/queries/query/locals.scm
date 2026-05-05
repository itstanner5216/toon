; =============================================================================
; Tree-sitter Query Language — locals.scm
; Each top-level pattern group is treated as a scope.
; =============================================================================

; Entire program is the top scope
(program) @scope

; A grouping  →  [ alt1 alt2 ]  creates an inner scope
(grouping) @scope

; Capture definition
(capture
  (identifier) @local.definition)

; Node type reference
(named_node
  name: (identifier) @local.reference)

