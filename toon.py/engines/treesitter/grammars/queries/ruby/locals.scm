; Tree-sitter Ruby locals
; Scopes, local definitions, and parameters.

; --- Scopes ---
(method) @scope
(singleton_method) @scope
(class) @scope
(module) @scope
(do_block) @scope
(block) @scope
(begin) @scope
(if) @scope
(unless) @scope
(while) @scope
(for) @scope
(lambda) @scope

; --- Method parameters ---
(method_parameters
  (identifier) @local.parameter)

; --- Block parameters ---
(block_parameters
  (identifier) @local.parameter)

; --- Local variable assignments ---
(assignment
  left: (identifier) @local.definition)

; --- Local references ---
(identifier) @local.reference

