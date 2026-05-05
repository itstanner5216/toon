; --- Functions ---

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(function_expression
  name: (identifier) @name.definition.function
) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(generator_function
  name: (identifier) @name.definition.function
) @definition.function

(function_signature
  name: (identifier) @name.definition.function
) @definition.function

; --- Arrow functions via variable declarator ---

(variable_declarator
  name: (identifier) @name.definition.function
  value: (arrow_function)
) @definition.function

(variable_declarator
  name: (identifier) @name.definition.function
  value: (function_expression)
) @definition.function

; --- Classes ---

(class_declaration
  name: (type_identifier) @name.definition.class
) @definition.class

(class
  name: (type_identifier) @name.definition.class
) @definition.class

(abstract_class_declaration
  name: (type_identifier) @name.definition.class
) @definition.class

; --- Interfaces ---

(interface_declaration
  name: (type_identifier) @name.definition.interface
) @definition.interface

; --- Type aliases ---

(type_alias_declaration
  name: (type_identifier) @name.definition.type
) @definition.type

; --- Enums ---

(enum_declaration
  name: (identifier) @name.definition.enum
) @definition.enum

; --- Modules / Namespaces ---

(module
  name: (identifier) @name.definition.module
) @definition.module

(module
  name: (string) @name.definition.module
) @definition.module

; --- Methods ---

(method_definition
  name: (property_identifier) @name.definition.method
) @definition.method

(method_signature
  name: (property_identifier) @name.definition.method
) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method
) @definition.method

; --- Variables / Constants ---

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
  )
) @definition.variable

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
  )
) @definition.variable

; --- Properties ---

(property_signature
  name: (property_identifier) @name.definition.property
) @definition.property

(public_field_definition
  name: (property_identifier) @name.definition.property
) @definition.property

; --- Object method shorthand ---

(pair
  key: (property_identifier) @name.definition.method
  value: [(function_expression) (arrow_function)]
) @definition.method

