import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { Type } from '@google/genai';
import { tokenRequired } from '../middleware/auth.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import {
  quizzes,
  users,
  sessionProgress,
  savePersistentData,
  syncDocToFirestore,
  getUniqueQuizTitle
} from '../store/db.ts';
import {
  cropImageBoundingBox,
  renderPdfPageRange,
  getFilesByField,
  sortQuestionsByIndex
} from '../services/pdf.ts';
import { getGeminiClient, getRealModelName, safeParseJSON } from '../services/gemini.ts';
import {
  generateGeminiContent,
  GeminiRateLimitError
} from '../services/geminiRateLimiter.ts';
import { normalizeAiLatexText, normalizeMathQuestionText, normalizeQuestionLayoutText, stripDuplicatedChoiceBlock, stripRedundantOptionPrefix, validateLatexText } from '../services/latex.ts';
import { buildAiTaskConfig } from '../services/aiTaskProfiles.ts';
import {
  applyGoldenAnswers,
  getWorksheetSourceId,
  indexGoldenAnswers,
  normalizeWorksheetSourceId,
  reconcileWorksheetPages,
  stripWorksheetSolverState,
  validateWorksheetQuizForPublication,
  type ExtractedWorksheetPage,
  type GoldenAnswerInput,
  type WorksheetDiagnostic
} from '../services/worksheetPipeline.ts';
import {
  solveWorksheetQuestionsInBatches,
  WORKSHEET_JOB_TIMEOUT_MS
} from '../services/worksheetSolver.ts';
import {
  acquireAiWork,
  AiWorkLimitError,
  type AiWorkLease
} from '../services/aiWorkGuard.ts';
import {
  SHARED_LATEX_RULES,
  getSubjectPromptRules,
  shouldUseStrictMathFormatting,
  WORKSHEET_EXTRACTION_PROMPT,
  WORKSHEET_EXTRACTION_PROMPT_NON_MATH,
  RMX_FLASH_EXTRACTION_PROMPT,
  RECOVERY_PROMPT,
} from '../../prompts.ts';

const MAX_WORKSHEET_FILES = 12;
const MAX_WORKSHEET_FILE_BYTES = 20 * 1024 * 1024;
const MAX_WORKSHEET_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_PDF_PAGES_PER_FILE = 100;
const MAX_WORKSHEET_AI_QUESTIONS = 50;
const aggregateUploadBytes = Symbol('aggregateUploadBytes');

const aggregateMemoryStorage = {
  _handleFile(req: any, file: any, callback: (error?: any, info?: any) => void) {
    const chunks: Buffer[] = [];
    let fileSize = 0;
    let settled = false;

    file.stream.on('data', (value: Buffer | Uint8Array) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const nextTotal = Number(req[aggregateUploadBytes] || 0) + chunk.length;
      req[aggregateUploadBytes] = nextTotal;
      if (nextTotal > MAX_WORKSHEET_TOTAL_BYTES) {
        settled = true;
        chunks.length = 0;
        const error: any = new Error(
          `Combined worksheet uploads must be ${MAX_WORKSHEET_TOTAL_BYTES / (1024 * 1024)} MB or smaller`
        );
        error.code = 'LIMIT_TOTAL_FILE_SIZE';
        file.stream.resume();
        callback(error);
        return;
      }
      chunks.push(chunk);
      fileSize += chunk.length;
    });

    file.stream.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      callback(error);
    });

    file.stream.once('end', () => {
      if (settled) return;
      settled = true;
      callback(null, { buffer: Buffer.concat(chunks, fileSize), size: fileSize });
    });
  },
  _removeFile(_req: any, file: any, callback: (error: Error | null) => void) {
    delete file.buffer;
    callback(null);
  }
};

const upload = multer({
  storage: aggregateMemoryStorage,
  limits: {
    fileSize: MAX_WORKSHEET_FILE_BYTES,
    files: MAX_WORKSHEET_FILES,
    fields: 30,
    fieldSize: 1024 * 1024,
    parts: MAX_WORKSHEET_FILES + 30
  },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      callback(null, true);
      return;
    }
    const error: any = new Error(`Unsupported worksheet file type: ${file.mimetype || 'unknown'}`);
    error.code = 'UNSUPPORTED_WORKSHEET_FILE';
    callback(error);
  }
});
const router = Router();

function respondWorksheetAiLimit(res: any, error: unknown): boolean {
  if (!(error instanceof AiWorkLimitError) && !(error instanceof GeminiRateLimitError)) return false;
  res.setHeader('Retry-After', String(error.retryAfterSeconds));
  res.status(error.status).json({
    success: false,
    error: error.message,
    code: error.code
  });
  return true;
}

const SESSION_PROGRESS_TTL_MS = 15 * 60 * 1000;
const progressCleanupTimers = new Map<string, NodeJS.Timeout>();

function canManageQuiz(user: any, quiz: any): boolean {
  if (!user || !quiz) return false;
  if (user.role === 'admin') return true;
  if (quiz.user_id && quiz.user_id === user.uid) return true;
  return !quiz.user_id && user.uid === 'teacher_test';
}

function setWorksheetProgress(sessionId: unknown, progress: Record<string, any>): void {
  const normalizedSessionId = String(sessionId || '').trim() || 'worksheet';
  const previousTimer = progressCleanupTimers.get(normalizedSessionId);
  if (previousTimer) clearTimeout(previousTimer);

  const updatedAt = Date.now();
  sessionProgress.set(normalizedSessionId, { ...progress, updated_at: updatedAt });
  const timer = setTimeout(() => {
    const current = sessionProgress.get(normalizedSessionId);
    if (current?.updated_at === updatedAt) sessionProgress.delete(normalizedSessionId);
    progressCleanupTimers.delete(normalizedSessionId);
  }, SESSION_PROGRESS_TTL_MS);
  timer.unref();
  progressCleanupTimers.set(normalizedSessionId, timer);
}

function worksheetUploadAny(req: any, res: any, next: any): void {
  upload.any()(req, res, (error: any) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      const limitMessages: Record<string, string> = {
        LIMIT_FILE_SIZE: `Each worksheet file must be ${MAX_WORKSHEET_FILE_BYTES / (1024 * 1024)} MB or smaller.`,
        LIMIT_FILE_COUNT: `Upload no more than ${MAX_WORKSHEET_FILES} worksheet and answer files at once.`,
        LIMIT_PART_COUNT: 'The worksheet upload contains too many form parts.',
        LIMIT_FIELD_COUNT: 'The worksheet upload contains too many form fields.',
        LIMIT_FIELD_VALUE: 'A worksheet form field is too large.'
      };
      const message = limitMessages[error.code] || `Invalid worksheet upload: ${error.message}`;
      res.status(error.code.startsWith('LIMIT_') ? 413 : 400).json({ success: false, error: message });
      return;
    }
    if (error?.code === 'LIMIT_TOTAL_FILE_SIZE') {
      res.status(413).json({
        success: false,
        error: `Combined worksheet and answer files must be ${MAX_WORKSHEET_TOTAL_BYTES / (1024 * 1024)} MB or smaller.`
      });
      return;
    }
    if (error?.code === 'UNSUPPORTED_WORKSHEET_FILE') {
      res.status(415).json({ success: false, error: `${error.message}. Upload PDF or image files only.` });
      return;
    }
    next(error);
  });
}

interface UploadedFilePage {
  buffer: Buffer;
  mimeType: string;
  pageIndex: number;
  pageNumber: number;
  pageCount: number;
}

async function forEachUploadedFilePage(
  file: Express.Multer.File,
  onPage: (page: UploadedFilePage) => void | Promise<void>
): Promise<void> {
  if (file.mimetype !== 'application/pdf') {
    await onPage({
      buffer: file.buffer,
      mimeType: file.mimetype,
      pageIndex: 0,
      pageNumber: 1,
      pageCount: 1
    });
    return;
  }

  await renderPdfPageRange(
    file.buffer,
    { maxPages: MAX_PDF_PAGES_PER_FILE },
    async page => {
      await onPage({
        buffer: page.image,
        mimeType: 'image/png',
        pageIndex: page.pageIndex,
        pageNumber: page.pageNumber,
        pageCount: page.pageCount
      });
    }
  );
}

const ALLOWED_QUESTION_TYPE_VALUES = [
  'multiple_choice',
  'multiple_choice_multi',
  'identification',
  'open_ended',
  'graphing',
  'true_false'
] as const;
const ALLOWED_QUESTION_TYPES = new Set<string>(ALLOWED_QUESTION_TYPE_VALUES);

const WORKSHEET_EXTRACTION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      raw_text: { type: Type.STRING, description: 'Self-contained display text composed from context_prefix and verbatim_text.' },
      verbatim_text: { type: Type.STRING, description: 'Only the literal text belonging to this numbered item, excluding shared instructions.' },
      context_prefix: { type: Type.STRING, description: 'Literal shared heading, passage, or instruction that applies to the item, or an empty string.' },
      options: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Choices, or an empty array.' },
      type: { type: Type.STRING, enum: [...ALLOWED_QUESTION_TYPE_VALUES], description: 'The normalized question type.' },
      original_index: { type: Type.STRING, description: 'The question identifier on the source.' },
      bounding_box: {
        type: Type.ARRAY,
        items: { type: Type.INTEGER },
        description: 'Four normalized integers [ymin, xmin, ymax, xmax], or an empty array.'
      }
    },
    required: ['raw_text', 'verbatim_text', 'context_prefix', 'options', 'type', 'original_index', 'bounding_box']
  }
};

const RMX_QUESTION_PROPERTIES = {
  identifier: { type: Type.STRING },
  original_index: { type: Type.STRING },
  statement: { type: Type.STRING },
  choices: { type: Type.ARRAY, items: { type: Type.STRING } },
  answer: { type: Type.STRING },
  bounding_box: { type: Type.ARRAY, items: { type: Type.INTEGER } }
};

const RMX_EXTRACTION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: RMX_QUESTION_PROPERTIES,
    required: ['identifier', 'original_index', 'statement', 'choices', 'bounding_box']
  }
};

const ANSWER_KEY_PAIR_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      question_number: { type: Type.STRING },
      answer: { type: Type.STRING }
    },
    required: ['question_number', 'answer']
  }
};

const COMPLETE_QUESTION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      question: { type: Type.STRING },
      raw_text: { type: Type.STRING },
      options: { type: Type.ARRAY, items: { type: Type.STRING } },
      answer: { type: Type.STRING },
      type: { type: Type.STRING, enum: [...ALLOWED_QUESTION_TYPE_VALUES] },
      source_index: { type: Type.INTEGER },
      original_index: { type: Type.STRING },
      solution: { type: Type.STRING }
    },
    required: ['question', 'options', 'answer', 'type', 'source_index']
  }
};


function validateBoundingBox(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || (value.length !== 0 && value.length !== 4)) {
    throw new Error('AI returned an invalid diagram bounding box');
  }
  const normalized = value.map(item => Number(item));
  if (normalized.some(item => !Number.isInteger(item) || item < 0 || item > 1000)) {
    throw new Error('AI returned diagram coordinates outside the 0-1000 range');
  }
  return normalized;
}

function validateExtractedQuestions(
  value: unknown,
  label: string,
  formatMathNumbers: boolean | ((item: any) => boolean) = true
): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} did not return a JSON question array`);
  return value.map((item: any, index: number) => {
    if (!item || typeof item !== 'object') throw new Error(`${label} question ${index + 1} is not an object`);
    const useStrictMath = typeof formatMathNumbers === 'function' ? formatMathNumbers(item) : formatMathNumbers;
    const normalizeDisplayText = useStrictMath ? normalizeMathQuestionText : normalizeAiLatexText;
    const normalizeQuestionText = (value: unknown) => normalizeQuestionLayoutText(normalizeDisplayText(value));
    const options = Array.isArray(item.options)
      ? item.options.map((option: unknown, index: number) => stripRedundantOptionPrefix(normalizeDisplayText(option), index))
      : [];
    const verbatimText = stripDuplicatedChoiceBlock(
      normalizeQuestionText(item.verbatim_text ?? item.raw_text ?? ''),
      options
    ).trim();
    const contextPrefix = normalizeDisplayText(item.context_prefix ?? '').trim();
    const legacyRawText = stripDuplicatedChoiceBlock(
      normalizeQuestionText(item.raw_text ?? ''),
      options
    ).trim();
    const rawText = verbatimText
      ? [contextPrefix, verbatimText].filter(Boolean).join('\n')
      : legacyRawText;
    const originalIndex = String(item.original_index ?? '').trim();
    const type = String(item.type || '').trim();
    const isChoiceFragment = !rawText && options.length >= 2;
    if ((!isChoiceFragment && (!rawText || !originalIndex)) || !ALLOWED_QUESTION_TYPES.has(type) || !Array.isArray(item.options)) {
      throw new Error(`${label} question ${index + 1} is missing required fields`);
    }
    const extractionIssues = [rawText, ...options]
      .flatMap(value => validateLatexText(value).map(issue => `${issue.code}: ${issue.message}`));
    return {
      ...item,
      raw_text: rawText,
      verbatim_text: verbatimText || legacyRawText,
      context_prefix: contextPrefix,
      original_index: originalIndex,
      type,
      options,
      bounding_box: validateBoundingBox(item.bounding_box),
      ...(extractionIssues.length > 0 ? { extraction_issues: extractionIssues } : {})
    };
  });
}

function answerPairsToRecord(
  value: unknown,
  label: string
): { record: Record<string, string>; diagnostics: WorksheetDiagnostic[] } {
  if (!Array.isArray(value)) throw new Error(`${label} did not return a JSON answer array`);
  const pairs = value.map((item: any, index: number) => {
    const key = normalizeWorksheetSourceId(item?.question_number);
    const answer = String(item?.answer ?? '').trim();
    if (!key || !answer) throw new Error(`${label} answer ${index + 1} is missing its number or value`);
    return { source_id: key, answer };
  });
  if (pairs.length === 0) throw new Error(`${label} did not find any answers`);
  const indexed = indexGoldenAnswers(pairs);
  const result = Object.fromEntries(
    Array.from(indexed.entries, ([sourceId, entry]) => [sourceId, String(entry.answer)])
  );
  return { record: result, diagnostics: indexed.diagnostics };
}

const WORKSHEET_DIAGNOSTIC_CODES = new Set<WorksheetDiagnostic['code']>([
  'invalid_source_id',
  'duplicate_source_id',
  'duplicate_question_text',
  'duplicate_golden_id',
  'missing_golden_id',
  'unmatched_golden_id',
  'invalid_golden_answer',
  'ambiguous_option_answer',
  'unresolved_fragment',
  'missing_question_text',
  'unsupported_question_type',
  'invalid_options',
  'invalid_latex',
  'duplicate_option',
  'invalid_answer',
  'invalid_points',
  'missing_solution',
  'grading_contract_mismatch',
  'solver_failure',
  'solver_disagreement',
  'invalid_checker_response',
  'review_required',
  'unverified_question',
  'missing_recheck_output',
  'unexpected_recheck_output',
  'invalid_recheck_output'
]);

interface SanitizedWorksheetFragment {
  kind: 'choices' | 'text' | 'image';
  target_source_id?: string;
  text?: string;
  options?: string[];
  crop_or_image_reference?: string;
  source_file?: string;
  page_number?: number;
  reason: string;
}

function boundedWorksheetMetadataText(value: unknown, maximum: number): string {
  return String(value ?? '')
    .replace(/data:[^;,"']+;base64,[A-Za-z0-9+/=]+/gi, '[embedded image omitted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function sanitizeCarriedWorksheetDiagnostics(value: unknown): WorksheetDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const rawCode = String(raw.code || 'review_required') as WorksheetDiagnostic['code'];
    const code = WORKSHEET_DIAGNOSTIC_CODES.has(rawCode) ? rawCode : 'review_required';
    const sourceId = normalizeWorksheetSourceId(raw.source_id).slice(0, 160);
    const sourceFile = boundedWorksheetMetadataText(raw.source_file, 240);
    const pageNumber = Number(raw.page_number);
    const message = boundedWorksheetMetadataText(raw.message, 600) || 'Worksheet review is required.';
    return [{
      code,
      severity: raw.severity === 'warning' ? 'warning' : 'error',
      message,
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(sourceFile ? { source_file: sourceFile } : {}),
      ...(Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber <= MAX_PDF_PAGES_PER_FILE
        ? { page_number: pageNumber }
        : {})
    }];
  });
}

function sanitizeCarriedWorksheetFragments(value: unknown): SanitizedWorksheetFragment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const rawKind = String(raw.kind || 'text');
    const kind: SanitizedWorksheetFragment['kind'] = rawKind === 'choices' || rawKind === 'image' ? rawKind : 'text';
    const targetSourceId = normalizeWorksheetSourceId(raw.target_source_id).slice(0, 160);
    const sourceFile = boundedWorksheetMetadataText(raw.source_file, 240);
    const text = boundedWorksheetMetadataText(raw.text, 1000);
    const options = Array.isArray(raw.options)
      ? raw.options.slice(0, 20).map(option => boundedWorksheetMetadataText(option, 300)).filter(Boolean)
      : [];
    const pageNumber = Number(raw.page_number);
    const rawReference = boundedWorksheetMetadataText(raw.crop_or_image_reference, 500);
    const cropReference = rawReference && !/^data:/i.test(rawReference) ? rawReference : '';
    const reason = boundedWorksheetMetadataText(raw.reason, 600) || 'This fragment could not be reconciled.';
    return [{
      kind,
      reason,
      ...(targetSourceId ? { target_source_id: targetSourceId } : {}),
      ...(sourceFile ? { source_file: sourceFile } : {}),
      ...(text ? { text } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(cropReference ? { crop_or_image_reference: cropReference } : {}),
      ...(Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber <= MAX_PDF_PAGES_PER_FILE
        ? { page_number: pageNumber }
        : {})
    }];
  });
}

function validateRmxQuestions(value: unknown, requireAnswer = false): any[] {
  if (!Array.isArray(value)) throw new Error('RMX extraction did not return a JSON question array');
  return value.map((item: any, index: number) => {
    const identifier = String(item?.identifier ?? '').trim();
    const originalIndex = String(item?.original_index ?? '').trim();
    const statement = normalizeMathQuestionText(item?.statement ?? '').trim();
    const answer = String(item?.answer ?? '').trim();
    if (!identifier || !originalIndex || !statement || !Array.isArray(item?.choices) || (requireAnswer && !answer)) {
      throw new Error(`RMX question ${index + 1} is missing required fields`);
    }
    return {
      ...item,
      identifier,
      original_index: originalIndex,
      statement,
      choices: item.choices.map((choice: unknown) => normalizeMathQuestionText(choice).trim()),
      ...(answer ? { answer } : {}),
      bounding_box: validateBoundingBox(item.bounding_box)
    };
  });
}

function validateCompleteQuestions(value: unknown, expectedLength: number): any[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`Gemini returned ${Array.isArray(value) ? value.length : 0} of ${expectedLength} finalized questions`);
  }
  const bySourceIndex = new Map<number, any>();
  value.forEach((item: any, index: number) => {
    const sourceIndex = Number(item?.source_index);
    const question = normalizeMathQuestionText(item?.question || '').trim();
    const answer = String(item?.answer ?? '').trim();
    const type = String(item?.type || '').trim();
    if (
      !Number.isInteger(sourceIndex)
      || sourceIndex < 0
      || sourceIndex >= expectedLength
      || bySourceIndex.has(sourceIndex)
      || !question
      || !answer
      || !Array.isArray(item?.options)
      || !ALLOWED_QUESTION_TYPES.has(type)
    ) {
      throw new Error(`Gemini returned an invalid finalized question at position ${index + 1}`);
    }
    bySourceIndex.set(sourceIndex, {
      ...item,
      source_index: sourceIndex,
      question,
      answer,
      type,
      options: item.options.map((option: unknown, index: number) => stripRedundantOptionPrefix(normalizeMathQuestionText(option), index)),
      ...(typeof item.solution === 'string' && item.solution.trim()
        ? { solution: normalizeMathQuestionText(item.solution).trim() }
        : {})
    });
  });
  return Array.from({ length: expectedLength }, (_, index) => {
    const item = bySourceIndex.get(index);
    if (!item) throw new Error(`Gemini omitted finalized question ${index + 1}`);
    return item;
  });
}

class WorksheetReviewRequiredError extends Error {
  diagnostics: WorksheetDiagnostic[];

  constructor(message: string, diagnostics: WorksheetDiagnostic[]) {
    super(message);
    this.name = 'WorksheetReviewRequiredError';
    this.diagnostics = diagnostics;
  }
}

function findMissingPlainNumericIds(questions: readonly unknown[]): string[] {
  const ids = questions.map(getWorksheetSourceId);
  if (ids.length === 0 || ids.some(id => !/^(?:0|[1-9]\d*)$/.test(id))) return [];
  const values = ids.map(id => Number(id));
  if (values.some(value => !Number.isSafeInteger(value)) || new Set(values).size !== values.length) return [];
  const minimumFound = Math.min(...values);
  const minimum = minimumFound <= 3 ? 1 : minimumFound;
  const maximum = Math.max(...values);
  const found = new Set(values);
  const missing: string[] = [];
  for (let value = minimum; value <= maximum; value++) {
    if (!found.has(value)) missing.push(String(value));
  }
  return missing;
}

function reconcileExtractedPageResults(pages: ExtractedWorksheetPage[]): {
  questions: any[];
  diagnostics: WorksheetDiagnostic[];
  unresolvedFragments: unknown[];
} {
  const reconciliation = reconcileWorksheetPages(pages);
  const questions = reconciliation.questions.map(question => ({
    ...question,
    raw_text: String(question.raw_text || question.question || '').trim()
  }));
  sortQuestionsByIndex(questions);
  return {
    questions,
    diagnostics: reconciliation.diagnostics,
    unresolvedFragments: reconciliation.unresolved_fragments
  };
}

function worksheetSourceSnapshot(questions: readonly unknown[]): Record<string, unknown>[] {
  return questions.map(question => stripWorksheetSolverState(question));
}

function worksheetBatchSourceLabel(
  questions: readonly unknown[],
  batchStart: number,
  batchEnd: number
): string {
  const first = getWorksheetSourceId(questions[batchStart]) || String(batchStart + 1);
  const last = getWorksheetSourceId(questions[Math.max(batchStart, batchEnd - 1)]) || String(batchEnd);
  return first === last ? `source question ${first}` : `source questions ${first}-${last}`;
}

router.post('/api/extract_worksheet', tokenRequired, worksheetUploadAny, async (req: AuthRequest, res) => {
  const {
    api_key,
    model_name = 'gemini-3.5-flash-lite',
    topic_hint = '',
    subject = 'General',
    session_id = 'ws_1'
  } = req.body;

  const files = (req.files as Express.Multer.File[]) || [];
  const wsFiles = getFilesByField(files, ['files', 'worksheet_files']);

  try {
    if (wsFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'Upload at least one worksheet PDF or image.' });
    }
    let resolvedApiKey = typeof api_key === 'string' ? api_key.trim() : '';
    if (!resolvedApiKey && req.user?.uid) {
      const user = users.get(req.user.uid);
      if (user && typeof user.stored_custom_key === 'string') {
        resolvedApiKey = user.stored_custom_key;
      }
    }
    const ai = getGeminiClient(resolvedApiKey);
    if (!ai) {
      return res.status(400).json({
        success: false,
        error: 'No Gemini API key is configured. Provide a browser key or configure GEMINI_API_KEY/API_KEY on the server.'
      });
    }
    setWorksheetProgress(session_id, { message: '📄 Processing uploaded worksheet files...', percentage: 20, status: 'processing' });
    let questions: any[] = [];
    const extractedPages: ExtractedWorksheetPage[] = [];

    {
      const selectedModel = getRealModelName(model_name);
      const extractionSchema = WORKSHEET_EXTRACTION_SCHEMA;
      const strictMathSubject = shouldUseStrictMathFormatting(subject, topic_hint);
      const subjectRules = getSubjectPromptRules(subject, topic_hint);
      const basePrompt = strictMathSubject ? WORKSHEET_EXTRACTION_PROMPT : WORKSHEET_EXTRACTION_PROMPT_NON_MATH;
      const prompt = basePrompt
        .replace('{latex_rules}', subjectRules)
        .replace('{subject_rules}', subjectRules)
        .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

      const totalFiles = wsFiles.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        const file = wsFiles[fileIdx];
        await forEachUploadedFilePage(file, async page => {
            setWorksheetProgress(session_id, {
              message: `🤖 Analyzing worksheet file ${fileIdx + 1} of ${totalFiles}, page ${page.pageNumber} of ${page.pageCount}...`,
              percentage: Math.round(30 + ((fileIdx + page.pageIndex / page.pageCount) / totalFiles) * 50),
              status: 'processing'
            });
            const response = await generateGeminiContent(ai, {
              model: selectedModel,
              contents: [
                prompt,
                {
                  inlineData: {
                    data: page.buffer.toString('base64'),
                    mimeType: page.mimeType
                  }
                }
              ],
              config: buildAiTaskConfig('document_extraction', {
                responseMimeType: 'application/json',
                responseSchema: extractionSchema,
                maxOutputTokens: 8192
              }) as any
            });

            const parsed = validateExtractedQuestions(
              safeParseJSON(response.text || ''),
              `Worksheet file ${fileIdx + 1}, page ${page.pageNumber}`,
              (item: any) => shouldUseStrictMathFormatting(
                subject,
                topic_hint,
                `${String(item?.raw_text ?? item?.verbatim_text ?? '')} ${Array.isArray(item?.options) ? item.options.join(' ') : ''}`
              )
            );
            for (const q of parsed) {
              if (q.bounding_box.length === 4) {
                const imgUri = await cropImageBoundingBox(page.buffer, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Source Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            extractedPages.push({
              source_file: file.originalname || `worksheet_${fileIdx + 1}`,
              page_number: page.pageNumber,
              file_order: fileIdx,
              questions: parsed
            });
        });
      }
    }

    const reconciliation = reconcileExtractedPageResults(extractedPages);
    questions = reconciliation.questions;

    if (questions.length === 0) {
      const message = 'Gemini did not find any worksheet questions. Check that the upload is readable and contains numbered questions, then try again.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({ success: false, error: message });
    }

    const missingIndices = findMissingPlainNumericIds(questions);

    setWorksheetProgress(session_id, { message: '✅ Worksheet extraction complete!', percentage: 100, status: 'completed' });
    res.json({
      success: true,
      questions,
      missing_indices: missingIndices,
      diagnostics: reconciliation.diagnostics,
      unresolved_fragments: reconciliation.unresolvedFragments
    });
  } catch (err: any) {
    setWorksheetProgress(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(502).json({ success: false, error: `Worksheet extraction failed: ${err.message}` });
  }
});

router.post('/api/solve_worksheet', tokenRequired, async (req: AuthRequest, res) => {
  const {
    questions = [],
    batch_size = 3,
    api_key,
    subject = 'General',
    time_limit = 20,
    quiz_mode = 'back_and_forth',
    topic = 'Worksheet Quiz',
    require_solution = false,
    model_name = 'gemini-3.5-flash-lite',
    session_id = 'solve_1'
  } = req.body;

  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ success: false, error: 'Provide at least one extracted worksheet question to solve.' });
  }
  if (questions.length > MAX_WORKSHEET_AI_QUESTIONS) {
    return res.status(400).json({
      success: false,
      error: `Worksheet solving is limited to ${MAX_WORKSHEET_AI_QUESTIONS} questions per job.`
    });
  }
  questions.forEach((question: any) => {
    if (!question || typeof question !== 'object') return;
    const rawText = question.raw_text ?? question.question ?? question.statement ?? '';
    const strictMath = shouldUseStrictMathFormatting(subject, topic, rawText);
    const displayText = strictMath ? normalizeMathQuestionText(rawText) : normalizeAiLatexText(rawText);
    const normalizedQuestionText = normalizeQuestionLayoutText(displayText).trim();
    if (Object.prototype.hasOwnProperty.call(question, 'raw_text')) question.raw_text = normalizedQuestionText;
    if (Object.prototype.hasOwnProperty.call(question, 'question')) question.question = normalizedQuestionText;
    if (Object.prototype.hasOwnProperty.call(question, 'statement')) question.statement = normalizedQuestionText;
    if (!question.raw_text && !question.question && !question.statement) question.raw_text = normalizedQuestionText;
    if (Array.isArray(question.options)) {
      question.options = question.options.map((option: unknown, index: number) =>
        stripRedundantOptionPrefix(strictMath ? normalizeMathQuestionText(option) : normalizeAiLatexText(option), index)
      );
      const cleanedQuestionText = stripDuplicatedChoiceBlock(normalizedQuestionText, question.options).trim();
      if (Object.prototype.hasOwnProperty.call(question, 'raw_text')) question.raw_text = cleanedQuestionText;
      if (Object.prototype.hasOwnProperty.call(question, 'question')) question.question = cleanedQuestionText;
      if (Object.prototype.hasOwnProperty.call(question, 'statement')) question.statement = cleanedQuestionText;
      if (!question.raw_text && !question.question && !question.statement) question.raw_text = cleanedQuestionText;
    }
  });
  const invalidQuestionIndex = questions.findIndex((question: any) => {
    const text = question?.raw_text || question?.question || question?.statement;
    return typeof text !== 'string' || !text.trim();
  });
  if (invalidQuestionIndex >= 0) {
    return res.status(400).json({
      success: false,
      error: `Question ${invalidQuestionIndex + 1} has no readable question text. Re-extract the worksheet before solving.`
    });
  }
  sortQuestionsByIndex(questions);
  const ai = getGeminiClient(api_key);
  if (!ai) {
    return res.status(400).json({
      success: false,
      error: 'No Gemini API key is configured. Provide an AI Studio browser key or configure GEMINI_API_KEY/API_KEY on the server.'
    });
  }

  const batchNum = Math.min(10, Math.max(1, parseInt(batch_size) || 3));
  let aiLease: AiWorkLease;
  try {
    aiLease = acquireAiWork({
      userId: req.user?.uid || '',
      cost: Math.max(questions.length, Math.ceil(questions.length / batchNum) * 3),
      byok: typeof api_key === 'string' && api_key.trim().length > 0,
      perUserConcurrency: 1,
      globalConcurrency: 3
    });
  } catch (error) {
    if (respondWorksheetAiLimit(res, error)) return;
    console.error('Worksheet AI work guard error:', error);
    return res.status(500).json({
      success: false,
      error: 'Worksheet solving could not be scheduled.'
    });
  }

  setWorksheetProgress(session_id, { message: '⚡ Preparing to solve worksheet questions...', percentage: 10, status: 'processing' });

  res.status(202).json({ success: true, status: 'accepted' });

  void (async () => {
    try {
      const totalQuestions = questions.length;
      const finalQuestions: any[] = [];
      const reviewRequiredIds: string[] = [];
      const reviewDiagnostics: WorksheetDiagnostic[] = [];

      setWorksheetProgress(session_id, {
        message: '🤖 Initializing Solve and Check Engine...',
        percentage: 15,
        status: 'processing'
      });

      const batchSize = batchNum;
      const consensusResults = await solveWorksheetQuestionsInBatches({
        ai,
        questions,
        batchSize,
        subject: String(subject || 'General'),
        topic: String(topic || 'Worksheet Quiz'),
        requestedModel: String(model_name || 'gemini-3.5-flash-lite'),
        deadlineAt: Date.now() + WORKSHEET_JOB_TIMEOUT_MS,
        retryReviewRequired: true,
        onBatchStart: progress => {
          setWorksheetProgress(session_id, {
            message: `🤖 Batch-solving ${worksheetBatchSourceLabel(questions, progress.batch_start, progress.batch_end)} (${progress.batch_end}/${totalQuestions}) with two independent models...`,
            percentage: Math.round(15 + (progress.completed / totalQuestions) * 75),
            status: 'processing'
          });
        },
        onBatchComplete: progress => {
          setWorksheetProgress(session_id, {
            message: `✅ Processed ${progress.completed}/${totalQuestions} questions.`,
            percentage: Math.round(15 + (progress.completed / totalQuestions) * 75),
            status: 'processing'
          });
        }
      });
      for (let index = 0; index < consensusResults.length; index++) {
        const result = consensusResults[index];
        if (!result.publishable) {
          reviewRequiredIds.push(getWorksheetSourceId(questions[index]) || String(index + 1));
          reviewDiagnostics.push(...result.diagnostics);
        }
        finalQuestions.push({
          ...result.question,
          source_index: index,
          source_id: getWorksheetSourceId(questions[index])
        });
      }

      const requireSolution = require_solution === true || require_solution === 'true';
      const publication = validateWorksheetQuizForPublication(finalQuestions, {
        require_solution: requireSolution,
        require_verification: true,
        allow_review_required: reviewRequiredIds.length > 0
      });
      if (!publication.valid && reviewRequiredIds.length === 0) {
        throw new WorksheetReviewRequiredError(
          'Worksheet quiz did not pass final publication validation.',
          publication.diagnostics
        );
      }
      const quizQuestions = publication.questions.length === finalQuestions.length
        ? publication.questions
        : finalQuestions;
      const isDraft = reviewRequiredIds.length > 0 || !publication.valid;
      const uniqueTitle = getUniqueQuizTitle(topic || 'Worksheet Quiz');
      const newQuizId = `quiz_${Date.now()}`;
      const newQuiz: any = {
        id: newQuizId,
        user_id: req.user ? req.user.uid : 'teacher_test',
        title: uniqueTitle,
        subject: subject || 'General',
        time_limit: parseInt(time_limit) || 20,
        quiz_mode: quiz_mode || 'back_and_forth',
        require_solution: requireSolution,
        worksheet_source: { extracted_questions: worksheetSourceSnapshot(questions) },
        questions: quizQuestions,
        is_draft: isDraft,
        review_required_ids: reviewRequiredIds,
        worksheet_validation: {
          review_required: reviewRequiredIds,
          diagnostics: [...reviewDiagnostics, ...publication.diagnostics]
        },
        created_at: new Date().toISOString()
      };

      quizzes.set(newQuizId, newQuiz);
      savePersistentData();
      await syncDocToFirestore('quizzes', newQuizId, newQuiz);

      setWorksheetProgress(session_id, {
        message: isDraft
          ? `📝 Draft created. Review question${reviewRequiredIds.length === 1 ? '' : 's'} ${reviewRequiredIds.join(', ')}.`
          : '🚀 Quiz created! Redirecting...',
        percentage: 100,
        status: 'completed',
        quiz_id: newQuizId,
        ...(isDraft ? { review_required: true, review_required_ids: reviewRequiredIds } : {})
      });
    } catch (err: any) {
      setWorksheetProgress(session_id, {
        message: `❌ Error: ${err.message}`,
        percentage: 100,
        status: 'error',
        error: err.message,
        ...(err instanceof WorksheetReviewRequiredError
          ? { review_required: true, diagnostics: err.diagnostics }
          : {})
      });
    } finally {
      aiLease.release();
    }
  })();
});

router.post('/api/extract_rmxflash', tokenRequired, worksheetUploadAny, async (req: AuthRequest, res) => {
  const { api_key, model_name = 'gemini-3.5-flash-lite', session_id = 'rmx_1' } = req.body;
  const files = (req.files as Express.Multer.File[]) || [];

  const wsFiles = getFilesByField(files, ['worksheet_files', 'files']);
  const ansFiles = getFilesByField(files, ['answer_files']);

  try {
    if (wsFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'Upload at least one RMX worksheet PDF or image.' });
    }
    const ai = getGeminiClient(api_key);
    if (!ai) {
      return res.status(400).json({
        success: false,
        error: 'No Gemini API key is configured. Provide an AI Studio browser key or configure GEMINI_API_KEY/API_KEY on the server.'
      });
    }
    setWorksheetProgress(session_id, { message: '⚡ Extracting RMXFlash questions...', percentage: 25, status: 'processing' });
    let rmxQuestions: any[] = [];
    let goldenKey: Record<string, string> = {};
    const pipelineDiagnostics: WorksheetDiagnostic[] = [];

    {
      const selectedModel = getRealModelName(model_name);

      let prompt = RMX_FLASH_EXTRACTION_PROMPT
        .replace('{latex_rules}', SHARED_LATEX_RULES)
        .replace('{prompt_additions}', 'CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].');

      const totalFiles = wsFiles.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        await forEachUploadedFilePage(wsFiles[fileIdx], async page => {
          setWorksheetProgress(session_id, {
            message: `⚡ Extracting RMX file ${fileIdx + 1} of ${totalFiles}, page ${page.pageNumber} of ${page.pageCount}...`,
            percentage: Math.round(25 + ((fileIdx + page.pageIndex / page.pageCount) / totalFiles) * 40),
            status: 'processing'
          });
          const response = await generateGeminiContent(ai, {
            model: selectedModel,
            contents: [
              prompt,
              {
                inlineData: {
                  data: page.buffer.toString('base64'),
                  mimeType: page.mimeType
                }
              }
            ],
            config: buildAiTaskConfig('document_extraction', {
              responseMimeType: 'application/json',
              responseSchema: RMX_EXTRACTION_SCHEMA,
              maxOutputTokens: 8192
            }) as any
          });

          const parsed = validateRmxQuestions(safeParseJSON(response.text || ''));
          for (const q of parsed) {
            q.source_id = normalizeWorksheetSourceId(q.original_index);
            q.source = {
              source_file: wsFiles[fileIdx].originalname || `rmx_${fileIdx + 1}`,
              page_number: page.pageNumber,
              original_index: q.source_id
            };
            if (q.bounding_box.length === 4) {
              const imgUri = await cropImageBoundingBox(page.buffer, q.bounding_box);
              if (imgUri) {
                const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                q.statement = (q.statement || '') + '\n' + imgHtml;
              }
            }
          }
          rmxQuestions.push(...parsed);
        });
      }

      if (ansFiles.length > 0) {
        setWorksheetProgress(session_id, { message: '⚡ Matching Golden Answer Key...', percentage: 80, status: 'processing' });
        let keyPrompt = `Extract the Golden Answer Key from these files.
Return ONLY a JSON array in this exact shape:
[{"question_number":"1","answer":"A"},{"question_number":"2","answer":"42"}]
Use the printed question number as question_number and the correct choice letter or answer text as answer.`;
        let keyContents: any[] = [keyPrompt];
        ansFiles.forEach(f => {
          keyContents.push({
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          });
        });

        const keyResp = await generateGeminiContent(ai, {
          model: selectedModel,
          contents: keyContents,
          config: buildAiTaskConfig('answer_key_extraction', {
            responseMimeType: 'application/json',
            responseSchema: ANSWER_KEY_PAIR_SCHEMA,
            maxOutputTokens: 4096
          }) as any
        });

        const indexedKey = answerPairsToRecord(safeParseJSON(keyResp.text || ''), 'RMX answer key extraction');
        goldenKey = indexedKey.record;
        pipelineDiagnostics.push(...indexedKey.diagnostics);

        if (Object.keys(goldenKey).length > 0) {
          const goldenApplied = applyGoldenAnswers(
            rmxQuestions.map(question => ({
              ...question,
              question: question.statement,
              options: question.choices,
              type: question.choices.length > 0 ? 'multiple_choice' : 'identification'
            })),
            goldenKey
          );
          pipelineDiagnostics.push(...goldenApplied.diagnostics);
          rmxQuestions = goldenApplied.questions.map((question, index) => ({
            ...rmxQuestions[index],
            answer: question.answer,
            verification: question.verification,
            worksheet_qa: question.worksheet_qa,
            source: question.source,
            source_id: getWorksheetSourceId(question)
          }));
        }
      }
    }

    if (rmxQuestions.length === 0) {
      const message = 'Gemini did not find any RMX questions. Check that the upload is readable and contains complete question statements.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({ success: false, error: message });
    }

    const duplicateKeyDiagnostics = pipelineDiagnostics.filter(item => item.code === 'duplicate_golden_id');
    if (duplicateKeyDiagnostics.length > 0) {
      const message = 'The answer key contains duplicate question identifiers and must be corrected before matching.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({
        success: false,
        error: message,
        review_required: true,
        diagnostics: duplicateKeyDiagnostics
      });
    }

    sortQuestionsByIndex(rmxQuestions);

    setWorksheetProgress(session_id, { message: '✅ RMXFlash extraction complete!', percentage: 100, status: 'completed' });
    res.json({
      success: true,
      questions: rmxQuestions,
      golden_reference: goldenKey,
      diagnostics: pipelineDiagnostics
    });
  } catch (err: any) {
    setWorksheetProgress(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(502).json({ success: false, error: `RMX extraction failed: ${err.message}` });
  }
});

router.post('/api/export_rmxflash_excel', tokenRequired, async (req, res) => {
  const { questions = [], year = '', test_name = '', contest = '' } = req.body;

  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Questions');

    sheet.columns = [
      { header: 'ID', key: 'identifier', width: 15 },
      { header: 'Q#', key: 'original_index', width: 8 },
      { header: 'Statement', key: 'statement', width: 50 },
      { header: 'Choice A', key: 'choice_a', width: 20 },
      { header: 'Choice B', key: 'choice_b', width: 20 },
      { header: 'Choice C', key: 'choice_c', width: 20 },
      { header: 'Choice D', key: 'choice_d', width: 20 },
      { header: 'Choice E', key: 'choice_e', width: 20 },
      { header: 'Correct Answer', key: 'answer', width: 15 }
    ];

    const extractedImages: { filename: string; buffer: Buffer }[] = [];

    questions.forEach((q: any, idx: number) => {
      const choices = q.choices || [];
      const statementRaw = q.statement || '';

      let cleanStatement = statementRaw;
      const imgMatch = statementRaw.match(/src="data:image\/([^;]+);base64,([^"]+)"/);
      if (imgMatch) {
        const ext = imgMatch[1] || 'png';
        const base64Data = imgMatch[2];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        const imgName = `q${q.original_index || idx + 1}_diagram.${ext}`;
        extractedImages.push({ filename: imgName, buffer: imgBuffer });
        cleanStatement = statementRaw.replace(/<div class="resizable-image-wrapper">.*?<\/div>\s*<\/div>/is, ` [Diagram: ${imgName}] `);
      }

      sheet.addRow({
        identifier: q.identifier || `id_${idx}`,
        original_index: q.original_index || idx + 1,
        statement: cleanStatement,
        choice_a: choices[0] || '',
        choice_b: choices[1] || '',
        choice_c: choices[2] || '',
        choice_d: choices[3] || '',
        choice_e: choices[4] || '',
        answer: q.answer || ''
      });
    });

    const excelBuffer = await workbook.xlsx.writeBuffer();

    const safeYear = (year || '').trim();
    const safeTest = (test_name || '').trim();
    const safeContest = (contest || '').trim();
    let baseFilename = `${safeYear}_${safeTest}_${safeContest}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();
    if (!baseFilename || baseFilename === '_') baseFilename = 'rmxflash_export';

    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.zip"`);

    archive.pipe(res);
    archive.append(Buffer.from(excelBuffer), { name: `${baseFilename}.xlsx` });

    extractedImages.forEach(img => {
      archive.append(img.buffer, { name: `images/${img.filename}` });
    });

    await archive.finalize();
  } catch (err: any) {
    console.error('Export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/extract_worksheet_with_answers', tokenRequired, worksheetUploadAny, async (req: AuthRequest, res) => {
  const { session_id = 'sess_ans_1', topic_hint = '', subject = 'General', api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  const files = (req.files as Express.Multer.File[]) || [];

  const wsFiles = getFilesByField(files, ['files', 'worksheet_files']);
  const ansFiles = getFilesByField(files, ['answer_files']);

  try {
    if (wsFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'Upload at least one worksheet PDF or image.' });
    }
    let resolvedApiKey = typeof api_key === 'string' ? api_key.trim() : '';
    if (!resolvedApiKey && req.user?.uid) {
      const user = users.get(req.user.uid);
      if (user && typeof user.stored_custom_key === 'string') {
        resolvedApiKey = user.stored_custom_key;
      }
    }
    const ai = getGeminiClient(resolvedApiKey);
    if (!ai) {
      return res.status(400).json({
        success: false,
        error: 'No Gemini API key is configured. Provide an AI Studio browser key or configure GEMINI_API_KEY/API_KEY on the server.'
      });
    }
    setWorksheetProgress(session_id, { message: '📄 Processing worksheet & answer key files...', percentage: 15, status: 'processing' });
    let questions: any[] = [];
    let goldenReference: Record<string, string> = {};
    const extractedPages: ExtractedWorksheetPage[] = [];
    const pipelineDiagnostics: WorksheetDiagnostic[] = [];
    let unresolvedFragments: unknown[] = [];

    {
      const selectedModel = getRealModelName(model_name);
      const extractionSchema = WORKSHEET_EXTRACTION_SCHEMA;
      const strictMathSubject = shouldUseStrictMathFormatting(subject, topic_hint);
      const subjectRules = getSubjectPromptRules(subject, topic_hint);
      const extractionPromptTemplate = strictMathSubject ? WORKSHEET_EXTRACTION_PROMPT : WORKSHEET_EXTRACTION_PROMPT_NON_MATH;
      const extractionPrompt = extractionPromptTemplate
        .replace('{latex_rules}', subjectRules)
        .replace('{subject_rules}', subjectRules)
        .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

      const totalFiles = wsFiles.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        await forEachUploadedFilePage(wsFiles[fileIdx], async page => {
            setWorksheetProgress(session_id, {
              message: `🤖 Extracting worksheet file ${fileIdx + 1} of ${totalFiles}, page ${page.pageNumber} of ${page.pageCount}...`,
              percentage: Math.round(30 + ((fileIdx + page.pageIndex / page.pageCount) / totalFiles) * 40),
              status: 'processing'
            });
            const wsResponse = await generateGeminiContent(ai, {
              model: selectedModel,
              contents: [
                extractionPrompt,
                {
                  inlineData: {
                    data: page.buffer.toString('base64'),
                    mimeType: page.mimeType
                  }
                }
              ],
              config: buildAiTaskConfig('document_extraction', {
                responseMimeType: 'application/json',
                responseSchema: extractionSchema,
                maxOutputTokens: 8192
              }) as any
            });

            const parsed = validateExtractedQuestions(
              safeParseJSON(wsResponse.text || ''),
              `Worksheet file ${fileIdx + 1}, page ${page.pageNumber}`,
              (item: any) => shouldUseStrictMathFormatting(
                subject,
                topic_hint,
                `${String(item?.raw_text ?? item?.verbatim_text ?? '')} ${Array.isArray(item?.options) ? item.options.join(' ') : ''}`
              )
            );
            for (const q of parsed) {
              if (q.bounding_box.length === 4) {
                const imgUri = await cropImageBoundingBox(page.buffer, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            extractedPages.push({
              source_file: wsFiles[fileIdx].originalname || `worksheet_${fileIdx + 1}`,
              page_number: page.pageNumber,
              file_order: fileIdx,
              questions: parsed
            });
        });
      }

      const reconciliation = reconcileExtractedPageResults(extractedPages);
      questions = reconciliation.questions;
      pipelineDiagnostics.push(...reconciliation.diagnostics);
      unresolvedFragments = reconciliation.unresolvedFragments;

      if (ansFiles.length > 0) {
        setWorksheetProgress(session_id, { message: '🔑 Extracting Golden Answer Key from answer files...', percentage: 70, status: 'processing' });
        let ansPrompt = `Extract the Golden Answer Key / Master Answers from these answer key files.
Return ONLY a JSON array in this exact shape:
[{"question_number":"1","answer":"A"},{"question_number":"2","answer":"42"}]
Use the printed question number as question_number and the correct choice letter or answer text as answer.`;

        let ansContents: any[] = [ansPrompt];
        ansFiles.forEach(f => {
          ansContents.push({
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          });
        });

        const ansResponse = await generateGeminiContent(ai, {
          model: selectedModel,
          contents: ansContents,
          config: buildAiTaskConfig('answer_key_extraction', {
            responseMimeType: 'application/json',
            responseSchema: ANSWER_KEY_PAIR_SCHEMA,
            maxOutputTokens: 4096
          }) as any
        });

        const indexedKey = answerPairsToRecord(
          safeParseJSON(ansResponse.text || ''),
          'Worksheet answer key extraction'
        );
        goldenReference = indexedKey.record;
        pipelineDiagnostics.push(...indexedKey.diagnostics);
      }
    }

    if (questions.length === 0) {
      const message = 'Gemini did not find any worksheet questions. Check that the worksheet upload is readable, then try again.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({ success: false, error: message });
    }

    if (Object.keys(goldenReference).length > 0) {
      const goldenApplied = applyGoldenAnswers(questions, goldenReference);
      questions = goldenApplied.questions;
      pipelineDiagnostics.push(...goldenApplied.diagnostics);
    }

    const duplicateKeyDiagnostics = pipelineDiagnostics.filter(item => item.code === 'duplicate_golden_id');
    if (duplicateKeyDiagnostics.length > 0) {
      const message = 'The answer key contains duplicate question identifiers and must be corrected before matching.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({
        success: false,
        error: message,
        review_required: true,
        diagnostics: duplicateKeyDiagnostics,
        unresolved_fragments: unresolvedFragments
      });
    }

    const missingIndices = findMissingPlainNumericIds(questions);

    setWorksheetProgress(session_id, { message: '✅ Questions and answers extracted successfully!', percentage: 100, status: 'completed' });
    res.json({
      success: true,
      questions,
      golden_reference: goldenReference,
      missing_indices: missingIndices,
      diagnostics: pipelineDiagnostics,
      unresolved_fragments: unresolvedFragments
    });
  } catch (err: any) {
    setWorksheetProgress(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(502).json({ success: false, error: `Worksheet and answer-key extraction failed: ${err.message}` });
  }
});

router.post('/api/recover_questions', tokenRequired, worksheetUploadAny, async (req: AuthRequest, res) => {
  const { missing_numbers, topic_hint = 'General', subject = 'General', api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  const files = (req.files as Express.Multer.File[]) || [];

  let parsedMissingNumbers: unknown = [];
  try {
    parsedMissingNumbers = typeof missing_numbers === 'string' ? JSON.parse(missing_numbers) : missing_numbers;
  } catch (e) {
    parsedMissingNumbers = [];
  }

  try {
    const missingIds = Array.isArray(parsedMissingNumbers)
      ? [...new Set(parsedMissingNumbers.map(normalizeWorksheetSourceId).filter(Boolean))]
      : [];
    if (missingIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Provide at least one valid missing question number.' });
    }
    if (files.length === 0) {
      return res.status(400).json({ success: false, error: 'Upload the original worksheet PDF or image for recovery.' });
    }
    const ai = getGeminiClient(api_key);
    if (!ai) {
      return res.status(400).json({
        success: false,
        error: 'No Gemini API key is configured. Provide an AI Studio browser key or configure GEMINI_API_KEY/API_KEY on the server.'
      });
    }
    let recovered: any[] = [];

    {
      const selectedModel = getRealModelName(model_name);
      const recoverySubjectRules = getSubjectPromptRules(subject, topic_hint);
      const prompt = RECOVERY_PROMPT
        .replace('{topic_hint}', topic_hint)
        .replace('{missing_numbers}', JSON.stringify(missingIds))
        + `\nSubject: ${subject}.\n${recoverySubjectRules}`;

      const totalFiles = files.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        await forEachUploadedFilePage(files[fileIdx], async page => {
          const response = await generateGeminiContent(ai, {
            model: selectedModel,
            contents: [
              prompt,
              {
                inlineData: {
                  data: page.buffer.toString('base64'),
                  mimeType: page.mimeType
                }
              }
            ],
            config: buildAiTaskConfig('document_extraction', {
              responseMimeType: 'application/json',
              responseSchema: WORKSHEET_EXTRACTION_SCHEMA,
              maxOutputTokens: 8192
            }) as any
          });

          const parsedRec = validateExtractedQuestions(
            safeParseJSON(response.text || ''),
            `Recovery file ${fileIdx + 1}, page ${page.pageNumber}`,
            (item: any) => shouldUseStrictMathFormatting(
              subject,
              topic_hint,
              `${String(item?.raw_text ?? item?.verbatim_text ?? '')} ${Array.isArray(item?.options) ? item.options.join(' ') : ''}`
            )
          ).filter(question => missingIds.includes(normalizeWorksheetSourceId(question.original_index)));
          for (const q of parsedRec) {
            q.source_id = normalizeWorksheetSourceId(q.original_index);
            q.source = {
              source_file: files[fileIdx].originalname || `recovery_${fileIdx + 1}`,
              page_number: page.pageNumber,
              original_index: q.source_id
            };
            if (q.bounding_box.length === 4) {
              const imgUri = await cropImageBoundingBox(page.buffer, q.bounding_box);
              if (imgUri) {
                const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
              }
            }
          }
          recovered.push(...parsedRec);
        });
      }
    }

    const recoveredById = new Map<string, any>();
    const duplicateIds: string[] = [];
    recovered.forEach(question => {
      const sourceId = getWorksheetSourceId(question);
      if (recoveredById.has(sourceId)) duplicateIds.push(sourceId);
      else recoveredById.set(sourceId, question);
    });
    if (duplicateIds.length > 0) {
      return res.status(422).json({
        success: false,
        error: `Recovery returned duplicate source IDs: ${[...new Set(duplicateIds)].join(', ')}`,
        diagnostics: [...new Set(duplicateIds)].map(sourceId => ({
          code: 'duplicate_source_id',
          severity: 'error',
          source_id: sourceId,
          message: `Recovery returned duplicate source ID "${sourceId}".`
        }))
      });
    }
    recovered = [...recoveredById.values()];
    if (recovered.length === 0) {
      return res.status(422).json({
        success: false,
        error: `Gemini could not locate requested question identifiers ${missingIds.join(', ')} in the uploaded files. Verify the pages and numbering, then try again.`
      });
    }

    sortQuestionsByIndex(recovered);
    const recoveredIds = new Set(recovered.map(getWorksheetSourceId));
    const stillMissing = missingIds.filter(sourceId => !recoveredIds.has(sourceId));
    res.json({ success: true, recovered, missing_numbers_remaining: stillMissing });
  } catch (err: any) {
    res.status(502).json({ success: false, error: `Question recovery failed: ${err.message}` });
  }
});

router.post('/api/generate_quiz_from_extracted', tokenRequired, async (req: AuthRequest, res) => {
  const {
    questions = [],
    golden_reference = {},
    topic = 'Matched Quiz',
    subject = 'General',
    batch_size = 3,
    time_limit = 30,
    quiz_mode = 'back_and_forth',
    require_solution = false,
    allow_review_required = false,
    worksheet_diagnostics = [],
    unresolved_fragments = [],
    model_name = 'gemini-3.5-flash-lite',
    api_key,
    session_id = 'gen_1'
  } = req.body;

  const explicitlyApproved = allow_review_required === true || allow_review_required === 'true';
  const carriedDiagnostics = sanitizeCarriedWorksheetDiagnostics(worksheet_diagnostics);
  const carriedUnresolvedFragments = sanitizeCarriedWorksheetFragments(unresolved_fragments);
  let aiLease: AiWorkLease | null = null;
  try {
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: 'Provide at least one extracted question to create a quiz.' });
    }
    if (questions.length > MAX_WORKSHEET_AI_QUESTIONS) {
      return res.status(400).json({
        success: false,
        error: `Quiz finalization is limited to ${MAX_WORKSHEET_AI_QUESTIONS} questions per request.`
      });
    }
    const malformedIndex = questions.findIndex((question: any) => {
      const text = question?.question || question?.raw_text || question?.statement;
      return typeof text !== 'string' || !text.trim();
    });
    if (malformedIndex >= 0) {
      return res.status(422).json({
        success: false,
        error: `Extracted question ${malformedIndex + 1} has no readable text. Re-extract or remove it before creating the quiz.`
      });
    }
    const ai = getGeminiClient(api_key);
    const unresolvedDiagnostics: WorksheetDiagnostic[] = carriedUnresolvedFragments.map(fragment => ({
      code: 'unresolved_fragment',
      severity: 'error',
      message: fragment.reason,
      ...(fragment.target_source_id ? { source_id: fragment.target_source_id } : {}),
      ...(fragment.source_file ? { source_file: fragment.source_file } : {}),
      ...(fragment.page_number ? { page_number: fragment.page_number } : {})
    }));
    const pipelineDiagnostics: WorksheetDiagnostic[] = [...carriedDiagnostics, ...unresolvedDiagnostics];
    const carriedBlockingDiagnostics = pipelineDiagnostics.filter(item => item.severity === 'error');
    if (carriedBlockingDiagnostics.length > 0 && !explicitlyApproved) {
      throw new WorksheetReviewRequiredError(
        'Worksheet extraction diagnostics require explicit teacher review before publication.',
        carriedBlockingDiagnostics
      );
    }
    let sourceQuestions = questions.map((question: any) => ({ ...question }));
    sortQuestionsByIndex(sourceQuestions);
    const hasGoldenReference = golden_reference
      && typeof golden_reference === 'object'
      && (Array.isArray(golden_reference) || Object.keys(golden_reference).length > 0);
    let canonicalGoldenReference: Record<string, unknown> | undefined;
    if (hasGoldenReference) {
      const indexedGolden = indexGoldenAnswers(golden_reference as GoldenAnswerInput);
      canonicalGoldenReference = Object.fromEntries(
        [...indexedGolden.entries].map(([sourceId, entry]) => [sourceId, entry.answer])
      );
      const goldenApplied = applyGoldenAnswers(sourceQuestions, golden_reference as GoldenAnswerInput);
      sourceQuestions = goldenApplied.questions;
      pipelineDiagnostics.push(...goldenApplied.diagnostics);
      const blockingGoldenDiagnostics = goldenApplied.diagnostics.filter(item => item.code !== 'review_required');
      if (blockingGoldenDiagnostics.some(item => item.severity === 'error')) {
        throw new WorksheetReviewRequiredError('Golden answer-key reconciliation requires teacher review.', blockingGoldenDiagnostics);
      }
    }
    const explicitlyApprovedQuestionIds = new Set(
      carriedBlockingDiagnostics.map(item => item.source_id).filter((sourceId): sourceId is string => Boolean(sourceId))
    );
    sourceQuestions.forEach((question: any) => {
      if (question?.verification?.verification_status === 'review_required') {
        const sourceId = getWorksheetSourceId(question);
        if (sourceId) explicitlyApprovedQuestionIds.add(sourceId);
      }
    });
    const isQuestionExplicitlyApproved = (question: unknown): boolean =>
      explicitlyApproved && explicitlyApprovedQuestionIds.has(getWorksheetSourceId(question));
    let finalQuestions = sourceQuestions.map(question => ({ ...question }));

    if (ai) {
        aiLease = acquireAiWork({
          userId: req.user?.uid || '',
          cost: questions.length * 3,
          byok: typeof api_key === 'string' && api_key.trim().length > 0
        });

        setWorksheetProgress(session_id, {
          message: '🤖 Initializing Solve and Check Engine...',
          percentage: 20,
          status: 'processing'
        });

        const totalQs = sourceQuestions.length;
        finalQuestions = [];

        const batchSize = Math.min(10, Math.max(1, parseInt(batch_size) || 3));
        const consensusResults = await solveWorksheetQuestionsInBatches({
          ai,
          questions: sourceQuestions,
          batchSize,
          subject: String(subject || 'General'),
          topic: String(topic || 'Matched Quiz'),
          requestedModel: String(model_name || 'gemini-3.5-flash-lite'),
          deadlineAt: Date.now() + WORKSHEET_JOB_TIMEOUT_MS,
          retryReviewRequired: true,
          onBatchStart: progress => {
            setWorksheetProgress(session_id, {
              message: `🤖 Batch-solving ${worksheetBatchSourceLabel(sourceQuestions, progress.batch_start, progress.batch_end)} (${progress.batch_end}/${totalQs}) with two independent models...`,
              percentage: Math.round(20 + (progress.completed / totalQs) * 75),
              status: 'processing'
            });
          },
          onBatchComplete: progress => {
            setWorksheetProgress(session_id, {
              message: `✅ Verified ${progress.completed}/${totalQs} questions.`,
              percentage: Math.round(20 + (progress.completed / totalQs) * 75),
              status: 'processing'
            });
          }
        });
        for (let index = 0; index < consensusResults.length; index++) {
          const result = consensusResults[index];
          if (!result.publishable && !isQuestionExplicitlyApproved(sourceQuestions[index])) {
            throw new WorksheetReviewRequiredError(
              `Question ${getWorksheetSourceId(sourceQuestions[index]) || index + 1} requires teacher review.`,
              result.diagnostics
            );
          }
          finalQuestions.push({
            ...result.question,
            source_index: index,
            source_id: getWorksheetSourceId(sourceQuestions[index])
          });
        }
    } else {
      const unansweredIndex = finalQuestions.findIndex((question: any) => !String(question?.answer ?? '').trim());
      if (unansweredIndex >= 0) {
        return res.status(400).json({
          success: false,
          error: `Question ${unansweredIndex + 1} has no answer and no Gemini key is configured to solve it. Provide an AI Studio browser key or configure GEMINI_API_KEY/API_KEY.`
        });
      }
      setWorksheetProgress(session_id, { message: '✨ Finalizing quiz...', percentage: 65, status: 'processing' });
    }

    const requireSolution = require_solution === true || require_solution === 'true';
    if (explicitlyApproved) {
      finalQuestions = finalQuestions.map((question: any) => {
        if (question?.verification?.verification_status === 'verified') return question;
        if (!isQuestionExplicitlyApproved(question)) return question;
        return {
          ...question,
          verification: {
            answer_source: 'manual',
            verification_status: 'verified',
            reason: 'Teacher explicitly approved this item during the worksheet review workflow.'
          }
        };
      });
    }
    const publication = validateWorksheetQuizForPublication(finalQuestions, {
      require_solution: requireSolution,
      require_verification: true,
      allow_review_required: false
    });
    if (!publication.valid) {
      throw new WorksheetReviewRequiredError(
        'Worksheet quiz did not pass final publication validation.',
        publication.diagnostics
      );
    }

    const uniqueTitle = getUniqueQuizTitle(topic || 'Extracted Worksheet Quiz');
    const newQuizId = `quiz_${Date.now()}`;
    const newQuiz: any = {
      id: newQuizId,
      user_id: req.user ? req.user.uid : 'teacher_test',
      title: uniqueTitle,
      subject: subject || 'General',
      time_limit: parseInt(time_limit) || 30,
      quiz_mode: quiz_mode || 'back_and_forth',
      require_solution: requireSolution,
      golden_reference: canonicalGoldenReference,
      worksheet_source: {
        extracted_questions: worksheetSourceSnapshot(sourceQuestions),
        diagnostics: pipelineDiagnostics,
        unresolved_fragments: carriedUnresolvedFragments,
        teacher_review_approved: explicitlyApproved
          && (carriedBlockingDiagnostics.length > 0 || explicitlyApprovedQuestionIds.size > 0)
      },
      questions: publication.questions,
      created_at: new Date().toISOString()
    };

    quizzes.set(newQuizId, newQuiz);
    savePersistentData();
    await syncDocToFirestore('quizzes', newQuizId, newQuiz);

    setWorksheetProgress(session_id, { message: '🚀 Quiz created! Redirecting...', percentage: 100, status: 'completed', quiz_id: newQuizId });
    res.json({ success: true, quiz_id: newQuizId });
  } catch (err: any) {
    setWorksheetProgress(session_id, {
      message: `❌ Error: ${err.message}`,
      percentage: 100,
      status: 'error',
      ...(err instanceof WorksheetReviewRequiredError
        ? { review_required: true, diagnostics: err.diagnostics }
        : {})
    });
    if (respondWorksheetAiLimit(res, err)) return;
    if (err instanceof WorksheetReviewRequiredError) {
      return res.status(422).json({
        success: false,
        error: err.message,
        review_required: true,
        diagnostics: err.diagnostics,
        unresolved_fragments: carriedUnresolvedFragments
      });
    }
    res.status(502).json({ success: false, error: `Quiz finalization failed: ${err.message}` });
  } finally {
    aiLease?.release();
  }
});

router.get('/worksheet_answers', tokenRequired, (req: AuthRequest, res) => {
  res.render('worksheet_answers_upload', {
    user: req.user,
    is_admin: req.user?.role === 'admin',
    is_rmx_authorized: true
  });
});

router.get(['/worksheet', '/worksheet_upload'], tokenRequired, (req: AuthRequest, res) => {
  res.render('worksheet_upload', {
    user: req.user,
    is_admin: req.user?.role === 'admin',
    is_rmx_authorized: true
  });
});

router.get('/rmxflash', tokenRequired, (req: AuthRequest, res) => {
  res.render('rmxflash_upload', {
    user: req.user,
    is_admin: req.user?.role === 'admin',
    is_rmx_authorized: true
  });
});

router.get('/worksheet/:quiz_id', tokenRequired, (req: AuthRequest, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (quiz) {
    if (!canManageQuiz(req.user, quiz)) return res.status(403).send('You do not have access to this quiz');
    return res.render('worksheet', { quiz });
  }
  res.status(404).send('Worksheet not found');
});

export default router;
