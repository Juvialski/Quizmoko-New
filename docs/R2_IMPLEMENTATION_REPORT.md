# R2 — Deterministic verification and question quality

Implemented from main `0925c696f9fc2a0f912312b6060f5572ad57a5a3`. No provider, API, database schema, infrastructure or production-data changes. Checks apply during generation and explicit revalidation; stored historical quizzes and grades are not scanned or rewritten.

## Implementation

- `mathVerification.ts` implements bounded parsing with exact BigInt rational coefficients. It never executes expressions or treats numerical sampling as symbolic proof. Outcomes are pass, fail or inconclusive, with a verifier version and a precise scope.
- Supported complete question templates cover integer/decimal/rational arithmetic, fractions, percentages, precedence, bounded integer powers, exact real square roots, polynomial expansion/equivalence in real x/y with constant nonzero denominators, complete rational linear/quadratic roots, two-variable linear systems, original-equation substitution, slopes/distances/midpoints/line equations, rectangle area/perimeter, triangle area, mean/median/range, a two-color single-draw probability and length/mass/time conversions. A separate caller-supplied absolute-tolerance API compares exact error bounds. Identification keys can omit units; explicitly conflicting supplied units fail.
- Every supported choice is checked independently. Selected root sets are checked for completeness; choices use substitution membership. Duplicate/equivalent options, missing or multiple correct choices and incorrect multi-select mappings require review. Equivalence is scoped to supported mathematical tasks, so prime-factorization distractors are not erroneously collapsed merely for having the same product.
- Explicit numeric equalities in solutions and supported polynomial-equation root transformations are checked. Valid separate root branches remain allowed. A contradiction in the draft, selected answer, selected solution or agreeing peer solution blocks automatic verification, including wrong adjudicator corrections and high-confidence wrong consensus. Golden keys remain authoritative and conflicts remain review-required.
- Local preflight runs before Gemini for normal generation/revalidation. Structurally sound unsupported questions retain the existing high-confidence AI-consensus policy, with explicitly inconclusive deterministic evidence. There is no claim of universal mathematical or factual proof. All checks run afresh, without a potentially stale answer/diagram cache.
- Normal solver retries request only missing/incomplete stable IDs. Worksheet field-validation retries retain good outputs and request only defective items, with bounded validator errors. Missing outputs cannot fall back to an old/golden answer and masquerade as solver evidence. No entire successful draft batch is regenerated. Semantic question rewriting is deliberately left to the teacher; the implementation repairs solver outputs, not guessed source content.
- Worksheet adjudication sends anonymous, alternated candidates and only answer/type/options/solution fields, with legacy response-name compatibility. Embedded generation/recheck images are supplied as actual vision inlineData in both solver and adjudicator calls, with original markup preserved in storage.
- TikZ checks cover delimiters, braces, environment matching, forbidden commands/pgfplots, missing semicolons and supported named-coordinate contradictions. Missing diagrams and inaccessible remote-image context require review. **TikZ source validation is not rendered or visual validation:** new TikZ questions require teacher preview/approval. The editor detects failed image previews and invalidates current R2 draft approval. No local TeX execution or paid renderer was added, and diagram plans/counts remain unchanged.
- PDF extraction optionally reads bounded existing text-layer runs alongside the existing rasterization. Explicit printed numeric/alphanumeric/Roman IDs are compared per file/page to extracted IDs; gaps are never invented. Missing coverage, truncated expressions and incomplete questions produce teacher diagnostics with source provenance. Scans without a usable text layer remain vision-only; missing source text is never fabricated. Existing recovery is the teacher's targeted page/item recovery path.
- The editor shows a concise issue and recommended action, preserving Re-solve and explicit approval. Optional evidence is private QA metadata and existing public stripping remains intact. No ordinary approval flag bypasses the verifier.
- Drafting prompt v5 is shorter and asks for explicit domains, solve-before-distractors and plausible misconception choices. Solving v5 covers updated vision/targeted coverage, and adjudication v4 adds domain/unit/choice/context checks. Models, high thinking, quotas, BYOK, Ollama, cancellation and durable publication remain unchanged.

## Reproducible evidence

Run `npm run eval:r2 -- --output=docs/R2_COMPARISON_OFFLINE.json`. The script temporarily imports the pinned **actual R1 verifier source** from Git and cleans it up. CI fetches history for this comparison. The same adversarial mocked answers/solutions are supplied to both implementations; ground truth labels are excluded from prompts. See the JSON for per-item outcomes, requests and local wall time. These percentages are fixture/pipeline measurements, **not Gemini accuracy**.

The original 136 gold items still verify correctly, with no known verified-wrong regression and two batched mocked requests. R2 records 34 deterministic passes and 102 inconclusive results; inconclusive outcomes are never relabeled deterministic passes. See `R2_GOLD_OFFLINE.json`.

The expanded adversarial corpus includes wrong agreeing solvers, wrong letters, equivalent choices, missing choices, invalid multi-select, incorrect solutions, extraneous/missing roots, undefined arithmetic, wrong units, missing/invalid/unrendered diagrams, coordinate conflicts, ambiguous choices, golden conflicts, symbolic equivalents, negative fractions, extraction truncation and safe/unsafe adjudication. Exact before/after counts are in `R2_COMPARISON_OFFLINE.json`.

| Offline adversarial metric (38 items) | R1 | R2 |
|---|---:|---:|
| Verified wrong answers | 12 | 0 |
| Unsafe verification including diagram/solution defects | 21 | 0 |
| Verified | 37 | 16 |
| Review required | 1 | 22 |
| False rejections of 16 known-correct cases | 0 | 0 |
| Accuracy among verified (fixture answer labels only) | 67.57% | 100% |
| Solver agreement count | 36 | 17 |
| Adjudications / automatically accepted | 2 / 2 | 2 / 1 |
| Mock requests | 78 | 40 |
| Requests per accepted question | 2.108 | 2.5 |
| Local orchestration elapsed time, one sample | 36.387 ms | 63.446 ms |

R2's deterministic distribution is 20 pass / 12 fail / 6 inconclusive. The increased requests-per-accepted ratio reflects a stricter acceptance denominator, not extra routine calls. Valid fixtures retain their previous request budgets. The wrong adjudicated correction is now reviewed instead of accepted. Agreement counts also exclude locally rejected items that no longer trigger solver requests.

There are no extra routine provider calls for deterministic checking. Supported draft failures avoid both solver calls. Valid items keep the existing two-model batches; genuine disagreement keeps the existing adjudication request. Bounded field repair may add one request per affected model, only for the defective subset. Local benchmark timing is orchestration/parser time and does not measure model/network latency or Render throughput.

Synthetic worksheet coverage detects three explicit printed IDs, extracts two and reports the one missing ID without inventing intervening numbers. Real OCR quality, multi-column visual ordering and complete page extraction are not established by this fixture. Diagram rendering failures are reported as unavailable/null, not a fabricated zero. No automated visual acceptance is claimed.

## Validation and release

- TypeScript and build pass.
- Complete regression: 153 passed, zero failed, including EJS/JavaScript, grading, source identity, persistence, security and worksheet contracts. The initial run exposed four worksheet retry/legacy-adjudication compatibility failures; implementation was repaired without weakening those tests.
- Twelve focused R2 tests cover parser execution rejection, exact precedence, domains, units, choice/root completeness, wrong consensus/adjudication, vision inputs, source coverage, per-item repair, teacher correction/revalidation and real local rasterization/text extraction of a synthetic PDF.
- Offline gold and adversarial comparisons pass. CI runs both and uploads their reports. Exact-head hosted CI/PR merge status is recorded in the final chat/PR; local evidence alone does not establish it.
- Live evaluation was not run: GEMINI_API_KEY/API_KEY are absent in this execution environment, and no local `.env` exists. No credentials were fetched from user profiles, Firestore or Chrome. Existing live evaluation now supports `--limit=N` for bounded opt-in subsets.
- No Chrome/desktop interaction, manual deployment, production Firestore reads/writes, historical quiz edits or student submissions were performed.

## Limitations and R3 recommendation

The parser supports a deliberately narrow grammar and full wording templates; general natural-language word problems, transcendental functions, irrational answers, arbitrary symbolic rational functions, inequalities, complex roots, higher-degree completeness, general dimensional analysis and irreducible factorization are inconclusive. Variable denominators/radicals can reject a supplied root by exact substitution but cannot generally prove a complete solution set. Polynomial equivalence does not certify requested factorization form.

Solution checks cover explicit supported claims, not the entire explanation, absence of unsupported facts or every omitted step. Generic semantic ambiguity, arbitrary diagrams/label overlap/curves, external images and actual rendering/vision accuracy remain teacher/AI responsibilities. PDF text layers may be absent, incomplete or ordered imperfectly; detected numbering is diagnostic evidence rather than an OCR oracle.

R3 should measure a credentialed representative gold subset, extend exact template coverage with independently labeled examples, and add a sandboxed diagram renderer plus verified structured geometry. It should also measure real worksheet vision coverage and Render latency. R3 has not been started.
