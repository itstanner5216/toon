; Tree-sitter C# locals
; Scopes, local variable definitions, and parameters.

; --- Scopes ---
(method_declaration) @scope
(constructor_declaration) @scope
(block) @scope
(for_statement) @scope
(foreach_statement) @scope
(try_statement) @scope
(catch_clause) @scope
(lambda_expression) @scope

; --- Local variable definitions ---
(local_declaration_statement
  (variable_declaration
    (variable_declarator
      (identifier) @local.definition)))

; --- Parameters ---
(parameter
  name: (identifier) @local.parameter)

; --- Local references ---
(identifier) @local.reference

