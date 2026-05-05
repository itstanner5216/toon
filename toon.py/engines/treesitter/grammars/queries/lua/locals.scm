; Lua Locals
; CONSERVATIVE: scopes from blocks and functions; parameters; local bindings.

; Function body creates a scope
(function_declaration
  body: (block) @scope)

(local_function_declaration
  body: (block) @scope)

(function_statement
  body: (block) @scope)

; do...end creates a scope
(do_statement
  body: (block) @scope)

; for loops create a scope
(for_statement
  body: (block) @scope)

(for_in_statement
  body: (block) @scope)

; while loop creates a scope
(while_statement
  body: (block) @scope)

; repeat...until creates a scope
(repeat_statement
  body: (block) @scope)

; if statement body
(if_statement
  consequence: (block) @scope)

; Parameters are local definitions
(parameters
  (identifier) @local.parameter)

; Local variable declarations
(local_variable_declaration
  (variable_list
    (identifier) @local.definition))

; Local function is a local definition
(local_function_declaration
  name: (identifier) @local.definition)

; Identifier references (all unresolved identifiers)
(identifier) @local.reference

