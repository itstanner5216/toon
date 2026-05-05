; =============================================================================
; TOML — definitions.scm
; Tree-sitter grammar: tree-sitter-toml
; =============================================================================

; Table header — [section.name]
; The table node spans the whole section; the key node is the name.
(table
  (bare_key) @name.definition.table) @definition.table

(table
  (dotted_key) @name.definition.table) @definition.table

(table
  (quoted_key) @name.definition.table) @definition.table

; Array-of-tables header — [[array.name]]
(table_array_element
  (bare_key) @name.definition.table_array) @definition.table_array

(table_array_element
  (dotted_key) @name.definition.table_array) @definition.table_array

(table_array_element
  (quoted_key) @name.definition.table_array) @definition.table_array

; Key-value pair — key = value
(pair
  (bare_key) @name.definition.property) @definition.property

(pair
  (dotted_key) @name.definition.property) @definition.property

(pair
  (quoted_key) @name.definition.property) @definition.property

; =============================================================================
; TOML — references.scm
; TOML is a pure data format; cross-references are not a language concept.
; We record bare_key usage inside inline tables as soft references so tooling
; can provide hover information.
; =============================================================================

; Key inside an inline table
(inline_table
  (pair
    (bare_key) @name.reference.property) @reference.property)
