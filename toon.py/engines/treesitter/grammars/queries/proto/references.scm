; Protocol Buffers References
; CONSERVATIVE: captures type references used in field and rpc declarations.

; Type reference in a field declaration (e.g., MyMessage field_name = 1)
(type) @name.reference.type

; Message type used as rpc input/output
(rpc
  (message_type) @reference.type)

; Import reference
(import
  path: (string) @reference.import) @reference.import

; Option name reference
(option_name) @name.reference.option

