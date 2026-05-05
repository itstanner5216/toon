; HTML Definitions
; tree-sitter-html grammar
; Captures element tag names as definitions and attribute names as attribute definitions.

; Element definitions — the tag_name inside start_tag acts as the "name"
(element
  (start_tag
    (tag_name) @name.definition.element) @definition.element)

; Self-closing element definitions
(element
  (self_closing_tag
    (tag_name) @name.definition.element) @definition.element)

; Attribute definitions — attribute_name inside attribute
(attribute
  (attribute_name) @name.definition.attribute) @definition.attribute

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
