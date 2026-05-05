; =============================================================================
; Nix — references.scm
; =============================================================================

; Bare identifier reference
(identifier) @name.reference.identifier @reference.identifier

; Attribute selection  →  expr.attr
(select_expression
  attrpath: (attrpath
    (identifier) @name.reference.attribute)) @reference.attribute

; Function application  →  f x
(apply_expression
  function: (identifier) @name.reference.function) @reference.function

; String interpolation  →  ${expr}
(interpolation
  (identifier) @name.reference.variable) @reference.variable

