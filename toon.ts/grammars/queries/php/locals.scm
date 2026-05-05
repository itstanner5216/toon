; Tree-sitter PHP locals
; Scopes, local definitions, and parameters.

; --- Scopes ---
(function_definition) @scope
(method_declaration) @scope
(compound_statement) @scope
(if_statement) @scope
(while_statement) @scope
(for_statement) @scope
(foreach_statement) @scope
(try_statement) @scope
(catch_clause) @scope

; --- Parameters ---
(simple_parameter
  name: (variable_name) @local.parameter)

; --- Variable assignments ---
(assignment_expression
  left: (variable_name) @local.definition)

; --- Local references ---
(variable_name) @local.reference

