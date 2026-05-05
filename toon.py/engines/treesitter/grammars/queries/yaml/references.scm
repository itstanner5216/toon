; Tree-sitter YAML references
; Captures alias references (*anchor_name) and anchor definitions.

; --- Alias references (*anchor_name) ---
(alias
  (alias_name) @name.reference.anchor) @reference.anchor

; --- Anchor as definition target (also a reference point) ---
(anchor
  (anchor_name) @name.reference.anchor) @reference.anchor

