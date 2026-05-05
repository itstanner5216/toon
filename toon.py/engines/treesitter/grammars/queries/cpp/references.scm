; Tree-sitter C++ references
; Extends C with qualified identifiers, template types, and new expressions.

; --- Function calls (direct) ---
(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (qualified_identifier) @name.reference.call) @reference.call

; --- Function calls (through member) ---
(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; --- Field access ---
(field_expression
  field: (field_identifier) @name.reference.field) @reference.field

; --- Type references ---
(type_identifier) @name.reference.type

; --- Qualified names (namespace::name) ---
(qualified_identifier
  name: (identifier) @name.reference.qualified) @reference.qualified

; --- Template types ---
(template_type
  name: (type_identifier) @name.reference.type) @reference.type

; --- new expressions ---
(new_expression
  type: (type_identifier) @name.reference.type) @reference.type

; --- Preprocessor includes ---
(preproc_include) @reference.include

