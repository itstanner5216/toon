# TOON Compression Review — council

## File Info
- Original: CouncilConfig.jsx — 26725 characters
- Level 1: coucil.txt — 9000 characters (33.68% of original)
- Level 2: coucil2.txt — 5000 characters (18.71% of original)
- Level 3: coucil3.txt — 2000 characters (7.48% of original)

## Level 1 Review
**Compression ratio:** 33.68%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 0/10 | The compressed file is not a compression of `CouncilConfig.jsx`; it contains Rust `compression.rs` content with `MessageRange`, `PlanTask`, `ChatSession`, and Rust compression registries. |
| Omission Clarity | 1/10 | It contains a `...[content truncated]...` marker, but gives no indication that the entire JSX source was replaced by unrelated Rust content. |
| Critical Logic Preservation | 0/10 | None of the React component's provider toggles, model filters, council member controls, validation paths, or heat sliders are present. |
| Usability | 0/10 | A developer using this file to integrate with `CouncilConfig` would have no usable information about the component. |

**What survived well:**
Nothing from the original `CouncilConfig.jsx` survived. The original imports `React` and `SearchableModelSelect`, defines `DIRECT_PROVIDERS`, exports `CouncilConfig`, implements `isSourceConfigured()`, `filterByRemoteLocal()`, and `getMemberFilter()`, then renders provider toggles, council member selectors, validation warnings, and chairman controls. The compressed file instead starts with a Rust license/header and `//! Plan-driven context compression`.

**What was lost that matters:**
Everything that matters for the JSX component is missing: the `CouncilConfig` function signature and props, the direct provider list for `openai`, `anthropic`, `google`, `mistral`, and `deepseek`, the source configuration switch for `openrouter`, `ollama`, `groq`, `custom`, and direct providers, the direct-provider master/child toggle synchronization, `SearchableModelSelect` usage for members and chairman, `validationErrors.member_*` and `validationErrors.chairman`, the `rateLimitWarning` banner, max-8 council member handling, and temperature disabling for `gpt-5.1`, `o1-`, and `o3-` models.

**Verdict:** This is a hard failure: the compressed artifact appears to be from the wrong source file. The 33.68% ratio is irrelevant because it preserves 0% of the target file's usable structure.

## Level 2 Review
**Compression ratio:** 18.71%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 0/10 | Like level 1, this is Rust `compression.rs` content, not the JSX component. |
| Omission Clarity | 1/10 | The truncation marker is explicit only within the unrelated Rust content; it does not disclose that `CouncilConfig.jsx` is absent. |
| Critical Logic Preservation | 0/10 | No CouncilConfig imports, props, helpers, callbacks, JSX sections, or validation conditions survive. |
| Usability | 0/10 | This cannot support integration with the React component at all. |

**What survived well:**
No actual `CouncilConfig.jsx` content survived. There is no `import React from 'react'`, no `import SearchableModelSelect from '../SearchableModelSelect'`, no `DIRECT_PROVIDERS`, and no `export default function CouncilConfig({ ... })`.

**What was lost that matters:**
The compressed file loses the helper behavior that determines configured sources (`settings?.openrouter_api_key_set`, `ollamaStatus?.connected`, `settings?.custom_endpoint_url`, and direct-provider API-key flags), the remote/local model filtering based on `ollama:` IDs, the council member map over `councilModels`, add/remove member controls, the disabled states based on provider availability, free OpenRouter filter, rate-limit warning rendering, chairman remote/local reset behavior, and heat slider callbacks using `setCouncilTemperature(parseFloat(...))` and `setChairmanTemperature(parseFloat(...))`.

**Verdict:** This level is unusable for the target test case. It compresses to 18.71% of the original size but carries unrelated Rust content.

## Level 3 Review
**Compression ratio:** 7.48%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 0/10 | The compressed text is still unrelated Rust content and preserves no JSX structure. |
| Omission Clarity | 1/10 | The marker says content was truncated, but the artifact never states that the target React file is missing. |
| Critical Logic Preservation | 0/10 | None of the component's critical UI or state logic appears. |
| Usability | 0/10 | A developer could not even identify the component name, props, imports, or rendered sections from this version. |

**What survived well:**
Nothing from `CouncilConfig.jsx` survived. Level 3 only contains a short Rust header fragment, a `...[content truncated]...` marker, and a tail fragment from Rust tests involving `session::Message`.

**What was lost that matters:**
The entire component is lost: provider availability UI, direct provider toggles, custom endpoint rendering, council composition controls, member filter buttons, `SearchableModelSelect` wiring, validation errors, add/remove member behavior, rate-limit banner, council and chairman heat sliders, and chairman model selection.

**Verdict:** This is the most compressed artifact, but it has zero target-file value. It is a wrong-file compression, not merely an over-aggressive one.

## Overall Assessment
All three council compressed files are failure cases because they contain Rust compression-module fragments instead of the React `CouncilConfig.jsx` source. Toon does not merely omit too much here; it appears to associate the wrong compressed content with the test case. The correct compressed representation should preserve at least the imports, `DIRECT_PROVIDERS`, the `CouncilConfig` prop list, the three helpers (`isSourceConfigured`, `filterByRemoteLocal`, `getMemberFilter`), and the major rendered sections for available sources, council members, rate-limit warning, council heat, chairman selection, and chairman heat.
