# R3 — Grading evidence and diagram reliability

Implemented from merged R2 main `9e885e2` in one feature branch. No production Firestore operations, credential retrieval/rotation, Chrome/desktop activity, manual deployment, historical rescore, new provider or package dependency occurred. R4 has not begun.

## Implemented behavior

- Semantic grading v5 rejects non-finite, missing and out-of-range fractions instead of clamping. Four-decimal quantization preserves partial/full distinctions. Teacher-weighted rubric criteria need exact unique-ID coverage, nonempty evidence and an aggregate matching explicit weights. No arbitrary equal-weight distribution is invented.
- Supported complete final-answer contracts independently validate the canonical key, then use R2 exact arithmetic, fractions, linear/polynomial equivalence, complete supported solutions and explicit numeric tolerance before Gemini. They cannot score reasoning, snapshots, graphing, required units or unsupported wording. Unsupported parsing stays inconclusive. Explicit assessment metadata prevents legacy numeric-open-ended identification coercion; absent metadata retains previous normalization and question digests.
- Primary semantic grading still makes one call for ordinary valid evidence. Targeted alternate validation/fallback is capped at two total calls across all clients/models. Unsupported full-credit reasoning, extreme-score feedback contradictions, weighted rubric conflicts and unreadable evidence trigger validation/review. Disagreement never selects the higher score. Infrastructure failure remains ungraded. Existing points, score authority, snapshots, proofs/revisions, creator keys and finalized submission protections remain.
- Images are checked against existing byte/count/pixel limits, MIME, dimensions, actual decoding and uniform blank content. Actual image bytes reach inlineData. Graphical grades need a readable model evidence status; absent/malformed/unreadable evidence remains pending. Image decoding/readability claims do not prove correct handwriting recognition.
- Teachers can edit optional rubric JSON and enable a final-answer contract in the existing editor. The existing results review shows partial/review/unavailable labels. A single-item **semantic** correction extends the existing locked recheck route: authenticated teacher/admin ownership, finalized result, current question digest, answer revision, expected grade revision, valid fraction/reason, private audit, and acknowledged existing persistence. Stale corrections return 409. Exact-answer items still use canonical-key correction and recheck; students cannot set grades. No bulk correction exists.
- A teacher-only diagram preview endpoint parses a fully consumed, closed TikZ subset into escaped uniform-scale SVG, then uses existing sharp to decode PNG. It bounds source length, statements, coordinates, output extent, two simultaneous renders and a five-second decoding timeout. No local TeX or new paid renderer exists. Source-safe but unsupported families retain Kroki/browser preview and teacher inspection. Client success flags cannot approve/publish a question.
- Structured coverage includes named Cartesian points, segments, grids, circles, rectangles, number-line segments and simple bar outlines/plain labels. Checks flag swapped/missing coordinates, missing labels and supported right-angle, slope, distance, midpoint and circle-radius contradictions. Source/render/semantic evidence is distinct: render validation requires actual decoding; **no fixture is automatically semantically validated**. Original TikZ is preserved separately from display markup and restored only while the display fingerprint matches. The bounded in-editor render cache holds at most ten small PNGs keyed by the full source; source edits invalidate reuse.
- Worksheet page context compares explicit printed-ID text-layer numeric sequences/options with vision extraction and flags per-file/page disagreements. Source IDs, original text and images are preserved; missing fractions/exponents/radicals are never guessed. Existing page/item recovery and publication diagnostics remain the correction path.

## Reproducible grading evidence

`npm run eval:r3:grading -- --output=docs/R3_GRADING_COMPARISON.json` loads pinned actual R2 `grading.ts` **and** `semanticGrading.ts` from Git, runs the canonical-local-before-semantic path, and compares current code on identical synthetic inputs/mock responses. Temporary baseline modules are removed. The independently specified arithmetic/rubric expectations are **not yet human teacher-reviewed**. Subjective cases use acceptable ranges. These measure pipeline behavior under specified mocks, not Gemini accuracy.

| 71 synthetic grading cases | Actual R2 | R3 |
|---|---:|---:|
| Incorrect full-credit awards | 3 | 0 |
| Incorrect zero-credit awards | 23 | 0 |
| Sum absolute score error, exact cases | 14 | 0 |
| Sum deviation outside acceptable ranges | 16.7 | 0 |
| Missed required review | 21 | 0 |
| False review triggers | 0 | 0 |
| Rubric compliance (grade in range or justified review) | 6/18 | 18/18 |
| Deterministically graded cases | 27 | 27 |
| Mock hosted requests | 45 | 54 |
| Pending evidence review | 0 | 16 |
| Invalid responses | 1 | 6 |

R3's deterministic distribution includes explicit final-answer mathematics and the existing canonical blank-response rule. Count alone does not show improvement: the R2 count includes legacy numeric identification producing incorrect zeros for valid expressions/work. Rubric compliance treats a genuinely invalid assessment routed to expected review as safe; it does not imply a returned score in every case. Score-error metrics exclude pending/invalid outcomes, which are separately counted. Fixtures cover alternative methods, incomplete work, correct finals/invalid methods, units, arithmetic slips, language/science, prompt injection, graphical evidence, blank/malformed submissions and contradictory rubrics.

This adversarial corpus used **20% more mock requests** (45 → 54), below doubling. Extra calls target suspicious evidence; ordinary acceptable primary responses retain one request, deterministic cases zero. The recorded sample local wall times were approximately 16.5 ms / 79.3 ms, with process RSS approximately 115/116 MB. Local timing/RSS include fixture orchestration/image decoding and are not Gemini latency, hosting throughput, maximum concurrent memory or representative classroom costs. No normal-traffic cost gain is claimed.

## Diagram and retained regression measurements

`npm run eval:r3:diagrams -- --output=docs/R3_DIAGRAM_REPORT.json` actually constructs and decodes local synthetic diagrams: **17/17 expectations pass, 10 render, 7 safely remain unavailable/rejected, 0 semantic certifications and 0 hosted requests**. Resource overflow, empty output, invalid/missing commands, source access/obfuscation and unsupported curves/scales are covered. Coordinate/label/right-angle defects can still render: their semantic review requirement is retained. This does not test actual Kroki availability, advanced TeX fidelity or perceptual label readability. Sampled local timing and process RSS are recorded in the machine-readable diagram report; they do not establish hosting throughput.

Retained gold: **136/136 correct/verified**, no verified wrong, two batched mock calls. Retained 38-case R1/current adversarial comparison: verified-wrong and unsafe acceptance remain **0**, with no false rejection of known-correct fixtures. See `R3_GOLD_OFFLINE.json` and `R3_R2_REGRESSION.json`; these remain mocked measurements.

## Live evaluation capability and missing certification

`npm run eval:ai:live -- --output=docs/R3_LIVE_EVALUATION.json` selects at most 20 versioned representative questions spanning arithmetic/fractions/algebra/word problems/geometry/trigonometry/coordinates/statistics/probability/science/language, actual vision data, incorrect source keys, ambiguity, duplicate choices and incorrect explanations. The separate `npm run eval:grading:live` command evaluates representative grading cases. Expected answers/ranges/review labels are excluded from model input; source answer keys are only passed through the existing golden-key boundary, never to independent solvers.

Both live commands use a reusable bounded wrapper: at most **60 actual SDK calls**, SDK internal retries disabled, actual counts by model/failures/adjudication, quota exhaustion abort, eight-minute overall deadline, inherited queue/transport cancellation and shared RPM. Live limits cannot be raised above 20 questions/60 requests. JSON plus Markdown reports include counts, latency, category outcomes, review/agreement/adjudication, false accept/reject metrics and requests per accepted question. Reports state their mode. CI runs only mocked grading/gold comparisons and local diagram decoding.

**Live Gemini certification was not performed:** neither `GEMINI_API_KEY` nor `API_KEY` was present in the execution environment. No `.env`, browser profile, private account, Firestore or Render secret was searched for credentials. No `R3_LIVE_EVALUATION.json` was created. There are no actual Gemini accuracy/latency measurements or comparable live before/after results in this phase.

## Validation and release evidence

- Complete local regression: **165 passed, zero failed**; existing expectations were preserved. Focused R3 tests also pass after the later blank-image/cancellation safeguards.
- TypeScript and build pass. Both R3 benchmarks and retained gold/adversarial evaluations pass.
- Tests exercise grade bounds, explicit contracts, alternate methods/partial rubrics, proof invalidation, prompt/vision handling, blank/malformed/unreadable images, two-attempt limits, transport/malformed failures, source safety, actual structured PNG decoding, worksheet provenance disagreement, request caps/quota, authenticated correction/stale revisions and teacher-only previews. Existing suites retain persistence/idempotency and publication compatibility coverage.
- CI adds the two offline R3 benchmarks and uploads JSON/Markdown evidence. Exact-head CI and merge status are reported in the PR/chat; local checks alone do not establish hosted CI or production acceptance.
- No manual deploy, production data writes or actual Render/provider/signed-in browser acceptance was performed. Existing R1 operational prerequisites and single-writable-process deployment boundary are unchanged.

## Remaining limits and R4 priorities

Teacher review is still required for rendered diagrams: curves/styles/arrows/complex TikZ, crowded labels, right-angle marker placement, inferred bar scales and semantic vision correctness are outside the local renderer. The source whitelist intentionally rejects commands beyond its safe vocabulary. A uniform nonblank image is only input availability; OCR uncertainty depends on honest model reporting and teacher inspection. Feedback heuristics can conservatively trigger review and do not prove general mathematical reasoning. No arbitrary student-work proof engine, general dimensional analysis, or universal partial-credit rubric was added.

The PDF numeric comparison is a coarse source-preservation warning, including possible layout/text-layer false positives; scans without usable text and multiple-column OCR ordering remain unmeasured. Existing targeted recovery remains manual. Synthetic expectations need independent human teacher review, especially subjective ranges. Normal traffic/provider latency/cost and advanced visual fidelity remain unmeasured.

Recommended R4: teacher-review the grading corpus and rubric UX; run comparable bounded credentialed Gemini/handwriting/worksheet measurements; measure representative classroom request/latency distributions; expand structured diagram families with explicit authoring specifications and visual acceptance. Do not infer these results from mocked benchmarks.
