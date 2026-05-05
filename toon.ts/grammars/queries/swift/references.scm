; Tree-sitter Swift references (CONSERVATIVE — alex-pinkus grammar)
; Captures function calls, navigation (member access), and imports.

; --- Call expressions ---
(call_expression
  (simple_identifier) @name.reference.call) @reference.call

; --- Navigation / member access ---
(navigation_expression
  (navigation_suffix
    (simple_identifier) @name.reference.member)) @reference.member

; --- Import declarations ---
(import_declaration
  (identifier) @name.reference.import) @reference.import

; --- Type references ---
(user_type
  (type_identifier) @name.reference.type) @reference.type

