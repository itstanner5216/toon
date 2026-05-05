; Tree-sitter PHP references
; Captures function calls, method calls, object creation, and use declarations.

; --- Function calls ---
(function_call_expression
  function: (name) @name.reference.call) @reference.call

(function_call_expression
  function: (qualified_name) @name.reference.call) @reference.call

; --- Member method calls ---
(member_call_expression
  name: (name) @name.reference.call) @reference.call

; --- Static method calls ---
(scoped_call_expression
  name: (name) @name.reference.call) @reference.call

; --- Member property access ---
(member_access_expression
  name: (name) @name.reference.member) @reference.member

; --- Object creation ---
(object_creation_expression
  class: (named_type
    (name) @name.reference.type)) @reference.type

(object_creation_expression
  class: (named_type
    (qualified_name) @name.reference.type)) @reference.type

; --- Use declarations ---
(use_declaration
  (use_declarator
    (qualified_name) @name.reference.import)) @reference.import

