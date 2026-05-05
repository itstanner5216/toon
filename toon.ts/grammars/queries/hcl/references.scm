; =============================================================================
; HCL — references.scm
; =============================================================================

; Function call  →  func_name(args)
(function_call
  (identifier) @name.reference.function) @reference.function

; Variable expression  →  bare identifier used as a value
(variable_expr
  (identifier) @name.reference.variable) @reference.variable

; Template interpolation  →  "${expr}"
(template_expr) @reference.template

; Traversal / get_attr  →  object.field
(get_attr
  (identifier) @name.reference.attribute) @reference.attribute

