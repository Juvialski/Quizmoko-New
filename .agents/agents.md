# AGENTS TEAM COORDINATOR & ARCHITECTURE MANIFEST

## Workspace Overview: QuizMoKo
- **Runtime**: Node.js (ESM `"type": "module"`) executed via `tsx`
- **Core Server**: Express.js web server (`server.ts`) with Socket.IO real-time engine (`http` + `socket.io`)
- **Frontend / Templating**: EJS views (`/views/*.ejs`) and EJS partial templates (`quiz_body.ejs`, `edit_top.ejs`, `ai_generator.ejs`, etc.) styled with Tailwind CSS and MathJax/KaTeX LaTeX rendering
- **AI Service Layer**: `@google/genai` TypeScript SDK with structured prompt configurations in `prompts.ts`
- **Data & Persistence**: Firebase Firestore (`firebase-admin`, `firebase/firestore`), Firestore security rules (`firestore.rules`), and in-memory Map stores with `/data/*.json` fallbacks
- **Document & Asset Processing**: `pdfjs-dist`, `exceljs`, `sharp`, `archiver`, `multer`

---

## Specialized Sub-Persona Roster

### 1. Frontend & EJS Template Engineer
- **Skill File**: `.agents/skills/frontend.md`
- **Trigger Description**: Trigger when modifying client UI, EJS view templates (`/views/*.ejs`, EJS partials), Tailwind CSS styling, MathJax/LaTeX formatting, client-side JavaScript, modal interactions, responsive layouts, or interactive student/teacher web pages.

### 2. Backend Core & AI Engine Specialist
- **Skill File**: `.agents/skills/backend.md`
- **Trigger Description**: Trigger when editing `server.ts`, `prompts.ts`, Express routes (`/api/*`), Socket.IO live quiz session events, `@google/genai` model integration, worksheet extraction/solver pipelines, or file import/export processing (PDF, Excel, images).

### 3. Data & Firebase Integration Architect
- **Skill File**: `.agents/skills/data.md`
- **Trigger Description**: Trigger when dealing with Firebase Firestore queries, Firebase Authentication, security rules (`firestore.rules`), JSON persistence stores (`/data/*.json`), user role authorization (`admin`/`teacher`/`student`), database seeding, or data integrity scripts.

### 4. DevOps & Package Guard
- **Skill File**: `.agents/skills/devops.md`
- **Trigger Description**: Trigger when modifying `package.json`, environment variables (`.env.example`), build scripts, `tsx` execution commands, dependency management, or performing project-wide compilation and syntax verification.

---

## Routing Guidelines
When receiving a task:
1. Identify the primary layers of the application impacted by the user request.
2. Activate the matching sub-persona from `.agents/skills/` based on explicit trigger criteria.
3. Follow the role instructions, step-by-step execution guidelines, and critical constraints in the skill file.
4. Perform syntax and compilation checks (`compile_applet` / `lint_applet`) prior to completing turns.
