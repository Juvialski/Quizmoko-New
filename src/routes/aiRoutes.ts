import { Router } from 'express';
import { Type } from '@google/genai';
import { tokenRequired } from '../middleware/auth.ts';
import { generateAiLimiter } from '../middleware/rateLimit.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import {
  quizzes,
  users,
  savePersistentData,
  syncDocToFirestore,
  getUniqueQuizTitle
} from '../store/db.ts';
import { getGeminiClient, getRealModelName, safeParseJSON } from '../services/gemini.ts';
import {
  generateGeminiContent,
  GeminiRateLimitError
} from '../services/geminiRateLimiter.ts';
import { buildAiTaskConfig } from '../services/aiTaskProfiles.ts';
import { duplicateQuestionIds, verifyQuestionBatch } from '../services/aiQuestionVerifier.ts';
import { applyLatexPatches, createLatexPatchRequests } from '../services/latexPatches.ts';
import { normalizeAiLatexText, normalizeMathQuestionText, normalizeQuestionLayoutText, stripDuplicatedChoiceBlock, stripRedundantOptionPrefix, validateQuestionLatex } from '../services/latex.ts';
import { buildTikzRequirementPlan, hasTikzDiagram, validateTikzRequirement } from '../services/tikzGeneration.ts';
import {
  getCorrectAnswer,
  normalizeQuestion,
  normalizeQuestionForStorage
} from '../services/grading.ts';
import {
  acquireAiWork,
  AiWorkLimitError,
  type AiWorkLease
} from '../services/aiWorkGuard.ts';
import {
  getSubjectPromptRules,
  shouldUseStrictMathFormatting,
  LATEX_POLISH_PROMPT,
  STRUCTURED_QUIZ_GENERATOR_PROMPT
} from '../../prompts.ts';

const router = Router();
const MAX_GENERATED_QUESTIONS = 50;

function hasBrowserApiKey(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function acquireRequestAiWork(
  req: AuthRequest,
  cost: number,
  apiKey: unknown,
  concurrency?: { perUser?: number; global?: number }
): AiWorkLease {
  return acquireAiWork({
    userId: req.user?.uid || '',
    cost,
    byok: hasBrowserApiKey(apiKey),
    perUserConcurrency: concurrency?.perUser,
    globalConcurrency: concurrency?.global
  });
}

function respondAiWorkLimit(res: any, error: unknown): boolean {
  if (!(error instanceof AiWorkLimitError) && !(error instanceof GeminiRateLimitError)) return false;
  res.setHeader('Retry-After', String(error.retryAfterSeconds));
  res.status(error.status).json({
    success: false,
    error: error.message,
    code: error.code
  });
  return true;
}

function canManageQuiz(user: any, quiz: any): boolean {
  if (!user || !quiz) return false;
  if (user.role === 'admin') return true;
  if (quiz.user_id && quiz.user_id === user.uid) return true;
  return !quiz.user_id && user.uid === 'teacher_test';
}

const questionProperties = {
  id: { type: Type.STRING },
  question: { type: Type.STRING, description: 'The complete question text.' },
  raw_text: { type: Type.STRING, description: 'Legacy alias for question text.' },
  options: { type: Type.ARRAY, items: { type: Type.STRING } },
  answer: { type: Type.STRING },
  type: {
    type: Type.STRING,
    enum: [
      'multiple_choice',
      'multiple_choice_multi',
      'true_false',
      'identification',
      'open_ended',
      'graphing'
    ]
  },
  source_index: { type: Type.INTEGER },
  original_index: { type: Type.STRING },
  solution: { type: Type.STRING },
  difficulty: { type: Type.STRING },
  correct_answer_letter: { type: Type.STRING }
};

const questionArraySchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: questionProperties,
    required: ['question', 'options', 'answer', 'type', 'solution']
  }
};

const solvedQuestionArraySchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: questionProperties,
    required: ['options', 'answer', 'type']
  }
};

const reprocessedQuestionSchema = {
  type: Type.OBJECT,
  properties: questionProperties,
  required: ['question', 'options', 'answer', 'type']
};

const resolvedQuestionSchema = {
  type: Type.OBJECT,
  properties: questionProperties,
  required: ['options', 'answer', 'type', 'solution']
};

const latexPatchSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING },
      field: { type: Type.STRING },
      original_hash: { type: Type.STRING },
      replacement: { type: Type.STRING }
    },
    required: ['id', 'field', 'original_hash', 'replacement']
  }
};

interface VisionAsset {
  token: string;
  html: string;
  data: string;
}

function addVisionAsset(html: string, contents: any[], assets: VisionAsset[]): string {
  const srcMatch = html.match(/\bsrc\s*=\s*["']data:([^;,"']+);base64,([^"']+)["']/i);
  if (!srcMatch) return html;

  const visionNumber = contents.reduce(
    (count, item) => count + (item && item.inlineData ? 1 : 0),
    0
  ) + 1;
  const token = `[IMAGE_PROVIDED_IN_VISION_CONTEXT_${visionNumber}]`;
  assets.push({ token, html, data: srcMatch[2] });
  contents.push({
    inlineData: {
      mimeType: srcMatch[1] || 'image/png',
      data: srcMatch[2]
    }
  });
  return token;
}

function prepareVisionText(rawValue: unknown, contents: any[]) {
  const original = typeof rawValue === 'string' ? rawValue : '';
  const assets: VisionAsset[] = [];

  const wrappedImagePattern = /<div\s+class=["']resizable-image-wrapper["'][^>]*>\s*<div\s+class=["']image-content-box["'][^>]*>\s*<img\b[^>]*\bsrc\s*=\s*["']data:[^"']+["'][^>]*>\s*<\/div>\s*<\/div>/gi;
  let text = original.replace(wrappedImagePattern, match => addVisionAsset(match, contents, assets));

  const standaloneImagePattern = /<img\b[^>]*\bsrc\s*=\s*["']data:[^"']+["'][^>]*>/gi;
  text = text.replace(standaloneImagePattern, match => addVisionAsset(match, contents, assets));
  text = text.replace(/<br\s*\/?>/gi, '\n').trim();

  return { original, text, assets };
}

function restoreVisionText(candidate: unknown, prepared: ReturnType<typeof prepareVisionText>): string {
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
    if (!restoredAssets.has(index)) {
      restored += `${restored.trim() ? '\n' : ''}${asset.html}`;
    }
  });

  return restored
    .replace(/\[IMAGE_PROVIDED_IN_VISION_CONTEXT(?:_\d+)?\]/gi, '')
    .trim();
}

function appendDataUrlVision(contents: any[], value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match || !match[2] || match[2].length > 28_000_000) return false;
  contents.push({
    inlineData: {
      mimeType: match[1] || 'image/png',
      data: match[2]
    }
  });
  return true;
}

function getOriginalQuestionText(question: any, sourceContext?: any): string {
  return String(
    question?.question
      || question?.raw_text
      || sourceContext?.raw_text
      || sourceContext?.question
      || ''
  );
}

function clonePlainValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

const ANSWER_OUTPUT_FIELDS = [
  'answer',
  'correct_answer',
  'correctAnswer',
  'correct_answer_letter',
  'correctAnswerLetter',
  'solution',
  'worked_solution'
] as const;

function withoutPriorAnswerState(value: any): Record<string, any> {
  const clean = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
  for (const field of ANSWER_OUTPUT_FIELDS) delete clean[field];
  return clean;
}

function asBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asStrictBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function interleaveCounts(counts: Record<string, number>): string[] {
  const remaining = Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [key, Math.max(0, Math.floor(value))])
  ) as Record<string, number>;
  const result: string[] = [];

  while (Object.values(remaining).some(value => value > 0)) {
    for (const key of Object.keys(remaining)) {
      if (remaining[key] > 0) {
        result.push(key);
        remaining[key]--;
      }
    }
  }
  return result;
}

function allocateByWeight(total: number, weights: Record<string, number>): Record<string, number> {
  const positiveWeights = Object.fromEntries(
    Object.entries(weights).map(([key, value]) => [key, Math.max(0, Number(value) || 0)])
  );
  const sum = Object.values(positiveWeights).reduce((acc, value) => acc + value, 0) || 1;
  const exact = Object.entries(positiveWeights).map(([key, value]) => ({
    key,
    exact: total * value / sum
  }));
  const allocated = Object.fromEntries(exact.map(item => [item.key, Math.floor(item.exact)])) as Record<string, number>;
  let remainder = total - Object.values(allocated).reduce((acc, value) => acc + value, 0);

  exact
    .sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)))
    .forEach(item => {
      if (remainder > 0) {
        allocated[item.key]++;
        remainder--;
      }
    });
  return allocated;
}

function normalizeQuestionTextForDisplay(value: unknown, formatMathNumbers: boolean): string {
  const displayText = formatMathNumbers ? normalizeMathQuestionText(value) : normalizeAiLatexText(value);
  return normalizeQuestionLayoutText(displayText);
}

function normalizeGeneratedQuestion(raw: any, expectedType: string, difficulty: string, formatMathNumbers = true) {
  if (!raw || typeof raw !== 'object') return null;
  const normalizeDisplayText = formatMathNumbers ? normalizeMathQuestionText : normalizeAiLatexText;
  const question = normalizeQuestionTextForDisplay(raw.question || raw.raw_text || '', formatMathNumbers).trim()
    .replace(/^(?:Question|Q)\s*\d*\s*[:.)-]\s*/i, '');
  const rawAnswer = normalizeAiLatexText(raw.answer ?? raw.correct_answer_letter ?? '').trim();
  if (!question || !rawAnswer) return null;

  const normalized: any = {
    question,
    options: [],
    answer: rawAnswer,
    type: expectedType,
    difficulty
  };
  if (typeof raw.solution === 'string' && raw.solution.trim()) {
    normalized.solution = normalizeDisplayText(raw.solution).trim();
  }

  if (expectedType === 'multiple_choice' || expectedType === 'multiple_choice_multi') {
    const sourceOptions = Array.isArray(raw.options) ? raw.options : [];
    if (sourceOptions.length !== 4) return null;
    normalized.options = sourceOptions.map((option: unknown, index: number) =>
      stripRedundantOptionPrefix(normalizeDisplayText(option ?? ''), index)
    );
    if (normalized.options.some((option: string) => !option.trim())) return null;
    normalized.question = stripDuplicatedChoiceBlock(normalized.question, normalized.options).trim();
    if (!normalized.question) return null;

    const answerLetters = Array.from(rawAnswer.toUpperCase().matchAll(/(?:^|[\s,;])([A-D])(?=$|[\s,;.)])/g))
      .map(match => match[1])
      .filter((letter, index, all) => all.indexOf(letter) === index);
    let answerLetter = answerLetters[0] || '';
    if (!answerLetter && expectedType === 'multiple_choice') {
      const answerText = rawAnswer.replace(/^[A-D][).:\-]\s*/i, '').trim().toLowerCase();
      const matchIndex = normalized.options.findIndex((option: string) =>
        option.trim().toLowerCase() === answerText
      );
      if (matchIndex >= 0) answerLetter = String.fromCharCode(65 + matchIndex);
    }
    if (!answerLetter) return null;
    if (expectedType === 'multiple_choice_multi') {
      if (answerLetters.length < 2) return null;
      normalized.answer = answerLetters.join(', ');
    } else {
      normalized.answer = answerLetter;
    }
  } else if (expectedType === 'true_false') {
    normalized.options = ['True', 'False'];
    if (/^(?:a|true)(?:\b|[).])/i.test(rawAnswer)) normalized.answer = 'A';
    else if (/^(?:b|false)(?:\b|[).])/i.test(rawAnswer)) normalized.answer = 'B';
    else return null;
  }
  const canonical = normalizeQuestionForStorage(normalized);
  if (!canonical.valid || canonical.normalized.type !== expectedType) return null;
  return { ...canonical.question, difficulty };
}

function normalizeOllamaBaseUrl(value: unknown): string {
  const parsedUrl = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Ollama URL must use http or https');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error('Ollama URL cannot contain credentials, a query, or a fragment');
  }
  const path = parsedUrl.pathname.replace(/\/+$/, '');
  return `${parsedUrl.origin}${path === '/' ? '' : path}`;
}

function isLoopbackOllamaUrl(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function resolveOllamaBaseUrl(requestedUrl: unknown): string {
  const configuredUrl = String(process.env.OLLAMA_BASE_URL || '').trim();
  const allowlistValues = String(process.env.OLLAMA_ALLOWED_BASE_URLS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (configuredUrl) allowlistValues.push(configuredUrl);

  const configuredValues = configuredUrl
    ? [configuredUrl, ...allowlistValues]
    : allowlistValues;
  const allowedUrls = new Set(configuredValues.map(value => normalizeOllamaBaseUrl(value)));
  const requestedValue = String(requestedUrl || '').trim();
  const candidate = normalizeOllamaBaseUrl(
    requestedValue || configuredUrl || 'http://127.0.0.1:11434'
  );
  if (allowedUrls.has(candidate)) return candidate;

  if (process.env.NODE_ENV !== 'production' && isLoopbackOllamaUrl(candidate)) {
    return candidate;
  }
  throw new Error(
    process.env.NODE_ENV === 'production'
      ? 'Remote Ollama is disabled. Configure OLLAMA_BASE_URL or OLLAMA_ALLOWED_BASE_URLS on the server.'
      : 'Development Ollama URLs must use localhost/loopback or be explicitly allowlisted.'
  );
}

function isOllamaConfigured(): boolean {
  return Boolean(
    String(process.env.OLLAMA_BASE_URL || '').trim()
    || String(process.env.OLLAMA_ALLOWED_BASE_URLS || '').trim()
  );
}

async function requestOllamaQuestions(ollamaUrl: unknown, model: string, prompt: string): Promise<any> {
  const baseUrl = resolveOllamaBaseUrl(ollamaUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      redirect: 'error',
      body: JSON.stringify({
        model: model.replace(/^ollama:/, ''),
        prompt,
        stream: false,
        format: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              answer: { type: 'string' },
              type: { type: 'string' },
              solution: { type: 'string' }
            },
            required: ['question', 'options', 'answer', 'type', 'solution']
          }
        }
      })
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, 'utf8') > 5 * 1024 * 1024) {
      throw new Error('Ollama response exceeded the 5 MB safety limit');
    }
    const data: any = JSON.parse(responseBody);
    return safeParseJSON(String(data.response || ''));
  } finally {
    clearTimeout(timeout);
  }
}

router.get('/api/ai/config', (_req, res) => {
  res.json({
    success: true,
    gemini_configured: Boolean(process.env.GEMINI_API_KEY || process.env.API_KEY),
    ollama_configured: isOllamaConfigured()
  });
});

router.get('/api/ollama_tags', tokenRequired, async (req: AuthRequest, res) => {
  try {
    const baseUrl = resolveOllamaBaseUrl(req.query?.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
      const responseText = await response.text();
      if (Buffer.byteLength(responseText, 'utf8') > 1024 * 1024) {
        throw new Error('Ollama model list exceeded the 1 MB safety limit');
      }
      const data = JSON.parse(responseText);
      const models = Array.isArray(data?.models)
        ? data.models
            .map((item: any) => String(item?.name || item?.model || '').trim())
            .filter((name: string) => name && name.length <= 200)
            .slice(0, 100)
        : [];
      return res.json({ success: true, installed: true, models });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    const message = error?.name === 'AbortError'
      ? 'Ollama did not respond before the timeout.'
      : (error?.message || 'Ollama is unavailable.');
    return res.status(503).json({
      success: false,
      installed: false,
      models: [],
      error: message
    });
  }
});

router.post(['/generate_ai', '/api/generate_ai'], tokenRequired, generateAiLimiter, async (req: AuthRequest, res) => {
  const wantsJson = req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');
  const fail = (status: number, message: string) => {
    if (wantsJson) return res.status(status).json({ success: false, error: message });
    return res.status(status).type('text/plain').send(`Quiz generation failed: ${message}`);
  };

  const {
    api_key: submittedApiKey,
    ollama_url,
    model_name = 'gemini-3.5-flash-lite',
    topic,
    subject: requestedSubject = 'General',
    custom_subject,
    question_style = 'Mixed',
    test_type = 'Mixed',
    quiz_mode = 'back_and_forth'
  } = req.body || {};

  let resolvedApiKey = typeof submittedApiKey === 'string' ? submittedApiKey.trim() : '';
  if (!resolvedApiKey && req.user?.uid) {
    const user = users.get(req.user.uid);
    if (user && typeof user.stored_custom_key === 'string') {
      resolvedApiKey = user.stored_custom_key;
    }
  }
  const api_key = resolvedApiKey || '';

  const cleanTopic = String(topic || '').trim();
  if (!cleanTopic) return fail(400, 'A quiz topic is required.');

  const subject = requestedSubject === '__custom__'
    ? String(custom_subject || '').trim() || 'General'
    : String(requestedSubject || 'General').trim() || 'General';
  const requestedNumItems = asStrictBoundedInt(
    req.body?.num_items,
    10,
    1,
    MAX_GENERATED_QUESTIONS
  );
  if (requestedNumItems === null) {
    return fail(
      400,
      `Total questions must be a whole number between 1 and ${MAX_GENERATED_QUESTIONS}.`
    );
  }
  const batchSize = asBoundedInt(req.body?.batch_size, 3, 1, 10);
  const timeLimit = asBoundedInt(req.body?.time_limit, 200, 1, 86_400);
  const imagesCount = asBoundedInt(req.body?.images_count, 0, 0, requestedNumItems);

  const typeName = String(test_type || 'Mixed').trim().toLowerCase();
  const singleTypeMap: Record<string, string> = {
    'multiple choice': 'multiple_choice',
    'true/false': 'true_false',
    'true false': 'true_false',
    identification: 'identification',
    'open ended': 'open_ended',
    'open-ended': 'open_ended',
    graphing: 'graphing',
    'graphing / drawing': 'graphing'
  };

  let typeCounts: Record<string, number>;
  let totalQuestions = requestedNumItems;
  if (typeName === 'mixed') {
    const requestedTypeCounts = {
      multiple_choice: asStrictBoundedInt(req.body?.mc_count, 0, 0, MAX_GENERATED_QUESTIONS),
      true_false: asStrictBoundedInt(req.body?.tf_count, 0, 0, MAX_GENERATED_QUESTIONS),
      identification: asStrictBoundedInt(req.body?.id_count, 0, 0, MAX_GENERATED_QUESTIONS),
      open_ended: asStrictBoundedInt(req.body?.oe_count, 0, 0, MAX_GENERATED_QUESTIONS),
      graphing: asStrictBoundedInt(req.body?.gr_count, 0, 0, MAX_GENERATED_QUESTIONS)
    };
    if (Object.values(requestedTypeCounts).some(count => count === null)) {
      return fail(
        400,
        `Each mixed question count must be a whole number between 0 and ${MAX_GENERATED_QUESTIONS}.`
      );
    }
    typeCounts = requestedTypeCounts as Record<string, number>;
    totalQuestions = Object.values(typeCounts).reduce((sum, count) => sum + count, 0);
    if (totalQuestions < 1) return fail(400, 'Mixed quizzes must include at least one question.');
    if (totalQuestions > MAX_GENERATED_QUESTIONS) {
      return fail(400, `A quiz cannot contain more than ${MAX_GENERATED_QUESTIONS} generated questions.`);
    }
  } else {
    const selectedType = singleTypeMap[typeName];
    if (!selectedType) return fail(400, `Unsupported test type: ${test_type}`);
    typeCounts = { [selectedType]: totalQuestions };
  }

  const typePlan = interleaveCounts(typeCounts);
  const difficultyCounts = allocateByWeight(totalQuestions, {
    easy: Number(req.body?.easy_pct) || 0,
    average: Number(req.body?.avg_pct) || 0,
    difficult: Number(req.body?.hard_pct) || 0
  });
  const difficultyPlan = interleaveCounts(difficultyCounts);
  const strictMathFormatting = shouldUseStrictMathFormatting(subject, cleanTopic);
  const subjectRules = getSubjectPromptRules(subject, cleanTopic);
  const model = String(model_name || 'gemini-3.5-flash-lite').trim();
  const isOllama = model.toLowerCase().startsWith('ollama:');
  const ai = isOllama ? null : getGeminiClient(api_key);
  if (!isOllama && !ai) {
    return fail(400, 'No Gemini API key is configured. Add a browser key or set GEMINI_API_KEY/API_KEY on the server.');
  }

  let aiLease: AiWorkLease;
  try {
    const plannedBatches = Math.ceil(totalQuestions / batchSize);
    const plannedCost = isOllama
      ? Math.max(totalQuestions, plannedBatches * 3)
      : Math.max(totalQuestions * 3, plannedBatches * 4);
    aiLease = acquireRequestAiWork(req, plannedCost, api_key);
  } catch (error) {
    if (error instanceof AiWorkLimitError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return fail(error.status, error.message);
    }
    console.error('AI work guard error:', error);
    return fail(500, 'AI generation could not be scheduled.');
  }

  try {
    const generatedQuestions: any[] = [];
    const tikzRequirementPlan = buildTikzRequirementPlan(totalQuestions, imagesCount);

    for (let offset = 0; offset < totalQuestions; offset += batchSize) {
      const batchTypes = typePlan.slice(offset, offset + batchSize);
      const batchDifficulties = difficultyPlan.slice(offset, offset + batchTypes.length);
      const batchDiagramRequirements = tikzRequirementPlan.slice(offset, offset + batchTypes.length);
      const batchImages = batchDiagramRequirements.filter(Boolean).length;
      const questionPlan = batchTypes
        .map((type, index) => `${index + 1}. type="${type}", difficulty="${batchDifficulties[index] || 'average'}", diagram_required="${batchDiagramRequirements[index] ? 'yes' : 'no'}"`)
        .join('\n');

      let prompt = STRUCTURED_QUIZ_GENERATOR_PROMPT
        .replace('{topic}', cleanTopic)
        .replace('{subject}', subject)
        .replace('{question_style}', String(question_style || 'Mixed'))
        .replace('{teacher_instructions}', 'None')
        .replace('{batch_size}', String(batchTypes.length))
        .replace('{question_plan}', questionPlan)
        .replace('{images_count}', String(batchImages))
        .replace('{subject_rules}', subjectRules);

      if (generatedQuestions.length > 0) {
        const previousQuestions = generatedQuestions
          .slice(-12)
          .map((question, index) => `${index + 1}. ${question.question}`)
          .join('\n');
        prompt += `\n\nQUESTIONS ALREADY GENERATED (do not repeat these scenarios):\n${previousQuestions}`;
      }

      let normalizedBatch: any[] | null = null;
      for (let attempt = 0; attempt < 2 && !normalizedBatch; attempt++) {
        let parsed: any;
        if (isOllama) {
          parsed = await requestOllamaQuestions(ollama_url, model, prompt);
        } else {
          const response = await generateGeminiContent(ai!, {
            model: getRealModelName(model),
            contents: prompt,
            config: buildAiTaskConfig('question_drafting', {
              responseMimeType: 'application/json',
              responseSchema: questionArraySchema,
              maxOutputTokens: 8192
            }) as any
          });
          parsed = safeParseJSON(response.text || '');
        }

        const rawQuestions = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.questions) ? parsed.questions : []);
        if (rawQuestions.length >= batchTypes.length) {
          const candidates = batchTypes.map((type, index) =>
            normalizeGeneratedQuestion(rawQuestions[index], type, batchDifficulties[index] || 'average', strictMathFormatting)
          );
          if (candidates.every(Boolean)) {
            const diagramErrors = (candidates as any[])
              .map((candidate, index) => {
                const check = validateTikzRequirement(candidate.question, Boolean(batchDiagramRequirements[index]));
                return check.valid ? '' : `Question ${index + 1}: ${check.reason || 'TikZ requirement was not met.'}`;
              })
              .filter(Boolean);
            if (diagramErrors.length === 0) {
              normalizedBatch = candidates as any[];
            } else {
              prompt += `\n\nDIAGRAM VALIDATION FAILED. Regenerate the entire batch and follow each diagram_required flag exactly. ${diagramErrors.join(' ')}`;
            }
          }
        }

        if (!normalizedBatch) {
          prompt += '\n\nYour previous response was incomplete or did not match the required types. Return every planned question with a non-empty answer and all required options. If diagram_required="yes", include exactly one non-empty [TIKZ]...[/TIKZ] block using base TikZ only; if diagram_required="no", include none.';
        }
      }

      if (!normalizedBatch) {
        throw new Error(`The model could not produce a valid batch beginning at question ${offset + 1}.`);
      }

      const identifiedBatch = normalizedBatch.map((question, index) => ({
        ...question,
        id: String(question.id || `generated_${offset + index + 1}`)
      }));
      if (isOllama || !ai) {
        generatedQuestions.push(...identifiedBatch.map(question => ({
          ...question,
          verification: {
            answer_source: 'manual',
            verification_status: 'review_required',
            reason: 'This Ollama draft was not independently verified by both Gemini Flash-Lite solvers.',
            solver_models: []
          }
        })));
      } else {
        const verified = await verifyQuestionBatch({
          ai,
          questions: identifiedBatch,
          subject,
          topic: cleanTopic,
          preferredModel: model,
          contextLabel: 'new quiz generation'
        });
        generatedQuestions.push(...verified.questions);
      }
    }

    const actualTikzCount = generatedQuestions.filter(question => hasTikzDiagram(question?.question)).length;
    if (actualTikzCount !== imagesCount) {
      throw new Error(`TikZ generation count mismatch: requested ${imagesCount} diagram question${imagesCount === 1 ? '' : 's'}, but generated ${actualTikzCount}. Please retry the quiz generation.`);
    }

    const duplicateIds = new Set(duplicateQuestionIds(generatedQuestions));
    if (duplicateIds.size > 0) {
      for (const question of generatedQuestions) {
        if (!duplicateIds.has(String(question.id || ''))) continue;
        question.verification = {
          ...(question.verification || {}),
          answer_source: 'manual',
          verification_status: 'review_required',
          reason: 'This question is a near-duplicate of another generated question and requires teacher review.'
        };
      }
    }
    const reviewRequiredIds = generatedQuestions
      .filter(question => question?.verification?.verification_status !== 'verified')
      .map(question => String(question.id || ''))
      .filter(Boolean);

    const quizId = `quiz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const quiz = {
      id: quizId,
      user_id: req.user?.uid || 'teacher_test',
      title: getUniqueQuizTitle(cleanTopic),
      subject,
      time_limit: timeLimit,
      quiz_mode: ['sequential', 'back_and_forth'].includes(String(quiz_mode))
        ? String(quiz_mode)
        : 'back_and_forth',
      require_solution: false,
      created_at: new Date().toISOString(),
      model_name: model,
      question_style: String(question_style || 'Mixed'),
      is_draft: reviewRequiredIds.length > 0,
      review_required_ids: reviewRequiredIds,
      verification_summary: {
        verified: generatedQuestions.length - reviewRequiredIds.length,
        review_required: reviewRequiredIds.length
      },
      questions: generatedQuestions
    };

    quizzes.set(quizId, quiz);
    savePersistentData();
    await syncDocToFirestore('quizzes', quizId, quiz);

    if (wantsJson) {
      return res.status(201).json({
        success: true,
        quiz_id: quizId,
        quiz,
        review_required: reviewRequiredIds.length > 0,
        review_required_ids: reviewRequiredIds,
        redirect: `/edit/${quizId}`
      });
    }
    return res.redirect(`/edit/${quizId}`);
  } catch (err: any) {
    console.error('Generate quiz error:', err);
    const message = err?.name === 'AbortError'
      ? 'The AI request timed out. Try a smaller batch size.'
      : (err?.message || 'Unknown AI generation error');
    return fail(502, message);
  } finally {
    aiLease.release();
  }
});

router.post('/api/generate_question', tokenRequired, async (req: AuthRequest, res) => {
  const {
    topic = 'Quiz',
    subject = 'General',
    question_style = 'Mixed',
    target_type = 'multiple_choice',
    instructions = '',
    existing_question,
    api_key: submittedApiKey,
    ollama_url,
    model_name = 'gemini-3.5-flash-lite'
  } = req.body || {};

  let resolvedApiKey = typeof submittedApiKey === 'string' ? submittedApiKey.trim() : '';
  if (!resolvedApiKey && req.user?.uid) {
    const user = users.get(req.user.uid);
    if (user && typeof user.stored_custom_key === 'string') {
      resolvedApiKey = user.stored_custom_key;
    }
  }
  const api_key = resolvedApiKey || '';
  const allowedTypes = new Set([
    'multiple_choice',
    'multiple_choice_multi',
    'true_false',
    'identification',
    'open_ended',
    'graphing'
  ]);
  if (!allowedTypes.has(target_type)) {
    return res.status(400).json({ success: false, error: 'Unsupported target type' });
  }

  let aiLease: AiWorkLease | null = null;
  try {
    const isOllama = String(model_name).toLowerCase().startsWith('ollama:');
    const ai = isOllama ? null : getGeminiClient(api_key);
    if (!isOllama && !ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });
    aiLease = acquireRequestAiWork(req, isOllama ? 1 : 4, api_key);

    const contents: any[] = [];
    const prepared = prepareVisionText(getOriginalQuestionText(existing_question), contents);
    const strictMathFormatting = shouldUseStrictMathFormatting(subject, topic, prepared.text);
    const subjectRules = getSubjectPromptRules(subject, topic);
    let teacherInstructions = String(instructions || '').trim().slice(0, 2_000) || 'None';
    if (prepared.text) {
      teacherInstructions += `\nReplace this existing question with a newly reasoned question. Do not reuse its answer or options:\n${prepared.text}`;
    }

    const prompt = STRUCTURED_QUIZ_GENERATOR_PROMPT
      .replace('{topic}', String(topic || 'Quiz').trim())
      .replace('{subject}', String(subject || 'General').trim())
      .replace('{question_style}', String(question_style || 'Mixed'))
      .replace('{teacher_instructions}', teacherInstructions)
      .replace('{batch_size}', '1')
      .replace('{question_plan}', `1. type="${target_type}", difficulty="average"`)
      .replace('{images_count}', prepared.assets.length > 0 ? '1' : '0')
      .replace('{subject_rules}', subjectRules);
    contents.unshift(prompt);

    let parsed: any;
    if (isOllama) {
      parsed = await requestOllamaQuestions(ollama_url, String(model_name), prompt);
    } else {
      const response = await generateGeminiContent(ai!, {
        model: getRealModelName(model_name),
        contents,
        config: buildAiTaskConfig('question_drafting', {
          responseMimeType: 'application/json',
          responseSchema: questionArraySchema,
          maxOutputTokens: 4096
        }) as any
      });
      parsed = safeParseJSON(response.text || '');
    }
    const rawQuestion = Array.isArray(parsed)
      ? parsed[0]
      : (Array.isArray(parsed?.questions) ? parsed.questions[0] : parsed);
    const normalized = normalizeGeneratedQuestion(rawQuestion, target_type, 'average', strictMathFormatting);
    if (!normalized) {
      return res.status(502).json({ success: false, error: 'The model returned an invalid question' });
    }
    const identified = { ...normalized, id: String(normalized.id || `generated_${Date.now()}`) };
    let finalQuestion: any;
    if (isOllama || !ai) {
      finalQuestion = {
        ...identified,
        verification: {
          answer_source: 'manual',
          verification_status: 'review_required',
          reason: 'This Ollama draft was not independently verified by both Gemini Flash-Lite solvers.',
          solver_models: []
        }
      };
    } else {
      const verification = await verifyQuestionBatch({
        ai,
        questions: [identified],
        subject: String(subject || 'General'),
        topic: String(topic || 'Quiz'),
        preferredModel: String(model_name),
        extraContents: contents.slice(1),
        contextLabel: 'single-question generation'
      });
      finalQuestion = verification.questions[0];
    }
    finalQuestion.question = restoreVisionText(finalQuestion.question, prepared);
    const reviewRequired = finalQuestion?.verification?.verification_status !== 'verified';
    return res.json({ success: true, question: finalQuestion, review_required: reviewRequired });
  } catch (err: any) {
    if (respondAiWorkLimit(res, err)) return;
    console.error('Generate question error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Question generation failed' });
  } finally {
    aiLease?.release();
  }
});

router.post('/api/polish_questions', tokenRequired, async (req: AuthRequest, res) => {
  const {
    questions,
    api_key,
    model_name = 'gemini-3.5-flash-lite',
    mode,
    subject = 'General',
    golden_reference = {}
  } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ success: false, error: 'No questions provided' });
  }
  if (questions.length > MAX_GENERATED_QUESTIONS) {
    return res.status(400).json({
      success: false,
      error: `Polishing is limited to ${MAX_GENERATED_QUESTIONS} questions per request`
    });
  }
  
  let aiLease: AiWorkLease | null = null;
  try {
    const ai = getGeminiClient(api_key);
    if (!ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });
    aiLease = acquireRequestAiWork(req, questions.length * (mode === 'RECHECK_ANSWERS' ? 2 : 1), api_key);

    const polishSubjectRules = getSubjectPromptRules(subject);
    const polishUsesStrictMath = (content: unknown) => shouldUseStrictMathFormatting(subject, '', content);
    const stableQuestions = questions.map((question: any, index: number) => ({
      ...question,
      id: String(question?.id || question?.source?.original_index || question?.original_index || `question_${index + 1}`)
    }));
    const preparedContents: any[] = [];
    const preparedQuestions = stableQuestions.map((question: any) => {
      const prepared = prepareVisionText(getOriginalQuestionText(question), preparedContents);
      const cleanBase = mode === 'RECHECK_ANSWERS'
        ? withoutPriorAnswerState(question)
        : { ...question };
      return {
        prepared,
        clean: {
          ...cleanBase,
          id: question.id,
          raw_text: prepared.text,
          question: prepared.text,
          ...(mode === 'RECHECK_ANSWERS'
            ? { proposed_answer_for_review: getCorrectAnswer(question) }
            : {})
        }
      };
    });
    const cleanQuestions = preparedQuestions.map(item => item.clean);
    const patchRequests = mode === 'RECHECK_ANSWERS' ? [] : createLatexPatchRequests(cleanQuestions);
    if (mode !== 'RECHECK_ANSWERS') {
      const prompt = `${LATEX_POLISH_PROMPT.replace('{subject_rules}', polishSubjectRules)}

FIELDS TO CHECK:
${JSON.stringify(patchRequests)}`;
      const runLatexModel = async (model: string): Promise<any[]> => {
        const response = await generateGeminiContent(ai, {
          model,
          contents: [prompt, ...preparedContents],
          config: buildAiTaskConfig('latex_polish', {
            responseMimeType: 'application/json',
            responseSchema: latexPatchSchema,
            maxOutputTokens: 8192
          }) as any
        });
        const parsed = safeParseJSON(response.text || '');
        if (!Array.isArray(parsed)) throw new Error(`${model} did not return a JSON array.`);
        return parsed;
      };
      if (patchRequests.length === 0) {
        const locallyCleaned = stableQuestions.map((question: any) => {
          const sourceText = getOriginalQuestionText(question);
          const itemStrictMath = polishUsesStrictMath(sourceText);
          const normalizedOptions = Array.isArray(question.options)
            ? question.options.map((option: unknown, index: number) => stripRedundantOptionPrefix(itemStrictMath ? normalizeMathQuestionText(option) : normalizeAiLatexText(option), index))
            : [];
          const cleanedQuestion = stripDuplicatedChoiceBlock(
            normalizeQuestionTextForDisplay(sourceText, itemStrictMath),
            normalizedOptions
          ).trim();
          return {
            ...question,
            question: cleanedQuestion,
            ...(Array.isArray(question.options) ? { options: normalizedOptions } : {}),
            ...(Object.prototype.hasOwnProperty.call(question, 'raw_text')
              ? { raw_text: stripDuplicatedChoiceBlock(normalizeQuestionTextForDisplay(question.raw_text, itemStrictMath), normalizedOptions).trim() }
              : {})
          };
        });
        return res.json({
          success: true,
          questions: locallyCleaned,
          polish_summary: { requested: 0, applied: 0, rejected: [] }
        });
      }
      const rawPatches = await runLatexModel(getRealModelName(model_name));
      const patchResult = applyLatexPatches(cleanQuestions, rawPatches);
      const patchedById = new Map(patchResult.questions.map((question: any) => [String(question.id), question]));
      const additionalRejected = [...patchResult.rejected];
      const polished = stableQuestions.map((original: any, index: number) => {
        const patched: any = patchedById.get(original.id) || cleanQuestions[index];
        const restoredQuestion = restoreVisionText(patched.question, preparedQuestions[index].prepared)
          || getOriginalQuestionText(original);
        const restoredRawText = Object.prototype.hasOwnProperty.call(original, 'raw_text')
          ? (restoreVisionText(patched.raw_text || patched.question, preparedQuestions[index].prepared) || original.raw_text)
          : undefined;
        const itemStrictMath = polishUsesStrictMath(restoredQuestion);
        const normalizedOptions = Array.isArray(patched.options)
          ? patched.options.map((option: unknown, index: number) => stripRedundantOptionPrefix(itemStrictMath ? normalizeMathQuestionText(option) : normalizeAiLatexText(option), index))
          : (Array.isArray(original.options) ? original.options : []);
        const candidate: any = {
          ...original,
          question: stripDuplicatedChoiceBlock(
            normalizeQuestionTextForDisplay(restoredQuestion, itemStrictMath),
            normalizedOptions
          ).trim(),
          options: normalizedOptions,
          answer: patched.answer ?? original.answer,
          ...(typeof patched.solution === 'string'
            ? { solution: itemStrictMath ? normalizeMathQuestionText(patched.solution) : normalizeAiLatexText(patched.solution) }
            : {}),
          ...(restoredRawText !== undefined
            ? { raw_text: stripDuplicatedChoiceBlock(
                normalizeQuestionTextForDisplay(restoredRawText, itemStrictMath),
                normalizedOptions
              ).trim() }
            : {})
        };
        const storage = normalizeQuestionForStorage(candidate);
        const latexIssues = storage.valid ? validateQuestionLatex(storage.question) : [];
        if (!storage.valid || latexIssues.length > 0) {
          additionalRejected.push({
            id: original.id,
            field: 'question',
            reason: !storage.valid
              ? 'The patched question failed canonical validation.'
              : latexIssues[0].message
          });
          return original;
        }
        return storage.question;
      });
      return res.json({
        success: true,
        questions: polished,
        polish_summary: {
          requested: patchRequests.length,
          applied: patchResult.applied,
          rejected: additionalRejected
        }
      });
    }

    const authoritativeAnswers: Record<string, unknown> = {};
    const verificationQuestions = cleanQuestions.map((clean: any, index: number) => {
      const original = stableQuestions[index];
      const sourceId = String(original?.source?.original_index || original?.original_index || original.id);
      const goldenValue = Object.prototype.hasOwnProperty.call(golden_reference || {}, sourceId)
        ? golden_reference[sourceId]
        : (Object.prototype.hasOwnProperty.call(golden_reference || {}, original.id)
          ? golden_reference[original.id]
          : undefined);
      if (goldenValue !== undefined) authoritativeAnswers[original.id] = goldenValue;
      return {
        ...clean,
        options: Array.isArray(original.options) ? original.options : [],
        answer: getCorrectAnswer(original),
        type: original.type,
        ...(typeof original.solution === 'string' ? { solution: original.solution } : {})
      };
    });
    const verification = await verifyQuestionBatch({
      ai,
      questions: verificationQuestions,
      preferredModel: String(model_name || 'gemini-3.5-flash-lite'),
      extraContents: preparedContents,
      contextLabel: 'answer recheck',
      authoritativeAnswers
    });
    const summary = {
      changed: [] as string[],
      unchanged: [] as string[],
      invalid: [...verification.invalidIds],
      review_required: [] as string[]
    };
    const resolved = verification.questions.map((verified: any, index: number) => {
      const original = stableQuestions[index];
      const restoredQuestion = restoreVisionText(verified.question, preparedQuestions[index].prepared)
        || getOriginalQuestionText(original);
      const itemStrictMath = polishUsesStrictMath(restoredQuestion);
      const output: any = {
        ...original,
        ...verified,
        id: original.id,
        question: normalizeQuestionTextForDisplay(restoredQuestion, itemStrictMath)
      };
      if (Array.isArray(output.options)) {
        output.options = output.options.map((option: unknown, index: number) => stripRedundantOptionPrefix(itemStrictMath ? normalizeMathQuestionText(option) : normalizeAiLatexText(option), index));
        output.question = stripDuplicatedChoiceBlock(output.question, output.options).trim();
      }
      if (typeof output.solution === 'string') {
        output.solution = itemStrictMath ? normalizeMathQuestionText(output.solution) : normalizeAiLatexText(output.solution);
      }
      if (Object.prototype.hasOwnProperty.call(original, 'raw_text')) {
        output.raw_text = normalizeQuestionTextForDisplay(original.raw_text, itemStrictMath);
        if (Array.isArray(output.options)) output.raw_text = stripDuplicatedChoiceBlock(output.raw_text, output.options).trim();
      }
      if (output?.verification?.verification_status !== 'verified') summary.review_required.push(original.id);
      const before = normalizeQuestion(original);
      const after = normalizeQuestion(output);
      if (before.valid && after.valid && JSON.stringify(before.question.answer) === JSON.stringify(after.question.answer)) {
        summary.unchanged.push(original.id);
      } else {
        summary.changed.push(original.id);
      }
      return output;
    });
    return res.json({
      success: true,
      questions: resolved,
      summary,
      review_required: summary.review_required.length > 0,
      model_failures: verification.modelFailures
    });
  } catch (err: any) {
    if (respondAiWorkLimit(res, err)) return;
    console.error('Polish questions error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    aiLease?.release();
  }
});

router.post('/api/resolve_question', tokenRequired, async (req: AuthRequest, res) => {
  const {
    question_data,
    source_context,
    api_key,
    subject = 'General',
    topic = 'Quiz',
    model_name = 'gemini-3.5-flash-lite'
  } = req.body;
  if (!question_data) return res.status(400).json({ success: false, error: 'No question data' });

  let aiLease: AiWorkLease | null = null;
  try {
    const ai = getGeminiClient(api_key);
    if (!ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });
    aiLease = acquireRequestAiWork(req, 3, api_key);

    const visionContents: any[] = [];
    const prepared = prepareVisionText(getOriginalQuestionText(question_data, source_context), visionContents);
    if (prepared.assets.length === 0) {
      if (!appendDataUrlVision(visionContents, source_context?.crop_data_url)) {
        appendDataUrlVision(visionContents, question_data?.image_url || source_context?.image_url);
      }
    }

    const id = String(
      question_data?.id
      || question_data?.source?.original_index
      || question_data?.original_index
      || `resolved_${Date.now()}`
    );
    const candidate = {
      ...question_data,
      id,
      question: prepared.text || getOriginalQuestionText(question_data, source_context),
      raw_text: prepared.text || getOriginalQuestionText(question_data, source_context)
    };
    const hasGoldenAnswer = question_data?.verification?.answer_source === 'golden_key';
    const authoritativeAnswers = hasGoldenAnswer
      ? { [id]: getCorrectAnswer(question_data) }
      : undefined;

    const verification = await verifyQuestionBatch({
      ai,
      questions: [candidate],
      subject: String(subject || 'General'),
      topic: String(topic || 'Quiz'),
      preferredModel: String(model_name || 'gemini-3.5-flash-lite'),
      extraContents: visionContents,
      contextLabel: 'manual question resolution',
      authoritativeAnswers
    });
    const verified = verification.questions[0];
    if (!verified) {
      return res.status(502).json({ success: false, error: 'The question could not be solved safely.' });
    }

    const restoredText = restoreVisionText(verified.question, prepared)
      || getOriginalQuestionText(question_data, source_context);
    const resolveStrictMath = shouldUseStrictMathFormatting(subject, topic, restoredText);
    const finalResolvedQuestion: any = {
      ...question_data,
      ...verified,
      id,
      question: normalizeQuestionTextForDisplay(restoredText, resolveStrictMath)
    };
    if (Array.isArray(finalResolvedQuestion.options)) {
      finalResolvedQuestion.options = finalResolvedQuestion.options.map((option: unknown, index: number) => stripRedundantOptionPrefix(resolveStrictMath ? normalizeMathQuestionText(option) : normalizeAiLatexText(option), index));
    }
    if (typeof finalResolvedQuestion.solution === 'string') {
      finalResolvedQuestion.solution = resolveStrictMath ? normalizeMathQuestionText(finalResolvedQuestion.solution) : normalizeAiLatexText(finalResolvedQuestion.solution);
    }
    if (Object.prototype.hasOwnProperty.call(question_data, 'raw_text')) {
      finalResolvedQuestion.raw_text = resolveStrictMath
        ? normalizeQuestionTextForDisplay(question_data.raw_text, true)
        : normalizeQuestionTextForDisplay(question_data.raw_text, false);
    }

    const reviewRequired = finalResolvedQuestion?.verification?.verification_status !== 'verified';
    return res.status(200).json({
      success: true,
      review_required: reviewRequired,
      reason: finalResolvedQuestion?.verification?.reason || '',
      question: finalResolvedQuestion,
      model_failures: verification.modelFailures
    });
  } catch (err: any) {
    if (respondAiWorkLimit(res, err)) return;
    console.error('Resolve question error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    aiLease?.release();
  }
});

router.post('/api/transfer_question', tokenRequired, async (req: AuthRequest, res) => {
  const { source_quiz_id, target_quiz_id, question_index } = req.body;
  const src = quizzes.get(source_quiz_id);
  const tgt = quizzes.get(target_quiz_id);
  if (!src || !tgt) {
    return res.status(404).json({ success: false, error: 'Source or target quiz not found' });
  }
  if (!canManageQuiz(req.user, src) || !canManageQuiz(req.user, tgt)) {
    return res.status(403).json({ success: false, error: 'You do not have access to the source or target quiz' });
  }
  if (source_quiz_id === target_quiz_id) {
    return res.status(400).json({ success: false, error: 'Source and target quizzes must be different' });
  }
  const index = Number(question_index);
  if (
    Number.isInteger(index)
    && index >= 0
    && Array.isArray(src.questions)
    && src.questions[index]
  ) {
    if (!Array.isArray(tgt.questions)) tgt.questions = [];
    tgt.questions.push(clonePlainValue(src.questions[index]));
    quizzes.set(target_quiz_id, tgt);
    savePersistentData();
    await syncDocToFirestore('quizzes', target_quiz_id, tgt);
    return res.json({ success: true, count: 1 });
  }
  return res.status(400).json({ success: false, error: 'Failed to transfer question' });
});

router.post('/api/bulk_import_questions', tokenRequired, async (req: AuthRequest, res) => {
  const {
    quiz_id,
    questions,
    source_quiz_id,
    target_quiz_id,
    question_indices
  } = req.body;

  // Preserve the legacy direct-import contract while supporting the current
  // editor contract (source id + selected indices + target id).
  const destinationId = target_quiz_id || quiz_id;
  const destination = quizzes.get(destinationId);
  if (!destination) {
    return res.status(404).json({ success: false, error: 'Target quiz not found' });
  }
  if (!canManageQuiz(req.user, destination)) {
    return res.status(403).json({ success: false, error: 'You do not have access to the target quiz' });
  }
  let selectedQuestions: any[] = [];

  if (Array.isArray(questions)) {
    selectedQuestions = questions;
  } else {
    const source = quizzes.get(source_quiz_id);
    if (!source) {
      return res.status(404).json({ success: false, error: 'Source quiz not found' });
    }
    if (!canManageQuiz(req.user, source)) {
      return res.status(403).json({ success: false, error: 'You do not have access to the source quiz' });
    }
    if (source && Array.isArray(source.questions) && Array.isArray(question_indices)) {
      const uniqueIndices = Array.from(new Set(
        question_indices
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isInteger(value) && value >= 0 && value < source.questions.length)
      ));
      selectedQuestions = uniqueIndices.map(index => source.questions[index]);
    }
  }

  if (selectedQuestions.length > 0 && selectedQuestions.length <= 500) {
    if (!Array.isArray(destination.questions)) destination.questions = [];
    const importedQuestions = selectedQuestions.map((question) => {
      const cloned = clonePlainValue(question);
      cloned.id = `q_imported_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (!cloned.source && cloned.original_index) {
        delete cloned.original_index;
      }
      return cloned;
    });

    destination.questions.push(...importedQuestions);
    quizzes.set(destinationId, destination);
    savePersistentData();
    await syncDocToFirestore('quizzes', destinationId, destination);
    return res.json({
      success: true,
      count: importedQuestions.length,
      imported_questions: importedQuestions,
      total_questions: destination.questions.length
    });
  }
  return res.status(400).json({ success: false, error: 'Failed to import questions' });
});

router.post('/api/reprocess_question', tokenRequired, async (req: AuthRequest, res) => {
  const {
    question_data,
    source_context,
    target_type,
    api_key,
    subject = 'General',
    topic = 'Quiz',
    model_name = 'gemini-3.5-flash-lite'
  } = req.body;
  if (!question_data || !target_type) {
    return res.status(400).json({ success: false, error: 'Missing question_data or target_type' });
  }
  const allowedTypes = new Set([
    'multiple_choice',
    'multiple_choice_multi',
    'true_false',
    'identification',
    'open_ended',
    'graphing'
  ]);
  if (!allowedTypes.has(target_type)) {
    return res.status(400).json({ success: false, error: 'Unsupported target type' });
  }

  let aiLease: AiWorkLease | null = null;
  try {
    const ai = getGeminiClient(api_key);
    if (!ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });
    aiLease = acquireRequestAiWork(req, 4, api_key);

    const selectedModel = getRealModelName(model_name);
    const visionContents: any[] = [];
    const prepared = prepareVisionText(getOriginalQuestionText(question_data, source_context), visionContents);
    if (prepared.assets.length === 0) {
      if (!appendDataUrlVision(visionContents, source_context?.crop_data_url)) {
        appendDataUrlVision(visionContents, question_data?.image_url || source_context?.image_url);
      }
    }

    const strictMathFormatting = shouldUseStrictMathFormatting(subject, topic, prepared.text);
    const subjectRules = getSubjectPromptRules(subject, topic);
    const sourceSummary = source_context && typeof source_context === 'object'
      ? {
          raw_text: String(source_context.raw_text || source_context.question || '').slice(0, 8_000),
          original_index: source_context.original_index || source_context?.source?.original_index || null
        }
      : null;
    const prompt = `You are an expert quiz editor. Rewrite the source as exactly one valid ${target_type} question and solve it from scratch.

Subject: ${String(subject || 'General')}
Topic: ${String(topic || 'Quiz')}
Source question:
${prepared.text}
Source metadata:
${JSON.stringify(sourceSummary)}

Rules:
- Preserve the source meaning and any image placeholder token. Do not copy a stale answer or stale options.
- multiple_choice: exactly four unique options and one answer letter.
- multiple_choice_multi: exactly four unique options and every correct letter in ascending order.
- true_false: options must be A) True and B) False; answer A or B.
- identification, open_ended, graphing: options must be empty.
- Include a concise, student-safe solution that verifies the answer.
- ${subjectRules}
- Return only the schema JSON. Use standard JSON escaping; serialized newlines use \\n.
`;

    const response = await generateGeminiContent(ai, {
      model: selectedModel,
      contents: [prompt, ...visionContents],
      config: buildAiTaskConfig('question_drafting', {
        responseMimeType: 'application/json',
        responseSchema: {
          ...reprocessedQuestionSchema,
          required: ['question', 'options', 'answer', 'type', 'solution']
        },
        maxOutputTokens: 4096
      }) as any
    });
    const parsed = safeParseJSON(response.text || '');
    const normalized = normalizeGeneratedQuestion(parsed, target_type, String(question_data?.difficulty || 'average'), strictMathFormatting);
    if (!normalized) {
      return res.status(502).json({ success: false, error: 'The model returned an invalid rewritten question.' });
    }

    const id = String(
      question_data?.id
      || question_data?.source?.original_index
      || question_data?.original_index
      || `reprocessed_${Date.now()}`
    );
    const draft = {
      ...normalized,
      id,
      question: normalizeQuestionTextForDisplay(normalized.question, strictMathFormatting)
    };
    const verification = await verifyQuestionBatch({
      ai,
      questions: [draft],
      subject: String(subject || 'General'),
      topic: String(topic || 'Quiz'),
      preferredModel: String(model_name || 'gemini-3.5-flash-lite'),
      extraContents: visionContents,
      contextLabel: 'question type conversion'
    });
    const verified = verification.questions[0];
    if (!verified) {
      return res.status(502).json({ success: false, error: 'The rewritten question could not be verified.' });
    }

    const restoredText = restoreVisionText(verified.question, prepared)
      || getOriginalQuestionText(question_data, source_context);
    const finalReprocessed: any = {
      ...question_data,
      ...verified,
      id,
      question: restoredText,
      type: target_type
    };
    if (Object.prototype.hasOwnProperty.call(question_data, 'raw_text')) {
      finalReprocessed.raw_text = question_data.raw_text;
    }
    const reviewRequired = finalReprocessed?.verification?.verification_status !== 'verified';
    return res.json({
      success: true,
      question: finalReprocessed,
      review_required: reviewRequired,
      model_failures: verification.modelFailures
    });
  } catch (err: any) {
    if (respondAiWorkLimit(res, err)) return;
    console.error('Reprocess question error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    aiLease?.release();
  }
});

export default router;
