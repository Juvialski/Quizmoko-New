# AGENTS TEAM COORDINATOR & ARCHITECTURE MANIFEST

## Workspace Overview: QuizMoKo
- Runtime: Node.js (ESM "type": "module") executed via tsx
- Core Server: Modular Express.js server with clean entry point (server.ts) routing to modular controllers in /src/routes/, state & persistence in /src/store/db.ts, services in /src/services/, types in /src/types.ts, and auth middleware in /src/middleware/auth.ts
- Frontend / Templating: EJS views (/views/*.ejs) and EJS partial templates (quiz_body.ejs, edit_top.ejs, ai_generator.ejs, etc.) styled with Tailwind CSS and MathJax/KaTeX LaTeX rendering
- AI Service Layer: @google/genai TypeScript SDK initialized in /src/services/gemini.ts with structured prompt configurations in prompts.ts
- Data & Persistence: Firebase Firestore (firebase-admin, firebase/firestore), Firestore security rules (firestore.rules), in-memory Map stores, and JSON persistence in /src/store/db.ts with /data/*.json fallbacks
- Document & Asset Processing: pdfjs-dist, exceljs, sharp, archiver, multer processed via /src/services/pdf.ts and route handlers

---
## Global Rules & Constraints (QuizMoKo)

These instructions contain critical rules and project conventions to prevent regressions in UI layout and AI endpoint interactions.

### 1. UI Layout & Display Properties
- Flexbox Buttons: The classes .btn-primary, .btn-secondary, and .btn in this project are styled using display: flex; or display: inline-flex;.
- CRITICAL RULE: When toggling visibility of these buttons via JavaScript, NEVER set style.display = 'inline-block' or 'block'. You MUST use style.display = 'inline-flex' or 'flex' respectively. Using inline-block breaks the alignment of icons and text inside the button.
- Dropdown Z-Index Stacking: When toggling absolute/relative dropdowns (like .quiz-actions-dropdown) inside horizontal list cards (.quiz-card-horizontal), you must dynamically elevate the parent card's z-index (e.g., z-index: 50) when the dropdown is open, and remove it when closed. Failing to do this causes the dropdown to render beneath subsequent sibling cards.

### 2. AI Prompting for Math & Science
- No Plain Text Wrapping: Do NOT wrap plain text words, labels, or categories (e.g., 'Right', 'Isosceles', 'John') in LaTeX tags. ONLY wrap numbers, math variables, math operators, and currency values.
- Real Newlines: When instructing the AI to use newlines, instruct it to use 'a real newline' rather than '\\n', which causes the AI to generate literal backslash characters in JSON outputs.
- LaTeX Enclosure Enforcement: When prompting the AI to generate feedback, explanations, or grading text for Math or Science questions, you MUST explicitly enforce LaTeX wrapping for all numbers and math expressions. Currency values can be formatted using escaped dollar syntax inside LaTeX delimiters, e.g., $\text{\$40}$ or $\$$40.
- Mandatory Prompt Addition: Append the following instruction to grading/explanation prompts: `CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside your feedback with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\$$40). Do NOT use asterisks for math.`

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

### 7. Continuous Agent Evolution (Self-Updating Rule)
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