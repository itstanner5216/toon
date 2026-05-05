; =============================================================================
; Regex — definitions.scm
; Tree-sitter grammar: tree-sitter/tree-sitter-regex
; Named capturing groups are the only real "definitions" in a regex pattern.
; =============================================================================

; Named capturing group  →  (?<name>...)  or  (?P<name>...)
(named_capturing_group
  name: (group_name) @name.definition.group) @definition.group

; =============================================================================
; Regex — references.scm
; Backreferences refer back to a previously captured group.
; =============================================================================

; Numbered backreference  →  \1
(backreference) @name.reference.backref @reference.backref

; Named backreference  →  \k<name>  (if grammar exposes group_name here)
(named_backreference
  name: (group_name) @name.reference.group) @reference.group
