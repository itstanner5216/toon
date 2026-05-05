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

