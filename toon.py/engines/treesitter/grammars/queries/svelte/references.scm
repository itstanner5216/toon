; Svelte References
; tree-sitter-svelte grammar
; Captures tag name and URL references.

; End tag references
(element
  (end_tag
    (tag_name) @name.reference.element) @reference.element)

; href references
(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value) @reference.url
  (#eq? @_attr_name "href"))

; src references
(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value) @reference.url
  (#eq? @_attr_name "src"))

