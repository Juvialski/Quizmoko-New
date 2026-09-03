# QuizMoKo Improvement Roadmap

> **Planning document — not current-state architecture**
>
> Current-state architecture remains authoritative in [`APP_WORKFLOW_MAP.md`](./APP_WORKFLOW_MAP.md) and [`workflow-map.json`](./workflow-map.json).
>
> This roadmap records improvements identified from the September 3, 2026 full-app audit. Items here are proposed work until merged into `main` and reflected in the canonical architecture map.

## 1. Purpose

QuizMoKo already has a strong correctness core: canonical server-side grading, answer revision/digest checks, final-attempt locking, fail-closed AI verification, worksheet source provenance, dual-model solving, public answer sanitization, and bounded worksheet AI jobs.

The next work should therefore **not** be a broad rewrite. The highest-value improvements are around production safety, secret handling, access boundaries, persistence reliability, modularity, browser security, and product/admin completeness.

This roadmap deliberately separates:

- **Phases 1–3:** real security, durability, and operational risks;
- **Phase 4:** backend engineering-risk reduction;
- **Phases 5–7:** maintainability, AI/product improvements, and later expansion.

Execution order should normally remain:

**Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7**

Do not start a later architectural phase merely because it is easier while an earlier safety phase remains incomplete.

---

## 2. Current strengths to preserve

The following systems have already received substantial hardening and should not be rewritten without specific evidence of a defect:

1. canonical question normalization and deterministic grading;
2. answer revision and digest identity;
3. semantic grade proofs;
4. final-attempt locking and idempotent submission;
5. fail-closed AI question verification;
6. dual-model worksheet solving and adjudication;
7. worksheet `original_index` source-number preservation;
8. public quiz answer/solution/provenance sanitization;
9. result capability-token design;
10. centralized Gemini task profiles and per-model RPM limiter.

Changes touching these areas must preserve existing invariants and add targeted regression tests.

---

## 3. Audit findings summary

| Priority | Area | Current finding |
|---|---|---|
| High | Result privacy | Signed-in student access still has a legacy `student_name` == account name/email authorization fallback. Names are not stable authorization identities. |
| High | BYOK security | Gemini keys can remain in browser `localStorage`, travel through request bodies, and be stored as `stored_custom_key` on user records. |
| High | Production durability | `.env.example` describes Render production as Firestore-required by default, while the implementation currently defaults `REQUIRE_FIRESTORE` to false when unset. |
| High | Deployment secrets | Missing/weak production `SESSION_SECRET` should fail startup rather than silently degrade stable session/result capability behavior. |
| High | Regression protection | The repository has a strong automated test suite but no permanent committed CI workflow protecting every PR/main change. |
| Medium-high | Demo state | `teacher_test` admin and sample quizzes are pre-populated in the database module and should not be implicit public-production state. |
| Medium | Public attempt boundary | Public attempt/progressive/live APIs depend heavily on possession of opaque quiz/session identifiers rather than a dedicated attempt capability. |
| Medium | Realtime boundary | Socket.IO currently accepts broad origins and process-local telemetry/rate state. |
| Medium | Verification provenance | Question verification/teacher-approval metadata can be carried through editor payloads; server ownership of audit metadata should be stronger. |
| Medium | Persistence complexity | Memory + local JSON + Firestore is resilient but has ambiguous production fallback semantics and substantial coordination complexity. |
| Medium | Resource usage | Worksheet jobs are bounded per file, but aggregate page rasterization, image dimensions, snapshot volume, and memory pressure can be tightened. |
| Medium | Backend maintainability | `gradingRoutes.ts`, `aiRoutes.ts`, and `worksheetRoutes.ts` are large orchestration modules with repeated policies/helpers. |
| Medium | Frontend maintainability | Major EJS pages contain extensive inline JavaScript and CSS. |
| Medium | Web perimeter | Security headers/CSP are not centralized, while multiple pages rely on inline scripts and third-party CDNs. |
| Maintenance | Dependencies | The PR #1 clean install reported 10 moderate and 3 high npm audit findings; these require classification rather than blind force upgrades. |
| Product | Admin | Usage stats/sync-history endpoints are placeholders and admin usage reporting is incomplete. |
| Product | Lifecycle | Quiz deletion currently removes associated results instead of providing an archive/trash lifecycle. |

---

# Phase 1 — Production Safety & Security

## Objective

Make insecure or non-durable production deployment fail closed, and make the test suite an automatic merge gate.

## Scope

### 1. Permanent CI

Add a committed GitHub Actions workflow for pull requests and `main` that runs at minimum:

- `npm ci`;
- `npm test`;
- `npm run build`;
- TypeScript/check gate;
- `git diff --check` where applicable;
- EJS lint/regression checks for changed critical templates if a dedicated check exists.

CI must be deterministic and must not require live Gemini credentials for the normal regression suite.

### 2. Result authorization hardening

Remove `student_name` == authenticated account name/email as an authorization mechanism for modern results.

Allowed modern result access should be only:

- administrator;
- quiz owner/authorized teacher;
- exact persisted `user_id === req.user.uid`;
- valid result capability token.

Keep the explicit high-entropy legacy capability-result path only where required for compatibility.

Add regressions proving:

- two students with the same display name cannot access each other's results;
- matching email text in `student_name` is not sufficient;
- exact `user_id` works;
- result capability token works;
- quiz owner/admin works;
- legacy 20-character capability result behavior remains intentional.

### 3. Firestore production fail-closed behavior

Align implementation with documented deployment expectations.

When running in normal Render production, credentialed Firestore should be required by default unless an explicit supported override is intentionally provided for a controlled environment.

Production must not quietly become "local-disk-only" because `REQUIRE_FIRESTORE` was omitted.

### 4. Stable production session secret

Production startup must fail when `SESSION_SECRET` is missing or does not meet the minimum strength contract.

Target:

- stable across restarts;
- 32+ characters;
- no randomly generated production fallback.

Development/test fallback behavior may remain convenient where explicitly safe.

### 5. Demo/test isolation

Ensure public production cannot implicitly expose:

- `teacher_test` admin access;
- arbitrary demo auth;
- sample quizzes seeded as real tenant content.

Demo/test seed state should be enabled only under explicit development/test/sandbox configuration.

### 6. Admin safety guard

Prevent accidental actions that would leave the installation with no active administrator where applicable.

At minimum, protect against blocking/demoting the last active admin through the normal admin route.

### 7. Baseline security headers

Add low-risk centralized headers first:

- `X-Content-Type-Options: nosniff`;
- appropriate `Referrer-Policy`;
- clickjacking protection (`frame-ancestors` later via CSP and/or legacy header during transition);
- conservative `Permissions-Policy`;
- correct cache rules for authenticated/private/result endpoints.

Do **not** introduce a strict CSP in this phase if it would break the current inline-script EJS architecture.

### 8. Dependency vulnerability classification

Run a fresh `npm audit --json` and classify each high/moderate issue as:

- direct runtime;
- transitive runtime;
- development/test-only;
- unreachable/not applicable;
- update available without breaking change;
- update requires planned breaking migration.

Perform minimal safe updates only. Do not use `npm audit fix --force` blindly.

## Phase 1 completion criteria

Phase 1 is complete only when:

- every PR automatically runs the permanent CI gate;
- all CI checks pass on exact head;
- name/email result authorization is gone for modern results;
- production refuses unsafe Firestore/session-secret configuration;
- demo seed/auth cannot activate accidentally in public production;
- dependency audit findings are documented and safe compatible updates are applied;
- architecture map and AGENTS documentation are updated for any changed runtime invariants.

---

# Phase 2 — BYOK, Public Attempts & Realtime Hardening

## Objective

Keep public quizzes simple while preventing raw teacher AI credentials and student attempt state from depending on browser-held secrets or guess-resistant IDs alone.

## Scope

### 1. Server-only BYOK model

Remove raw Gemini keys from long-lived browser storage.

Target browser behavior:

- user may enter/update/delete a key;
- raw key is sent once over authenticated HTTPS for configuration;
- browser receives only state such as `custom_key_configured: true`;
- raw key is not written to `localStorage`, normal page HTML, API responses, logs, backups, or admin listings.

### 2. Encrypt teacher AI credentials at rest

Do not store raw `stored_custom_key` values as ordinary user-record fields.

Introduce a dedicated encryption secret, separate from `SESSION_SECRET`, with authenticated encryption and explicit key versioning/rotation strategy.

Stored teacher credentials must be excluded from:

- database export;
- user admin APIs;
- Firestore browser-readable documents;
- logs;
- architecture/debug snapshots.

If keeping encrypted credentials in the same datastore is undesirable, use an isolated server-only credential store abstraction.

### 3. Central AI credential resolver

All AI and worksheet routes should call one service such as:

`resolveTeacherAiCredential(userId, requestContext)`

Routes should stop independently deciding whether to read:

- request `api_key`;
- `stored_custom_key`;
- environment `GEMINI_API_KEY`.

The resolver should establish one auditable precedence and policy.

### 4. Remove raw API-key request plumbing

Once server-only BYOK is established, remove `api_key` fields from authenticated frontend API contracts wherever possible.

AI work-cost classification should distinguish server-funded vs user-BYOK based on server credential metadata, not by checking whether a browser sent a key.

### 5. Attempt capability

Create a short-lived cryptographic attempt capability when a browser starts a quiz.

Bind it to at least:

- quiz ID;
- session ID;
- issued time/expiry;
- stable server secret.

Require or verify it for attempt-specific operations such as:

- grade individual;
- progressive save;
- progressive restore;
- semantic explanation;
- live ping/socket attempt registration.

Do not make students authenticate merely to take a public quiz.

### 6. Realtime origin and abuse protection

Restrict Socket.IO production origins to configured application origins.

Add bounded connection/message telemetry controls without trusting student-supplied score data.

### 7. Session-ID fallback cleanup

Modern browsers already support Web Crypto. Remove or fail closed on the weak `Date.now() + Math.random()` fallback for security-sensitive session IDs.

## Phase 2 completion criteria

- no persistent raw Gemini key in browser storage;
- raw teacher BYOK is encrypted/server-only;
- one credential resolver controls AI credential selection;
- authenticated AI/worksheet routes no longer depend on browser `api_key` payloads where avoidable;
- student attempt endpoints require a valid attempt capability;
- Socket.IO origins are deployment-configured;
- attempt/session security regressions are covered automatically.

---

# Phase 3 — Persistence & Resource Reliability

## Objective

Make production durability and resource consumption predictable under real worksheet/live usage.

## Scope

### 1. Clarify persistence authority

Production contract should become explicit:

- Firestore = authoritative durable store;
- in-memory Maps = active hot state/cache;
- local JSON = development/recovery/controlled fallback, not ambiguous primary production durability.

### 2. Disable unsafe production web-SDK persistence fallback

Unauthenticated Firebase web-SDK fallback may remain for supported sandbox/development environments, but normal production should use credentialed Firebase Admin only.

### 3. Persistence service separation

Begin separating `src/store/db.ts` responsibilities into bounded modules without changing behavior, for example:

- store state;
- local snapshot persistence;
- Firestore adapter;
- Firestore chunking;
- persistence health/readiness;
- hydration/recovery;
- ordered mutation queue.

This can be incremental. Do not combine it with data-schema redesign unless necessary.

### 4. Worksheet aggregate resource limits

Add limits that account for the whole job, not only one file:

- maximum total PDF pages across all files;
- maximum decoded/raster pixel count;
- maximum image width/height;
- maximum rasterized bytes in flight;
- bounded parallel page rendering;
- early rejection before expensive AI calls.

### 5. Stronger upload validation

Validate actual file signatures/magic bytes for supported PDF/image formats rather than trusting browser MIME type alone.

### 6. Whiteboard/snapshot storage reduction

Review the current per-attempt snapshot ceiling and storage representation.

Reduce unnecessary base64 overhead through:

- client-side image resizing/compression;
- strict image dimensions/quality;
- fewer redundant snapshots;
- optional object/blob storage only if it materially simplifies Firestore document size.

Do not migrate storage merely for architectural purity.

### 7. Ephemeral-state TTL

Add explicit cleanup/TTL for inactive:

- live sessions;
- generation progress;
- rate/AI-work buckets where needed;
- stale revision state.

### 8. Recovery verification

Add tests for:

- Firestore required/unavailable startup;
- partial collection hydration failure;
- ordered write rollback behavior;
- restart/local recovery;
- large/chunked result round trip;
- graceful-shutdown flush.

## Phase 3 completion criteria

- production persistence authority is unambiguous;
- Firestore Admin is the normal production durable backend;
- worksheet/image jobs have aggregate memory/size protections;
- uploaded data is signature-validated;
- large snapshots are meaningfully reduced or bounded;
- transient process state self-cleans;
- persistence failure/recovery behavior has automated coverage.

---

# Phase 4 — Backend Contract & Modularization

## Objective

Reduce regression risk from large route files and browser-owned audit metadata without changing public product behavior.

## Scope

### 1. Central authorization services

Replace repeated route-local helpers with shared, tested policy functions for:

- `canManageQuiz`;
- result access;
- admin capability;
- AI credential management;
- legacy compatibility access.

### 2. Request schema validation

Introduce consistent validation for major JSON API contracts rather than ad hoc field parsing across routes.

Do not introduce a large framework migration; use a lightweight schema approach compatible with the current Express architecture.

### 3. Split grading orchestration

Move domain work out of `gradingRoutes.ts` into services such as:

- attempt identity/revision service;
- individual grading service;
- progressive-result service;
- final submission service;
- explanation service.

Routes should remain thin HTTP adapters.

### 4. Split AI authoring orchestration

Separate `aiRoutes.ts` into bounded services for:

- quiz drafting;
- single-question generation;
- transformation/polish;
- verification/adjudication;
- variants/import/transfer.

### 5. Split worksheet orchestration

Separate `worksheetRoutes.ts` into:

- upload/extraction;
- recovery;
- answer-key/golden handling;
- solve;
- quiz finalization;
- RMX import/export.

Keep source-order and worksheet-verification invariants centralized.

### 6. Server-authoritative teacher approval

Move teacher answer approval/audit creation to an authenticated server endpoint.

The server should own fields such as:

- `teacher_approved`;
- `teacher_approved_at`;
- `teacher_approved_by`;
- `teacher_approval_method`;
- verification status transitions.

Ordinary quiz update payloads must not be able to forge these fields.

### 7. Verification transition policy

Define explicit allowed transitions, for example:

- AI draft → review_required;
- dual agreement/adjudication → verified;
- semantic content edit → review_required;
- explicit teacher approval → verified/manual;
- resolve/re-solve → review_required until teacher confirms when required.

Add tests proving invalid transitions are rejected.

## Phase 4 completion criteria

- route files are substantially thinner;
- shared authorization policy is centralized;
- verification/audit metadata is server-authoritative;
- no public endpoint behavior is unintentionally changed;
- existing grading/worksheet/AI regressions remain green;
- architecture map reflects new service boundaries.

---

# Phase 5 — Frontend Modularization & Browser Security

## Objective

Make UI changes safer without rewriting QuizMoKo into a SPA.

## Scope

### 1. Keep EJS

Do **not** migrate to React/Next/Vue solely for code organization.

Retain server-rendered EJS and progressively extract reusable browser modules.

### 2. Extract page JavaScript

Target modules may include:

- `dashboard.js`;
- `edit-quiz.js`;
- `quiz-attempt.js`;
- `worksheet-upload.js`;
- `worksheet-answers-upload.js`;
- `results.js`;
- `live.js`;
- `admin.js`.

### 3. Extract page CSS

Move large inline `<style>` sections into versioned page/shared stylesheets while retaining existing visuals.

### 4. Shared browser utilities

Centralize:

- safe math/display HTML sanitation;
- MathJax scheduling;
- API request/error handling;
- clipboard support;
- dialogs/modals/focus trapping;
- icon refresh;
- source-ID display utilities;
- loading/progress UI.

### 5. Pin/self-host browser dependencies

Avoid unversioned URLs such as `lucide@latest`.

Pin exact browser library versions and preferably self-host critical static dependencies where practical.

### 6. CSP migration

Once inline scripts/styles are sufficiently reduced, introduce a practical Content Security Policy with nonces/hashes and only the external origins actually required.

Do not break MathJax, Kroki/TikZ images, Firebase auth, Socket.IO, or worksheet tooling.

### 7. Accessibility pass

Audit:

- keyboard navigation;
- visible focus;
- modal focus trap/restore;
- button/link semantics;
- labels;
- ARIA announcements for asynchronous grading/extraction;
- mobile viewport behavior;
- color contrast.

## Phase 5 completion criteria

- large EJS pages have substantially less inline JS/CSS;
- shared browser behavior is reused instead of copied;
- critical third-party scripts are pinned/self-hosted where justified;
- CSP can be enabled without breaking primary workflows;
- keyboard/mobile accessibility regression checks cover critical paths.

---

# Phase 6 — AI Quality, Cost & Worksheet UX

## Objective

Improve AI reliability/cost using measured evaluation data rather than weakening the current verification architecture by intuition.

## Scope

### 1. Preserve dual-model verification first

Do not reduce the current high-thinking/dual-model verification pipeline unless evaluations demonstrate equal safety.

### 2. Expand gold evaluation coverage

Grow beyond the existing small gold fixture with categorized cases for:

- arithmetic/algebra;
- geometry/diagrams;
- statistics/probability;
- science;
- history/language/non-math;
- multiple select;
- identification/numeric/unit answers;
- open-ended/graphing grading;
- LaTeX edge cases;
- worksheet gaps/alphanumeric/Roman/repeated numbering;
- poor scan/image extraction;
- answer-key conflicts;
- ambiguous or intentionally unsolvable items.

### 3. Track quality metrics by task/model

Record at least:

- solver accuracy;
- agreement rate;
- adjudication rate;
- review-required rate;
- verified-but-wrong count;
- extraction coverage;
- latency;
- requests per successful question;
- estimated token/request cost where available.

### 4. Tune only from evidence

Potential optimizations may include:

- fewer retries where safe;
- larger/smaller worksheet batches;
- task-specific timeout changes;
- selective single-model formatting/extraction where validation is deterministic;
- cache/reuse of exact deterministic outcomes.

Every optimization must pass the expanded gold suite with no unacceptable verified-wrong regression.

### 5. Worksheet 50-question UX

The backend currently limits worksheet solve/finalization jobs to 50 questions.

The product should either:

- clearly communicate and enforce the 50-question limit before expensive extraction; or
- implement controlled multi-job continuation with preserved source identity and a safe final merge.

Do not simply raise the limit without resource/AI quota analysis.

### 6. Better review workflow

Improve teacher review presentation for:

- solver disagreement;
- extraction uncertainty;
- duplicate/repeated source IDs;
- golden-key conflict;
- invalid LaTeX;
- missing question fragments.

The goal is faster teacher judgment, not hiding uncertainty.

## Phase 6 completion criteria

- expanded versioned evaluation corpus exists;
- quality/cost metrics are reproducible;
- any AI optimization is justified by measurements;
- no verified-wrong regression is accepted silently;
- worksheet size limits and review states are clear to the teacher.

---

# Phase 7 — Product & Admin Improvements

## Objective

Complete operational/product features after the security and architecture foundation is stable.

## Scope

### 1. Real usage dashboard

Replace placeholder admin usage endpoints with real metrics such as:

- AI jobs/calls by task/model/user;
- rate-limit/retry events;
- worksheet extraction/solve jobs;
- quiz attempts/completions;
- Firestore health/write failures;
- storage/document-size warnings;
- application uptime/version.

Do not expose raw API keys or sensitive student answer content in metrics.

### 2. Audit history

Record meaningful administrator/teacher actions:

- user block/unblock;
- teacher approval/recheck;
- quiz archive/delete/restore;
- API-key configuration change (metadata only, never key value);
- backup/export operations where useful.

### 3. Quiz lifecycle: archive/trash

Replace immediate destructive deletion as the default UX with archive/trash semantics.

Separate:

- archive quiz;
- restore quiz;
- permanent delete;
- associated result retention/deletion policy.

Historical results should not disappear casually because a teacher cleans the dashboard.

### 4. Backup/restore

Improve the existing database export with:

- schema/version metadata;
- integrity validation;
- documented restore procedure;
- safe import preview/dry run before destructive restore.

### 5. Result analytics

Only after the result model is stable, consider richer teacher analytics:

- item difficulty/facility;
- common distractors;
- question-level performance;
- completion/time patterns;
- class/quiz summary exports.

### 6. Optional quiz controls

Possible later features, only when product need is confirmed:

- access code;
- open/close schedule;
- attempt count limit;
- teacher roster association;
- controlled anonymous vs authenticated mode.

These are product decisions, not foundational fixes.

## Phase 7 completion criteria

- admin monitoring reflects real system data;
- meaningful mutations have safe audit history;
- quiz deletion has a recoverable lifecycle;
- backups have a documented validation/restore path;
- added analytics do not weaken student privacy or grading integrity.

---

## 4. Explicitly deferred work

The following should **not** be introduced unless real usage requires them:

### Horizontal scaling

QuizMoKo currently uses process-local:

- attempt locks;
- revision high-water state;
- live sessions;
- rate buckets;
- Gemini queues;
- AI concurrency state.

This is acceptable for the current single-writable-process deployment model. Do not add Redis/shared coordination merely for theoretical scalability.

If real load later requires multiple writable processes, create a separate scaling architecture phase covering distributed locks, shared rate/AI quotas, realtime adapter, durable session state, and transactional persistence semantics.

### Full SPA/framework rewrite

No React/Next migration is planned. EJS modularization is lower risk and sufficient for current needs.

### Database replacement

No migration away from Firestore is planned without measured evidence that Firestore is the product bottleneck.

### AI model expansion

Do not add many alternate hosted models just because they are available. The current Flash-Lite pair gives a controlled and testable verification surface.

---

## 5. Phase execution rules

Every implementation phase should follow the same process:

1. Start from current `main` and re-read the canonical architecture map.
2. Confirm the roadmap item is still relevant against current code.
3. Create one focused branch/PR for the phase or a clearly bounded sub-phase.
4. Add regression tests before/with behavior changes.
5. Keep unrelated feature work out of the phase.
6. Run the permanent CI gate on the exact PR head.
7. Review security/privacy/persistence impacts explicitly.
8. Update `APP_WORKFLOW_MAP.md` and `workflow-map.json` if current architecture changed.
9. Update `AGENTS.md` when a permanent invariant or implementation rule changed.
10. Append the completed work/learning to `AGENT_EVOLUTION_LOG.md`.
11. Merge only after exact-head checks are clean.

---

## 6. Recommended immediate next phase

The next implementation phase is:

**Phase 1 — Production Safety & Security**

Do not begin new product features before completing its core safeguards unless there is an urgent production defect.

Suggested Phase 1 implementation order:

1. permanent CI workflow;
2. result authorization fix + tests;
3. Render/Firestore production default fix;
4. production `SESSION_SECRET` fail-closed validation;
5. demo/sample-data isolation;
6. admin last-admin safety;
7. low-risk security headers;
8. dependency audit classification and compatible updates;
9. exact-head full regression verification;
10. architecture/documentation synchronization.

---

## 7. Documentation authority

Use these documents for different purposes:

- [`APP_WORKFLOW_MAP.md`](./APP_WORKFLOW_MAP.md) — what the application **currently is**.
- [`workflow-map.json`](./workflow-map.json) — machine-readable current architecture.
- `IMPROVEMENT_ROADMAP.md` — what should be **improved next**.
- `AGENTS.md` — permanent implementation/non-regression rules.
- `AGENT_EVOLUTION_LOG.md` — historical decisions and completed changes.
- `AI_QUALITY.md` — detailed AI-quality policy and evaluation system.

A roadmap item must not be described as current behavior until its implementation has been merged and the canonical architecture map has been updated.
