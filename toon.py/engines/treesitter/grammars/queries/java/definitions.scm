; --- Classes ---

(class_declaration
  name: (identifier) @name.definition.class
) @definition.class

; --- Interfaces ---

(interface_declaration
  name: (identifier) @name.definition.interface
) @definition.interface

; --- Enums ---

(enum_declaration
  name: (identifier) @name.definition.enum
) @definition.enum

; --- Enum constants ---

(enum_constant
  name: (identifier) @name.definition.constant
) @definition.constant

; --- Annotation types ---

(annotation_type_declaration
  name: (identifier) @name.definition.annotation
) @definition.annotation

; --- Records ---

(record_declaration
  name: (identifier) @name.definition.class
) @definition.class

; --- Methods ---

(method_declaration
  name: (identifier) @name.definition.method
) @definition.method

; --- Constructors ---

(constructor_declaration
  name: (identifier) @name.definition.constructor
) @definition.constructor

; --- Fields ---

(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name.definition.field)
) @definition.field

; --- Constants (static final fields) ---

(constant_declaration
  declarator: (variable_declarator
    name: (identifier) @name.definition.constant)
) @definition.constant

