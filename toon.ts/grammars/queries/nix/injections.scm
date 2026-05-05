; =============================================================================
; Nix — injections.scm
; Nix indented strings are commonly used as shell scripts, Python, etc.
; We inject bash as a best-effort default.
; =============================================================================

; Indented string (''...'' heredoc-like) — commonly shell scripts
(indented_string_expression) @injection.content
(#set! injection.language "bash")

