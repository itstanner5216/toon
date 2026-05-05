; =============================================================================
; Regex — locals.scm
; The pattern root is the single scope; named groups are local definitions.
; =============================================================================

; Entire pattern is one scope
(pattern) @scope

; Named group definition
(named_capturing_group
  name: (group_name) @local.definition)

; Anonymous capturing group — no name, but still a scope boundary
(anonymous_capturing_group) @scope

