; SCSS Definitions
; tree-sitter-scss grammar (serenadeai/tree-sitter-scss)
; CONSERVATIVE: extends CSS patterns with SCSS-specific constructs.
; Captures rule sets, mixins, functions, and variable declarations.

; Rule set selector — the selectors node is the "name"
(rule_set
  (selectors) @name.definition.rule) @definition.rule

; Mixin declaration: @mixin name { ... }
(mixin_statement
  name: (identifier) @name.definition.mixin) @definition.mixin

; Include as a mixin "definition" target (for cross-referencing)
; (no definition — include is a reference)

; SCSS variable declaration: $var: value;
(declaration
  (variable_value) @name.definition.variable) @definition.variable

; Placeholder selector: %placeholder { ... }
(placeholder_selector
  (identifier) @name.definition.placeholder) @definition.placeholder

; Keyframes definition: @keyframes name { ... }
(keyframes_statement
  (keyframes_name) @name.definition.keyframes) @definition.keyframes

; Class selector inside rule set selectors
(class_selector
  (class_name) @name.definition.class) @definition.class

; ID selector
(id_selector
  (id_name) @name.definition.id) @definition.id

