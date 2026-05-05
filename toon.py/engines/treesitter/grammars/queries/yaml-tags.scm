; YAML — key definitions (structural symbols)
; Grammar: ikatyang/tree-sitter-yaml (or tree-sitter-grammars/tree-sitter-yaml)
;
; YAML keys at all nesting levels are the meaningful structural elements.
; block_mapping_pair has field `key` which is a flow_node or block_node.
; The actual key text is inside plain_scalar > string_scalar (unquoted),
; double_quote_scalar (double-quoted), or single_quote_scalar (single-quoted).

; Unquoted keys (most common): name: value
(block_mapping_pair
  key: (flow_node
    (plain_scalar) @name.definition.key)) @definition.key

; Double-quoted keys: "name": value
(block_mapping_pair
  key: (flow_node
    (double_quote_scalar) @name.definition.key)) @definition.key

; Single-quoted keys: 'name': value
(block_mapping_pair
  key: (flow_node
    (single_quote_scalar) @name.definition.key)) @definition.key

; Flow mapping keys (inline): {name: value}
(flow_pair
  key: (flow_node
    (plain_scalar) @name.definition.key)) @definition.key

(flow_pair
  key: (flow_node
    (double_quote_scalar) @name.definition.key)) @definition.key

(flow_pair
  key: (flow_node
    (single_quote_scalar) @name.definition.key)) @definition.key
