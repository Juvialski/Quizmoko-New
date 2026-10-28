# QuizMoKo tutoring workspace — visual review

**Ready for owner screenshot review. Do not merge or deploy automatically.** Base: latest `main`, `e9775b4`, including merged PR #15. Review date: 28 October 2026, Asia/Manila.

**Latest creation refinement:** [Create Quiz review packet](creation-refinement/README.md), [desktop comparison](creation-refinement/comparison-desktop.png), [mobile comparison](creation-refinement/comparison-mobile.png), and [64 updated screenshots](creation-refinement/SCREENSHOTS.md). This supersedes the creation images and compact-upload description below. The original 112-image packet remains the before-refinement evidence and the review source for the preserved editor, student, results and classroom layouts. Current focused checks are in the new packet; the broader validation below records the original PR pass.

Start with the [desktop comparison](comparison-desktop.png), [mobile comparison](comparison-mobile.png), then the [complete screenshot index](SCREENSHOTS.md). The index links every state at **1440px and 390px, in both light and dark modes**. The matched comparisons contain synthetic mathematics records, not real student data.

## What changed

- **One workspace:** shared navigation, typography, consistent controls and light/dark tokens across teacher pages. Quiz context links the editor, live monitor and results. Existing active classroom runs appear on the dashboard with a direct return link.
- **Creation:** manual, AI and worksheet inputs share a dedicated Create Quiz surface and method navigation. The library is hidden while creating; original AI/manual forms and worksheet documents retain their own input. Manual creation is inline, and generation still supports job-retry deep links. The first-visit tour points to visible workspace sections.
- **Continuous editing:** all questions remain on one page. Duplicate, delete and move actions are directly accessible. Points and solutions edit inline. Letter-based answer selection avoids repeating the full choice text a third time. The rendered student preview remains beside the editor on desktop and below it on mobile. Save, publication, review and conflict states still use the existing controllers.
- **Worksheet flow:** Questions, With answer key and RMX export sit within Create Quiz, with separate retained files and edits. Desktop uploads place files beside useful options/actions, and paired uploads share a row; mobile stacks them. Completed extraction opens the existing review. Actual questions/current jobs drive progress. Retained documents resize with their content and keep crop/progress dialogs inside the visible top-level viewport.
- **Teaching and checking:** classroom controls are grouped above the roster. Mobile roster/results use labelled rows with reachable actions. Student questions keep their reading width; the working canvas follows vertically and provides a return-to-question control. Display settings are progressive. Result dates use local display formatting, and percentages use readable precision. Student result pages use a result header instead of teacher navigation.

The [design system](DESIGN-SYSTEM.md) documents the shared foundation. Backend changes are limited to presentation data for existing active runs and selecting teacher/student result navigation. No endpoint contract, provider/model setting, authentication rule, grading logic, schema or persistent store was changed.

## Investigation and architectural decision

Chrome **Al** production inspection covered dashboard/library actions, AI form and manual dialog, the continuous draft editor, saved preview, all three worksheet modes, the live classroom controls and student entry. Production was inspected without starting a classroom, recording an attempt, changing saved questions or running paid AI work. Native production images are in [before/production](before/production); [its manifest](before/production/manifest.json) distinguishes requested viewport size from the dimensions returned by Chrome. These support the observations; the sibling synthetic PNGs provide the exact matched-width comparisons.

Observed problems included repeated creation/navigation actions, a mobile header/dashboard that pushed the library down, hidden editor operations, repeated answer text, a historical task shown as current upload progress, nested worksheet scrolling, and a student wrapper wider than the viewport. Mobile results hid actions behind sideways scrolling. These findings informed the layout changes above.

The three worksheet documents have working, independently stateful upload/crop/provider/export controllers. This revision retains that boundary and unifies presentation: one top-level navigation, content-sized retained documents, synchronized theme, truthful current-step status, visible-viewport overlays with keyboard focus retained in crop dialogs, and compatible direct-entry URLs. Modes still keep **separate** files and edits; switching mode does not copy or reprocess inputs.

## Visual refinement

The first rendered pass was inspected before a further refinement pass. [Intermediate student split view](refinement/student-split-before-refinement.png) shows why the working canvas needed to move below mobile questions. The final mobile question toolbar wraps, and both End Quiz and whiteboard actions fit. Results were changed from a horizontally scrolling table to labelled rows, with a check on the inner wrapper as well as the page width. Empty worksheet and completed review layouts were corrected to remove an empty side column. Generator alignment/field space, editor touch targets, inline points/solutions, contrast and shared spacing received a second pass.

Final images use actual app routes/templates/scripts, real CDN fonts/icons and **real MathJax**. They are rendered screenshots, not design mockups. See [before capture evidence](before/capture-evidence.json), [after capture evidence](after/capture-evidence.json) and [source fingerprints](source-fingerprints.json). Math rendering was inspected in the editor, preview, student question, feedback and paper view. Saved preview disables automatic startup typesetting because its existing renderer already requests a pass; the capture checks for nested duplicate accessibility math. The final target-width capture has no page overflow, page errors or failed asset requests.

## Validation

| Check | Result / evidence |
| --- | --- |
| Full application suite | `npm test`: **194 passed**, 0 failed; includes classroom admission/recovery, job durability, grading and persistence regressions |
| Final targeted checks | UI consistency, R4 workflow and quiz flows: **82 passed**, 0 failed |
| Build | `npm run build`: passed |
| Existing browser journeys | `npm run test:ui`: passed; see [test evidence](tests/) |
| Worksheet Studio | `npm run test:studio`: passed; real XLSX ZIP export, three-mode input retention, keyboard tabs, recovery and theme synchronization |
| New redesign journey | [workflow-evidence.json](workflow-evidence.json): duplicate/reorder, immutable source metadata, inline points/solution persistence, generator focus, mobile feedback/actions, inner overflow, retained-mode crop placement, student whiteboard and active-classroom return link |
| Visual captures | 108 baseline images and 112 final images; 27 matched states plus the new whiteboard view, each at two widths and two themes |

Existing browser evidence is copied under this packet so historical review directories retain their original snapshots. The browser suite exercises manual creation/save/preview, mocked generation and extraction, publication guards, save failures/concurrent edits, roster recovery, closed-run stale-answer rejection, pending grading, worksheet job restoration, thirty-question continuous editing, diagram decode failures and print scaling. The new journey covers the added presentation mechanics. Mocked provider calls establish UI/recovery behavior, **not Gemini mathematical accuracy**.

## Remaining review and limits

- Owner acceptance of the visual design and daily tutoring flow is still required. Nothing was merged or deployed.
- Live Gemini generation/grading/extraction and production Firestore persistence were not re-evaluated for this presentation task. Existing backend invariants and tests are retained.
- Chrome production inspection was read-only. Mutating workflows were exercised with isolated synthetic records. This does not claim every destructive admin/library action was executed against production.
- Screenshots cannot establish drawing feel, long-session behavior or every device/browser combination. A real classroom smoke test after a separately approved rollout remains appropriate.
- Worksheet controllers remain in retained same-origin documents. Inputs stay separate by design; this is not an iframe-free implementation.

Reproduce comparisons with `node scripts/capture-ui-final.mjs --before` and `node scripts/capture-ui-final.mjs`. Both use an isolated fixture server on port 3000; stop other local fixture servers first. No production data or provider credentials are loaded. Run `npm run test:ui-final` for the added functional journey.
