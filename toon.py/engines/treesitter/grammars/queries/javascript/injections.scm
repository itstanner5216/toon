; --- Template literal injections ---

; HTML template literals: html`...`
(call_expression
  function: (identifier) @_name
  (#match? @_name "^(html|css|svg|gql|graphql|sql)$")
  arguments: (template_string) @injection.content
  (#set! injection.language "html"))

; css template literals
(call_expression
  function: (identifier) @_css
  (#match? @_css "^css$")
  arguments: (template_string) @injection.content
  (#set! injection.language "css"))

; GraphQL template literals
(call_expression
  function: (identifier) @_gql
  (#match? @_gql "^(gql|graphql)$")
  arguments: (template_string) @injection.content
  (#set! injection.language "graphql"))

; SQL template literals
(call_expression
  function: (identifier) @_sql
  (#match? @_sql "^sql$")
  arguments: (template_string) @injection.content
  (#set! injection.language "sql"))

