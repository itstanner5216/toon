; =============================================================================
; Nix — locals.scm
; =============================================================================

; let … in creates a scope
(let_expression) @scope

; Function expression creates a scope
(function_expression) @scope

; with expression introduces a scope
(with_expression) @scope

; rec attrset creates a self-referential scope
(rec_attrset_expression) @scope

; let binding names
(let_expression
  (binding_set
    (binding
      attrpath: (attrpath
        (identifier) @local.definition))))

; Function simple parameter
(function_expression
  (identifier) @local.parameter)

; Function formals parameter
(function_expression
  (formals
    (formal
      (identifier) @local.parameter)))

; Identifier references
(identifier) @local.reference

