; Tree-sitter Bash locals
; Scopes and local definitions.

; --- Scopes ---
(function_definition) @scope
(subshell) @scope
(compound_statement) @scope
(if_statement) @scope
(while_statement) @scope
(for_statement) @scope
(case_statement) @scope

; --- Variable assignments as local definitions ---
(variable_assignment
  name: (variable_name) @local.definition)

; --- Variable references ---
(variable_name) @local.reference

