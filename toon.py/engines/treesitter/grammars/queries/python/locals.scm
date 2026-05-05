; --- Scopes ---

(function_definition) @scope
(class_definition) @scope
(if_statement) @scope
(while_statement) @scope
(for_statement) @scope
(with_statement) @scope
(try_statement) @scope
(except_clause) @scope
(list_comprehension) @scope
(set_comprehension) @scope
(dictionary_comprehension) @scope
(generator_expression) @scope

; --- Parameters ---

(parameters
  (identifier) @local.parameter)

(parameters
  (typed_parameter
    (identifier) @local.parameter))

(parameters
  (default_parameter
    name: (identifier) @local.parameter))

(parameters
  (typed_default_parameter
    name: (identifier) @local.parameter))

(parameters
  (list_splat_pattern
    (identifier) @local.parameter))

(parameters
  (dictionary_splat_pattern
    (identifier) @local.parameter))

; --- Local definitions ---

(function_definition
  name: (identifier) @local.definition)

(class_definition
  name: (identifier) @local.definition)

(assignment
  left: (identifier) @local.definition)

(named_expression
  name: (identifier) @local.definition)

; --- Local references ---

(identifier) @local.reference

