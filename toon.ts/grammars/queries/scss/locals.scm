; SCSS Locals
; tree-sitter-scss grammar
; CONSERVATIVE: rule sets and mixin bodies create scopes.

; Rule set body is a scope
(rule_set
  (block) @scope)

; Mixin body is a scope
(mixin_statement
  (block) @scope)

; Each statement: @each $var in list { }
(each_statement) @scope

; For statement: @for $var from 1 to 10 { }
(for_statement) @scope

; SCSS variable local definitions
(declaration
  (variable_value) @local.definition)

; Mixin parameters
(mixin_statement
  (arguments
    (variable_value) @local.parameter))

; Variable references
(variable_value) @local.reference

