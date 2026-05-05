; Tree-sitter YAML locals
; Block mappings as scopes.

; --- Block mappings as scopes ---
(block_mapping) @scope

; --- Flow mappings as scopes ---
(flow_mapping) @scope

; --- Block sequence items as scopes ---
(block_sequence_item) @scope

; --- Mapping key definitions ---
(block_mapping_pair
  key: (flow_node
    (plain_scalar
      (string_scalar) @local.definition)))

; --- Alias references ---
(alias
  (alias_name) @local.reference)

