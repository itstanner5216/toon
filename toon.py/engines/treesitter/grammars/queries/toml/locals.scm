; =============================================================================
; TOML — locals.scm
; Each [table] header creates a logical scope for its key-value pairs.
; =============================================================================

; Whole document is the top-level scope
(document) @scope

; Each table section is a nested scope
(table) @scope

; Table array element is a nested scope
(table_array_element) @scope

; Inline table is a nested scope
(inline_table) @scope

; Key binding inside any scope
(pair
  (bare_key) @local.definition)

(pair
  (dotted_key) @local.definition)

(pair
  (quoted_key) @local.definition)

