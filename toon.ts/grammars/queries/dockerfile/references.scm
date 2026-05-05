; =============================================================================
; Dockerfile — references.scm
; =============================================================================

; FROM image reference — the base image being referenced
(from_instruction
  (image_spec
    name: (image_name) @name.reference.image)) @reference.image

; Variable expansion inside RUN / CMD / etc.
; $VAR or ${VAR}
(variable
  (variable_name) @name.reference.variable) @reference.variable

