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

; =============================================================================
; XML — references.scm
; CONSERVATIVE: capitalised node names per tree-sitter-xml grammar.
; =============================================================================

; End tag references its paired start tag by name
(ETag
  (Name) @name.reference.element) @reference.element

; href / src / ref attribute values are cross-document references
(Attribute
  (Name) @_attr_name
  (AttValue) @name.reference.href
  (#any-of? @_attr_name "href" "src" "ref" "xlink:href")) @reference.href
