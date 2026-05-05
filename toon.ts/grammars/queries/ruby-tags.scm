; Method definitions
[
  (method
    name: (_) @name.definition.method) @definition.method
  (singleton_method
    name: (_) @name.definition.method) @definition.method
]

(alias
  name: (_) @name.definition.method) @definition.method

; Class definitions
[
  (class
    name: [
      (constant) @name.definition.class
      (scope_resolution
        name: (_) @name.definition.class)
    ]) @definition.class
  (singleton_class
    value: [
      (constant) @name.definition.class
      (scope_resolution
        name: (_) @name.definition.class)
    ]) @definition.class
]

; Module definitions
(module
  name: [
    (constant) @name.definition.module
    (scope_resolution
      name: (_) @name.definition.module)
  ]) @definition.module

; Calls
(call method: (identifier) @name.reference.call) @reference.call
