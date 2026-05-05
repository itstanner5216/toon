; Tree-sitter SQL locals (CONSERVATIVE — DerekStride/tree-sitter-sql grammar)
; Scopes for SELECT statements and function bodies.

; --- Scopes ---
(select_statement) @scope
(subquery) @scope

; --- CTE definitions (WITH clause) ---
(cte_definition
  (identifier) @local.definition)

; --- Column aliases ---
(alias
  (identifier) @local.definition)

