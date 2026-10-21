# R4.2 — Live classroom session reliability

Date: 2026-10-21 (Asia/Manila). Base: merged R4.1 `0e21d9acfed958c21e39d28aab9ea7641d818142`.

## Root cause and change

Termination previously belonged to the quiz's process-local live state. A new student inherited it. Roster recovery also used quiz identity plus a 24-hour window, mixing separate tutorials. Removing the anonymous reset was correct for security but left no authorized restart action.

The existing Live page now offers Start New Session, Pause/Resume and End Session with a human-readable start timestamp. Starting an active replacement requires confirmation; ending a session also asks for confirmation. Each control carries the selected run identity so stale tabs cannot control a later classroom. Opening monitoring changes no attempts.

`src/services/classroomRuns.ts` owns serialized first admission and teacher transitions. A secure UUID identifies each run. `live_runs/{quiz_id}` stores the current pointer, quiz, authorized owner, start time, status and pause flag. There is one small document per explicitly managed quiz, no migration and no startup seeding. Run changes and first admission await persistence; heartbeat/reconnect operations do not write new documents. Local fallback adds `data/live-runs.json`.

Each admitted attempt retains its established result/session ID and optional server-owned `live_run_id` and `live_run_started_at`. Grading-only standalone requests preserve their old write behavior. First standalone pings establish a standalone attempt so later runs cannot capture it. Client-supplied run IDs never select a binding. Admissions serialize with transitions before provider awaits; existing admitted heartbeats do not wait behind another attempt's grading lock.

## Isolation, recovery and compatibility

Managed monitoring reconstructs exactly the selected current run's results. There is no timestamp window. Earlier attempts cannot join its roster, move runs on refresh or emit current monitoring updates. Their canonical grades and final submissions remain in the existing Results workflow. Superseded run IDs are treated as closed; the lightweight current pointer does not retain a second historical roster store or add a run-history selector. Each run-associated result preserves its own run/start metadata.

Durable pause/end state restores from `live_runs` before accepting traffic. Persisted attempts restore authoritative grades and completion; `last_active=0` means Unknown/reconnecting until a fresh authorized ping. Whiteboard restrictions remain process-local and reset after restart; the monitoring page explicitly asks for reconfirmation. Restored completed attempts retain Completed status. Legacy completed results are not synthesized into a new standalone roster. No old result is rewritten or automatically assigned to a run. Existing published links, quiz definitions, drafts and result access remain unchanged.

Teacher roster events remain in owner/admin-only `monitor_*` rooms. Managed controls travel through `classroom_{quiz}_{run}` rooms joined only after account/capability authorization and server-side binding. Private whiteboard events retain existing `quiz_session_*` guards. Public rooms receive no names, grades, answers or session IDs, and public joins receive no managed controls. Old-run pings get their own terminal state, without current-run roster updates. Old standalone attempts can continue independently.

Revision/digest/proof identities, canonical grading, pending/error states, finalization locks and idempotent result IDs are unchanged. Final records explicitly preserve run metadata. Delayed grades update only their original attempt; starting a run never deletes or regrades earlier records. A whiteboard redraw guard also prevents late termination acknowledgments from reading a removed question page.

## Local validation

- Full regression suite: **187 passed, 0 failed**, including R1–R4.1 regressions and new lifecycle/durability tests.
- TypeScript/build: passed.
- Actual Engine.IO/Socket.IO tests: unauthorized run creation/end, monitor-room rejection, private attempt access, old-run room isolation and current-run controls passed.
- Three same-day runs: preserved earlier grades, isolated fresh rosters, rejected stale teacher controls and forged run metadata.
- Mocked delayed semantic grade: pending before completion; final score stays in the original run after replacement. Existing provider outage/pending and finalized immutability checks pass.
- Isolated persistence backend: admission and transition failure rollback, acknowledged run/attempt hydration, recovered pause/end, unknown presence/whiteboard and ten repeated heartbeats with zero additional writes passed.
- Standalone/historical compatibility: original records remain unchanged and unbound; progressive-load reads create no attempt.
- `npm run test:ui`: existing R4/R4.1 browser suites pass, including generation Preview → Back/refresh recovery, student reconnect and background worksheet recovery.
- Required R4.2 Chromium regression: **terminate morning → start afternoon → two new students answer normally**, afternoon-only roster, morning grades readable, old pings excluded, refresh identity/answers retained, pause/resume, explicit third-session replacement and desktop/mobile layout passed. No browser errors. Evidence: [`r4-2-browser/evidence.json`](r4-2-browser/evidence.json), with desktop/mobile screenshots. Real Express routes, Socket.IO and browser scripts; synthetic records and mocked Gemini only.
- Existing evaluations passed: AI gold corpus 136/136; offline R2 adversarial comparison; offline R3 grading comparison; local diagram expectations 17/17. These are not live Gemini performance or semantic visual acceptance.

## CI and merge gate

The consolidated PR runs the full regression suite, build, all three browser suites, offline AI/R2/R3 evaluations and dependency classification on its exact head. The CI workflow uploads R4.2 browser evidence. At report creation hosted CI is pending; the PR check rollup is the authoritative final status. Merge is conditional on the user's exact-head, compatibility, security and deployment prerequisite gates; no manual deploy is authorized.

## Production readiness: read-only evidence

Render workspace My Workspace was explicitly confirmed for read-only checks. QuizMoKo service `srv-d8apc25ckfvc73cld4e0` is configured for `main`, `npm start`, one instance and automatic deployment. The live deploy inspected was `dep-dbc8tmmk1f9s73bt4i5g`, R4.1 merge `0e21d9a`. Startup completed with service-account Admin Firestore and **234 quizzes, 251 results, 14 users**. `/healthz` returned HTTP 200 with `status=ready` and persistence ready.

R4.1 startup fails before traffic when `ai_jobs` history cannot be read; successful production startup/readiness establishes that existing credentialed read path. Runtime production validation also requires a strong secret and trusted origins. This release changes no Render environment values, stable secret, service account, IAM, provider/model profiles or SDK configuration, and requires no rotation. The observed service has a single instance; process-local guards still require one writable server.

Direct local Admin queries were unavailable: local configuration is project-only, without database credentials. No production data was changed to test writes. The new `live_runs` read/write path is verified against isolated persistence, not independently exercised on hosted Firebase before deployment. Successful R4.1 startup is existing-baseline evidence, not deployed R4.2 acceptance. Hosted R4.2 behavior, an actual production classroom and live Gemini correctness remain separate evidence. No manual production deployment, restart, secret retrieval, collection migration or destructive operation was performed.

## Remaining boundaries

- Single writable process remains required; no distributed coordinator was added.
- Whiteboard restrictions and online presence require fresh confirmation after restart.
- The current run pointer is lightweight; previous results stay accessible through Results without an additional historical run selector.
- Anonymous attempt IDs remain existing bearer capabilities. There is no new student account requirement.
- No new provider/model/API architecture, worksheet extraction change, Redis or paid realtime service.


## PR #9 review remediation (2026-10-21)

### Vulnerability and server fix

`bindClassroomAttempt()` correctly retained an existing attempt's immutable run binding, but callers treated binding as permission for further answers. The existing-record fast path therefore let stale clients send new answer revisions after End Session or replacement. Socket termination and current-run roster filtering did not enforce answer closure.

Answer admission is now separate from identity binding. `/api/grade_individual`, `/api/save_progressive_result`, `/submit` and `/api/submit_quiz` take the attempt lock and then the short classroom lifecycle lock to check the selected attempt against the active run. Before releasing the lifecycle lock, new accepted work records canonical revision, answer/snapshot digests and question digest in the existing grading state. Bulk admission records one immutable snapshot, with no per-question Firestore request. Teacher transitions and answer acceptance therefore have a single ordered boundary. The lifecycle lock is released before Gemini or slot waits. Binding finishes before answer admission; teacher transitions do not wait on a slow grading attempt lock.

New identities for ended, superseded or missing managed runs receive HTTP 409 / `CLASSROOM_SESSION_CLOSED`. No rejected request starts Gemini or replaces saved answers. Accepted in-flight individual and final-submit grading may finish after termination and stays attached to its original run; it cannot update the replacement roster. Existing revision/digest/proof and final-result guards remain authoritative. Retrieval and standalone attempts retain their contracts. Explicit owner/admin assessment endpoints retain their existing authorization; no historical bulk regrade was added.

Identical closed-run retries must match actual saved answer, revision, snapshot and question identities. Individual retries return the saved graded/pending/error outcome and never start new Gemini after closure. A revision containing the same text but never accepted is rejected. Closed progressive retries acknowledge existing state without rewriting progress. Saved work may finalize through either submit route; pending semantic work stays incomplete until its already admitted grader finishes or existing teacher review resolves it. Untouched unanswered items may remain unanswered, but cannot introduce new text or snapshots. Repeated finalization returns the same immutable result ID.

### Added and extended regressions

Four new actual HTTP tests cover:

- End and replacement: higher revisions, never-accepted same-text revisions, old reconnects and joined-but-never-answered students; reject mutations through all four endpoints, preserve answers/scores and assert unchanged mock SDK call counts. Completed retries use saved identity even after clearing process-local revision state. Both submit routes finalize accepted work idempotently; new-run students continue normally.
- Barrier-controlled individual Gemini: pending identity recorded before End Session; closed retry, attempted edit and early finalization do not start another SDK call; release provider only afterward, retain Run A grade and leave Run B empty.
- Eight concurrent HTTP answer/end/retry races, alternating dispatch order: saved answer/score and subsequent retry agree with the actual acceptance outcome; later revisions always fail.
- Barrier-controlled final-submit Gemini: End Session succeeds while final grading is blocked, then accepted grading finishes and both final-submit routes reuse the same immutable result.

The isolated durability regression now denies `live_runs` reads, confirms hydration rejects without changing remote results, restores read access and recovers ended/old-run state. Required startup hydration remains fail-closed: silently treating unreadable run history as empty could reopen closed classrooms. The operations guide now documents recovery without deleting data, changing secrets or enabling stale local fallback.

### Validation of the remediation

- Full local regression: **191 passed, 0 failed** (including R4.1 reliability/job recovery, R4.2 lifecycle/durability, actual HTTP and Engine.IO/Socket.IO authorization).
- TypeScript and build passed.
- All three isolated Chromium suites passed, including terminate morning -> start afternoon -> new students, old-result readability, current-only roster and background recovery. Screenshots were regenerated for validation; unchanged UI assets were not added to the fix.
- Existing offline evaluations passed: AI corpus 136/136, R2 adversarial comparison, R3 grading comparison and local diagram expectations 17/17. No live Gemini work was used for these regression claims.
- Exact new-head GitHub Actions status is recorded in the PR after pushing; the earlier `6029591` CI result does not certify this remediation.

### Hosted access evidence and remaining merge blocker

Using the user-confirmed Render workspace, current service inspection again shows QuizMoKo on main, `npm start`, one instance, automatic deployment. Read-only Render logs at 2026-10-21 10:08:46-10:08:58 UTC show service-account Admin Firestore initialization for the expected project and successful hydration of 234 quizzes, 251 results and 14 users. This is R4.1 baseline evidence.

Read-only Google Cloud Console IAM inspection now establishes that the project's Firebase Admin SDK service account has the project-wide **Firebase Admin SDK Administrator Service Agent** role, plus the existing authentication/token roles. The Deny tab reports no deny policies attached to this project. Google's [role reference](https://docs.cloud.google.com/iam/docs/roles-permissions/firebase#firebase.sdkAdminServiceAgent) describes read/write Admin SDK access, including Firestore entity permissions. [Firestore server IAM documentation](https://docs.cloud.google.com/firestore/native/docs/security/iam) distinguishes read/list from entity create/update. Accordingly, this grant covers `live_runs` as well as other collections for that principal; a collection-specific client security rule is not required. No IAM/rules change is indicated by this policy evidence.

**Still unverified:** this session has not independently established that the running Render credential uses that exact principal, nor issued a bounded `live_runs` query as the Render principal. Render MCP provides service/log inspection but no Firestore query, IAM evaluation or remote execution; this local process has no Admin credential or installed Google Cloud CLI. A Console-owner collection read would test a different identity, so it was not represented as service-account evidence. The grant is strong policy evidence, but it is not a direct hosted read/write test and does not by itself bind the opaque deployment credential to the inspected account.

**Deployment safety is not certified; leave PR #9 open.** Before merge, an authorized operator must establish the current runtime principal without revealing secret fields, correlate its effective read/list/create/update grants across configured databases and, where available, perform a bounded read-only `live_runs` query in that runtime. No production write is necessary to inspect IAM; a read-only probe alone must not be described as a successful write. No production records, credentials, IAM, environment variables or client rules were modified. No manual Render deployment or restart was performed.
