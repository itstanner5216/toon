; --- Functions ---

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(function_expression
  name: (identifier) @name.definition.function
) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(generator_function
  name: (identifier) @name.definition.function
) @definition.function

; --- Arrow functions via variable declarator ---

(variable_declarator
  name: (identifier) @name.definition.function
  value: (arrow_function)
) @definition.function

(variable_declarator
  name: (identifier) @name.definition.function
  value: (function_expression)
) @definition.function

; --- Classes ---

(class_declaration
  name: (identifier) @name.definition.class
) @definition.class

(class
  name: (identifier) @name.definition.class
) @definition.class

; --- Methods ---

(method_definition
  name: (property_identifier) @name.definition.method
) @definition.method

; --- Variables / Constants ---

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
  )
) @definition.variable

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
  )
) @definition.variable

; --- Assignments (module.exports style) ---

(assignment_expression
  left: (identifier) @name.definition.variable
) @definition.variable

; --- Object method shorthand ---

(pair
  key: (property_identifier) @name.definition.method
  value: [(function_expression) (arrow_function)]
) @definition.method

