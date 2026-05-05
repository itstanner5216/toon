; --- Function/method calls ---

(call_expression
  function: (identifier) @name.reference.call
) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)
) @reference.call

; --- Constructor calls ---

(new_expression
  constructor: (identifier) @name.reference.class
) @reference.class

(new_expression
  constructor: (member_expression
    property: (property_identifier) @name.reference.class)
) @reference.class

; --- Imports ---

(import_statement
  source: (string) @name.reference.module
) @reference.module

; --- Member access ---

(member_expression
  property: (property_identifier) @name.reference.property
) @reference.property

; --- Exports ---

(export_statement
  declaration: (identifier) @name.reference.export
) @reference.export

