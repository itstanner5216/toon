; Svelte Injections
; tree-sitter-svelte grammar
; MOST IMPORTANT: inject JavaScript into <script> and CSS into <style>.

; <script> element — inject JavaScript
(script_element
  (raw_text) @injection.content
  (#set! injection.language "javascript"))

; <script lang="ts"> — inject TypeScript (try raw_text_svelte if raw_text fails)
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

; <style> element — inject CSS
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

