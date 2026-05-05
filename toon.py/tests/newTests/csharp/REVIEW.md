# TOON Compression Review — csharp

## File Info
- Original: semmlecode.csharp.dbscheme — 39292 characters
- Level 1: csharp.txt — 2000 characters (5.09% of original)
- Level 2: csharp2.txt — 2000 characters (5.09% of original)
- Level 3: csharp3.txt — 3600 characters (9.16% of original)

## Level 1 Review
**Compression ratio:** 5.09%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 1/10 | Keeps `compilations`, `compilation_info`, and the final ASP.NET predicates, but loses almost the entire dbscheme type and predicate surface. |
| Omission Clarity | 2/10 | There is one `...[content truncated]...` marker, but it gives no line count and cuts from a dangling doc comment into a partial ASP.NET enum line. |
| Critical Logic Preservation | 1/10 | For a dbscheme, the critical content is schema relationships and case mappings; nearly all of those are missing. |
| Usability | 1/10 | A developer could not understand or integrate with the C# schema from this alone beyond the compiler invocation and ASP.NET tail. |

**What survived well:**
The upgrade-safety comment with date `2021-07-14` survived. The `compilations(unique int id : @compilation, string cwd : string ref)` predicate and `compilation_info(int id, info_key, info_value)` predicate are present. The tail of the ASP.NET section preserves `@asp_attribute`, `asp_elements`, `asp_comment_server`, `asp_code_inline`, `asp_directive_attribute`, `asp_directive_name`, `asp_element_body`, `asp_tag_attribute`, `asp_tag_name`, and `asp_tag_isempty`.

**What was lost that matters:**
The middle of the schema is essentially gone: `compilation_args`, `compilation_expanded_args`, `compilation_compiling_files`, `diagnostics`, `extractor_messages`, `@element`, `@declaration`, `@locatable`, namespace and preprocessor predicates, the `types` kind mapping, generics, members, callables, variables, statements, expressions, XML predicates, comments, and most location predicates. The marker jumps into `comment` before ASP.NET, which hides that the original includes the earlier `@asp_close_tag`, `@asp_code`, and `@asp_comment` enum arms.

**Verdict:** This is far too aggressive. It preserves the first two predicates and the final ASP.NET tail, but it removes the schema areas a reader would need most.

## Level 2 Review
**Compression ratio:** 5.09%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 1/10 | This is byte-identical to Level 1 and has the same structural loss. |
| Omission Clarity | 2/10 | Same single generic truncation marker as Level 1, without line counts or section names. |
| Critical Logic Preservation | 1/10 | Same loss of type, statement, expression, callable, XML, and diagnostic schema definitions as Level 1. |
| Usability | 1/10 | Same as Level 1: not enough of the predicate surface remains to use the schema. |

**What survived well:**
The same content as Level 1 survived: the upgrade comment, `compilations`, `compilation_info`, and the final ASP.NET predicates such as `asp_elements` and `asp_tag_attribute`.

**What was lost that matters:**
Because Level 2 is identical to Level 1, it loses all the same major structures: the compiler argument predicates, diagnostics and extractor messages, all core `@type` and `@expr` hierarchies, `params`, `methods`, `fields`, `statements`, `expressions`, XML, and comment schemas.

**Verdict:** Level 2 provides no improvement over Level 1 despite being a separate compression level. It is not usable for understanding the dbscheme.

## Level 3 Review
**Compression ratio:** 9.16%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 2/10 | Adds `compilation_args` and part of `compilation_expanded_args`, plus the comments and ASP.NET tail, but still drops most of the schema. |
| Omission Clarity | 2/10 | The marker is visible, but it occurs after a broken parameter `string arg : s`, so the compressed version looks syntactically corrupted. |
| Critical Logic Preservation | 2/10 | It keeps a little more compiler-invocation structure and comment metadata, but loses the central type, member, statement, and expression mappings. |
| Usability | 1/10 | The extra 1600 characters do not make the dbscheme meaningfully usable for integration. |

**What survived well:**
Level 3 preserves the initial compiler invocation predicates better than Levels 1 and 2: `compilations`, `compilation_info`, `compilation_args`, and the beginning of `compilation_expanded_args` are visible. It also keeps the comment predicates `commentline`, `commentline_location`, `commentblock`, `commentblock_location`, `commentblock_binding`, and `commentblock_child`, then the ASP.NET tail.

**What was lost that matters:**
`compilation_expanded_args` is cut mid-signature at `string arg : s`, so even one preserved predicate is damaged. The entire semantic core is still omitted: `@element`, `@declaration`, `@type_container`, `@preprocessor_directive`, `types` with its `case @type.kind`, `params`, `methods`, `constructors`, `fields`, `statements`, `expressions`, `expr_call`, `expr_access`, `xmlElements`, `xmlAttrs`, and the control/data-flow aliases.

**Verdict:** Level 3 is slightly better than Levels 1 and 2, but still fails the main requirement for a schema file: preserving the predicate/type inventory. It is compressed enough, but the retained material is poorly chosen.

## Overall Assessment
None of the three levels hits a good balance for this dbscheme. Levels 1 and 2 are identical and mostly preserve the file header plus the first and last few predicates. Level 3 adds early compiler-argument and comment predicates, but it still omits the central C# schema sections. For schema-like files, toon needs to preserve an outline of every predicate and every `@type` alias or `case` mapping, even if comments and examples are cut aggressively. The current outputs optimize for contiguous head/tail retention, which is the wrong strategy for this file type.
