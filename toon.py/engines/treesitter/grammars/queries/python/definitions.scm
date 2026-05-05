; --- Functions ---

(function_definition
  name: (identifier) @name.definition.function
) @definition.function

; --- Decorated functions ---

(decorated_definition
  definition: (function_definition
    name: (identifier) @name.definition.function)
) @definition.function

; --- Classes ---

(class_definition
  name: (identifier) @name.definition.class
) @definition.class

; --- Decorated classes ---

(decorated_definition
  definition: (class_definition
    name: (identifier) @name.definition.class)
) @definition.class

