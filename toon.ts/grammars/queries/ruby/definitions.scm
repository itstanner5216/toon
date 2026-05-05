; Tree-sitter Ruby definitions
; Captures methods, singleton methods, classes, modules, and assignments.

; --- Instance methods ---
(method
  name: (identifier) @name.definition.method) @definition.method

; --- Singleton (class-level) methods ---
(singleton_method
  name: (identifier) @name.definition.method) @definition.method

; --- Classes ---
(class
  name: (constant) @name.definition.class) @definition.class

(class
  name: (scope_resolution) @name.definition.class) @definition.class

; --- Modules ---
(module
  name: (constant) @name.definition.module) @definition.module

(module
  name: (scope_resolution) @name.definition.module) @definition.module

; --- Constant assignments ---
(assignment
  left: (constant) @name.definition.constant) @definition.constant

; --- Variable assignments ---
(assignment
  left: (identifier) @name.definition.variable) @definition.variable

; --- Aliases ---
(alias
  name: (identifier) @name.definition.alias) @definition.alias

