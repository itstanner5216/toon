; =============================================================================
; HCL — injections.scm
; Inject languages for heredoc / template strings where the language is
; declared by the heredoc marker.
; =============================================================================

; Template string content (best-effort; language not auto-detectable)
(template_literal) @injection.content
(#set! injection.language "hcl")

