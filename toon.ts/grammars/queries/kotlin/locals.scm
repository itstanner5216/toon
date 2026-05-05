; Tree-sitter Kotlin locals (CONSERVATIVE — fwcd grammar)
; Scopes, local definitions, and parameters.

; --- Scopes ---
(function_declaration) @scope
(class_declaration) @scope
(object_declaration) @scope
(lambda_literal) @scope
(if_expression) @scope
(when_expression) @scope
(for_statement) @scope
(while_statement) @scope

; --- Parameters ---
(function_value_parameters
  (function_value_parameter
    (parameter
      (simple_identifier) @local.parameter)))

; --- Local variable definitions ---
(property_declaration
  (simple_identifier) @local.definition)

; --- Local references ---
(simple_identifier) @local.reference

