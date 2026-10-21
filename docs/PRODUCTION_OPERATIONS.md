# Production operations and R1 rollout gate

## Required configuration

Set Render's **Start Command to `npm start`**, which invokes `tsx server.ts`. Do not use plain `node server.ts`: Node's strip-only TypeScript mode does not support all syntax used by the app. Use one writable Node process (supported Node 22.13–24). Render supplies the application port; preserve the default 3000.

1. Set a stable random `SESSION_SECRET` with at least 32 bytes; generate it securely once and store it in Render's secret environment configuration. Do not print/paste it into logs or rotate it casually: sessions, result capabilities and grade proofs depend on it.
2. Enable Firebase Admin and provide one existing supported credential mechanism: service-account JSON/base64, the existing Render `FIREBASE_JSON` alias, or an application-default credential file. Match `FIREBASE_PROJECT_ID` and `FIRESTORE_DATABASE_ID` to the existing data. Do not create a new database or migrate collections. For a named database the existing loader also reads `(default)`; both configured backends must be accessible, so verify existing deployment requirements first.
3. Normal production requires Firestore regardless of the blank default. Remove `REQUIRE_FIRESTORE=false`. Missing credentials, unreadable collections or hydration timeout prevent listening. Configure `FIRESTORE_STARTUP_TIMEOUT_MS` for the deployment startup budget (default code 60 seconds; example environment 15 seconds).
4. Keep `ALLOW_DEMO_AUTH=false`. Render's `RENDER_EXTERNAL_URL` supplies a trusted Socket.IO origin; list any real custom frontend origins in `TRUSTED_ORIGINS`, separated by commas. Values must be absolute URLs. Do not configure a wildcard.
5. Preserve HTTPS secure cookies and Render's single trusted proxy hop. Existing COOKIE_SECURE/TRUST_PROXY overrides remain available; verify custom proxy deployments separately.
6. Preserve Gemini BYOK/server keys, existing Firestore project IDs and the current allowed Flash-Lite models. Do not copy credential values into GitHub CI; CI is hermetic.

## Administrator recovery

Existing persisted administrators and quiz ownership are untouched. Demo authentication is not an administrator recovery mechanism in production. If no real administrator exists, have an authorized project administrator identify the intended existing Firebase UID and update only that user's existing `users/{uid}` role through the Firebase Console or approved Admin tooling. Record the authorized UID/change privately and restart for hydration if needed. This phase did not execute any such change. Verify that a real admin can sign in before rollout.

## Readiness and failures

`/healthz` returns a minimal status with 200 for ready/degraded optional development persistence, or 503 for unavailable required persistence. It never returns sensitive details, including when HEALTH_DETAILS is set. `/api/admin/system_health` exposes pending and failed write counts to authenticated admins. A failed production write marks readiness unavailable; a subsequent successful write can restore connectivity health, while failed-target counts remain until that target succeeds. This is lightweight write-driven health, not a periodic independent connection probe.

Progress save success is returned after the coalesced checkpoint. Sandbox responses explicitly report `durable:false`. Failed save/final requests must be retried with the same session and revisions; the browser retains its local state. Final success is returned after remote acknowledgment. Do not reinterpret a timeout or transport failure as an academic zero. Shutdown stops HTTP acceptance, drains requests and flushes checkpoints/queues, exiting nonzero on failure/deadline.

## Worksheet limits

Defaults: 12 files, 20 MB each, 60 MB compressed total; 40 PDF pages/images per complete upload; 12 million pixels per image; 10000 pixels per dimension; 960 MB cumulative RGBA work. Images are PNG/JPEG/WebP/GIF; multipage/animated images are rejected. Two uploads and two PDF canvases are active at once; canvases are limited to six million pixels (~24 MB RGBA each). Cumulative budget bounds total accepted processing work, not simultaneous allocated memory. Limits may be tightened with the documented WORKSHEET environment variables. Exhausted upload capacity returns 429/Retry-After; job/pixel limits return 413 and invalid signatures 415. Split large worksheets before retrying.

## Rollout and rollback

Do not merge until the actual Render prerequisites above are confirmed; an auto-deploy could otherwise make the service unavailable. Validate credentials/read permissions and administrator access through existing authorized operational tooling without resetting data. GitHub settings are not evidence of Render configuration. Stage a controlled restart/shutdown drill separately; none was performed here.

R1 changes no collection schema or document migration. Roll back application code to the prior release if necessary; preserve the same secret, project/database and credentials. Restoring older code also restores its known permissive startup/result-privacy behavior, so use rollback only as a temporary incident response. Never restore JSON over Firestore or delete collections to repair a startup failure.

## Verified existing Render configuration

The service currently auto-deploys main. Browser checks found the existing FIREBASE_JSON service account matching the configured QuizMoKo project and existing enabled Firebase SDK administrator principal. R1 recognizes that legacy variable. SESSION_SECRET is already 64 characters and passes strength validation; preserve it. No Render environment or IAM changes were made. The live deployment inspected was starting-main, not R1, and browser health/admin navigation was blocked by the client.

## R1 production acceptance (2026-10-13)

PR #4 merged as `256c2e6`; exact PR-head and merged-main CI passed all 141 tests plus build, clean installation, offline evaluation and audit classification. Render's first attempt failed because its existing Start Command was `node server.ts`. The authorized correction to `npm start` succeeded; the same merge commit is live. Startup confirms service-account Admin Firestore and hydration of 234 quizzes, 250 results and 14 persisted users. The removed fifteenth hot-state user was the implicit demo seed, not a deleted Firestore user.

The public health API reports `ready` with only the minimal readiness response. Chrome confirms the deployed dashboard guard and existing library, plus a public quiz start screen with no registration requirement. No attempt was started/submitted, no credentials or IAM changed, and no migration or destructive data operation occurred. Existing session secret and active service-account key were retained. Production write/restart/load drills and live AI accuracy remain untested.

Documentation-only acceptance updates use Render's [documented skip-deploy commit phrase](https://render.com/docs/deploys#skipping-an-auto-deploy) to avoid an unnecessary release; their source tree changes no application code.


## R4.1 recovery boundary

Use the existing single writable server and stable secret. No production migration, key retrieval, rules deployment, Redis or manual Render deploy is part of this release. The server now reads/writes `ai_jobs` through its existing Admin identity; verify that collection access in staging before rollout. Missing job-history reads fail startup rather than permit duplicate provider work. The normal catch-all browser rules already deny direct collection access.

Owned generation, worksheet solving and finalization survive browser navigation after their accepted 202 response. Retry an uncertain acknowledgment with the same idempotency key. Seven-day bounded job metadata and acknowledged private quiz batch checkpoints survive a process restart; in-flight tasks become Interrupted, with any saved partial draft available for deliberate review. BYOK credentials and input upload bytes are never recovered automatically. Active partial drafts reject edits to prevent worker overwrite.

Worksheet extraction/retry caches last up to 30 idle minutes in the current process, at most 20 caches/24 MiB. Re-upload the identical originals to retry failed pages; keep successful extracted work in the open review page. Extraction and its raw upload do not survive restart; a request abandoned before its response may not yield a recovery handle. RMX uses its retained extraction path. The complete textbook PDF may exceed existing per-file/page limits; upload bounded page images or split PDFs.

Recent durable attempt totals restore teacher monitoring; transient presence, pause/terminate and whiteboard signals are process-local and are unknown after restart. Reconfirm controls, then allow student pings to restore presence. No ping-level Firestore writes were added. Rollback preserves the stable secret and Firestore data, including the new metadata collection; never reset results or bulk-regrade history. Old code restores the prior socket privacy defect, so treat rollback as an incident response with classroom monitoring disabled until a safe release is available.
