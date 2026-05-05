; Tree-sitter Kotlin definitions (CONSERVATIVE — fwcd grammar)
; Node names based on tree-sitter-kotlin by fwcd.
; May need adjustment for other Kotlin grammar implementations.

; --- Functions ---
(function_declaration
  (simple_identifier) @name.definition.function) @definition.function

; --- Classes ---
(class_declaration
  (type_identifier) @name.definition.class) @definition.class

; --- Objects (singletons) ---
(object_declaration
  (simple_identifier) @name.definition.object) @definition.object

; --- Properties ---
(property_declaration
  (simple_identifier) @name.definition.property) @definition.property

; --- Type aliases ---
(type_alias
  (simple_identifier) @name.definition.type) @definition.type

