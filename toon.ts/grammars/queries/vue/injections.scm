; Vue Injections
; tree-sitter-vue grammar
; MOST IMPORTANT: inject JavaScript/TypeScript into <script> and CSS into <style>,
; and HTML into <template>.

; <template> — inject HTML
(template_element
  (raw_text) @injection.content
  (#set! injection.language "html"))

; <script> without lang attribute — inject JavaScript
(script_element
  (raw_text) @injection.content
  (#set! injection.language "javascript"))

; <script lang="ts"> — inject TypeScript
(script_element
  (start_tag
    (attribute
      (attribute_name) @_lang_attr
      (quoted_attribute_value
        (attribute_value) @_lang_val
        (#eq? @_lang_attr "lang")
        (#eq? @_lang_val "ts"))))
  (raw_text) @injection.content
  (#set! injection.language "typescript"))

; <style> without lang — inject CSS
(style_element
  (raw_text) @injection.content
  (#set! injection.language "css"))

; <style lang="scss"> — inject SCSS
(style_element
  (start_tag
    (attribute
      (attribute_name) @_lang_attr
      (quoted_attribute_value
        (attribute_value) @_lang_val
        (#eq? @_lang_attr "lang")
        (#eq? @_lang_val "scss"))))
  (raw_text) @injection.content
  (#set! injection.language "scss"))

