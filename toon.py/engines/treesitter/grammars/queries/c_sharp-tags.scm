; Tree-sitter C# definitions
; Captures classes, structs, interfaces, enums, records, namespaces,
; methods, constructors, properties, fields, events, delegates, and enum members.

; --- Namespaces ---
(namespace_declaration
  name: (identifier) @name.definition.namespace) @definition.namespace

(file_scoped_namespace_declaration
  name: (identifier) @name.definition.namespace) @definition.namespace

; --- Classes ---
(class_declaration
  name: (identifier) @name.definition.class) @definition.class

; --- Structs ---
(struct_declaration
  name: (identifier) @name.definition.struct) @definition.struct

; --- Interfaces ---
(interface_declaration
  name: (identifier) @name.definition.interface) @definition.interface

; --- Enums ---
(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; --- Records ---
(record_declaration
  name: (identifier) @name.definition.record) @definition.record

; --- Methods ---
(method_declaration
  name: (identifier) @name.definition.method) @definition.method

; --- Constructors ---
(constructor_declaration
  name: (identifier) @name.definition.constructor) @definition.constructor

; --- Properties ---
(property_declaration
  name: (identifier) @name.definition.property) @definition.property

; --- Fields ---
(field_declaration
  (variable_declaration
    (variable_declarator
      (identifier) @name.definition.field))) @definition.field

; --- Events ---
(event_declaration
  name: (identifier) @name.definition.event) @definition.event

; --- Delegates ---
(delegate_declaration
  name: (identifier) @name.definition.delegate) @definition.delegate

; --- Enum members ---
(enum_member_declaration
  name: (identifier) @name.definition.enumerator) @definition.enumerator

; Tree-sitter C# references
; Captures method invocations, object creation, member access, and using directives.

; --- Method / function invocations ---
(invocation_expression
  function: (identifier) @name.reference.call) @reference.call

(invocation_expression
  function: (member_access_expression
    name: (identifier) @name.reference.call)) @reference.call

; --- Object creation ---
(object_creation_expression
  type: (identifier) @name.reference.type) @reference.type

(object_creation_expression
  type: (generic_name
    (identifier) @name.reference.type)) @reference.type

; --- Member access ---
(member_access_expression
  name: (identifier) @name.reference.member) @reference.member

; --- Using directives ---
(using_directive
  (identifier) @name.reference.import) @reference.import

(using_directive
  (qualified_name
    (identifier) @name.reference.import)) @reference.import
