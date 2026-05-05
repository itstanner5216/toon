; Tree-sitter C references
; Captures function calls, field accesses, and type references.

; --- Function calls (direct) ---
(call_expression
  function: (identifier) @name.reference.call) @reference.call

; --- Function calls (through pointer / member) ---
(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; --- Field access ---
(field_expression
  field: (field_identifier) @name.reference.field) @reference.field

; --- Type references ---
(type_identifier) @name.reference.type

; --- Preprocessor includes ---
(preproc_include) @reference.include

