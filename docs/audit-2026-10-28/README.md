# Daily mathematics audit — 28 October 2026

Baseline: main `494b656` (includes PR #12). No open GitHub issues were listed. PR #9 separately addresses closed classroom runs and still has an unresolved production access gate; PR #13 includes an overlapping RMX export fix and a broader UI proposal. Neither was merged here.

## Findings and changes

- RMX export returned HTTP 500 because installed Archiver 8 exports `ZipArchive`, while the endpoint called the module as a function. The endpoint now creates a ZIP with that class. A regression reads the returned ZIP and workbook, checking a printed ID, choice and answer. This overlaps PR #13.
- After a generation job completed, the dashboard's inline message still said it was generating even though the task panel showed completion. The message now follows the accepted job's terminal status, including failures and review items. A browser check covers completion and a simulated failure.
- The answer-key page implied the AI simply follows the extracted key. It now tells teachers that the key is retained, independently checked and conflicts need review. The upload hint now includes WebP and GIF, consistent with the stated accepted formats.

## Verification

- `npm test`: 184 tests passed on baseline, including TypeScript and mocked AI/quality and grading checks. After the changes, `npm run check` passed and the focused R4.1 reliability file passed 15 tests, including the new actual ZIP endpoint test. The export test failed with HTTP 500 before the fix and passed afterward.
- `node scripts/test-r4-1-browser.mjs`: passed with isolated synthetic data and mocked Gemini. Four students joined, answered concurrently, reconnected, and a final submission updated the monitor. A three-page PDF retry preserved successful pages; generation and worksheet jobs survived navigation. The final submission uses the HTTP route from the browser, so this is not a complete click-by-click student submission journey.
- `node scripts/test-worksheet-editor-browser.mjs`: passed using isolated synthetic data and mocked Gemini. Thirty cards stayed visible; edited choices and answer survived save/reload; explicit review and publication worked; blank choices were blocked.
- Production Chrome profile Al: dashboard, generator, worksheet, answer-key and RMX entry screens inspected. A real Gemini generation of two linear-equation questions completed in a private draft. Manual calculation confirmed the selected answers: x/3 + 5 = 9 gives 12, and 2x/3 - 1/2 = x/4 + 2 gives 6. This small sample does not establish general model accuracy. The audit draft remains in production; it was not published.

## Remaining limitations

This was not an exhaustive click test of every button, navigation path or production student workflow. Live worksheet extraction, diagrams, multi-page provider accuracy, live semantic grading, production durability and real classroom reconnect/load behavior were not independently established. Extraction retry and provider failure checks above use mocks. Continue teacher review of generated and extracted work. Main's known stale-client closed-run admission problem remains outside this PR; see PR #9 and its deployment gate. Production was not deployed or merged by this audit.

## Screenshots

The PNGs in this directory use isolated synthetic fixtures. `generator-{before,after}-{desktop,mobile}.png`, `worksheet-{before,after}-{desktop,mobile}.png`, and `answer-key-{before,after}-{desktop,mobile}.png` show the changed surfaces. Dashboard, live monitor, worksheet and editor captures provide additional context. Production captures, which may show private library/task details, are retained locally under `.local/audit-2026-10-28/production/` and are not committed.
