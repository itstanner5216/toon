; --- Function calls ---

(call_expression
  function: (identifier) @name.reference.call
) @reference.call

(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)
) @reference.call

(call_expression
  function: (scoped_identifier
    name: (identifier) @name.reference.call)
) @reference.call

; --- Macro invocations ---

(macro_invocation
  macro: (identifier) @name.reference.macro
) @reference.macro

; --- Use declarations ---

(use_declaration
  argument: (scoped_identifier
    name: (identifier) @name.reference.import)
) @reference.import

(use_declaration
  argument: (identifier) @name.reference.import
) @reference.import

; --- Type references ---

(type_identifier) @name.reference.type @reference.type

; --- Field access ---

(field_expression
  field: (field_identifier) @name.reference.field
) @reference.field

; --- Scoped identifiers (path references) ---

(scoped_identifier
  path: (identifier) @name.reference.module
) @reference.module

