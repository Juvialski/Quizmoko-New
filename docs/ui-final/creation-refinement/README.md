# PR #16 — Create Quiz refinement

28 October 2026, Asia/Manila. Refines the existing `codex/ui-final-redesign` branch. Leave PR #16 open for owner review; do not merge or deploy automatically.

Start with the [desktop comparison](comparison-desktop.png), [mobile comparison](comparison-mobile.png), and [complete screenshot index](SCREENSHOTS.md). The 64 current screenshots cover AI/manual creation, all worksheet options, selected files, expanded settings, extracted review, generation errors and compatible direct-entry URLs at 1440px/390px in light/dark.

## What changed

- AI generation, manual creation and worksheet extraction now share a dedicated **Create Quiz** page state with one heading and method navigation. The library is hidden while creating. Manual creation is inline. Original forms, advanced options, key/local-model settings and task-retry links keep their controllers.
- Switching methods retains AI inputs, the manual title/folder and the same worksheet documents. Returning to the library within the page, then reopening Create, also retains those inputs. Browser history selects the corresponding method.
- Empty desktop worksheet forms use the available width for source files beside existing options and the extraction action. Worksheet/key pairs share a row. Mobile stacks the same controls; no extra content panels or decorative sidebars were added.
- Worksheet choices are **Questions**, **With answer key** and **RMX export**, with short outcome descriptions. Files and edits remain separate. RMX has its own Upload → Extract → Review → Export steps and explicitly says it produces a spreadsheet rather than a quiz.
- Inactive retained panels remain hidden even when grid styles apply. Crop overlays account for the top-level viewport when a source option is nested inside Create. Extraction completion opens the existing review surface, and draft completion reaches the top-level continuous editor.

This refinement changes no backend source, routes, provider configuration, data model or grading behavior. Editor, student quiz, results and live-classroom compositions are preserved.

## Visual comparison

The left column uses the original PR #16 screenshots at `209fcdb`, retained in [`../after/`](../after/). The right uses the current refinement. Both use the same synthetic classroom fixture and target viewport/theme; original screenshot scroll positions and form examples are preserved. These are rendered app screenshots, not mockups or a pixel-identical image-diff benchmark. Full individual captures are available from the index.

| Workflow | Before | Refined result |
| --- | --- | --- |
| AI generation | Form sits beside the quiz library, with separate creation launchers still above it | Dedicated Create surface with persistent method navigation, readable form width and full-width mobile topic input |
| Manual creation | Modal over the library | Inline title/folder form under the same Create heading |
| Worksheet questions | Compact upload column leaves much of desktop width unused | Source upload and useful file-limit guidance/options/action share one wide form |
| Worksheet + key | Two uploads stacked in a narrow column | Paired uploads beside the matching action; the same controls stack on mobile |
| RMX | Separate tool naming and a quiz-oriented progress sequence | Clearly labelled export option and four export-specific steps, retaining metadata and spreadsheet export |

The rendered first pass exposed an inactive worksheet upload showing beneath the answer-key document: a grid rule overrode `hidden`. The final pass fixes that rule and adds a browser assertion that hidden panels have no visible layout. Mobile review also led to stacking topic/folder fields, making difficulty full width, removing a duplicate worksheet heading and removing a redundant mobile return button. The main Quizzes navigation remains available.

## Relevant verification

| Check | Evidence |
| --- | --- |
| UI consistency + R4 authoring contracts | 21 tests passed; template/JS/CSS validation, private drafts, saved preview, publication and stale-save guards |
| TypeScript | `npm run check` passed |
| Create workspace | [`evidence.json`](evidence.json): retention across methods/library/history, all compatible URLs, actual manual/AI editor destinations, rate-limit recovery, extraction/source identity, nested crop placement, RMX XLSX ZIP export; zero browser errors, asset failures or horizontal overflow |
| Existing creation journey | [`tests/r4-browser.json`](tests/r4-browser.json): manual create/save/preview, single AI submission, review/publication/share, extraction to draft and responsive layouts |
| Owned-task and worksheet recovery | [`tests/r4-1-browser.json`](tests/r4-1-browser.json): original generation identity through Back/refresh, extraction recovery and owned-task completion |
| Worksheet Studio | [`tests/studio.json`](tests/studio.json): separate files/edits, keyboard tabs, theme synchronization, source `7b`, real spreadsheet export, 390/768/1366/1920px |
| Shared workflow preservation | [`tests/workflow.json`](tests/workflow.json): continuous editor duplicate/reorder/save, mobile results/actions and student whiteboard, crop placement and active-classroom return links |
| Existing UI audit | [`tests/ui-audit.json`](tests/ui-audit.json): generator advanced settings/quota, search/filter and responsive presentation |

Local checks were limited to creation, shared UI and the affected authoring/recovery journeys; the full backend and model-evaluation suites were not rerun locally. GitHub's existing CI remains unchanged and runs its configured checks on the PR commit.

Captures use real CDN fonts/icons/MathJax and actual local templates/scripts. Generation/extraction providers and Firebase browser modules are mocked; RMX workbook generation and app save routes are real. No production account or student records were used. Source hashes: [`source-fingerprints.json`](source-fingerprints.json).

## Limits and reproduction

Files and unsaved edits are retained while the document remains open. Refresh cannot restore native file selections. Existing owned-job recovery remains available. The retained worksheet document boundary is intentionally preserved. Owner acceptance, live Gemini accuracy and production Firestore durability are not established by these screenshots or mocked journeys.

Run `npm run test:ui-final` for the focused shared/Create journeys. Capture with `node scripts/test-create-workspace-browser.mjs --capture`, then build comparisons with `node scripts/index-create-workspace.mjs`. The synthetic fixture server uses local port 3000. No merge or rollout is authorized.
