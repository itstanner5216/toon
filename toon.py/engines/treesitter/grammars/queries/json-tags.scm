; JSON — key definitions (structural symbols)
; Grammar: tree-sitter/tree-sitter-json
;
; In JSON, object keys are the meaningful structural elements.
; We capture the string_content (the text without quotes) as the name,
; and the full pair node as the definition to get the value range.

(pair
  key: (string (string_content) @name.definition.key)) @definition.key
