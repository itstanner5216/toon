; Markdown — heading definitions (structural symbols)
; Grammar: ikatyang/tree-sitter-markdown
;
; Headings are the primary navigational structure in markdown.
; We capture the heading content text as the "name" and the full
; atx_heading node as the "definition" to get the line range.
;
; The heading level can be derived from atx_heading_marker text length.

(atx_heading
  (heading_content) @name.definition.section) @definition.section
