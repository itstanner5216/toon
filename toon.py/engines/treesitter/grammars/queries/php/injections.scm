; Tree-sitter PHP injections
; PHP files embed HTML; inject HTML parsing into the template parts.

((text) @injection.content
  (#set! injection.language "html"))

