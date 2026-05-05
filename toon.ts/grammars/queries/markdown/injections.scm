; Tree-sitter Markdown injections
; MOST IMPORTANT: inject language for fenced code blocks based on info string.
; This enables syntax highlighting of code blocks in Markdown files.

; --- Fenced code blocks with explicit language ---
(fenced_code_block
  (info_string
    (language) @injection.language)
  (code_fence_content) @injection.content)

; --- Fenced code blocks without language (default to text) ---
(fenced_code_block
  (code_fence_content) @injection.content
  (#set! injection.language "text"))

