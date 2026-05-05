; Vue Definitions
; tree-sitter-vue grammar
; Captures component sections and attribute definitions.

; Element definitions in template
(element
  (start_tag
    (tag_name) @name.definition.element) @definition.element)

(element
  (self_closing_tag
    (tag_name) @name.definition.element) @definition.element)

; Attribute definitions
(attribute
  (attribute_name) @name.definition.attribute) @definition.attribute

; Directive attributes (v-if, :prop, @event, etc.)
(directive_attribute
  (directive_name) @name.definition.directive) @definition.directive

