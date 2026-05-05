; Tree-sitter C# references
; Captures method invocations, object creation, member access, and using directives.

; --- Method / function invocations ---
(invocation_expression
  function: (identifier) @name.reference.call) @reference.call

(invocation_expression
  function: (member_access_expression
    name: (identifier) @name.reference.call)) @reference.call

; --- Object creation ---
(object_creation_expression
  type: (identifier) @name.reference.type) @reference.type

(object_creation_expression
  type: (generic_name
    (identifier) @name.reference.type)) @reference.type

; --- Member access ---
(member_access_expression
  name: (identifier) @name.reference.member) @reference.member

; --- Using directives ---
(using_directive
  (identifier) @name.reference.import) @reference.import

(using_directive
  (qualified_name
    (identifier) @name.reference.import)) @reference.import

