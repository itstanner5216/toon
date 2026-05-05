; GraphQL Definitions
; tree-sitter-graphql grammar
; Captures all GraphQL type system definitions and operation definitions.

; Object type definition: type Foo { ... }
(object_type_definition
  name: (name) @name.definition.type) @definition.type

; Input object type: input Foo { ... }
(input_object_type_definition
  name: (name) @name.definition.input) @definition.input

; Interface definition: interface Foo { ... }
(interface_type_definition
  name: (name) @name.definition.interface) @definition.interface

; Union definition: union Foo = ...
(union_type_definition
  name: (name) @name.definition.union) @definition.union

; Enum definition: enum Foo { ... }
(enum_type_definition
  name: (name) @name.definition.enum) @definition.enum

; Scalar definition: scalar Foo
(scalar_type_definition
  name: (name) @name.definition.scalar) @definition.scalar

; Schema definition: schema { ... }
(schema_definition) @definition.schema

; Operation definition: query Foo { ... } / mutation Foo { ... }
(operation_definition
  name: (name) @name.definition.operation) @definition.operation

; Fragment definition: fragment Foo on Type { ... }
(fragment_definition
  name: (name) @name.definition.fragment) @definition.fragment

; Directive definition: directive @foo on ...
(directive_definition
  name: (name) @name.definition.directive) @definition.directive

; Field definition inside type
(field_definition
  name: (name) @name.definition.field) @definition.field

; Type extension definitions
(object_type_extension
  name: (name) @name.definition.type) @definition.type

(interface_type_extension
  name: (name) @name.definition.interface) @definition.interface

(enum_type_extension
  name: (name) @name.definition.enum) @definition.enum

