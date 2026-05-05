; Lua References
; CONSERVATIVE: handles function calls and identifier references.

; Function call: foo(...)
(function_call
  called_object: (identifier) @name.reference.function) @reference.call

; Method call: obj:method(...)
(function_call
  called_object: (method_index_expression
    method: (identifier) @name.reference.method)) @reference.call

; Dot-style call: obj.method(...)
(function_call
  called_object: (dot_index_expression
    field: (identifier) @name.reference.method)) @reference.call

; Plain identifier usage (variable references)
(identifier) @name.reference.variable

