; Prisma Schema Locals
; CONSERVATIVE: model/enum blocks create scopes; fields are local definitions.

; Model body is a scope
(model_declaration
  (model_body) @scope)

; Enum body is a scope
(enum_declaration
  (enum_body) @scope)

; Type body is a scope
(type_declaration
  (type_body) @scope)

; Datasource body is a scope
(datasource_declaration
  (datasource_body) @scope)

; Generator body is a scope
(generator_declaration
  (generator_body) @scope)

; Field declarations are local definitions
(field_declaration
  (identifier) @local.definition)

; Enum values are local definitions
(enum_value_declaration
  (identifier) @local.definition)

; Type identifier references
(type_identifier) @local.reference

; General identifier references
(identifier) @local.reference

