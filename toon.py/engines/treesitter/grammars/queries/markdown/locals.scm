; Tree-sitter Markdown locals
; Sections as scopes.

; --- Sections (headings create scope) ---
(section) @scope

; --- ATX heading content as definition ---
(atx_heading
  (inline) @local.definition)

; --- Link references ---
(link_destination) @local.reference

