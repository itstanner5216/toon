; Tree-sitter Bash definitions
; Captures function definitions and variable assignments.

; --- Functions ---
(function_definition
  name: (word) @name.definition.function) @definition.function

; --- Variable assignments ---
(variable_assignment
  name: (variable_name) @name.definition.variable) @definition.variable

