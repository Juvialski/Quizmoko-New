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
  acquireAiWork,
  AiWorkLimitError,
  type AiWorkLease
} from '../services/aiWorkGuard.ts';
import {
  SHARED_LATEX_RULES,
  WORKSHEET_EXTRACTION_PROMPT,
  WORKSHEET_EXTRACTION_PROMPT_NON_MATH,
  NON_MATH_RULES,
  WORKSHEET_SOLVER_PROMPT,
  WORKSHEET_SOLVER_PROMPT_NON_MATH,
  RMX_FLASH_EXTRACTION_PROMPT,
  RMX_FLASH_MATCH_PROMPT,
  RECOVERY_PROMPT,
  RECHECK_ANSWERS_PROMPT
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
  if (!(error instanceof AiWorkLimitError)) return false;
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

const ALLOWED_QUESTION_TYPES = new Set([
  'multiple_choice',
  'multiple_choice_multi',
  'identification',
  'open_ended',
  'graphing',
  'true_false'
]);

const WORKSHEET_EXTRACTION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      raw_text: { type: Type.STRING, description: 'The literal text transcript of the question.' },
      options: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Choices, or an empty array.' },
      type: { type: Type.STRING, description: 'The normalized question type.' },
      original_index: { type: Type.STRING, description: 'The question identifier on the source.' },
      bounding_box: {
        type: Type.ARRAY,
        items: { type: Type.INTEGER },
        description: 'Four normalized integers [ymin, xmin, ymax, xmax], or an empty array.'
      }
    },
    required: ['raw_text', 'options', 'type', 'original_index', 'bounding_box']
  }
};

const SOLVED_QUESTION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      options: { type: Type.ARRAY, items: { type: Type.STRING } },
      answer: { type: Type.STRING },
      type: { type: Type.STRING },
      source_index: { type: Type.INTEGER },
      solution: { type: Type.STRING }
    },
    required: ['options', 'answer', 'type', 'source_index']
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

const RMX_MATCH_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: RMX_QUESTION_PROPERTIES,
    required: ['identifier', 'original_index', 'statement', 'choices', 'answer']
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
      type: { type: Type.STRING },
      source_index: { type: Type.INTEGER },
      original_index: { type: Type.STRING },
      solution: { type: Type.STRING }
    },
    required: ['question', 'options', 'answer', 'type', 'source_index']
  }
};

const SINGLE_SOLVED_QUESTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    options: { type: Type.ARRAY, items: { type: Type.STRING } },
    answer: { type: Type.STRING },
    type: { type: Type.STRING },
    solution: { type: Type.STRING }
  },
  required: ['options', 'answer', 'type', 'solution']
};

const SINGLE_CHECKER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verified: { type: Type.BOOLEAN },
    corrected_answer: { type: Type.STRING },
    corrected_solution: { type: Type.STRING },
    corrected_type: { type: Type.STRING },
    reason: { type: Type.STRING }
  },
  required: ['verified', 'reason']
};

function areAnswersMatching(ans1: string, ans2: string, type1?: string, type2?: string): boolean {
  if (!ans1 || !ans2) return false;
  const a = String(ans1).trim();
  const b = String(ans2).trim();
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;

  // 1. Helper function to normalize LaTeX/Math expressions
  const normalizeMath = (str: string): string => {
    let s = str.replace(/\$/g, '').trim();
    // Replace \frac{A}{B} or \dfrac{A}{B} with A/B
    s = s.replace(/\\d?frac\s*\{([^}]+)\}\s*\{([^}]+)\}/g, '$1/$2');
    // Remove \text{...} wrappers
    s = s.replace(/\\text\s*\{([^}]+)\}/g, '$1');
    // Remove general LaTeX wrappers: \mathrm, \mathbf, \vec etc.
    s = s.replace(/\\[a-zA-Z]+\s*\{([^}]+)\}/g, '$1');
    // Replace LaTeX spacing and special symbols
    s = s.replace(/\\[,;!\s]/g, ' ');
    s = s.replace(/\\cdot/g, '*').replace(/\\times/g, '*');
    s = s.replace(/\\div/g, '/');
    s = s.replace(/\\bar\s*\{([^}]+)\}/g, '$1');
    s = s.replace(/\\/g, '');
    
    // Normalize spaces to single space instead of removing everything immediately
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  };

  const normA = normalizeMath(a);
  const normB = normalizeMath(b);
  if (normA.toLowerCase() === normB.toLowerCase()) return true;
  if (normA.replace(/\s+/g, '') === normB.replace(/\s+/g, '')) return true;

  // 2. Multiple choice letter comparison (e.g., "A" vs "A) some text" or "A.")
  const cleanA = normA.replace(/\s+/g, '');
  const cleanB = normB.replace(/\s+/g, '');
  const letterA = cleanA.match(/^([a-d])[\b\)\.]?/)?.[1] || cleanA.match(/\b([a-d])\b/)?.[1];
  const letterB = cleanB.match(/^([a-d])[\b\)\.]?/)?.[1] || cleanB.match(/\b([a-d])\b/)?.[1];
  if (letterA && letterB && letterA === letterB && (type1 === 'multiple_choice' || type2 === 'multiple_choice' || (cleanA.length <= 4 && cleanB.length <= 4))) {
    return true;
  }

  // 3. Mathematical evaluation (e.g., "1/3" vs "0.33", "3 1/2" vs "7/2" or "3.5")
  const tryEvaluate = (str: string): number | null => {
    const cleaned = str.trim().toLowerCase();
    
    // Remove common trailing units and prefixes
    const unitLess = cleaned
      .replace(/(?:cm|m|in|inches|ft|feet|deg|degrees|usd|dollars|cents|units|%|px|\bpt\b)\.?$/g, '')
      .replace(/^\$/, '')
      .trim();

    // 1. Pure number: "12", "12.5", "-4.2"
    if (/^-?\d+(?:\.\d+)?$/.test(unitLess)) {
      return parseFloat(unitLess);
    }

    // 2. Pure fraction: "1/2", "7/4", "-1/3"
    const fracMatch = unitLess.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (fracMatch) {
      const num = parseFloat(fracMatch[1]);
      const den = parseFloat(fracMatch[2]);
      if (den !== 0) return num / den;
    }

    // 3. Mixed number: "3 1/2" or "3_1/2" or "3-1/2"
    const mixedMatch = unitLess.match(/^(\d+)(?:\s+|-|_|&nbsp;)(\d+)\/(\d+)$/);
    if (mixedMatch) {
      const whole = parseFloat(mixedMatch[1]);
      const num = parseFloat(mixedMatch[2]);
      const den = parseFloat(mixedMatch[3]);
      if (den !== 0) return whole + (num / den);
    }

    return null;
  };

  const valA = tryEvaluate(normA);
  const valB = tryEvaluate(normB);
  if (valA !== null && valB !== null && Math.abs(valA - valB) < 0.015) {
    return true;
  }

  // 4. Word-by-word text comparison (for open-ended/descriptive)
  const textA = normA.replace(/[^\w]/g, ' ');
  const textB = normB.replace(/[^\w]/g, ' ');
  if (textA.trim() === textB.trim() && textA.trim() !== '') return true;

  const wordsA = new Set(textA.split(' ').filter(w => w.length > 2));
  const wordsB = new Set(textB.split(' ').filter(w => w.length > 2));
  if (wordsA.size > 0 && wordsB.size > 0) {
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const overlapFraction = intersection / Math.min(wordsA.size, wordsB.size);
    if (overlapFraction >= 0.85) return true;
  }

  return false;
}

const MANDATORY_MATH_FEEDBACK_RULE =
  'CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside your feedback with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\\$$40). Do NOT use asterisks for math.';

interface PreparedVisionText {
  original: string;
  text: string;
  assets: Array<{ token: string; html: string; data: string }>;
}

function prepareVisionText(rawValue: unknown, contents: any[]): PreparedVisionText {
  const original = typeof rawValue === 'string' ? rawValue : '';
  const assets: PreparedVisionText['assets'] = [];
  const addAsset = (html: string) => {
    const srcMatch = html.match(/\bsrc\s*=\s*["']data:([^;,"']+);base64,([^"']+)["']/i);
    if (!srcMatch) return html;
    const visionNumber = contents.reduce(
      (count, item) => count + (item && item.inlineData ? 1 : 0),
      0
    ) + 1;
    const token = `[IMAGE_PROVIDED_IN_VISION_CONTEXT_${visionNumber}]`;
    contents.push({ inlineData: { mimeType: srcMatch[1] || 'image/png', data: srcMatch[2] } });
    assets.push({ token, html, data: srcMatch[2] });
    return token;
  };

  const wrappedImagePattern = /<div\s+class=["']resizable-image-wrapper["'][^>]*>\s*<div\s+class=["']image-content-box["'][^>]*>\s*<img\b[^>]*\bsrc\s*=\s*["']data:[^"']+["'][^>]*>\s*<\/div>\s*<\/div>/gi;
  let text = original.replace(wrappedImagePattern, addAsset);
  text = text.replace(/<img\b[^>]*\bsrc\s*=\s*["']data:[^"']+["'][^>]*>/gi, addAsset);
  text = text.replace(/<br\s*\/?>/gi, '\n').trim();
  return { original, text, assets };
}

function restoreVisionText(candidate: unknown, prepared: PreparedVisionText): string {
  if (typeof candidate !== 'string' || !candidate.trim()) return prepared.original;
  let restored = candidate;
  const restoredAssets = new Set<number>();
  prepared.assets.forEach((asset, index) => {
    if (restored.includes(asset.token)) {
      restored = restored.split(asset.token).join(asset.html);
      restoredAssets.add(index);
    } else if (restored.includes(asset.data)) {
      restoredAssets.add(index);
    }
  });
  prepared.assets.forEach((asset, index) => {
    if (!restoredAssets.has(index)) restored += `${restored.trim() ? '\n' : ''}${asset.html}`;
  });
  return restored.replace(/\[IMAGE_PROVIDED_IN_VISION_CONTEXT(?:_\d+)?\]/gi, '').trim();
}

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

function validateExtractedQuestions(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} did not return a JSON question array`);
  return value.map((item: any, index: number) => {
    if (!item || typeof item !== 'object') throw new Error(`${label} question ${index + 1} is not an object`);
    const rawText = String(item.raw_text || '').trim();
    const originalIndex = String(item.original_index ?? '').trim();
    const type = String(item.type || '').trim();
    if (!rawText || !originalIndex || !ALLOWED_QUESTION_TYPES.has(type) || !Array.isArray(item.options)) {
      throw new Error(`${label} question ${index + 1} is missing required fields`);
    }
    return {
      ...item,
      raw_text: rawText,
      original_index: originalIndex,
      type,
      options: item.options.map((option: unknown) => String(option)),
      bounding_box: validateBoundingBox(item.bounding_box)
    };
  });
}

function validateSolvedQuestions(value: unknown, expectedLength: number, expectedStartIndex: number): any[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`AI solved ${Array.isArray(value) ? value.length : 0} of ${expectedLength} questions in a batch`);
  }
  return value.map((item: any, index: number) => {
    if (
      !item
      || typeof item !== 'object'
      || !Array.isArray(item.options)
      || !ALLOWED_QUESTION_TYPES.has(String(item.type || ''))
      || !Number.isInteger(Number(item.source_index))
      || Number(item.source_index) !== expectedStartIndex + index
      || item.answer === undefined
      || item.answer === null
      || !String(item.answer).trim()
    ) {
      throw new Error(`AI returned an invalid solution for batch question ${index + 1}`);
    }
    return {
      ...item,
      options: item.options.map((option: unknown) => String(option)),
      answer: String(item.answer).trim(),
      type: String(item.type)
    };
  });
}

function answerPairsToRecord(value: unknown, label: string): Record<string, string> {
  if (!Array.isArray(value)) throw new Error(`${label} did not return a JSON answer array`);
  const result: Record<string, string> = {};
  value.forEach((item: any, index: number) => {
    const key = String(item?.question_number ?? '').trim();
    const answer = String(item?.answer ?? '').trim();
    if (!key || !answer) throw new Error(`${label} answer ${index + 1} is missing its number or value`);
    result[key] = answer;
  });
  if (Object.keys(result).length === 0) throw new Error(`${label} did not find any answers`);
  return result;
}

function validateRmxQuestions(value: unknown, requireAnswer = false): any[] {
  if (!Array.isArray(value)) throw new Error('RMX extraction did not return a JSON question array');
  return value.map((item: any, index: number) => {
    const identifier = String(item?.identifier ?? '').trim();
    const originalIndex = String(item?.original_index ?? '').trim();
    const statement = String(item?.statement ?? '').trim();
    const answer = String(item?.answer ?? '').trim();
    if (!identifier || !originalIndex || !statement || !Array.isArray(item?.choices) || (requireAnswer && !answer)) {
      throw new Error(`RMX question ${index + 1} is missing required fields`);
    }
    return {
      ...item,
      identifier,
      original_index: originalIndex,
      statement,
      choices: item.choices.map((choice: unknown) => String(choice)),
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
    const question = String(item?.question || '').trim();
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
      options: item.options.map((option: unknown) => String(option))
    });
  });
  return Array.from({ length: expectedLength }, (_, index) => {
    const item = bySourceIndex.get(index);
    if (!item) throw new Error(`Gemini omitted finalized question ${index + 1}`);
    return item;
  });
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
    const ai = getGeminiClient(api_key);
    if (!ai) {
      return res.status(400).json({
        success: false,
        error: 'No Gemini API key is configured. Provide a browser key or configure GEMINI_API_KEY/API_KEY on the server.'
      });
    }
    setWorksheetProgress(session_id, { message: '📄 Processing uploaded worksheet files...', percentage: 20, status: 'processing' });
    let questions: any[] = [];

    {
      const selectedModel = getRealModelName(model_name);
      const extractionSchema = WORKSHEET_EXTRACTION_SCHEMA;
      const isNonMath = ['english', 'history', 'biology', 'social studies'].includes(String(subject).toLowerCase());
      const basePrompt = isNonMath ? WORKSHEET_EXTRACTION_PROMPT_NON_MATH : WORKSHEET_EXTRACTION_PROMPT;
      const prompt = basePrompt
        .replace('{latex_rules}', SHARED_LATEX_RULES)
        .replace('{subject_rules}', isNonMath ? NON_MATH_RULES : '')
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
            const response = await ai.models.generateContent({
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
              config: {
                responseMimeType: 'application/json',
                responseSchema: extractionSchema,
                maxOutputTokens: 8192
              }
            });

            const parsed = validateExtractedQuestions(
              safeParseJSON(response.text || ''),
              `Worksheet file ${fileIdx + 1}, page ${page.pageNumber}`
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
            questions.push(...parsed);
        });
      }
    }

    if (questions.length === 0) {
      const message = 'Gemini did not find any worksheet questions. Check that the upload is readable and contains numbered questions, then try again.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({ success: false, error: message });
    }

    sortQuestionsByIndex(questions);

    const extractedIndices = questions.map((q: any) => parseInt(q.original_index)).filter((n: number) => !isNaN(n)).sort((a: number, b: number) => a - b);
    const missingIndices: number[] = [];
    if (extractedIndices.length > 0) {
      const maxIdx = Math.max(...extractedIndices);
      let minIdx = Math.min(...extractedIndices);
      if (minIdx <= 3) minIdx = 1;
      
      for (let i = minIdx; i <= maxIdx; i++) {
        if (!extractedIndices.includes(i)) {
          missingIndices.push(i);
        }
      }
    }

    setWorksheetProgress(session_id, { message: '✅ Worksheet extraction complete!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions, missing_indices: missingIndices });
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
      const isNonMath = ['english', 'history', 'biology', 'social studies'].includes(String(subject).toLowerCase());
      const solverPromptTemplate = isNonMath ? WORKSHEET_SOLVER_PROMPT_NON_MATH : WORKSHEET_SOLVER_PROMPT;
      const selectedModel = getRealModelName(model_name);

      const totalQuestions = questions.length;
      const finalQuestions: any[] = [];

      setWorksheetProgress(session_id, {
        message: '🤖 Initializing Solve and Check Engine...',
        percentage: 15,
        status: 'processing'
      });

      const batchSize = batchNum;
      for (let i = 0; i < totalQuestions; i += batchSize) {
        const batchEnd = Math.min(totalQuestions, i + batchSize);
        const batchQuestions = questions.slice(i, batchEnd);

        setWorksheetProgress(session_id, {
          message: `🤖 Solving Batch Q${i + 1}-${batchEnd}/${totalQuestions} with Peer Verification...`,
          percentage: Math.round(15 + (i / totalQuestions) * 75),
          status: 'processing'
        });

        const batchPromises = batchQuestions.map(async (rawQ: any, index: number) => {
          const qIdx = i + index;
          const pctStart = Math.round(15 + (qIdx / totalQuestions) * 75);
          const pctEnd = Math.round(15 + ((qIdx + 1) / totalQuestions) * 75);

          const qContents: any[] = [];
          const prepared = prepareVisionText(rawQ.raw_text || rawQ.question || rawQ.statement || '', qContents);

          const existingOptions = Array.isArray(rawQ.options) ? rawQ.options : (Array.isArray(rawQ.choices) ? rawQ.choices : []);

          const solverPromptText = `You are a master educator and subject matter expert test solver.
Solve the following question accurately and generate a complete step-by-step worked solution.

SUBJECT: ${subject || 'General'}
TOPIC: ${topic || 'General'}

QUESTION TO SOLVE:
${prepared.text}

EXISTING CHOICES/OPTIONS (if multiple choice):
${JSON.stringify(existingOptions)}

CRITICAL INSTRUCTIONS:
1. Provide the exact correct answer in the 'answer' field.
   - For Multiple Choice: Output the correct choice letter (e.g. "A", "B", "C", "D") or choice string matching the option.
   - For Multiple Select: Output comma-separated options/letters (e.g. "A, C").
   - For True/False: Output "A" or "B" (or "True" / "False").
   - For Identification: Output ONLY the concise final answer value (no sentence wrappers).
   - For Open Ended / Math / Science: Output the complete, accurate answer value or key rubric grading points.
2. In the 'solution' field, write a clear, thorough step-by-step worked explanation showing how to arrive at the answer.
3. ${MANDATORY_MATH_FEEDBACK_RULE}

Return STRICTLY a JSON object with keys:
- "options": array of strings (choices if multiple choice, else [])
- "answer": string (the exact correct answer)
- "type": string (one of "multiple_choice", "multiple_choice_multi", "identification", "open_ended", "graphing", "true_false")
- "solution": string (detailed step-by-step worked solution)
`;

          qContents.unshift(solverPromptText);

          // 1. Solve Step
          let resSolve;
          try {
            resSolve = await ai.models.generateContent({
              model: selectedModel,
              contents: qContents,
              config: {
                responseMimeType: 'application/json',
                responseSchema: SINGLE_SOLVED_QUESTION_SCHEMA,
                maxOutputTokens: 4096
              }
            });
          } catch (err: any) {
            console.error(`[Worksheet Solver] Solver model failed for Q${qIdx + 1}:`, err);
            throw new Error(`Solver model failed: ${err.message}`);
          }

          const parsed = safeParseJSON(resSolve?.text || '{}') || {};
          const solvedAnswer = String(parsed.answer || '').trim();
          const solvedSolution = String(parsed.solution || '').trim();
          const solvedType = String(parsed.type || rawQ.type || 'identification').trim();

          // 2. Check Step (Peer Checker)
          const checkerModel = selectedModel === 'gemini-3.1-flash-lite' ? 'gemini-3.5-flash-lite' : 'gemini-3.1-flash-lite';
          
          setWorksheetProgress(session_id, {
            message: `🔍 Q${qIdx + 1}/${totalQuestions}: Peer checker (${checkerModel}) verifying answer...`,
            percentage: Math.round(pctStart + (pctEnd - pctStart) * 0.5),
            status: 'processing'
          });

          const checkContents: any[] = [];
          const checkerPrepared = prepareVisionText(rawQ.raw_text || rawQ.question || rawQ.statement || '', checkContents);

          const checkerPrompt = `You are a senior educator and peer reviewer. Your job is to verify the correctness of an AI-generated answer and step-by-step solution for the given question.

SUBJECT: ${subject || 'General'}
TOPIC: ${topic || 'General'}

QUESTION TO VERIFY:
${checkerPrepared.text}

EXISTING CHOICES/OPTIONS (if multiple choice):
${JSON.stringify(existingOptions)}

PROPOSED ANSWER TO VERIFY:
"${solvedAnswer}"

PROPOSED WORKED SOLUTION TO VERIFY:
"${solvedSolution}"

PROPOSED QUESTION TYPE:
"${solvedType}"

CRITICAL INSTRUCTIONS:
1. Analyze the question carefully. Determine if the proposed answer is correct and mathematically accurate.
2. If the proposed answer, solution, and type are correct/accurate, set 'verified' to true.
3. If there is any mistake in calculations, logic, fact, or option choice, set 'verified' to false.
4. If 'verified' is false, you MUST provide the correct 'corrected_answer', 'corrected_solution', and 'corrected_type'.
5. ${MANDATORY_MATH_FEEDBACK_RULE}

Return STRICTLY a JSON object with keys:
- "verified": boolean (true if correct, false if incorrect or needs correction)
- "corrected_answer": string (the corrected exact answer, only if verified is false)
- "corrected_solution": string (the corrected step-by-step solution, only if verified is false)
- "corrected_type": string (one of "multiple_choice", "multiple_choice_multi", "identification", "open_ended", "graphing", "true_false", only if verified is false)
- "reason": string (concise explanation of why the proposed solution is correct or why/how it was corrected)
`;
          checkContents.unshift(checkerPrompt);

          let finalAnswer = solvedAnswer;
          let finalSolution = solvedSolution;
          let finalType = solvedType;
          let finalOptions = (Array.isArray(parsed.options) && parsed.options.length > 0) ? parsed.options : existingOptions;

          try {
            const resCheck = await ai.models.generateContent({
              model: checkerModel,
              contents: checkContents,
              config: {
                responseMimeType: 'application/json',
                responseSchema: SINGLE_CHECKER_SCHEMA,
                maxOutputTokens: 4096
              }
            });
            const checkParsed = safeParseJSON(resCheck?.text || '{}') || {};

            if (checkParsed.verified === true) {
              setWorksheetProgress(session_id, {
                message: `✅ Q${qIdx + 1}/${totalQuestions}: Solver answer verified! Answer: "${finalAnswer.substring(0, 25)}"`,
                percentage: pctEnd,
                status: 'processing'
              });
            } else if (checkParsed.verified === false) {
              finalAnswer = String(checkParsed.corrected_answer || solvedAnswer).trim();
              finalSolution = String(checkParsed.corrected_solution || solvedSolution).trim();
              finalType = String(checkParsed.corrected_type || solvedType).trim();
              setWorksheetProgress(session_id, {
                message: `✍️ Q${qIdx + 1}/${totalQuestions}: Peer corrected answer to: "${finalAnswer.substring(0, 25)}"`,
                percentage: pctEnd,
                status: 'processing'
              });
            } else {
              setWorksheetProgress(session_id, {
                message: `🔍 Q${qIdx + 1}/${totalQuestions}: Solver answer bypassed checker: "${finalAnswer.substring(0, 25)}"`,
                percentage: pctEnd,
                status: 'processing'
              });
            }
          } catch (checkErr: any) {
            console.warn(`[Worksheet Solver] Peer checker failed for Q${qIdx + 1} (falling back to Solver answer):`, checkErr);
            setWorksheetProgress(session_id, {
              message: `🔍 Q${qIdx + 1}/${totalQuestions}: Solver answer: "${finalAnswer.substring(0, 25)}"`,
              percentage: pctEnd,
              status: 'processing'
            });
          }

          return {
            ...rawQ,
            question: restoreVisionText(rawQ.question || rawQ.statement || rawQ.raw_text, prepared),
            raw_text: rawQ.raw_text || restoreVisionText(rawQ.question || rawQ.statement, prepared),
            options: finalOptions,
            answer: finalAnswer,
            type: finalType || (finalOptions.length > 0 ? 'multiple_choice' : 'identification'),
            solution: finalSolution
          };
        });

        const batchResults = await Promise.all(batchPromises);
        finalQuestions.push(...batchResults);

        // Dynamic rate limit control: Add cooldown between batches to fit 15 RPM
        if (i + batchSize < totalQuestions) {
          const progressPercentage = Math.round(15 + (batchEnd / totalQuestions) * 75);
          setWorksheetProgress(session_id, {
            message: `⏳ Cool-down phase (3s) to prevent API rate limits...`,
            percentage: progressPercentage,
            status: 'processing'
          });
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      const uniqueTitle = getUniqueQuizTitle(topic || 'Worksheet Quiz');
      const newQuizId = `quiz_${Date.now()}`;
      const newQuiz = {
        id: newQuizId,
        user_id: req.user ? req.user.uid : 'teacher_test',
        title: uniqueTitle,
        subject: subject || 'General',
        time_limit: parseInt(time_limit) || 20,
        quiz_mode: quiz_mode || 'back_and_forth',
        require_solution: require_solution === true || require_solution === 'true',
        questions: finalQuestions,
        created_at: new Date().toISOString()
      };

      quizzes.set(newQuizId, newQuiz);
      savePersistentData();
      await syncDocToFirestore('quizzes', newQuizId, newQuiz);

      setWorksheetProgress(session_id, {
        message: '🚀 Quiz created! Redirecting...',
        percentage: 100,
        status: 'completed',
        quiz_id: newQuizId
      });
    } catch (err: any) {
      setWorksheetProgress(session_id, {
        message: `❌ Error: ${err.message}`,
        percentage: 100,
        status: 'error',
        error: err.message
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
          const response = await ai.models.generateContent({
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
            config: {
              responseMimeType: 'application/json',
              responseSchema: RMX_EXTRACTION_SCHEMA,
              maxOutputTokens: 8192
            }
          });

          const parsed = validateRmxQuestions(safeParseJSON(response.text || ''));
          for (const q of parsed) {
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

        const keyResp = await ai.models.generateContent({
          model: selectedModel,
          contents: keyContents,
          config: {
            responseMimeType: 'application/json',
            responseSchema: ANSWER_KEY_PAIR_SCHEMA,
            maxOutputTokens: 4096
          }
        });

        goldenKey = answerPairsToRecord(safeParseJSON(keyResp.text || ''), 'RMX answer key extraction');

        if (Object.keys(goldenKey).length > 0) {
          const matchPrompt = RMX_FLASH_MATCH_PROMPT
            .replace('{questions_json}', JSON.stringify(rmxQuestions))
            .replace('{golden_key}', JSON.stringify(goldenKey));

          const matchResp = await ai.models.generateContent({
            model: selectedModel,
            contents: [matchPrompt],
            config: {
              responseMimeType: 'application/json',
              responseSchema: RMX_MATCH_SCHEMA,
              maxOutputTokens: 8192
            }
          });

          const matched = validateRmxQuestions(safeParseJSON(matchResp.text || ''), true);
          if (matched.length !== rmxQuestions.length) {
            throw new Error(`RMX answer matching returned ${matched.length} of ${rmxQuestions.length} questions`);
          }
          rmxQuestions = matched;
        }
      }
    }

    if (rmxQuestions.length === 0) {
      const message = 'Gemini did not find any RMX questions. Check that the upload is readable and contains complete question statements.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({ success: false, error: message });
    }

    sortQuestionsByIndex(rmxQuestions);

    setWorksheetProgress(session_id, { message: '✅ RMXFlash extraction complete!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions: rmxQuestions });
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
    const ai = getGeminiClient(api_key);
    if (!ai) {
      return res.status(400).json({
        success: false,
        error: 'No Gemini API key is configured. Provide an AI Studio browser key or configure GEMINI_API_KEY/API_KEY on the server.'
      });
    }
    setWorksheetProgress(session_id, { message: '📄 Processing worksheet & answer key files...', percentage: 15, status: 'processing' });
    let questions: any[] = [];
    let goldenReference: Record<string, string> = {};

    {
      const selectedModel = getRealModelName(model_name);
      const extractionSchema = WORKSHEET_EXTRACTION_SCHEMA;
      const isNonMath = ['english', 'history', 'biology', 'social studies'].includes(String(subject).toLowerCase());
      const extractionPromptTemplate = isNonMath ? WORKSHEET_EXTRACTION_PROMPT_NON_MATH : WORKSHEET_EXTRACTION_PROMPT;
      const extractionPrompt = extractionPromptTemplate
        .replace('{latex_rules}', SHARED_LATEX_RULES)
        .replace('{subject_rules}', isNonMath ? NON_MATH_RULES : '')
        .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

      const totalFiles = wsFiles.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        await forEachUploadedFilePage(wsFiles[fileIdx], async page => {
            setWorksheetProgress(session_id, {
              message: `🤖 Extracting worksheet file ${fileIdx + 1} of ${totalFiles}, page ${page.pageNumber} of ${page.pageCount}...`,
              percentage: Math.round(30 + ((fileIdx + page.pageIndex / page.pageCount) / totalFiles) * 40),
              status: 'processing'
            });
            const wsResponse = await ai.models.generateContent({
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
              config: {
                responseMimeType: 'application/json',
                responseSchema: extractionSchema,
                maxOutputTokens: 8192
              }
            });

            const parsed = validateExtractedQuestions(
              safeParseJSON(wsResponse.text || ''),
              `Worksheet file ${fileIdx + 1}, page ${page.pageNumber}`
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
            questions.push(...parsed);
        });
      }

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

        const ansResponse = await ai.models.generateContent({
          model: selectedModel,
          contents: ansContents,
          config: {
            responseMimeType: 'application/json',
            responseSchema: ANSWER_KEY_PAIR_SCHEMA,
            maxOutputTokens: 4096
          }
        });

        goldenReference = answerPairsToRecord(
          safeParseJSON(ansResponse.text || ''),
          'Worksheet answer key extraction'
        );
      }
    }

    if (questions.length === 0) {
      const message = 'Gemini did not find any worksheet questions. Check that the worksheet upload is readable, then try again.';
      setWorksheetProgress(session_id, { message: `Error: ${message}`, percentage: 100, status: 'error' });
      return res.status(422).json({ success: false, error: message });
    }

    if (Object.keys(goldenReference).length > 0) {
      questions.forEach((q: any) => {
        const idxKey = String(q.original_index);
        if (goldenReference[idxKey]) {
          q.answer = goldenReference[idxKey];
        }
      });
    }

    sortQuestionsByIndex(questions);

    const extractedIndices = questions.map((q: any) => parseInt(q.original_index)).filter((n: number) => !isNaN(n)).sort((a: number, b: number) => a - b);
    const missingIndices: number[] = [];
    if (extractedIndices.length > 0) {
      const maxIdx = Math.max(...extractedIndices);
      let minIdx = Math.min(...extractedIndices);
      if (minIdx <= 3) minIdx = 1;
      
      for (let i = minIdx; i <= maxIdx; i++) {
        if (!extractedIndices.includes(i)) {
          missingIndices.push(i);
        }
      }
    }

    setWorksheetProgress(session_id, { message: '✅ Questions and answers extracted successfully!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions, golden_reference: goldenReference, missing_indices: missingIndices });
  } catch (err: any) {
    setWorksheetProgress(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(502).json({ success: false, error: `Worksheet and answer-key extraction failed: ${err.message}` });
  }
});

router.post('/api/recover_questions', tokenRequired, worksheetUploadAny, async (req: AuthRequest, res) => {
  const { missing_numbers, topic_hint = 'General', api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  const files = (req.files as Express.Multer.File[]) || [];

  let missingNums: number[] = [];
  try {
    missingNums = typeof missing_numbers === 'string' ? JSON.parse(missing_numbers) : missing_numbers;
  } catch (e) {
    missingNums = [];
  }

  try {
    if (!Array.isArray(missingNums)) missingNums = [];
    missingNums = [...new Set(missingNums.map(Number).filter(Number.isInteger))];
    if (missingNums.length === 0) {
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
      const prompt = RECOVERY_PROMPT
        .replace('{topic_hint}', topic_hint)
        .replace('{missing_numbers}', JSON.stringify(missingNums));

      const totalFiles = files.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        await forEachUploadedFilePage(files[fileIdx], async page => {
          const response = await ai.models.generateContent({
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
            config: {
              responseMimeType: 'application/json',
              responseSchema: WORKSHEET_EXTRACTION_SCHEMA,
              maxOutputTokens: 8192
            }
          });

          const parsedRec = validateExtractedQuestions(
            safeParseJSON(response.text || ''),
            `Recovery file ${fileIdx + 1}, page ${page.pageNumber}`
          ).filter(question => missingNums.includes(parseInt(question.original_index, 10)));
          for (const q of parsedRec) {
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

    const recoveredByNumber = new Map<string, any>();
    recovered.forEach(question => recoveredByNumber.set(String(parseInt(question.original_index, 10)), question));
    recovered = [...recoveredByNumber.values()];
    if (recovered.length === 0) {
      return res.status(422).json({
        success: false,
        error: `Gemini could not locate requested question numbers ${missingNums.join(', ')} in the uploaded files. Verify the pages and numbering, then try again.`
      });
    }

    sortQuestionsByIndex(recovered);
    const recoveredNumbers = new Set(recovered.map(question => parseInt(question.original_index, 10)));
    const stillMissing = missingNums.filter(number => !recoveredNumbers.has(number));
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
    model_name = 'gemini-3.5-flash-lite',
    api_key,
    session_id = 'gen_1'
  } = req.body;

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
    let finalQuestions = questions.map((question: any) => ({ ...question }));

    if (ai) {
        aiLease = acquireAiWork({
          userId: req.user?.uid || '',
          cost: questions.length * 2,
          byok: typeof api_key === 'string' && api_key.trim().length > 0
        });

        setWorksheetProgress(session_id, {
          message: '🤖 Initializing Solve and Check Engine...',
          percentage: 20,
          status: 'processing'
        });

        const totalQs = questions.length;
        finalQuestions = [];

        const batchSize = Math.min(10, Math.max(1, parseInt(batch_size) || 3));
        for (let i = 0; i < totalQs; i += batchSize) {
          const batchEnd = Math.min(totalQs, i + batchSize);
          const batchQuestions = questions.slice(i, batchEnd);

          setWorksheetProgress(session_id, {
            message: `🤖 Solving Batch Q${i + 1}-${batchEnd}/${totalQs} with Peer Verification...`,
            percentage: Math.round(20 + (i / totalQs) * 75),
            status: 'processing'
          });

          const batchPromises = batchQuestions.map(async (rawQ: any, index: number) => {
            const qIdx = i + index;
            const pctStart = Math.round(20 + (qIdx / totalQs) * 75);
            const pctEnd = Math.round(20 + ((qIdx + 1) / totalQs) * 75);

            // Prepare vision image assets for this individual question
            const qContents: any[] = [];
            const prepared = prepareVisionText(rawQ.raw_text || rawQ.question || rawQ.statement || '', qContents);

            const existingOptions = Array.isArray(rawQ.options) ? rawQ.options : (Array.isArray(rawQ.choices) ? rawQ.choices : []);

            const solverPromptText = `You are a master educator and subject matter expert test solver.
Solve the following question accurately and generate a complete step-by-step worked solution.

SUBJECT: ${subject || 'General'}
TOPIC: ${topic || 'General'}
GOLDEN ANSWER KEY REFERENCE (if provided): ${JSON.stringify(golden_reference || '')}

QUESTION TO SOLVE:
${prepared.text}

EXISTING CHOICES/OPTIONS (if multiple choice):
${JSON.stringify(existingOptions)}

CRITICAL INSTRUCTIONS:
1. Provide the exact correct answer in the 'answer' field.
   - For Multiple Choice: Output the correct choice letter (e.g. "A", "B", "C", "D") or choice string matching the option.
   - For Multiple Select: Output comma-separated options/letters (e.g. "A, C").
   - For True/False: Output "A" or "B" (or "True" / "False").
   - For Identification: Output ONLY the concise final answer value (no sentence wrappers).
   - For Open Ended / Math / Science: Output the complete, accurate answer value or key rubric grading points.
2. In the 'solution' field, write a clear, thorough step-by-step worked explanation showing how to arrive at the answer.
3. ${MANDATORY_MATH_FEEDBACK_RULE}

Return STRICTLY a JSON object with keys:
- "options": array of strings (choices if multiple choice, else [])
- "answer": string (the exact correct answer)
- "type": string (one of "multiple_choice", "multiple_choice_multi", "identification", "open_ended", "graphing", "true_false")
- "solution": string (detailed step-by-step worked solution)
`;

            qContents.unshift(solverPromptText);

            // 1. Solve Step
            let resSolve;
            try {
              resSolve = await ai.models.generateContent({
                model: model_name || 'gemini-3.5-flash-lite',
                contents: qContents,
                config: {
                  responseMimeType: 'application/json',
                  responseSchema: SINGLE_SOLVED_QUESTION_SCHEMA,
                  maxOutputTokens: 4096
                }
              });
            } catch (err: any) {
              console.error(`[Worksheet Solver] Solver model failed for Q${qIdx + 1}:`, err);
              throw new Error(`Solver model failed: ${err.message}`);
            }

            const parsed = safeParseJSON(resSolve?.text || '{}') || {};
            const solvedAnswer = String(parsed.answer || '').trim();
            const solvedSolution = String(parsed.solution || '').trim();
            const solvedType = String(parsed.type || rawQ.type || 'identification').trim();

            // 2. Check Step (Peer Checker)
            const checkerModel = model_name === 'gemini-3.1-flash-lite' ? 'gemini-3.5-flash-lite' : 'gemini-3.1-flash-lite';
            
            setWorksheetProgress(session_id, {
              message: `🔍 Q${qIdx + 1}/${totalQs}: Peer checker (${checkerModel}) verifying answer...`,
              percentage: Math.round(pctStart + (pctEnd - pctStart) * 0.5),
              status: 'processing'
            });

            const checkContents: any[] = [];
            const checkerPrepared = prepareVisionText(rawQ.raw_text || rawQ.question || rawQ.statement || '', checkContents);

            const checkerPrompt = `You are a senior educator and peer reviewer. Your job is to verify the correctness of an AI-generated answer and step-by-step solution for the given question.

SUBJECT: ${subject || 'General'}
TOPIC: ${topic || 'General'}

QUESTION TO VERIFY:
${checkerPrepared.text}

EXISTING CHOICES/OPTIONS (if multiple choice):
${JSON.stringify(existingOptions)}

PROPOSED ANSWER TO VERIFY:
"${solvedAnswer}"

PROPOSED WORKED SOLUTION TO VERIFY:
"${solvedSolution}"

PROPOSED QUESTION TYPE:
"${solvedType}"

CRITICAL INSTRUCTIONS:
1. Analyze the question carefully. Determine if the proposed answer is correct and mathematically accurate.
2. If the proposed answer, solution, and type are correct/accurate, set 'verified' to true.
3. If there is any mistake in calculations, logic, fact, or option choice, set 'verified' to false.
4. If 'verified' is false, you MUST provide the correct 'corrected_answer', 'corrected_solution', and 'corrected_type'.
5. ${MANDATORY_MATH_FEEDBACK_RULE}

Return STRICTLY a JSON object with keys:
- "verified": boolean (true if correct, false if incorrect or needs correction)
- "corrected_answer": string (the corrected exact answer, only if verified is false)
- "corrected_solution": string (the corrected step-by-step solution, only if verified is false)
- "corrected_type": string (one of "multiple_choice", "multiple_choice_multi", "identification", "open_ended", "graphing", "true_false", only if verified is false)
- "reason": string (concise explanation of why the proposed solution is correct or why/how it was corrected)
`;
            checkContents.unshift(checkerPrompt);

            let finalAnswer = solvedAnswer;
            let finalSolution = solvedSolution;
            let finalType = solvedType;
            let finalOptions = (Array.isArray(parsed.options) && parsed.options.length > 0) ? parsed.options : existingOptions;

            try {
              const resCheck = await ai.models.generateContent({
                model: checkerModel,
                contents: checkContents,
                config: {
                  responseMimeType: 'application/json',
                  responseSchema: SINGLE_CHECKER_SCHEMA,
                  maxOutputTokens: 4096
                }
              });
              const checkParsed = safeParseJSON(resCheck?.text || '{}') || {};

              if (checkParsed.verified === true) {
                setWorksheetProgress(session_id, {
                  message: `✅ Q${qIdx + 1}/${totalQs}: Solver answer verified! Answer: "${finalAnswer.substring(0, 25)}"`,
                  percentage: pctEnd,
                  status: 'processing'
                });
              } else if (checkParsed.verified === false) {
                finalAnswer = String(checkParsed.corrected_answer || solvedAnswer).trim();
                finalSolution = String(checkParsed.corrected_solution || solvedSolution).trim();
                finalType = String(checkParsed.corrected_type || solvedType).trim();
                setWorksheetProgress(session_id, {
                  message: `✍️ Q${qIdx + 1}/${totalQs}: Peer corrected answer to: "${finalAnswer.substring(0, 25)}"`,
                  percentage: pctEnd,
                  status: 'processing'
                });
              } else {
                setWorksheetProgress(session_id, {
                  message: `🔍 Q${qIdx + 1}/${totalQs}: Solver answer bypassed checker: "${finalAnswer.substring(0, 25)}"`,
                  percentage: pctEnd,
                  status: 'processing'
                });
              }
            } catch (checkErr: any) {
              console.warn(`[RMX Solver] Peer checker failed for Q${qIdx + 1} (falling back to Solver answer):`, checkErr);
              setWorksheetProgress(session_id, {
                message: `🔍 Q${qIdx + 1}/${totalQs}: Solver answer: "${finalAnswer.substring(0, 25)}"`,
                percentage: pctEnd,
                status: 'processing'
              });
            }

            return {
              ...rawQ,
              options: finalOptions,
              answer: finalAnswer,
              type: finalType || rawQ.type || (finalOptions.length > 0 ? 'multiple_choice' : 'identification'),
              solution: finalSolution,
              question: restoreVisionText(rawQ.question || rawQ.statement || rawQ.raw_text, prepared),
              raw_text: rawQ.raw_text || restoreVisionText(rawQ.question || rawQ.statement, prepared)
            };
          });

          const batchResults = await Promise.all(batchPromises);
          finalQuestions.push(...batchResults);

          // Dynamic rate limit control: Add cooldown between batches to fit 15 RPM
          if (i + batchSize < totalQs) {
            const progressPercentage = Math.round(20 + (batchEnd / totalQs) * 75);
            setWorksheetProgress(session_id, {
              message: `⏳ Cool-down phase (3s) to prevent API rate limits...`,
              percentage: progressPercentage,
              status: 'processing'
            });
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
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

    sortQuestionsByIndex(finalQuestions);

    const formattedQuestions = finalQuestions.map((q: any, i: number) => {
      const question = String(q.question || q.raw_text || q.statement || '').trim();
      const options = (Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : []))
        .map((option: unknown) => String(option));
      const answer = String(q.answer ?? '').trim();
      const type = String(q.type || (options.length > 0 ? 'multiple_choice' : 'identification'));
      if (!question || !answer || !ALLOWED_QUESTION_TYPES.has(type)) {
        throw new Error(`Finalized question ${i + 1} is missing valid text, answer, or type`);
      }
      return {
        ...q,
        question,
        options,
        answer,
        type
      };
    });

    const uniqueTitle = getUniqueQuizTitle(topic || 'Extracted Worksheet Quiz');
    const newQuizId = `quiz_${Date.now()}`;
    const newQuiz = {
      id: newQuizId,
      user_id: req.user ? req.user.uid : 'teacher_test',
      title: uniqueTitle,
      subject: subject || 'General',
      time_limit: parseInt(time_limit) || 30,
      quiz_mode: quiz_mode || 'back_and_forth',
      require_solution: false,
      questions: formattedQuestions,
      created_at: new Date().toISOString()
    };

    quizzes.set(newQuizId, newQuiz);
    savePersistentData();
    await syncDocToFirestore('quizzes', newQuizId, newQuiz);

    setWorksheetProgress(session_id, { message: '🚀 Quiz created! Redirecting...', percentage: 100, status: 'completed', quiz_id: newQuizId });
    res.json({ success: true, quiz_id: newQuizId });
  } catch (err: any) {
    setWorksheetProgress(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    if (respondWorksheetAiLimit(res, err)) return;
    res.status(502).json({ success: false, error: `Quiz finalization failed: ${err.message}` });
  } finally {
    aiLease?.release();
  }
});

router.get('/worksheet_answers', tokenRequired, (req, res) => {
  res.render('worksheet_answers_upload');
});

router.get(['/worksheet', '/worksheet_upload'], tokenRequired, (req, res) => {
  res.render('worksheet_upload');
});

router.get('/rmxflash', tokenRequired, (req, res) => {
  res.render('rmxflash_upload');
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
