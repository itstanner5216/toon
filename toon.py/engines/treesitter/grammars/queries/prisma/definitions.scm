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

