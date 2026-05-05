; --- Function calls ---

(call
  function: (identifier) @name.reference.call
) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name.reference.call)
) @reference.call

; --- Imports ---

(import_statement
  name: (dotted_name
    (identifier) @name.reference.module)
) @reference.module

(import_from_statement
  module_name: (dotted_name
    (identifier) @name.reference.module)
) @reference.module

(import_from_statement
  name: (dotted_name
    (identifier) @name.reference.import)
) @reference.import

; --- Attribute access ---

(attribute
  attribute: (identifier) @name.reference.property
) @reference.property

