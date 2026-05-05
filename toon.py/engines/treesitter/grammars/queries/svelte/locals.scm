; Svelte Locals
; tree-sitter-svelte grammar
; Svelte template blocks create scopes; each_statement binds loop variables.

; The document root is a top-level scope
(document) @scope

; Each block creates a scope with a bound variable
(each_statement) @scope

; If blocks create scopes
(if_statement) @scope

; Await blocks create scopes
(await_statement) @scope

; Elements create nested scopes
(element) @scope

