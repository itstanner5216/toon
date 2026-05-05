; Tree-sitter YAML definitions (ikatyang grammar)
; Captures mapping keys as property definitions.
; Anchors are captured as reusable definitions.

; --- Block mapping pairs (key: value) ---
(block_mapping_pair
  key: (flow_node
    (plain_scalar
      (string_scalar) @name.definition.property)) @definition.property)

(block_mapping_pair
  key: (flow_node
    (double_quote_scalar) @name.definition.property) @definition.property)

(block_mapping_pair
  key: (flow_node
    (single_quote_scalar) @name.definition.property) @definition.property)

; --- Flow mapping pairs ---
(flow_pair
  key: (flow_node
    (plain_scalar
      (string_scalar) @name.definition.property)) @definition.property)

; --- Anchor definitions (&anchor_name) ---
(anchor
  (anchor_name) @name.definition.anchor) @definition.anchor

