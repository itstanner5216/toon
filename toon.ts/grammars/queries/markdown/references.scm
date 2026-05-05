; Tree-sitter Markdown references
; Captures links and image references.

; --- Inline links ---
(inline_link
  (link_destination) @name.reference.link) @reference.link

; --- Reference links ---
(full_reference_link
  (link_label) @name.reference.link) @reference.link

(collapsed_reference_link
  (link_label) @name.reference.link) @reference.link

; --- Images ---
(image
  (link_destination) @name.reference.link) @reference.link

