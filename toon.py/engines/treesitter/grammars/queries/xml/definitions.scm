; =============================================================================
; XML — definitions.scm
; Tree-sitter grammar: tree-sitter-xml (tree-sitter-grammars/tree-sitter-xml)
; CONSERVATIVE: node names use XML-spec capitalisation in this grammar.
; Both STag/ETag and EmptyElemTag forms are covered.
; =============================================================================

; Element defined by a start tag — <Tag ...>
(STag
  (Name) @name.definition.element) @definition.element

; Self-closing element — <Tag ... />
(EmptyElemTag
  (Name) @name.definition.element) @definition.element

; Attribute definition — name="value"
(Attribute
  (Name) @name.definition.attribute) @definition.attribute

; XML id attribute is a canonical definition anchor
(Attribute
  (Name) @_attr_name
  (AttValue) @name.definition.id
  (#eq? @_attr_name "id")) @definition.id

