; Tree-sitter Kotlin references (CONSERVATIVE — fwcd grammar)
; Captures function calls, navigation expressions, and imports.

; --- Call expressions ---
(call_expression
  (simple_identifier) @name.reference.call) @reference.call

; --- Navigation (member access) ---
(navigation_expression
  (navigation_suffix
    (simple_identifier) @name.reference.member)) @reference.member

; --- Import headers ---
(import_header
  (identifier) @name.reference.import) @reference.import

; --- Type references ---
(user_type
  (simple_identifier) @name.reference.type) @reference.type

(user_type
  (type_identifier) @name.reference.type) @reference.type

