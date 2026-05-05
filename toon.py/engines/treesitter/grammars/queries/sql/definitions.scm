; Tree-sitter SQL definitions (CONSERVATIVE — DerekStride/tree-sitter-sql grammar)
; Node names may vary between grammar implementations.
; Captures table, function, view, index, and type definitions.

; --- CREATE TABLE ---
(create_table_statement
  (object_reference
    name: (identifier) @name.definition.table)) @definition.table

; --- CREATE FUNCTION ---
(create_function_statement
  (object_reference
    name: (identifier) @name.definition.function)) @definition.function

; --- CREATE VIEW ---
(create_view_statement
  (object_reference
    name: (identifier) @name.definition.view)) @definition.view

; --- CREATE INDEX ---
(create_index_statement
  (object_reference
    name: (identifier) @name.definition.index)) @definition.index

; --- CREATE TYPE ---
(create_type_statement
  (object_reference
    name: (identifier) @name.definition.type)) @definition.type

; --- Column definitions ---
(column_definition
  name: (identifier) @name.definition.column) @definition.column

