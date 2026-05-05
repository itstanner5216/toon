; Prisma Schema Definitions
; CONSERVATIVE: victorhqc/tree-sitter-prisma or similar grammar.
; Captures model, enum, type, datasource, and generator declarations.

; Model declaration: model Foo { ... }
(model_declaration
  (identifier) @name.definition.model) @definition.model

; Enum declaration: enum Foo { ... }
(enum_declaration
  (identifier) @name.definition.enum) @definition.enum

; Type declaration: type Foo { ... }
(type_declaration
  (identifier) @name.definition.type) @definition.type

; Datasource declaration: datasource db { ... }
(datasource_declaration
  (identifier) @name.definition.datasource) @definition.datasource

; Generator declaration: generator client { ... }
(generator_declaration
  (identifier) @name.definition.generator) @definition.generator

; Field declaration inside model
(field_declaration
  (identifier) @name.definition.field) @definition.field

; Enum value inside enum block
(enum_value_declaration
  (identifier) @name.definition.enum_value) @definition.enum_value

; Prisma Schema References
; CONSERVATIVE: captures type references and attribute references.

; Type reference in field type position (e.g., String, Int, MyModel)
(type_identifier) @name.reference.type

; Attribute reference: @id, @unique, @relation
(attribute
  (attribute_name) @name.reference.attribute) @reference.attribute

; Block attribute: @@index, @@unique
(block_attribute
  (attribute_name) @name.reference.attribute) @reference.attribute

; Relation reference (model name used in @relation)
(argument
  (identifier) @name.reference.identifier) @reference.argument
