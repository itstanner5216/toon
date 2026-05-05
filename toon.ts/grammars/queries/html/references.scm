; HTML References
; tree-sitter-html grammar
; Captures tag_name references and href/src/action attribute values.

; Tag name references (usage of known element names)
(element
  (end_tag
    (tag_name) @name.reference.element) @reference.element)

; href attribute value references (URL targets)
(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value) @reference.url
  (#eq? @_attr_name "href"))

; src attribute value references
(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value) @reference.url
  (#eq? @_attr_name "src"))

; action attribute value references
(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value) @reference.url
  (#eq? @_attr_name "action"))

