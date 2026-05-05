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

