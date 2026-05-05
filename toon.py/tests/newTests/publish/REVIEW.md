# TOON Compression Review — publish

## File Info
- Original: publish.ts — 14689 characters
- Level 1: publish.txt — 6000 characters (40.85% of original)
- Level 2: publish2.txt — 3000 characters (20.42% of original)
- Level 3: publish3.txt — 9500 characters (64.67% of original)

## Level 1 Review
**Compression ratio:** 40.85%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 0/10 | The compressed file is Rust context-compression code, not the Bun/TypeScript publish script. None of the original imports, constants, functions, or interface are present. |
| Omission Clarity | 0/10 | There is no indication that the entire `publish.ts` source was replaced by unrelated content. Omission markers describe cuts in the wrong file. |
| Critical Logic Preservation | 0/10 | All publish logic is missing, including npm publish handling, version bumping, platform package batching, changelog generation, contributor lookup, and release tagging. |
| Usability | 0/10 | A developer using this compressed version would be integrating against the wrong module and wrong language. |

**What survived well:**
No source-relevant content survived. The original `import { $ } from "bun"`, `existsSync`, `join`, `PACKAGE_NAME`, `PLATFORM_PACKAGES`, and `PublishResult` interface are absent.

**What was lost that matters:**
Everything from the original file matters here: `fetchPreviousVersion()`, `bumpVersion()`, `updatePackageVersion()`, `updateAllPackageVersions()`, `findPreviousTag()`, `generateChangelog()`, `getContributors()`, `getDistTag()`, `checkPackageVersionExists()`, `publishPackage()`, `publishAllPackages()`, `buildPackages()`, `gitTagAndRelease()`, `checkVersionExists()`, and `main()` are all missing. The crucial `publishPackage()` handling for `EPUBLISHCONFLICT`, `E409`, `E403`, and npm registry verification is not present.

**Verdict:** Level 1 is a complete failure for this test case because it appears to be a compression of a different file. The 40.85% ratio is meaningless for usability.

## Level 2 Review
**Compression ratio:** 20.42%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 0/10 | Like level 1, this contains Rust context-compression snippets rather than the TypeScript publishing script. |
| Omission Clarity | 0/10 | It silently omits the real source file and even includes mid-token truncation such as `use se`, which is not an honest source-level omission marker. |
| Critical Logic Preservation | 0/10 | No original publishing, versioning, changelog, contributor, build, npm, git, or GitHub release logic survives. |
| Usability | 0/10 | This cannot help a developer run or modify `publish.ts`. |

**What survived well:**
Nothing from the original survived. The compressed output has Rust references such as `PlanTask`, `ChatSession`, `SessionId`, `estimate_tokens`, and a `task_compression_no_advancement_when_no_tool_calls()` test, none of which exist in `publish.ts`.

**What was lost that matters:**
The entire original script is lost, including environment controls `BUMP`, `VERSION`, `REPUBLISH`, `--prepare-only`, and `SKIP_PLATFORM_PACKAGES`; package names such as `oh-my-opencode-linux-x64-musl`; the `BATCH_SIZE = 2` platform publish loop; the `npm publish --access public --ignore-scripts` command; and the CI-only git tag/release flow.

**Verdict:** Level 2 is worse than normal over-compression because it is not a compressed representation of the requested file. It provides zero usable integration information.

## Level 3 Review
**Compression ratio:** 64.67%

| Criterion | Score | Notes |
|:--|:--|:--|
| Structure Preservation | 0/10 | The file is still unrelated Rust code; the original TypeScript structure is entirely absent despite the large 64.67% size. |
| Omission Clarity | 1/10 | Some omission markers are present in the Rust content, but they do not disclose that the TypeScript source was replaced. The visible `pub struct PhaseCompression` also appears cut mid-field at `pub compressed_at: ch`. |
| Critical Logic Preservation | 0/10 | None of the original publish workflow survives. |
| Usability | 0/10 | A reader would learn about session-scoped compression registries, not how to publish `oh-my-opencode`. |

**What survived well:**
No original `publish.ts` symbols survived. Searches for original identifiers such as `PACKAGE_NAME`, `publishPackage`, `publishAllPackages`, `PLATFORM_PACKAGES`, `Bun`, `npm publish`, `gitTagAndRelease`, and `fetchPreviousVersion` returned no matches in the compressed publish files.

**What was lost that matters:**
All important original behavior is gone: fetching the previous package version from npm, bumping semver while stripping prerelease suffixes, updating root and platform package versions, using previous beta tags for changelog comparison, filtering contributors, selecting dist-tags for prereleases, differentiating true publish failures from already-published packages, batching platform publishes to avoid OIDC token expiration, building packages, pushing tags before the branch, and creating the GitHub release.

**Verdict:** Level 3 spends more characters than level 1 or level 2 but still represents the wrong file. It is the least efficient failure because it is both large and unusable.

## Overall Assessment
None of the publish compressed levels are usable. The compressor or test fixture appears to have associated `publish.ts` with an unrelated Rust module about plan-driven context compression. TOON misses the entire original structure and all critical logic, including `publishPackage()` error classification, `publishAllPackages()` batching, and `gitTagAndRelease()` CI release flow. The best score for this file type would require preserving the TypeScript imports, top-level constants, all async function signatures, `PublishResult`, and concise bodies or summaries for the npm/git/gh command paths; these outputs preserve none of that.
