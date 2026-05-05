; =============================================================================
; TOML — references.scm
; TOML is a pure data format; cross-references are not a language concept.
; We record bare_key usage inside inline tables as soft references so tooling
; can provide hover information.
; =============================================================================

; Key inside an inline table
(inline_table
  (pair
    (bare_key) @name.reference.property) @reference.property)

