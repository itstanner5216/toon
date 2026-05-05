; Tree-sitter JSON definitions
; Captures object keys as property definitions for indexing and navigation.
; JSON has minimal definition/reference semantics — keys are the primary symbols.

; --- Top-level object pairs ---
(document
  (object
    (pair
      key: (string
        (string_content) @name.definition.property) @definition.property)))

; --- Nested object pairs (first level of nesting) ---
(document
  (object
    (pair
      value: (object
        (pair
          key: (string
            (string_content) @name.definition.property) @definition.property)))))

; --- All object pairs (general) ---
(object
  (pair
    key: (string
      (string_content) @name.definition.property) @definition.property))

