; Protocol Buffers Definitions
; CONSERVATIVE: supports tree-sitter-protobuf (mitchellh) and similar grammars.
; Captures message, enum, service, rpc, and field definitions.

; Message definition: message Foo { ... }
(message
  (message_name) @name.definition.message) @definition.message

; Enum definition: enum Foo { ... }
(enum
  (enum_name) @name.definition.enum) @definition.enum

; Service definition: service Foo { ... }
(service
  (service_name) @name.definition.service) @definition.service

; RPC method definition: rpc Method(...) returns (...)
(rpc
  (rpc_name) @name.definition.rpc) @definition.rpc

; Message field definition
(field
  (field_name) @name.definition.field) @definition.field

; Enum field/value definition
(enum_field
  (identifier) @name.definition.enum_value) @definition.enum_value

; Oneof definition
(oneof
  (identifier) @name.definition.oneof) @definition.oneof

