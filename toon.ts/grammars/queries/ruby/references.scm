; Tree-sitter Ruby references
; Captures method calls, constant references, and scope resolutions.

; --- Method calls ---
(call
  method: (identifier) @name.reference.call) @reference.call

; --- Scope resolution (Namespace::Name) ---
(scope_resolution
  name: (constant) @name.reference.constant) @reference.constant

(scope_resolution
  name: (identifier) @name.reference.constant) @reference.constant

; --- Standalone constant references ---
(constant) @name.reference.type

