; Lua Definitions
; CONSERVATIVE: supports both MunifTanjim/tree-sitter-lua node naming conventions.
; Covers function declarations, local functions, and variable assignments.

; Top-level function declaration: function foo() end
(function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Method/dot-style function: function obj.method() end
(function_declaration
  name: (dot_index_expression
    field: (identifier) @name.definition.method)) @definition.method

; Method style: function obj:method() end
(function_declaration
  name: (method_index_expression
    method: (identifier) @name.definition.method)) @definition.method

; Local function declaration: local function foo() end
(local_function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Fallback: some grammars use function_statement
(function_statement
  name: (identifier) @name.definition.function) @definition.function

(function_statement
  name: (dot_index_expression
    field: (identifier) @name.definition.method)) @definition.method

(function_statement
  name: (method_index_expression
    method: (identifier) @name.definition.method)) @definition.method

; Local variable declaration: local foo = ...
(local_variable_declaration
  (variable_list
    (identifier) @name.definition.variable)) @definition.variable

; Assignment that looks like a definition at top scope
(variable_assignment
  (variable_list
    (identifier) @name.definition.variable)) @definition.variable

; Lua References
; CONSERVATIVE: handles function calls and identifier references.

; Function call: foo(...)
(function_call
  called_object: (identifier) @name.reference.function) @reference.call

; Method call: obj:method(...)
(function_call
  called_object: (method_index_expression
    method: (identifier) @name.reference.method)) @reference.call

; Dot-style call: obj.method(...)
(function_call
  called_object: (dot_index_expression
    field: (identifier) @name.reference.method)) @reference.call

; Plain identifier usage (variable references)
(identifier) @name.reference.variable
