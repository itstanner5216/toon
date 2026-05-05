; --- Method invocations ---

(method_invocation
  name: (identifier) @name.reference.call
) @reference.call

(method_invocation
  object: (identifier) @name.reference.object
  name: (identifier) @name.reference.call
) @reference.call

; --- Object creation ---

(object_creation_expression
  type: (type_identifier) @name.reference.class
) @reference.class

; --- Field access ---

(field_access
  field: (identifier) @name.reference.field
) @reference.field

; --- Type references ---

(type_identifier) @name.reference.type @reference.type

; --- Imports ---

(import_declaration
  (scoped_identifier
    name: (identifier) @name.reference.import)
) @reference.import

; --- Scoped identifiers ---

(scoped_identifier
  name: (identifier) @name.reference.scoped
) @reference.scoped

; --- Class literals ---

(class_literal
  name: (identifier) @name.reference.class
) @reference.class

