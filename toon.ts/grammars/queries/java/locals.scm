; --- Scopes ---

(block) @scope
(method_declaration) @scope
(constructor_declaration) @scope
(for_statement) @scope
(enhanced_for_statement) @scope
(try_statement) @scope
(catch_clause) @scope
(lambda_expression) @scope

; --- Formal parameters ---

(formal_parameter
  name: (identifier) @local.parameter)

(spread_parameter
  (variable_declarator
    name: (identifier) @local.parameter))

(catch_formal_parameter
  name: (identifier) @local.parameter)

; --- Lambda parameters ---

(lambda_expression
  parameters: (identifier) @local.parameter)

(inferred_parameters
  (identifier) @local.parameter)

; --- Local variable declarations ---

(local_variable_declaration
  declarator: (variable_declarator
    name: (identifier) @local.definition))

; --- Enhanced for loop variable ---

(enhanced_for_statement
  name: (identifier) @local.definition)

; --- Local references ---

(identifier) @local.reference

(type_identifier) @local.reference

