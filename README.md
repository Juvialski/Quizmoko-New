<div align="center">
<img width="1200" height="475" alt="QuizMoKo banner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# QuizMoKo

QuizMoKo is an AI-assisted quiz and worksheet application built with Node.js, TypeScript, Express, EJS, Firebase, and the Google Gen AI SDK.

## Run locally

**Prerequisite:** Node.js 22.13 or newer, below Node.js 25.

```bash
npm install
cp .env.example .env
npm run dev
```

Set at least one Gemini key in `.env` when server-side AI features are required:

```env
GEMINI_API_KEY=your_api_key_here
```

## Architecture map

The canonical current-state application map is [`docs/architecture/APP_WORKFLOW_MAP.md`](docs/architecture/APP_WORKFLOW_MAP.md). Its machine-readable companion is [`docs/architecture/workflow-map.json`](docs/architecture/workflow-map.json).

These files map the full app before roadmap work: actors, UI surfaces, route modules, services, persistence, auth, AI authoring, worksheet extraction/solving, student grading, live sessions, results, deployment constraints, tests, invariants, and known current boundaries.

## Improvement roadmap

Planned hardening and improvement work is tracked separately in [`docs/architecture/IMPROVEMENT_ROADMAP.md`](docs/architecture/IMPROVEMENT_ROADMAP.md).

The roadmap is intentionally **not** a description of current behavior. It organizes the September 2026 full-app audit into seven ordered phases: production safety/security, BYOK and attempt hardening, persistence/resource reliability, backend contract modularization, frontend/browser hardening, measured AI/worksheet improvements, and product/admin completion.

## AI quality pipeline

Hosted AI work is deliberately limited to Gemini 3.5 Flash-Lite and Gemini 3.1 Flash-Lite. Task settings and prompt versions are centralized in `src/services/aiTaskProfiles.ts`.

Every Gemini call also passes through `src/services/geminiRateLimiter.ts`. The default configuration respects a 15-RPM-per-model quota with one request held in reserve, so this server starts at most 14 requests per rolling minute for each model. Drafting, both solvers, retries, adjudication, extraction, grading, and explanations all share those model-specific queues.

New or transformed questions follow a fail-closed pipeline:

1. Generate a structured draft.
2. Normalize the question and run deterministic structure, answer-map, grading-contract, duplicate, and LaTeX checks.
3. Send an answerless copy to both Flash-Lite models for independent solving.
4. Verify canonical agreement, or use blind high-confidence adjudication when the solvers disagree.
5. Keep unresolved, one-solver, malformed, or low-confidence items in `review_required`; structurally unusable items become `invalid`.
6. Publish only verified questions. Review-required questions may remain in the teacher editor as drafts.

Golden answer keys remain authoritative, but conflicts with independent solvers are surfaced for teacher review rather than silently accepted or overwritten.

LaTeX formatting is handled through hash-checked field patches. The formatting model cannot alter wording, numbers, answers, HTML, images, or question meaning. Server and browser validators protect MathJax from malformed delimiters, braces, bare commands, and legacy `\n` corruption.

See [`docs/AI_QUALITY.md`](docs/AI_QUALITY.md) for the complete architecture and status rules.
See [`docs/IMPLEMENTATION_REPORT.md`](docs/IMPLEMENTATION_REPORT.md) for the historical phase-by-phase implementation report.

## Commands

```bash
npm run check   # TypeScript validation
npm test        # TypeScript validation and regression suite
npm run build   # Validation build gate
npm run eval:ai # Run the 20-question live gold evaluation (requires GEMINI_API_KEY)
npm start       # Start the production server
```

## Important deployment boundary

Use a stable `SESSION_SECRET` in production. QuizMoKo's attempt locks and revision high-water guards are process-local, so deploy one writable server process unless durable transactional compare-and-swap protection is added.
