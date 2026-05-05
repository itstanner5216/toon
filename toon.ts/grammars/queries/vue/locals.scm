; Vue Locals
; tree-sitter-vue grammar
; Vue components are scoped; script content is the main local scope.

; The entire component is the top-level scope
(component) @scope

; Template element is a scope for template-local variables
(template_element) @scope

; Elements create nested scopes
(element) @scope

