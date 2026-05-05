; HTML Locals
; tree-sitter-html grammar
; HTML has limited lexical scoping — elements are treated as scopes.

; Each element creates a scope
(element) @scope

