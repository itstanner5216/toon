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

; --- Type references ---

(type_annotation
  (type_identifier) @name.reference.type
) @reference.type

(generic_type
  name: (type_identifier) @name.reference.type
) @reference.type

(implements_clause
  (type_identifier) @name.reference.type
) @reference.type

; --- Imports ---

(import_statement
  source: (string) @name.reference.module
) @reference.module

; --- Member access ---

(member_expression
  property: (property_identifier) @name.reference.property
) @reference.property

; --- JSX component references ---

(jsx_opening_element
  name: (identifier) @name.reference.component
) @reference.component

(jsx_opening_element
  name: (member_expression
    property: (property_identifier) @name.reference.component)
) @reference.component

(jsx_self_closing_element
  name: (identifier) @name.reference.component
) @reference.component

(jsx_self_closing_element
  name: (member_expression
    property: (property_identifier) @name.reference.component)
) @reference.component

; --- Exports ---

(export_statement
  declaration: (identifier) @name.reference.export
) @reference.export

