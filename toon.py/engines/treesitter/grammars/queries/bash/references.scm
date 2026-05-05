; Tree-sitter Bash references
; Captures command invocations and variable expansions.

; --- Command invocations ---
(command
  name: (command_name
    (word) @name.reference.call)) @reference.call

; --- Simple variable expansions ($VAR) ---
(simple_expansion
  (variable_name) @name.reference.variable) @reference.variable

; --- Full variable expansions (${VAR}) ---
(expansion
  (variable_name) @name.reference.variable) @reference.variable

; --- Command substitutions ---
(command_substitution) @reference.call

