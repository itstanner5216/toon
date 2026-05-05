; --- Scopes ---

(statement_block) @scope
(arrow_function) @scope
(function_declaration) @scope
(function_expression) @scope
(generator_function_declaration) @scope
(generator_function) @scope
(class_body) @scope
(for_statement) @scope
(for_in_statement) @scope
(catch_clause) @scope

; --- Parameters ---

(formal_parameters
  (identifier) @local.parameter)

(formal_parameters
  (assignment_pattern
    left: (identifier) @local.parameter))

(formal_parameters
  (rest_pattern
    (identifier) @local.parameter))

; --- Local definitions ---

(variable_declarator
  name: (identifier) @local.definition)

(function_declaration
  name: (identifier) @local.definition)

(class_declaration
  name: (identifier) @local.definition)

; --- Local references ---

(identifier) @local.reference

