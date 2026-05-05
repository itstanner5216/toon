; =============================================================================
; Dockerfile — definitions.scm
; Tree-sitter grammar: tree-sitter-dockerfile
; Node names verified against the published grammar.
; =============================================================================

; ARG instruction — defines a build argument
; ARG MY_VAR=default  →  name node is the identifier, full node is arg_instruction
(arg_instruction
  name: (unquoted_string) @name.definition.argument) @definition.argument

; ENV instruction — defines an environment variable via env_pair
; ENV KEY=VALUE  →  name node is the key, full node is env_instruction
(env_instruction
  (env_pair
    name: (unquoted_string) @name.definition.env)) @definition.env

; FROM … AS alias — defines a build-stage alias
; FROM image AS myalias  →  name node is image_alias, full node is from_instruction
(from_instruction
  alias: (image_alias
    (unquoted_string) @name.definition.stage)) @definition.stage

; LABEL instruction — defines metadata key(s)
(label_instruction
  (label_pair
    key: (unquoted_string) @name.definition.label)) @definition.label

