; --- Scopes ---

(block) @scope
(function_declaration) @scope
(method_declaration) @scope
(func_literal) @scope
(if_statement) @scope
(for_statement) @scope
(switch_statement) @scope
(type_switch_statement) @scope

; --- Parameters ---

(parameter_declaration
  name: (identifier) @local.parameter)

(variadic_parameter_declaration
  name: (identifier) @local.parameter)

; --- Local definitions ---

(short_var_declaration
  left: (expression_list
    (identifier) @local.definition))

(var_spec
  name: (identifier) @local.definition)

(const_spec
  name: (identifier) @local.definition)

(function_declaration
  name: (identifier) @local.definition)

(type_spec
  name: (type_identifier) @local.definition)

; --- Local references ---

(identifier) @local.reference

(type_identifier) @local.reference

(field_identifier) @local.reference

