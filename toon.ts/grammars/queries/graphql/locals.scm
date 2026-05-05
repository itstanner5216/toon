; GraphQL Locals
; tree-sitter-graphql grammar
; Operation/fragment bodies act as scopes; variable definitions are local.

; Operation definition is a scope
(operation_definition) @scope

; Fragment definition is a scope
(fragment_definition) @scope

; Variable definitions are local parameters
(variable_definition
  variable: (variable
    (name) @local.parameter))

; Local definition for named fragments
(fragment_definition
  name: (name) @local.definition)

; Name references
(name) @local.reference

