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
