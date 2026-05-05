; =============================================================================
; Regex — references.scm
; Backreferences refer back to a previously captured group.
; =============================================================================

; Numbered backreference  →  \1
(backreference) @name.reference.backref @reference.backref

; Named backreference  →  \k<name>  (if grammar exposes group_name here)
(named_backreference
  name: (group_name) @name.reference.group) @reference.group

