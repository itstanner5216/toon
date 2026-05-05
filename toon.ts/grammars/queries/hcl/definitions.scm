; =============================================================================
; HCL — definitions.scm
; Tree-sitter grammar: MichaHoffmann/tree-sitter-hcl
; =============================================================================

; Generic block — keyword "type" "name" { ... }
; The first identifier child is the block type; labelled string children
; provide the logical name.  We capture the block_type identifier as name
; and the block node itself as the definition span.
(block
  (identifier) @name.definition.block) @definition.block

; resource block  →  resource "aws_instance" "name" { }
(block
  (identifier) @_kw
  (string_lit) @_type
  (string_lit) @name.definition.resource
  (#eq? @_kw "resource")) @definition.resource

; variable block  →  variable "name" { }
(block
  (identifier) @_kw
  (string_lit) @name.definition.variable
  (#eq? @_kw "variable")) @definition.variable

; output block  →  output "name" { }
(block
  (identifier) @_kw
  (string_lit) @name.definition.output
  (#eq? @_kw "output")) @definition.output

; data block  →  data "type" "name" { }
(block
  (identifier) @_kw
  (string_lit) @_type
  (string_lit) @name.definition.data
  (#eq? @_kw "data")) @definition.data

; module block  →  module "name" { }
(block
  (identifier) @_kw
  (string_lit) @name.definition.module
  (#eq? @_kw "module")) @definition.module

; locals block  →  locals { key = value }
(block
  (identifier) @_kw
  (#eq? @_kw "locals")) @definition.locals

; provider block  →  provider "name" { }
(block
  (identifier) @_kw
  (string_lit) @name.definition.provider
  (#eq? @_kw "provider")) @definition.provider

; Attribute definition  →  key = expression
(attribute
  (identifier) @name.definition.attribute) @definition.attribute

