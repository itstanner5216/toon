; =============================================================================
; XML — locals.scm
; CONSERVATIVE: XML does not have a traditional variable scope model.
; We use element boundaries as scopes and attribute names as local definitions.
; =============================================================================

; Each element is a scope
(element) @scope

; Attribute names are local definitions within their element
(Attribute
  (Name) @local.definition)

; id attribute value as a named anchor
(Attribute
  (Name) @_n
  (AttValue) @local.definition
  (#eq? @_n "id"))

