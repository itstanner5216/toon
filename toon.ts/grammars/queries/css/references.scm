; Tree-sitter CSS references
; Captures @import, property names, and references to classes/IDs.

; --- @import statements ---
(import_statement
  (string_value) @name.reference.import) @reference.import

; --- Property names ---
(declaration
  (property_name) @name.reference.property) @reference.property

; --- Tag names in selectors ---
(tag_name) @name.reference.tag

; --- Class names in selectors ---
(class_name) @name.reference.class

; --- ID names in selectors ---
(id_name) @name.reference.id

; --- Function calls (e.g., url(), rgb(), var()) ---
(call_expression
  (function_name) @name.reference.call) @reference.call

