; --- Scopes ---

(block) @scope
(function_item) @scope
(closure_expression) @scope
(if_expression) @scope
(match_expression) @scope
(while_expression) @scope
(for_expression) @scope
(loop_expression) @scope

; --- Parameters ---

(parameter
  pattern: (identifier) @local.parameter)

(self_parameter) @local.parameter

; --- Let bindings ---

(let_declaration
  pattern: (identifier) @local.definition)

(let_declaration
  pattern: (tuple_pattern
    (identifier) @local.definition))

; --- Local definitions ---

(function_item
  name: (identifier) @local.definition)

(const_item
  name: (identifier) @local.definition)

; --- Local references ---

(identifier) @local.reference

(type_identifier) @local.reference

(field_identifier) @local.reference

