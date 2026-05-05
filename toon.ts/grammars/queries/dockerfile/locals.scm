; =============================================================================
; Dockerfile — locals.scm
; Dockerfiles are essentially flat; the entire file is one scope.
; ARG/ENV names are treated as local definitions visible file-wide.
; =============================================================================

; Whole file is the single scope
(source_file) @scope

; ARG defines a local build argument
(arg_instruction
  name: (unquoted_string) @local.definition)

; ENV defines a local environment variable
(env_instruction
  (env_pair
    name: (unquoted_string) @local.definition))

; Variable usage
(variable
  (variable_name) @local.reference)

