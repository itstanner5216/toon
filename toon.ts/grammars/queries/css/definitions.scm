; Tree-sitter CSS definitions
; Captures rule sets (by selector), keyframe animations, and media queries.

; --- Class selectors (.foo) ---
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.class))) @definition.class

; --- ID selectors (#foo) ---
(rule_set
  (selectors
    (id_selector
      (id_name) @name.definition.id))) @definition.id

; --- Tag/element selectors (div, span, etc.) ---
(rule_set
  (selectors
    (tag_name) @name.definition.tag)) @definition.tag

; --- Keyframe animations ---
(keyframes_statement
  (keyframes_name) @name.definition.keyframes) @definition.keyframes

; --- Media queries ---
(media_statement) @definition.media

