(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(protocol_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(function_declaration
  name: (simple_identifier) @name.definition.function) @definition.function

(class_declaration
  (class_body
    (function_declaration
      name: (simple_identifier) @name.definition.method))) @definition.method

(class_declaration
  (class_body
    (property_declaration
      (pattern (simple_identifier) @name.definition.property)))) @definition.property

(property_declaration
  (pattern (simple_identifier) @name.definition.property)) @definition.property
