# QuizMoKo AI Quality Architecture

## Supported hosted models

QuizMoKo intentionally routes hosted AI work through only:

- `gemini-3.5-flash-lite` as the primary model
- `gemini-3.1-flash-lite` as the independent peer model

Legacy hosted model names are migrated by `getRealModelName()`. Ollama remains a separate optional draft path and its output is review-required because it does not receive the dual Gemini verification guarantee.


## Per-model RPM protection

All hosted Gemini calls go through `src/services/geminiRateLimiter.ts`, including drafting, extraction, both independent solvers, validation retries, adjudication, semantic grading, and student explanations.

- Each model has its own rolling-window queue, so 3.5 Flash-Lite and 3.1 Flash-Lite do not consume one another's RPM allowance.
- The default configured quota is 15 RPM per model.
- One request is held in reserve by default, limiting this server process to 14 starts per rolling minute per model.
- Retries re-enter the same queue and cannot bypass the cap.
- A request that cannot obtain a slot within the configured maximum wait fails with HTTP 429 and `Retry-After` instead of producing a generic server error.
- The limit is configurable through `GEMINI_FLASH_LITE_RPM`, `GEMINI_FLASH_LITE_RPM_RESERVE`, `GEMINI_RATE_LIMIT_WINDOW_MS`, and `GEMINI_RATE_LIMIT_MAX_WAIT_MS`.

The queue is process-local, matching QuizMoKo's existing single-writable-process deployment boundary. Multiple app instances would require a shared distributed limiter.

## Task profiles

`src/services/aiTaskProfiles.ts` is the only source of task reasoning settings and prompt versions.

| Task | Thinking | Verification role |
|---|---:|---|
| Document and answer-key extraction | Minimal | Schema and deterministic validation |
| LaTeX formatting | Minimal | Hash/content guarded patches |
| Question drafting | High | Produces an untrusted draft |
| Independent solving | High | Runs on both Flash-Lite models |
| Conflict adjudication | High | Blind, high-confidence only |
| Semantic grading | High | Structured score and feedback |
| Student explanations | High | Structured, validated explanation |

## Question lifecycle

1. A drafting model creates structured question objects.
2. The server normalizes types, choices, answers, IDs, and LaTeX.
3. Deterministic checks reject duplicate choices, answer leaks, invalid answer mappings, broken LaTeX, and grading-contract failures.
4. Both Flash-Lite models receive an answerless copy and solve independently.
5. Canonical agreement produces `verified` with method `dual_agreement`.
6. Disagreement is sent to a blind adjudicator. Only a safe, high-confidence result produces `verified` with method `adjudicated`.
7. One solver, failed coverage, low confidence, unresolved disagreement, or quality issues produce `review_required`.
8. Structurally unusable content produces `invalid`.
9. Public publication accepts only `verified` questions. The editor may retain review-required items as a draft.
10. Editing question text, answer choices, type, answer value, or a meaningful diagram invalidates previous verification. The teacher must explicitly approve the current answer or run Re-solve before publication.

## Golden answers

Teacher and answer-key values remain authoritative. They are still independently checked:

- both solvers agree with the key: verified
- either solver disagrees or fails: preserve the key and require teacher review
- key cannot map to the question type/options: invalid

## LaTeX contract

- Use `$...$` for real inline mathematics.
- Use `$$...$$` for standalone equations, aligned work, and tables.
- In math-facing question text, options, solutions, and feedback, wrap every standalone numeric value in `$...$`, including prose quantities and measurements. Wrap the complete expression when a number belongs to one; printed question numbers and option letters remain outside delimiters.
- Identification answer keys are concise plain values without delimiters or unnecessary units.
- JSON serializes line breaks as `\n`; parsing creates the actual newline.
- Every AI field is normalized and validated before storage or display.
- LaTeX polish uses stable IDs, field names, and content hashes. A patch is rejected if it changes text, numbers, HTML, images, or meaning.

## Stored QA metadata

Verified/reviewed questions retain:

- verification status and method
- answer source
- solver model names
- prompt version
- timestamp
- concise reason and validation issues
- anonymous candidate answers and confidence

Student/public payload sanitation continues to remove private answer and QA metadata where appropriate.

## Regression tests

`test/ai-quality.test.ts` covers:

- model migration and task profiles
- server and browser LaTeX safety
- safe and unsafe formatting patches
- dual-solver agreement
- conflict adjudication
- low-confidence agreement fail-closed behavior
- one-solver failure
- golden-key disagreement
- invalid-LaTeX fail-closed behavior
- raw-template regressions involving JavaScript backslash escapes
- prompt regressions involving JSON newlines and over-wrapped numbers
- canonical validity of the 20-question gold evaluation fixture
- editor invalidation of stale AI verification after semantic content changes
- per-model rolling-window RPM queuing and independent model buckets


## Live gold evaluation

Run `npm run eval:ai` with `GEMINI_API_KEY` or `API_KEY` configured. The harness in `scripts/evaluate-ai-quality.ts` sends the answerless 20-question fixture in `test/fixtures/ai-quality-gold.json` through the real verification pipeline and reports:

- final answer accuracy
- per-model solver accuracy
- solver agreement rate
- verified, review-required, and invalid counts
- verified-but-wrong count
- model failures and item-level reasons
- total elapsed time

Use this command before promoting prompt or model-profile changes. The fixture answers are used only for evaluation after model responses are received; they are not included in solver or adjudicator prompts.
