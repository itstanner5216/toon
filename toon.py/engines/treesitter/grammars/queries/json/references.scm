; Tree-sitter JSON references
; JSON has no meaningful reference semantics.
; String values that look like keys are included for completeness.

; --- String values (potential references to other keys) ---
(pair
  value: (string
    (string_content) @name.reference.value) @reference.value)

