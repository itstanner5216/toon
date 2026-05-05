; =============================================================================
; XML — injections.scm
; Inject content based on common script/style elements.
; =============================================================================

; <script> tag content → JavaScript
(element
  (STag
    (Name) @_tag_name)
  (content) @injection.content
  (#eq? @_tag_name "script")
  (#set! injection.language "javascript"))

; <style> tag content → CSS
(element
  (STag
    (Name) @_tag_name)
  (content) @injection.content
  (#eq? @_tag_name "style")
  (#set! injection.language "css"))

