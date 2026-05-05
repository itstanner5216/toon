; Tree-sitter Swift locals (CONSERVATIVE — alex-pinkus grammar)
; Scopes, local definitions, and parameters.

; --- Scopes ---
(function_declaration) @scope
(class_declaration) @scope
(protocol_declaration) @scope
(init_declaration) @scope
(closure_expression) @scope
(if_statement) @scope
(while_statement) @scope
(for_statement) @scope

; --- Parameters ---
(parameter
  internal_name: (simple_identifier) @local.parameter)

; --- Local variable bindings ---
(value_binding_pattern
  (simple_identifier) @local.definition)

; --- Local references ---
(simple_identifier) @local.reference

