# QuizMoKo AI Quality Architecture

For the complete current application context around this subsystem, see [`architecture/APP_WORKFLOW_MAP.md`](architecture/APP_WORKFLOW_MAP.md).

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

`src/services/aiTaskProfiles.ts` is the only source of task reasoning settings and prompt versions. All current hosted task profiles use the maximum supported `high` thinking level.

| Task | Thinking | Verification role |
|---|---:|---|
| Document and answer-key extraction | High | Schema and deterministic validation |
| LaTeX formatting | High | Hash/content guarded patches |
| Question drafting | High | Produces an untrusted draft |
| Independent solving | High | Runs on both Flash-Lite models |
| Conflict adjudication | High | Blind, high-confidence only |
| Semantic grading | High | Structured score and feedback |
| Student explanations | High | Structured, validated explanation |

## Question lifecycle

1. A drafting model creates structured question objects.
2. The server normalizes types, choices, answers, IDs, and LaTeX.
3. Deterministic checks reject duplicate/equivalent choices, answer leaks, invalid mappings, broken LaTeX, grading-contract failures and supported mathematical/solution contradictions before hosted calls.
4. Both Flash-Lite models receive an answerless copy and solve independently.
5. Canonical or exact supported identification equivalence produces `verified` with method `dual_agreement` only after the shared quality gate passes. Definite local contradictions override agreement/confidence. Unsupported math retains explicitly inconclusive evidence and is labeled AI consensus, not mathematical proof.
6. Disagreement is sent to a blind adjudicator. Only a safe, high-confidence result that passes the quality gate produces `verified` with method `adjudicated`. Missing/invalid/unrendered diagrams remain review-required.
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
- canonical validity of the 136-question gold evaluation fixture
- editor invalidation of stale AI verification after semantic content changes
- per-model rolling-window RPM queuing and independent model buckets

## Live gold evaluation

Run `npm run eval:ai` for hermetic mocked pipeline measurement. The 136-question gold corpus includes 30 category labels, arithmetic oracles, choice/identification questions, science/language, LaTeX and stable worksheet numbering. Six separate negative fixtures cover ambiguity, inconsistent equations, missing diagrams, golden conflicts, malformed output and broken LaTeX. Their review outcomes are regression expectations driven by mocks, not automatic detection of mathematical ambiguity.

`docs/AI_BASELINE_OFFLINE.json` records the mocked baseline: 136 correct/verified, no verified-wrong results, two solver requests. This **does not measure Gemini accuracy or demonstrate an accuracy gain**. `npm run eval:ai:live` explicitly requires credentials and uses batches of ten; it is never run by CI. Both modes report final/verified accuracy, agreement, review/adjudication rates, malformed frequency, request count, total latency and model failures. Gold answers/solutions/oracles are excluded from solver/adjudicator question payloads.

Actual visual acceptance and live Gemini runs are separate from offline regression. Diagram-dependent missing-context behavior is mocked here; supplying real worksheet diagrams and measuring vision accuracy is deferred to an explicitly credentialed evaluation. Existing TikZ tests continue to cover deterministic diagram-plan validation.

## R2 deterministic and quality gates

`mathVerification.ts` supplies exact rational arithmetic, bounded polynomial equivalence, complete rational linear/quadratic roots, systems, original-equation substitution, coordinate/line calculations, rectangle/triangle formulas, basic statistics/probability and unit conversions through complete supported wording templates. Undefined arithmetic and extraneous/missing roots cannot pass. Caller-supplied numeric tolerance is explicit. Unsupported wording/domains, irrational/transcendental math, arbitrary rational functions and irreducible factorization remain inconclusive.

`questionQuality.ts` is shared by normal and worksheet verification. It checks supported choices independently, explicit worked equalities/transformations, diagram source/context and extraction completeness. Source-safe TikZ is still unrendered and requires teacher preview; no visual correctness is inferred from syntax. Embedded images go to actual vision inlineData rather than base64 text. PDF text-layer IDs supply optional file/page coverage evidence without invented numbering. Successful solver items survive bounded targeted field/coverage repair.

Private versioned local evidence lives in optional QA metadata. Teacher notices show an issue and corrective action; existing explicit approval and Re-solve remain. Historical published quizzes/grades are not scanned or rewritten. Drafting/solving/adjudication prompt versions are v5/v5/v4; providers and high-thinking/RPM settings are unchanged.

Run `npm run eval:r2` for the 38-item actual-R1/current adversarial mocked comparison, and `npm run eval:ai` for the retained 136-item gold corpus. `eval:ai:live -- --limit=N` supports bounded opt-in live subsets. See [R2 implementation and limitations](R2_IMPLEMENTATION_REPORT.md), [adversarial measurement](R2_COMPARISON_OFFLINE.json) and [gold measurement](R2_GOLD_OFFLINE.json). Offline measurements do not establish Gemini or visual accuracy.

See [R1 report](R1_IMPLEMENTATION_REPORT.md) for operational limits and evidence.

## R3 grading, diagrams and live measurements

Semantic grading v5 rejects out-of-range scores and uses at most two attempts total. Teacher-weighted criterion evidence must cover the rubric exactly and agree with the aggregate; incomplete graphical evidence, contradictory extreme-score feedback and unresolved secondary disagreements remain pending. Existing fractions, weighted points, attempt identities, creator keys and finalization behavior remain authoritative. No universal equal-weight rubric or automatic two-model call is introduced. Legacy responses can retain concise feedback as justification; weighted rubric and graphical assessments require their additional evidence.

Teachers may add `grading_rubric: {version:1, criteria:[{id,description,weight}]}` or `response_contract: {version:1,mode:"final_answer",absolute_tolerance?:"0.001"}`. Rubric weights must sum to one. A final-answer contract may deterministically score a supported complete task after independent key validation; it does not score work, graphing, arbitrary prose, requested units or omitted reasoning. Unsupported parsing is inconclusive. Numeric open-ended questions opt into semantic assessment through explicit metadata; legacy type normalization/digests are unchanged without it. Rubric changes invalidate signed question identities. New teacher corrections use the existing locked recheck API with `teacher_assessment`, a reason and expected grade/question/answer revisions; only finalized semantic items owned by a teacher/admin qualify. Audits stay server-side and writes await acknowledgement.

Snapshots are decoded under existing byte/count/pixel limits, checked for MIME/dimensions and uniform blank content, then supplied as actual inlineData. A model must explicitly report readable evidence for graphical credit; unreadable/insufficient evidence stays pending. This is not a handwriting recognizer or proof that a model correctly inspected every pixel.

The teacher-only `/api/diagram_preview` uses a closed parsed subset and the existing sharp package to decode generated SVG into PNG (two concurrent renders, five-second decoding timeout, source/dimension bounds). Supported points, segments, circles, grids, rectangles, number-line segments and plain labels share uniform coordinates; definite point/label/right-angle/slope/distance/midpoint/radius contradictions are flagged. Unsupported source retains Kroki preview and teacher inspection. Source checks do not certify rendering; render success does not certify semantics. Preview evidence is advisory and cannot publish a question. Original TikZ is retained alongside display markup and restored in the editor only when the display fingerprint still matches. General TikZ, curves, right-angle marker placement, numeric bar scales, crowding and subjective diagrams still need visual review.

PDF text-layer spans keyed by explicit printed IDs are compared with extracted numeric sequences, including options. Differences become per-file/page review diagnostics without reconstructed symbols or altered source identifiers. This deliberately coarse warning is not OCR truth: absent, duplicate, incomplete and multi-column text layers remain inconclusive. Existing targeted recovery handles flagged pages/items.

`eval:ai:live` now selects a versioned representative 20-question synthetic corpus including actual visual data, incorrect source/generation keys, ambiguous choices and broken explanations. `eval:grading:live` is the separate optional grading command. Both require already available environment credentials, cap actual SDK requests at 60, suppress internal SDK retries, abort on quota/deadline/budget, retain shared per-model RPM and inherit queue cancellation. Expected outcomes are excluded from prompts. Neither runs in CI. Live comparisons require comparable earlier measurements before claiming an accuracy improvement.

`eval:r3:grading` compares pinned actual R2 canonical/semantic code with current code across 71 synthetic cases; expectations have not received human teacher review. `eval:r3:diagrams` actually decodes the closed local SVG corpus; it does not measure Kroki or semantic vision accuracy. Reports and limitations: [R3 implementation](R3_IMPLEMENTATION_REPORT.md), [grading comparison](R3_GRADING_COMPARISON.json), [diagram report](R3_DIAGRAM_REPORT.json).
