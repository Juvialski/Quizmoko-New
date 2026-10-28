# Unified UI redesign — 25 October 2026

The three worksheet entry points now initialize Worksheet Studio, with the same header, keyboard-accessible mode tabs, five-step progress, upload surfaces, question cards and action styling. Each mode retains its own files and edits while the workspace remains open. Existing URLs, crop tools, source metadata, answer-key matching, RMX metadata/export, job recovery and provider configuration remain in their existing implementations.

The dashboard exposes Generate with AI, Worksheet to Quiz, My Quizzes and Results together. Blank creation remains available. The desktop layout fills the available screen width. The generator and library can sit side by side; the editor keeps all questions and its sticky save/preview/publish controls. Student, monitor and result pages share the same restrained colors, borders, buttons and theme tokens.

Following owner feedback, the top area was compacted further: smaller branding, four primary actions, shorter dashboard heading, and collapsed finished-task history. Active tasks open automatically; terminal links, errors and retry controls remain accessible through the disclosure. Mobile Studio uses a compact header and stacked forms. Admin tools remain accessible through the dashboard.

Expandable settings and question tools share bordered disclosure panels, full-width 48px headers, keyboard focus indicators, consistent chevrons and clear open-state separation. Responsive button changes animate colors only, avoiding transient width/padding overflow when switching viewport sizes. Dark screenshots wait for theme transitions to finish.

RMX exposes extraction options and export metadata in separate disclosures, preserving model selection, diagram capture, year, test name and contest fields. Dual uploads use compact surfaces so the extraction action remains easier to reach.

## Implementation boundary

Studio retains the initial document in place and lazily mounts other existing mode documents in same-origin frames. This preserves specialized controllers and their native File objects without risky backend consolidation. Switching tabs does not reload them or transfer inputs. Closing/reloading the page cannot restore native File inputs; existing owned-job recovery still works. A leave warning protects changed inputs. RMX uses Export in the final workflow step rather than claiming it creates a quiz draft.

One pre-existing export failure was found and fixed: Archiver 8 exposes `ZipArchive`, whereas the RMX route still called the removed factory. Its ZIP/workbook contents and endpoint contract are unchanged. RMX extraction also prevents duplicate submission and always clears its polling timer.

No Gemini models, thinking profiles, grading rules, API-key configuration, Firestore schemas or classroom-run code changed. PR #9 remains untouched. Production was inspected read-only through Chrome Al with Hubstaff stopped; no production records were changed.

## Validation

- `npm run build`: TypeScript/build checks pass.
- `npm test`: 184 tests pass, zero failures.
- `npm run test:ui`: all five existing isolated browser suites pass, including editing/saving/publishing, student navigation, monitoring, recovery and diagram lifecycle.
- `npm run test:studio`: retained mode files/edits, answer-key extraction/review, real RMX ZIP/Excel download, accessible tabs, draft creation, compatible navigation, synchronized themes and responsive layouts.
- Studio browser matrix: 390, 768, 1366 and 1920 pixels, light and dark themes. Page errors and unexpected failed requests are checked.
- Before/after screenshots use the same synthetic records and baseline commit `494b656`; see [screenshot index](SCREENSHOT_INDEX.md). Real fonts/icons/MathJax are loaded for visual captures; functional tests isolate external assets.

Mock extraction and solver responses are intentional. These checks do not certify Gemini accuracy, production Firestore durability or every crop-drag interaction. Native File objects are preserved during mode switching, not across refresh. Visual approval remains with the owner; do not merge or deploy automatically.
