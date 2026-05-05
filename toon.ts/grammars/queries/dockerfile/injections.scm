; =============================================================================
; Dockerfile — injections.scm
; Inject shell language into RUN, CMD, ENTRYPOINT shell forms.
; =============================================================================

; RUN with a shell command string
(run_instruction
  (shell_command) @injection.content
  (#set! injection.language "bash"))

; SHELL instruction content
(shell_instruction
  (json_string_array) @injection.content
  (#set! injection.language "bash"))

