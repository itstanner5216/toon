; GraphQL References
; tree-sitter-graphql grammar
; Captures type references, fragment spreads, field selections, and directive usages.

; Named type references (e.g., in field types, argument types)
(named_type
  (name) @name.reference.type) @reference.type

; Fragment spread: ...FragName
(fragment_spread
  name: (name) @name.reference.fragment) @reference.fragment

; Inline fragment on type
(inline_fragment
  type_condition: (named_type
    (name) @name.reference.type)) @reference.type

; Field selection in operation or fragment
(field
  name: (name) @name.reference.field) @reference.field

; Directive usage: @directive
(directive
  name: (name) @name.reference.directive) @reference.directive

; Variable usage: $var
(variable
  (name) @name.reference.variable) @reference.variable

; Argument usage: key: value
(argument
  name: (name) @name.reference.argument) @reference.argument

