; Protocol Buffers Locals
; CONSERVATIVE: message and service bodies are scopes.

; Message body is a scope
(message
  (message_body) @scope)

; Enum body is a scope
(enum
  (enum_body) @scope)

; Service body is a scope
(service
  (service_body) @scope)

; RPC body is a scope
(rpc
  (rpc_body) @scope)

; Oneof body is a scope
(oneof
  (oneof_body) @scope)

; Field names are local definitions within their scope
(field
  (field_name) @local.definition)

; Enum values are local definitions
(enum_field
  (identifier) @local.definition)

; Type references
(type) @local.reference

