; CSS — selectors and @-rules (structural symbols)
; Grammar: tree-sitter/tree-sitter-css
;
; CSS "symbols" are:
;   - Rule selectors (class, id, tag, etc.)
;   - @keyframes names
;   - @media rules
;   - Custom property (variable) declarations

; Selectors in rule sets — capture the full selectors text
(rule_set
  (selectors) @name.definition.selector) @definition.selector

; @keyframes — capture the keyframe name
(keyframes_statement
  name: (keyframes_name) @name.definition.keyframes) @definition.keyframes

; @media — capture the whole media rule for navigation
(media_statement) @name.definition.media @definition.media
