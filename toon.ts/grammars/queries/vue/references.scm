; Vue References
; tree-sitter-vue grammar
; References to tag names, attributes, and directive targets.

; End tag references
(element
  (end_tag
    (tag_name) @name.reference.element) @reference.element)

; href/src references in attributes
(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value) @reference.url
  (#eq? @_attr_name "href"))

(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value) @reference.url
  (#eq? @_attr_name "src"))

