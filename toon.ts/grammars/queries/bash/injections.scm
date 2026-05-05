; Tree-sitter Bash injections
; Inject language for heredoc content based on delimiter name.

((heredoc_body) @injection.content
  (#set! injection.language "bash"))

