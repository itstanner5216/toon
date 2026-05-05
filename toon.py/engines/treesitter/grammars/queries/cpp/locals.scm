; Tree-sitter C++ locals
; Scopes, local definitions, and parameters.

; --- Scopes ---
(function_definition) @scope
(compound_statement) @scope
(for_statement) @scope
(if_statement) @scope
(while_statement) @scope
(class_specifier) @scope
(namespace_definition) @scope
(lambda_expression) @scope

; --- Local variable definitions ---
(declaration
  declarator: (init_declarator
    declarator: (identifier) @local.definition))

(declaration
  declarator: (identifier) @local.definition)

; --- Parameters ---
(parameter_declaration
  declarator: (identifier) @local.parameter)

; --- Local references ---
(identifier) @local.reference

