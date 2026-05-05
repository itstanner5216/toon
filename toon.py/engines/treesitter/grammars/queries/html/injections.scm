; HTML Injections
; tree-sitter-html grammar
; MOST IMPORTANT: inject JavaScript into <script> and CSS into <style>.

; <script> element — inject JavaScript
(script_element
  (raw_text) @injection.content
  (#set! injection.language "javascript"))

; <style> element — inject CSS
(style_element
  (raw_text) @injection.content
  (#set! injection.language "css"))

