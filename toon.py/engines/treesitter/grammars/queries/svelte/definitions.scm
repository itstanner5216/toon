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

