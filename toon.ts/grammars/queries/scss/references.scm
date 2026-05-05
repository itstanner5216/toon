; SCSS References
; tree-sitter-scss grammar
; CONSERVATIVE: captures mixin includes, variable references, and selector references.

; Mixin include: @include name
(include_statement
  name: (identifier) @name.reference.mixin) @reference.mixin

; Variable reference in property value
(variable_value) @name.reference.variable

; Class selector reference (used in compound selectors / extends)
(class_selector
  (class_name) @name.reference.class) @reference.class

; Extend reference: @extend .selector
(extend_statement
  (class_selector
    (class_name) @name.reference.class)) @reference.extend

; Property name reference
(property_name) @name.reference.property

