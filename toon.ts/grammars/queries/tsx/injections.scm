; --- JSX expression containers ---

(jsx_expression
  (_) @injection.content
  (#set! injection.language "tsx"))

; --- Template literal injections ---

(call_expression
  function: (identifier) @_name
  (#match? @_name "^(html|css|svg|gql|graphql|sql)$")
  arguments: (template_string) @injection.content
  (#set! injection.language "html"))

(call_expression
  function: (identifier) @_css
  (#match? @_css "^css$")
  arguments: (template_string) @injection.content
  (#set! injection.language "css"))

(call_expression
  function: (identifier) @_gql
  (#match? @_gql "^(gql|graphql)$")
  arguments: (template_string) @injection.content
  (#set! injection.language "graphql"))

