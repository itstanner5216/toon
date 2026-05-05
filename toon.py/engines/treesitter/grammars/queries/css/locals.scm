; Tree-sitter CSS locals
; Scopes for rule blocks and media query blocks.

; --- Rule set blocks as scopes ---
(rule_set
  (block) @scope)

; --- Media query blocks as scopes ---
(media_statement
  (block) @scope)

; --- Keyframe blocks as scopes ---
(keyframes_statement
  (keyframe_block_list) @scope)

; --- Custom property definitions (--var-name) ---
(declaration
  (property_name) @local.definition)

; --- Property references ---
(plain_value) @local.reference

