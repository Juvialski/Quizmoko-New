# AI Quality Improvement Implementation Report

> **Historical document:** This report records the August 2026 AI-quality implementation pass. It is not the canonical current application architecture. Use `docs/architecture/APP_WORKFLOW_MAP.md` for the current full-app map.

Date: 2026-08-06

## Phase 1 — Fail-closed correctness

- Limited hosted AI routing to `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`.
- Added centralized task profiles and prompt versions in `src/services/aiTaskProfiles.ts`.
- Rebuilt answer verification in `src/services/aiQuestionVerifier.ts` around answerless, independent dual-model solving.
- Changed solver disagreement, incomplete coverage, malformed output, and single-model success to `review_required` instead of silently preferring one model.
- Added blind adjudication for genuine solver disagreements.
- Required high confidence from both agreeing solvers before dual agreement can be marked verified.
- Preserved golden answers while surfacing conflicts for teacher review.
- Added publication gates so review-required or invalid questions cannot be exposed as public quizzes.

## Phase 2 — Prompt and LaTeX hardening

- Replaced overlapping prompt rules with short task-specific contracts for drafting, extraction, solving, adjudication, grading, explanation, and formatting.
- Converted multiline prompt constants to `String.raw` so JavaScript does not corrupt LaTeX commands such as `\times`, `\right`, or `\dfrac`.
- Removed the invalid instruction to place literal unescaped newlines inside JSON strings; prompts now require valid JSON `\n` escapes.
- Stopped requiring every ordinary number or label to be wrapped in math delimiters.
- Added centralized server-side LaTeX normalization and validation for delimiters, braces, nested math, bare commands, and legacy newline corruption.
- Added safe browser-side normalization in `public/js/math-display.js`.
- Replaced whole-question LaTeX rewrites with stable-ID, field-hash, formatting-only patches that reject changes to words, values, HTML, images, or meaning.

## Phase 3 — Extraction, grading, and editor safety

- Split worksheet extraction into `verbatim_text`, `context_prefix`, and server-composed `raw_text`.
- Applied task profiles and full LaTeX validation to worksheet solving, semantic grading, and student explanations.
- Added targeted retries for invalid structured coverage instead of regenerating an entire batch unnecessarily.
- Added persistent verification metadata, solver evidence, prompt versions, and review reasons.
- Invalidated stale verification when a teacher changes question text, choices, type, answer, or meaningful image content.
- Typing an answer no longer marks it verified. Verification returns only after the dedicated **Approve Answer** action or a successful re-solve.
- Formatting-only image width changes may retain verification because they do not change question meaning.

## Phase 4 — Evaluation and regression protection

- Added `test/ai-quality.test.ts` with 20 focused tests, including per-model RPM queuing and upstream 429 handling.
- Added `test/fixtures/ai-quality-gold.json`, a 20-question mixed-subject gold set.
- Added `npm run eval:ai` and `scripts/evaluate-ai-quality.ts` for live accuracy, agreement, status, failure, verified-wrong, and latency reporting.
- Updated `AGENTS.md`, `AGENT_EVOLUTION_LOG.md`, `README.md`, and `docs/AI_QUALITY.md` with the new architecture and non-regression rules.

## Phase 5 — Flash-Lite RPM safety

- Added `src/services/geminiRateLimiter.ts`, a process-wide rolling-window queue with separate buckets for Gemini 3.5 Flash-Lite and Gemini 3.1 Flash-Lite.
- Routed every hosted Gemini call through the queue, including drafting, extraction, both solver models, retries, adjudication, worksheet recovery, semantic grading, and student explanations.
- Configured a 15-RPM default with one reserved request, so the server starts no more than 14 calls per rolling minute for each model.
- Made quota, reserve, window, and maximum queue wait configurable through `.env`.
- Returned HTTP 429 with `Retry-After` when a queued request cannot be scheduled safely.
- Prevented targeted verifier and worksheet retries from immediately retrying a local queue-timeout error.
- Verified with a timed queue test that the third request under a two-request test cap waits for the rolling window, while different models receive independent slots.

## Verification completed

- AI-quality regression suite: **20 passed, 0 failed**.
- TypeScript syntax transpilation: **43 files, 0 syntax failures**.
- Browser math-display JavaScript syntax check: passed.
- All 16 hosted Gemini call sites use centralized task configuration and the shared per-model RPM wrapper; no direct SDK calls remain outside the wrapper.
- Runtime prompt hygiene checks: passed.
- Legacy hosted model literals remain only in migration regression tests.
- Whitespace/error diff check: passed.
- Temporary dependency stubs and `node_modules` were removed before packaging.

## Environment limitation

The complete repository `npm test` suite could not be executed in this container because the dependency installation registry returned a 404 for `zip-stream@7.0.5`, and the public registry attempt timed out. The focused AI regression suite was run using a temporary minimal `@google/genai` import stub and the stub was deleted afterward. This limitation does not indicate an application test failure, but a normal clean install should run `npm ci && npm test` in AI Studio or the deployment environment.
