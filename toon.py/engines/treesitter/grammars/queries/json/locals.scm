; Tree-sitter JSON locals
; Objects as scopes, pairs as definitions.

; --- Objects as scopes ---
(object) @scope

; --- Array elements as scopes (for objects within arrays) ---
(array
  (object) @scope)

; --- Key-value pairs as local definitions ---
(pair
  key: (string
    (string_content) @local.definition))

