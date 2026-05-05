; =============================================================================
; HCL — locals.scm
; =============================================================================

; Block body is a scope
(body) @scope

; for expression introduces a scope
(for_tuple_expr) @scope
(for_object_expr) @scope

; Variable defined by an attribute assignment
(attribute
  (identifier) @local.definition)

; for-expression loop variable
(for_tuple_expr
  (identifier) @local.definition)

(for_object_expr
  (identifier) @local.definition)

; Identifier used as a value (reference)
(variable_expr
  (identifier) @local.reference)

