# TOON Compression Review — compression

## File Info
- Original: compression.rs — 41373 characters
- Level 1: compression.rs.txt — 4000 characters (9.67% of original)
- Level 2: compression.rs2.txt — 10000 characters (24.17% of original)
- Level 3: compression.rs3.txt — 8000 characters (19.34% of original)

## Level 1 Review
**Compression ratio:** 9.67%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 2/10 | Preserves imports, the module header, and the final `task_compression_no_advancement_when_no_tool_calls()` test, but almost every public type and function signature between the session registry comments and the test tail is omitted. |
| Omission Clarity | 6/10 | The `...[content truncated]...` marker is explicit, but it gives no line or character count and creates a misleading jump from the registry comments into the last test body. |
| Critical Logic Preservation | 2/10 | Keeps part of the orphaned-tool-result regression test, but loses the actual `compress_completed_task()` implementation, `format_compressed_summary()`, token counting, phase compression, project compression, and file-reference extraction. |
| Usability | 1/10 | A developer could not integrate against this module from this version because the exported request/process APIs and data structures are mostly absent. |

**What survived well:**
The license/header, module-level purpose comment, imports for `MessageRange`, `PlanTask`, `ChatSession`, `SessionId`, `estimate_tokens`, `anyhow`, `serde`, `HashMap`, and synchronization types survived. The end of `task_compression_no_advancement_when_no_tool_calls()` also survived, including its local `msg(role: &str) -> Message` helper and assertion that `adjusted_start` stays unchanged.

**What was lost that matters:**
The compressed version drops the signatures for `request_compression()`, `request_forced_compression()`, `set_pending_compression_range()`, `process_pending_compression()`, `request_phase_compression()`, `request_project_compression()`, `process_pending_phase_compression()`, and `process_pending_project_compression()`. It also loses the `PhaseCompression`, `ProjectCompression`, `PhaseCompressionRequest`, `ProjectCompressionRequest`, and `CompressionMetrics` structs, plus the critical `compress_completed_task()` logic that skips non-saving compression, enforces the 20% threshold unless `force` is set, advances past assistant tool results, logs compression points, and resets token counters.

**Verdict:** This is too aggressive for code comprehension. It honestly marks that content was truncated, but it preserves neither the public surface nor the main behavior.

## Level 2 Review
**Compression ratio:** 24.17%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 4/10 | Preserves imports, global registries, `effective_session_id()`, `cleanup_compression_state()`, and the beginnings of `PendingTaskCompression`, `PhaseCompression`, and `ProjectCompression`; most later APIs are still hidden. |
| Omission Clarity | 6/10 | The truncation marker is visible, but it does not explain that hundreds of lines and most runtime functions were removed. |
| Critical Logic Preservation | 3/10 | Retains useful evidence of the orphaned tool-call test scenario and the start of the data model, but omits the live compression implementations. |
| Usability | 2/10 | A developer could infer some storage model and registry shape, but could not safely call or modify the compression workflow without reading the original. |

**What survived well:**
This level keeps the three session-keyed registries (`PENDING_COMPRESSIONS`, `PENDING_PHASE_COMPRESSIONS`, `PENDING_PROJECT_COMPRESSIONS`), the CLI fallback globals, `effective_session_id()`, `cleanup_compression_state()`, and the beginning of the core data model: `PendingTaskCompression`, `PhaseCompression`, and `ProjectCompression`. It also retains much of the regression test for advancing `start_index` past tool results, including the `call_A`/`call_B` orphaning scenario.

**What was lost that matters:**
The compressed text truncates before the full definitions of `ProjectCompression`, `PhaseCompressionRequest`, `ProjectCompressionRequest`, `CompressionMetrics`, and every main function after cleanup. Missing APIs include `set_pending_compression_range()`, `process_pending_compression()`, `compress_completed_task()`, `format_compressed_summary()`, `calculate_range_tokens()`, `compress_phase()`, `compress_project()`, and `extract_file_refs_from_messages()`. The most important non-obvious behavior, especially tool-result preservation, threshold skipping, project/phase consolidation, and token reset after compression, is absent from the main implementation and only partially visible through tests.

**Verdict:** Better than level 1 for recognizing the module's registry/data-model setup, but still not usable as an integration reference. The 24.17% size does not buy enough of the public API or critical implementation.

## Level 3 Review
**Compression ratio:** 19.34%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 3/10 | Preserves imports, global registries, and part of `cleanup_compression_state()`, then jumps to the tests; it loses even more of the data model than level 2. |
| Omission Clarity | 6/10 | Uses a visible `...[content truncated]...` marker, but still gives no scale or boundaries for the omitted region. |
| Critical Logic Preservation | 3/10 | Keeps a useful slice of the orphaned tool-call regression test, including the start-index advancement logic, but not the production function that applies it. |
| Usability | 2/10 | It shows the module purpose and one important bug pattern, but not enough callable surface or implementation detail to support integration. |

**What survived well:**
The module imports and registry declarations survived, along with the beginning of `cleanup_compression_state()`. The retained test fragment clearly shows the important orphaned `tool_use` issue: `start_index` begins at an assistant message with `call_A` and `call_B`, the naive drain range would remove matching tool results, and the fix advances `adjusted_start` past following `tool` messages.

**What was lost that matters:**
This level omits the definitions of `PendingTaskCompression`, `PhaseCompression`, `ProjectCompression`, `PhaseCompressionRequest`, `ProjectCompressionRequest`, and `CompressionMetrics`. It also omits all request and processing APIs, including `request_compression()`, `request_forced_compression()`, `process_pending_compression()`, `compress_completed_task()`, `process_pending_phase_compression()`, and `process_pending_project_compression()`. The retained test does not expose how the production code calculates tokens, skips compression below the 20% context fraction, inserts compressed knowledge, logs compression points, or resets session token tracking.

**Verdict:** This preserves one meaningful edge-case narrative, but fails as a compressed representation of the module. It is smaller than level 2 but not materially more useful than level 1 for integration.

## Overall Assessment
None of the three levels hits a good balance for this Rust module. Level 2 is the best of the three because it at least preserves the registry setup and part of the data model, but it still hides the public processing functions and the critical implementation paths. Toon does well at leaving a visible truncation marker and at preserving head/tail context, but it misses the actual semantic center of the file: `compress_completed_task()`, token accounting, phase/project compression, file-reference extraction, and session cleanup/reset behavior. For this file type, a better compression should preserve all public function signatures and struct fields, then summarize or omit routine bodies while keeping the non-obvious tool-result and token-accounting logic.
