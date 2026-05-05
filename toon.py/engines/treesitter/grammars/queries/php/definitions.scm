; Tree-sitter PHP definitions
; Captures functions, classes, interfaces, traits, enums, methods,
; properties, constants, and namespaces.

; --- Namespaces ---
(namespace_definition
  name: (namespace_name) @name.definition.namespace) @definition.namespace

; --- Functions ---
(function_definition
  name: (name) @name.definition.function) @definition.function

; --- Classes ---
(class_declaration
  name: (name) @name.definition.class) @definition.class

; --- Interfaces ---
(interface_declaration
  name: (name) @name.definition.interface) @definition.interface

; --- Traits ---
(trait_declaration
  name: (name) @name.definition.trait) @definition.trait

; --- Enums ---
(enum_declaration
  name: (name) @name.definition.enum) @definition.enum

; --- Methods ---
(method_declaration
  name: (name) @name.definition.method) @definition.method

; --- Constants ---
(const_declaration
  (const_element
    name: (name) @name.definition.constant)) @definition.constant

; --- Properties ---
(property_declaration
  (property_element
    (variable_name) @name.definition.property)) @definition.property

