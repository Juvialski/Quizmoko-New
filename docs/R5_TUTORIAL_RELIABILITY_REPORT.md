# R5 tutoring reliability — 28 October 2026

Base: `bf2266ac167e9d932ebb1828c53c8c648c370cda` (latest main, merged PR #16). Existing UI retained. All writable tests used isolated synthetic users/quizzes/results with Firestore and JSON persistence disabled. Production was opened read-only in the Codex browser and required login; no production records were accessed or changed. Chrome profiles were not used.

## Reproduced problems and fixes

| Reproduction | Fix and evidence |
| --- | --- |
| Ten-question generation failed: first provider response ended mid-JSON; second contained ten questions but currency answers failed option matching. | Match answer and option content after identical normalization. Saved response replay: 8/10 accepted before, 10/10 afterward. Batch drafting now uses the central 16,384-token allowance rather than the route's 8,192/12,288 overrides. The initial response's finish reason was not captured, so its truncation cause is unproven. |
| New fraction choices became `\dfrac{$5$}{$6$}`; currency choices became `\text{\$$60$}`. Editor showed broken commands and publication blockers. | Wrap complete numeric fractions/currency as one expression before number formatting; reject bare `\text` in centralized validation. Idempotence, key matching, invalid-key rejection and markup-preservation regressions pass. |
| Actual PDF extraction reported nonexistent missing questions C/D and numeric disagreements on all six items. PDF.js split each choice row into separate text runs. | Preserve PDF.js line endings. Replay of the real extraction now detects exactly `7a, 7b, 8 / 21, 22, 23`; ten diagnostics reduce to one conservative diagram/text comparison warning. No source IDs are rewritten. |
| At 390px mobile width, remove-choice targets were 29px wide; save/attach/add-choice controls were 40px high. | Targeted CSS increases these to at least 44px. Codex browser measurements confirm dimensions and no horizontal overflow. |
| Worksheet extraction displayed “No API keys with remaining quota” despite configured server Gemini. Sibling modes also required browser keys. | All worksheet modes now use an optional, safely parsed BYOK selector and submit an empty key for server fallback. Removed fabricated browser quota gates. Regression exercises all three real frontend extraction handlers with no browser key and verifies the server receives the request; malformed/blocked storage and legacy BYOK remain supported. |
| An account switch in the shared synthetic browser correctly caused HTTP 403 at final submission, but ended-session signals immediately retried in a loop and overwrote the failure view. | Finalization now latches automatic repeats after its first attempt. Existing explicit retry remains available for retryable failures. Actual submit-function regression injects 503, repeated end signals, then an explicit successful retry with the same answers. Access/grading protections are unchanged. Finalizing exact-answer questions no longer claims Gemini work is underway. |
| Visual preview of the second real extraction cut off the triangle’s 6 cm height label, although its answer key was correct. | Wider bounded lateral crop padding preserves the external label. Pixel regression retains the entire label marker for the observed box; real PDF replay and browser preview show both 6 cm and 8 cm. The synthetic item was repaired through the existing image-upload editor, invalidated, saved, explicitly approved and republished. |

## Actual Gemini and extraction results

Seventeen actual SDK calls total: thirteen to `gemini-3.5-flash-lite`, four to `gemini-3.1-flash-lite`; no provider failures. High-thinking profiles, quota queue and independent verification remained active. The cap was 24; testing stopped at seventeen. These calls cover two failed generation responses, one ten-question draft and independent checks, four PDF page extractions, and three six-item worksheet solve batches including targeted validation retries. The extra batches exercised live creation/recovery; they do not expand the sixteen unique independently checked items.

The live ten-question batch completed as a private draft with seven verified and three review-required items. Independent calculation checked all keys, rather than treating model agreement as proof:

| Item | Independent result |
| --- | --- |
| 1 | `3x+5-x+2 = 2x+7` (A) |
| 2 | `3/4+1/6 = 11/12` (B) |
| 3 | `3(2x-4)-2(x+1)=10` gives `4x=24`, `x=6` (B) |
| 4 | `80 × 3/4 = 60` dollars (B) |
| 5 | `4(2x-3)-3(x-5) = 5x+3` (B) |
| 6 | `(5/8)/(3/4) = 5/6` (A) |
| 7 | `x/3+4=9` gives `x=15` (B) |
| 8 | `20-(3×2.50+2×1.25) = 10` dollars (B) |
| 9 | `(2/3)(3/5+1/2) = 11/15` (B) |
| 10 | `5x-7=2x+8` gives `x=5` (B) |

All keys matched. Item 2 had equivalent distractors `2/5` and `4/10`; the synthetic teacher replaced one with `1/3` during review. This sample is not a general Gemini accuracy certification.

The synthetic two-page PDF contained six MC questions, fractions/equations, word problems and a labelled right-triangle diagram. Real rasterization/extraction returned HTTP 200, six of six exact printed IDs, four choices each, no failed pages and `incomplete:false`. Independent keys: `7a=5` (B), `7b=17/12` (C), `8=4×18=72` (C), `21=8×6/2=24` (B), `22=4×5=20` (C), `23=7y-8` (A). Both solver models completed; all six answers matched and quiz creation succeeded. Continued visual review found the crop defect above; correct keys did not establish diagram completeness. The corrected real crop is 1012×650 and retains both dimensions.

## Workflow and browser outcomes

- Actual routes: multiple generated stem/choice edits, private save, reopen, stale-update rejection, review publication rejection, explicit approval, publish and public answer-key stripping passed. Worksheet creation/publication retained all printed labels. Same-intent generation retry returned the same job. A concurrent worksheet solve correctly returned 429 while generation occupied capacity; retrying retained extracted questions succeeded without repeating extraction.
- Classroom routes: three synthetic students produced correct/incorrect/unanswered work and weighted totals 3/6, 1/6, 0/6. Progressive load, repeated grade/final submissions, end-run rejection of new answers, saved-work finalization and result access after a new run passed.
- Codex browser: synthetic 429 generation retained topic and restored its button; accepted generation remained visible across navigation. Editor text/choice edits immediately invalidated verification. Mobile published previews had 58 and 30 rendered MathJax expressions respectively, zero MathJax error elements, correct worksheet labels and a decoded diagram.
- Codex browser teacher monitor displayed three synthetic attempts, automatically updated a corrected score from 0/6 to 1/6, retained roster/totals on refresh, and received Ended state with disabled pause/end controls. Completed results remained visible after starting another run.
- `npm test`: **196/196 passed**, including typecheck, real Socket.IO polling, classroom admission/reconnect/termination and persistence fault/recovery coverage. Full suite ran once. Targeted CSS parser/scoping checks passed after the final mobile CSS change.
- Continuation: **32/32 focused frontend/lifecycle checks and 9/9 PDF tests passed**, plus typecheck. Three new workflow regressions cover optional server-key fallback, malformed browser settings and explicit-only finalization retry; the crop regression checks an external label. No duplicate full-suite run. Initial PR-head hosted CI also passed before the continuation changes.
- Browser continuation: multiple edits saved/refreshed/reopened with review indicators; publication succeeded (the user initially cleared native confirmation popups). Subsequent student, session and worksheet publication dialogs were handled through the Codex native window. Real extraction without browser keys returned all six items, both edited stems survived solving, and closing/reopening during an accepted 0/6 job recovered owner-scoped progress and disabled duplicate submission. Its saved draft opened and published through the UI.
- Three browser students finished at **1/6, 6/6, 0/6**, with correct/incorrect/unanswered feedback matching the teacher monitor. Mid-attempt refresh resumed the same question and timer. End Session, new session, empty replacement roster, new student admission and historical result access all passed. Restoring the switched account’s accepted work under its original identity finalized at 1/6 in the ended run.

## Remaining limits

The initial browser “timeouts” included native confirmation popups missed by the dialog API; they were not evidence of unresponsive application buttons. Native-window handling completed the later flows. Codex automatically declines worksheet `beforeunload` navigation (observed opening/closed events with `result:false`), so recovery was verified by closing/reopening the accepted running job rather than silently disabling the leave warning. First generation used real routes and live Gemini; the continuation reused its saved output for browser editing rather than spending another full generation batch.

Extraction abandoned before receiving a recovery handle still requires re-uploading the originals; process-memory page recovery expires after 30 idle minutes/restart. Diagram text-layer warnings remain conservative because measurements reside in images. Wider crop context can include neighboring source material on dense pages; visually review diagrams before approval. The test browser shares login cookies, so sequential actor changes require restoring the original identity; access denial was retained, not bypassed. No production durability/deployment or general accuracy claim is made. PR remains unmerged.

Browser evidence: [completed synthetic results](R5_BROWSER_RESULTS.jpg), [corrected worksheet preview](R5_BROWSER_WORKSHEET.jpg). Result summary cards cover the quiz’s synthetic history, while the search filters its three named browser students.

Reproduction fixtures: `test/r5-browser-server.ts` (test bootstrap required; optional explicit `--live`, existing local credential, bounded SDK ledger) and `test/r5-worksheet.py` (ReportLab). Private provider output, detailed route evidence and rendered fixtures remain under ignored `.local/r5/`.
