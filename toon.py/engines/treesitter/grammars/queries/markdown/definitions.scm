; Tree-sitter Markdown definitions
; Captures heading sections as definition anchors.

; --- ATX headings (# Heading) ---
(atx_heading
  (inline) @name.definition.section) @definition.section

; --- Setext headings (underline style) ---
(setext_heading
  (paragraph
    (inline) @name.definition.section)) @definition.section

