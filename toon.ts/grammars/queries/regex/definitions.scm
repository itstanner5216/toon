; =============================================================================
; Regex — definitions.scm
; Tree-sitter grammar: tree-sitter/tree-sitter-regex
; Named capturing groups are the only real "definitions" in a regex pattern.
; =============================================================================

; Named capturing group  →  (?<name>...)  or  (?P<name>...)
(named_capturing_group
  name: (group_name) @name.definition.group) @definition.group

