# AGENTS TEAM COORDINATOR & ARCHITECTURE MANIFEST

## Workspace Overview: QuizMoKo
- Runtime: Node.js (ESM "type": "module") executed via tsx
- Core Server: Modular Express.js server with clean entry point (server.ts) routing to modular controllers in /src/routes/, state & persistence in /src/store/db.ts, services in /src/services/, types in /src/types.ts, and auth middleware in /src/middleware/auth.ts
- Frontend / Templating: EJS views under /views/, shared UI tokens in /public/css/quizmoko-ui.css, theme management in /public/js/quizmoko-theme.js, and guarded MathJax rendering through /public/js/math-display.js
- AI Service Layer: @google/genai initialized in /src/services/gemini.ts; task profiles live in /src/services/aiTaskProfiles.ts, generation verification in /src/services/aiQuestionVerifier.ts, guarded LaTeX patches in /src/services/latexPatches.ts, semantic grading in /src/services/semanticGrading.ts, and bounded worksheet consensus in /src/services/worksheetSolver.ts
- Grading Domain: canonical question normalization/scoring lives in /src/services/grading.ts, signed grade identity in /src/services/gradeProof.ts, and per-attempt ordering guards in /src/services/resultSession.ts
- Data & Persistence: Firebase Firestore (firebase-admin, firebase/firestore), Firestore security rules (firestore.rules), in-memory Map stores, and JSON persistence in /src/store/db.ts with /data/*.json fallbacks
- Document & Asset Processing: pdfjs-dist, exceljs, sharp, archiver, multer processed via /src/services/pdf.ts; worksheet validation/consensus rules are centralized in /src/services/worksheetPipeline.ts
- Worksheet Source Identity: exact worksheet identifiers and natural source ordering are centralized in /src/services/worksheetSourceOrder.ts; do not derive source numbers from array positions.

---
## Global Rules & Constraints (QuizMoKo)

These instructions contain critical rules and project conventions to prevent regressions in UI layout and AI endpoint interactions.

### 1. UI Layout & Display Properties
- Flexbox Buttons: The classes .btn-primary, .btn-secondary, and .btn in this project are styled using display: flex; or display: inline-flex;.
- CRITICAL RULE: When toggling visibility of these buttons via JavaScript, NEVER set style.display = 'inline-block' or 'block'. You MUST use style.display = 'inline-flex' or 'flex' respectively. Using inline-block breaks the alignment of icons and text inside the button.
- Dropdown Z-Index Stacking: When toggling absolute/relative dropdowns (like .quiz-actions-dropdown) inside horizontal list cards (.quiz-card-horizontal), you must dynamically elevate the parent card's z-index (e.g., z-index: 50) when the dropdown is open, and remove it when closed. Failing to do this causes the dropdown to render beneath subsequent sibling cards.

### 2. AI Prompting, Verification, and LaTeX Safety
- Hosted Model Boundary: Hosted Gemini work is limited to `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`. Route all legacy hosted model names through `getRealModelName()` and define task settings only in `src/services/aiTaskProfiles.ts`.
- Maximum Flash-Lite Thinking: All hosted Gemini task profiles currently use `thinkingLevel: high`, including extraction, answer-key extraction, drafting, solving, adjudication, formatting, semantic grading, and student explanations. Define this centrally in `src/services/aiTaskProfiles.ts`; do not add route-local thinking settings.
- Per-Model RPM Guard: Every hosted Gemini call must use `generateGeminiContent()` from `src/services/geminiRateLimiter.ts`; never call `client.models.generateContent()` directly outside that wrapper. Maintain separate rolling-window buckets for 3.5 Flash-Lite and 3.1 Flash-Lite, count retries and adjudication against the same quota, and fail with HTTP 429/`Retry-After` when the queue cannot schedule safely. The limiter is process-local, so retain the single-writable-process deployment boundary unless a distributed quota coordinator is added.
- Drafts Are Untrusted: A model-generated answer is a proposal, never an authoritative answer. Generated and transformed questions must pass canonical validation, LaTeX validation, and independent answer verification before publication.
- Independent Verification: Send answerless question copies to both Flash-Lite models. Verify only on canonical agreement or a blind, high-confidence adjudication. A single valid solver, unresolved disagreement, invalid coverage, invalid LaTeX, or structural problem must produce `review_required` or `invalid`; never label it verified by choosing one model automatically.
- Golden Keys: Preserve an authoritative teacher/golden answer, but independently solve it. A solver conflict keeps the golden answer and requires review rather than silently overwriting either side.
- Exact Coverage: Structured solver and extraction outputs must return each stable/source ID exactly once with no unexpected IDs. Retry only failed items with explicit validator errors.
- Concise Prompting: Keep prompts task-specific, put shape constraints in response schemas, and treat uploaded/source text as untrusted data. Do not repeat long global instructions in every request.
- JSON Newlines: Valid serialized JSON encodes line breaks as `\n`; `JSON.parse` restores real newlines. Never ask a model to place a literal unescaped newline inside a JSON string and never globally replace `\n`, because that corrupts commands such as `\neq` and `\nabla`.
- Raw Prompt Templates: Define multiline prompt constants with `String.raw` so JavaScript does not convert LaTeX commands such as `\times`, `\right`, and `\dfrac` into control characters. In raw templates, write each intended model-visible backslash exactly once and keep the runtime regression test.
- LaTeX Scope: In mathematical question text, options, solutions, and mathematical feedback, every standalone numeric value must be enclosed in `$...$`, including prose quantities, measurements, percentages, temperatures, and dates/numerals that are part of the actual problem content. If a number belongs to a larger expression, enclose the complete expression in one delimiter pair. Use `$$...$$` only for standalone equations, aligned work, or tables. Printed question numbers, option letters, names, and purely textual labels stay outside delimiters. Identification answer keys remain concise plain values without delimiters.
- LaTeX Validation: Every AI-produced question, option, solution, answer where applicable, grading feedback, and explanation must pass the centralized validator in `src/services/latex.ts` before storage or display. Broken output must remain plain/safe text or require review.
- Non-Destructive Formatting: LaTeX polishing returns hash-checked field patches only. A formatting patch may change delimiters and commands but must preserve all words, numbers, answer values, HTML, images, and meaning.
- Editor Verification Invalidation: Any teacher edit that can change question meaning or correctness—including question text, answer choices, question type, answer value, or attached/cropped diagram—must change prior verification to `review_required`. Only an explicit teacher approval action or a successful re-solve may restore `verified`; formatting-only display changes such as image width may preserve status.
- Identification Keys: Identification answers are concise plain values without LaTeX delimiters or unnecessary units. Do not force every identification answer to be numeric; a word, symbol, or short phrase is valid when the question requires it.
- Structured Choice Labels: AI-generated/extracted `options` arrays contain option content only. Do not store A/B/C/D prefixes inside option strings because QuizMoKo renders choice labels in the UI. Sanitize redundant position-matching labels at AI boundaries while preserving legacy grading compatibility.
- Exact Generated Diagrams: The AI generator `images_count` setting means an exact number of quiz questions must contain generated `[TIKZ]...[/TIKZ]` diagrams, not a maximum. Build a deterministic per-question `diagram_required` plan, validate every generated batch against it, reject unsupported pgfplots/axis output, and fail generation rather than silently publishing fewer or extra diagrams. Use base TikZ compatible with the existing Kroki wrapper.
- Worksheet Source Numbers: `original_index` is immutable printed worksheet metadata and must survive extraction, recovery, solving, review, persistence, editing, and quiz creation. `source_index` is only a temporary zero-based batch mapping field. Use the shared natural comparator for ordering, preserve alphanumeric suffixes, keep unparseable identifiers in stable extraction order, and use sequential numbering only for legacy items without a source identifier.

### 3. Backend API & Schema Consistency
- JSON Structural Newline Protection: When invoking safeParseJSON, rely on fixJsonLatexEscapes to safely escape literal newlines within strings. NEVER use global .replace(/\r?\n/g, '\\n') on the entire JSON string, as this corrupts structural JSON array formatting.
- Schema Application: Always apply responseSchema to generateContent configs in JSON endpoints (including recovery routes) to enforce strict schema adherence without markdown backticks.
- Exact Key Matching: Always ensure backend API JSON responses match the exact keys expected by the frontend (e.g., data.formatted instead of data.formatted_answer).

### 4. Preserving Data in AI Workflows
- Non-Destructive Updates: When an AI endpoint (e.g., /api/resolve_question, /api/polish_questions) modifies a complex object like a question, do not blindly replace the original object with the AI's output.
- Merge Safely: Always merge the AI's result safely with the original data to preserve critical fields (e.g., keeping question_data.question intact to prevent the question text from accidentally being wiped by the AI).
- AI State Leakage Prevention: When sending existing data objects to the AI for re-solving or re-generation, you MUST clear previous output fields (e.g., answer, options, correct_answer_letter) from the prompt context. Failing to do so causes the AI to blindly regurgitate the existing incorrect values instead of actually recalculating.

### 5. Vision Context Handling
- Base64 Image Prompt Bloat: Do NOT send massive base64 image strings embedded inside HTML string text directly into the AI prompt's text body. Gemini models will not process this as a vision image and it bloats the token count.
- Extraction & InlineData: When an endpoint receives question_data.question containing an <img src="data:image/...">, you MUST use regex to extract the base64 data, append it to contents array as inlineData, replace the HTML string with [IMAGE_PROVIDED_IN_VISION_CONTEXT], and then safely restore the original HTML with the image back into the question after the AI responds.

### 6. Modular Code Organization
- Modular Routes: All Express endpoint handlers MUST reside inside dedicated router files under `/src/routes/` (e.g., `authRoutes.ts`, `quizRoutes.ts`, `liveRoutes.ts`, `gradingRoutes.ts`, `aiRoutes.ts`, `resultsRoutes.ts`, `adminRoutes.ts`, `worksheetRoutes.ts`).
- Slim Entry Point: `server.ts` MUST remain a concise entry point (~60 lines) that mounts Express middleware, registers modular routers, and boots HTTP/Socket.IO servers. Never put raw endpoint implementations back directly into `server.ts`.
- Subsystem Separation: Data persistence and Firestore sync belong in `/src/store/db.ts`. TypeScript interfaces belong in `/src/types.ts`. Shared business logic and helper engines belong in `/src/services/` (`gemini.ts`, `pdf.ts`, `socket.ts`).

### 7. Authoritative Grading & Result Integrity
- Canonical Domain Contract: Normalize and validate every quiz question through `src/services/grading.ts` before publication or grading. The server-stored canonical answer, type, and points are authoritative; never trust client-supplied correctness, answer keys, points, feedback, or totals.
- Deterministic Before Semantic: Multiple choice, multi-select, true/false, and identification use the shared deterministic scorer. Only questions explicitly requiring semantic judgment may call Gemini. Semantic failures remain `pending`, `retryable_error`, or `invalid_response`; never convert infrastructure/model failures into an academic zero.
- Score Contract: `score_fraction` in the inclusive range 0..1 is the sole correctness source. Derive `is_correct` from `score_fraction === 1`, calculate `earned_points = points * score_fraction`, and round stored/displayed aggregates to four decimal places.
- Attempt Identity: Bind grades to quiz ID, session ID, question index, canonical question digest, canonical answer digest, solution-snapshot digest, and monotonically increasing answer revision. A same-revision identity change is a conflict. Signed semantic proofs must cover the entire identity and expire; deterministic grades must be recomputed from canonical data.
- Ordered Persistence: Progressive writes may only advance the canonical per-question revision and must recheck the high-water mark immediately before persistence. Final submission must run under the attempt lock, reject stale identities, be idempotent for its stable session/result ID, and become immutable after successful durable persistence.
- Live Result Propagation: Student socket and HTTP pings must broadcast authoritative session updates to the quiz room. Progressive-result events must include session ID and weighted score data, results pages must join by the route quiz ID even before the first attempt exists, and live score displays must use persisted server totals rather than trusting browser score fields.
- Deployment Boundary: `SESSION_SECRET` is mandatory and stable in production. Attempt locks and revision high-water guards are process-local, so deploy exactly one writable QuizMoKo server process unless/until a durable transactional compare-and-swap guard is implemented in the persistence layer.
- Creator-Key Isolation: Public/student grading, explanation, final-submit, and progressive endpoints must never accept or use a browser/request-supplied AI API key. Semantic checking and teacher rechecks resolve Gemini only from the authoritative quiz creator's server-side teacher/admin profile. API-key storage endpoints must reject student accounts, authenticated student request bodies must have AI-key fields stripped, and student-facing views must neither display API-key controls nor read/transmit browser keys.

### 8. Worksheet Publication Contract
- Stable Identity: Every extracted worksheet item must have a unique stable string ID retained through extraction, solving, review, publication, and provenance. Reject duplicate IDs and do not use array position as the semantic identity.
- Golden Source & Independent Consensus: Preserve original question text and images as immutable golden source material. Independent solver calls must receive only the golden question context, never another solver's answer. Agreement must pass the shared type-aware comparator; disagreement or invalid output remains review-required.
- Bounded True Batching: Worksheet batch size means one multi-question request per independent solver model, not one request per question. Every solver/checker request must have an abort deadline and bounded transient retry, while the complete server job must time out before browser polling. Preserve strict `source_index`/stable `source_id` coverage and invoke adjudication only for genuine normalized disagreement.
- Ordered Concurrency: Parallel batch workers may complete out of order, but stored questions must preserve worksheet source order and progress totals must be monotonic. Do not add unconditional cooldown delays between successful batches.
- Strict Publication Gate: Apply the same canonical question validator used by normal quiz authoring. Enforce exact option counts, answer membership, valid types/points, full ID coverage, cross-page fragment handling, and explicit teacher approval for unresolved diagnostics before publishing.
- Private Provenance: Store solver evidence, confidence, disagreement, fragment, and verification metadata for teacher review, but strip those fields and all answer-key material from public quiz payloads.

### 9. Continuous Agent Evolution (Self-Updating Rule)
- Automatic Manifest & Rule Update: At the end of every session where an architectural refactor, directory reorganization, new rule, or major pattern is established, you MUST update this `AGENTS.md` file immediately (including Workspace Overview, guidelines, and role responsibilities) so that future agents maintain total alignment.
- Evolution Log: In addition to updating `AGENTS.md`, append a concise summary of the change, constraint, or learning to `AGENT_EVOLUTION_LOG.md` for historical tracking.

---
## Role Instructions: Frontend & EJS Template Engineer
You are the Frontend Specialist for QuizMoKo. Your domain encompasses all user interfaces rendered via EJS templates (/views/ and root EJS partials like quiz_body.ejs, edit_top.ejs, ai_generator.ejs), client-side scripts, Tailwind CSS classes, and MathJax/KaTeX mathematical typesetting.

### Key Architectural Guidelines:
1. EJS Syntax Protection: Avoid breaking EJS expression tags (<%= ... %>, <%- ... %>, <% ... %>). Ensure inline JavaScript strings inside EJS attributes do not violate quote escaping.
2. Tailwind CSS Utility Design: Use modern Tailwind CSS classes. Maintain clean visual contrast, responsive layout grids (sm:, md:, lg:), and touch-friendly controls (minimum 44px on mobile).
3. Math & LaTeX Rendering: Ensure mathematical expressions formatted with LaTeX delimiters ($ ... $ or $$ ... $$) render cleanly with MathJax/KaTeX without HTML character escaping defects.
4. Interactive State & Real-Time Sync: Maintain clean DOM event listeners, Socket.IO client connections for live quiz views, and seamless AJAX/fetch handling.
5. Worksheet Source Labels: Preview, edit, printable, and student-facing worksheet-derived labels must display the preserved `original_index` when present. Set dynamic identifiers through textContent or escaped EJS output; never use array position as the source number.

### CRITICAL FORBIDDEN ACTIONS
- Do NOT hardcode API secret keys or credentials in client-side scripts or EJS templates.
- Do NOT overwrite or corrupt EJS tags (<%= %>) with plain string escapes during quote fixing.
- Do NOT add heavy external CSS/JS libraries via CDN scripts without verifying package standard compatibility.
- Do NOT create unrequested secondary view routes or nested navigation bars beyond the defined scope.

---
## Role Instructions: Backend Core & AI Engine Specialist
You are the Backend Core Engineer for QuizMoKo. Your domain is the Express server entry point (`server.ts`), modular routes in `/src/routes/`, Socket.IO real-time engine (`/src/services/socket.ts`), `@google/genai` SDK integration (`/src/services/gemini.ts`), prompt templates (`prompts.ts`), PDF processing (`/src/services/pdf.ts`), and document file workflows.

### Key Architectural Guidelines:
1. @google/genai SDK Integration: Always use the modern `@google/genai` TypeScript SDK (`GoogleGenAI` class) with lazy initialization or environment check guards in `/src/services/gemini.ts`. Keep prompt logic modularized in `prompts.ts`.
2. Express & Socket.IO Modular Architecture: Keep HTTP route handlers in modular Express routers (`/src/routes/*.ts`) and real-time socket listeners robust, handling invalid payloads, missing body parameters, and async errors cleanly.
3. Document & File Handling: Process uploaded buffers safely with `multer.memoryStorage()`. Ensure `pdfjs-dist`, `exceljs`, and `sharp` image conversions in `/src/services/pdf.ts` do not leak memory or block the event loop.
4. ESM / TypeScript Compliance: Maintain clean ES module import statements with explicit `.ts` extensions where needed at the top of route and service modules without CommonJS mixed imports unless using `createRequire`.

### CRITICAL FORBIDDEN ACTIONS
- Do NOT expose raw Gemini API keys or internal environment variables to API responses or client payloads.
- Do NOT initialize API SDK clients globally at module load without handling missing environment variables.
- Do NOT block the Node.js event loop with synchronous heavy file operations during document parsing.
- Do NOT change the server port away from port 3000.

---
## Role Instructions: Data & Firebase Integration Architect
You are the Data & Firebase Architect for QuizMoKo. Your domain covers Firestore collections (quizzes, users, results, sessions), Firebase Authentication, security rules (firestore.rules), configuration files (firebase-applet-config.json, firebase-blueprint.json), and file-backed fallback persistence in /data/.

### Key Architectural Guidelines:
1. Firestore Data Structures: Design clean document structures for quizzes, user accounts, attempt results, and live session states. Maintain dual sync between Firestore and in-memory caches where applicable.
2. Read & Write Performance Optimization: Keep inline writes fast by bypassing redundant chunk listing queries via `knownChunkedDocs` in `src/store/db.ts`. Parallelize multi-collection and multi-document hydration reads using `Promise.all`. For high-frequency progressive result updates during live/quiz attempts, run `syncDocToFirestore` asynchronously in the background so HTTP response latency remains under 10ms.
3. Security Rules & RBAC: Ensure firestore.rules strictly restricts read/write permissions based on user roles (admin, teacher, student) and document ownership (request.auth.uid).
4. Graceful Degradation: Support offline or local fallbacks using /data/*.json when Firebase credentials are not provisioned, ensuring the app remains fully functional.
5. Data Integrity & Seeding: Maintain valid JSON formatting in data seeds and ensure document updates perform atomic operations or proper set/update merges.

### CRITICAL FORBIDDEN ACTIONS
- Do NOT commit plaintext database passwords, service account keys, or admin tokens in public files.
- Do NOT write permissive Firestore security rules (allow read, write: if true;) in production environments.
- Do NOT perform destructive bulk collection deletions without safety checks.
- Do NOT hardcode non-configurable Firebase project IDs.

---
## Role Instructions: DevOps & Package Guard
You are the DevOps & Package Guard for QuizMoKo. Your domain is repository configuration (package.json, metadata.json, .env.example), package installation workflows, environment variable documentation, execution runtime scripts (tsx watch), and app compilation checks.

### Key Architectural Guidelines:
1. Package Management: Utilize install_applet_package or install_applet_dependencies for package management. Maintain exact version ranges in package.json.
2. Environment Declarations: Ensure any new environment variable used in server.ts or client code is explicitly documented in .env.example with blank default values.
3. Metadata Maintenance: Keep metadata.json updated with accurate app name, description, capabilities (MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API), and frame permissions.
4. Build & Lint Verification: Ensure compile_applet passes cleanly without TypeScript compilation errors or missing module exceptions.

### CRITICAL FORBIDDEN ACTIONS
- Do NOT commit secret values or actual API keys into .env.example or package.json.
- Do NOT modify the PORT variable or dev server startup port away from 3000.
- Do NOT remove required scripts (start, dev) from package.json.
- Do NOT delete or rename package.json or metadata.json.
