; Svelte Definitions
; tree-sitter-svelte grammar
; Captures element tag names and attribute definitions in Svelte templates.

; Element definitions
(element
  (start_tag
    (tag_name) @name.definition.element) @definition.element)

(element
  (self_closing_tag
    (tag_name) @name.definition.element) @definition.element)

; Attribute definitions
(attribute
  (attribute_name) @name.definition.attribute) @definition.attribute

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
