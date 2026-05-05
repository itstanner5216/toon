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

