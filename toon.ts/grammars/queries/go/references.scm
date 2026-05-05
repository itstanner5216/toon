; --- Function calls ---

(call_expression
  function: (identifier) @name.reference.call
) @reference.call

(call_expression
  function: (selector_expression
    field: (field_identifier) @name.reference.call)
) @reference.call

; --- Selector / member access ---

(selector_expression
  field: (field_identifier) @name.reference.property
) @reference.property

; --- Type references ---

(type_identifier) @name.reference.type @reference.type

; --- Imports ---

(import_spec
  path: (interpreted_string_literal) @name.reference.module
) @reference.module

; --- Composite literals ---

(composite_literal
  type: (type_identifier) @name.reference.type
) @reference.type

