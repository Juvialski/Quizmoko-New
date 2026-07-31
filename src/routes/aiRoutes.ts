import { Router } from 'express';
import { Type } from '@google/genai';
import { tokenRequired } from '../middleware/auth.ts';
import { generateAiLimiter } from '../middleware/rateLimit.ts';
import type { AuthRequest } from '../middleware/auth.ts';
import {
  quizzes,
  savePersistentData,
  syncDocToFirestore,
  getUniqueQuizTitle
} from '../store/db.ts';
import { getGeminiClient, getRealModelName, safeParseJSON } from '../services/gemini.ts';
import {
  acquireAiWork,
  AiWorkLimitError,
  type AiWorkLease
} from '../services/aiWorkGuard.ts';
import {
  SHARED_LATEX_RULES,
  NON_MATH_RULES,
  WORKSHEET_SOLVER_PROMPT,
  WORKSHEET_SOLVER_PROMPT_NON_MATH,
  LATEX_POLISH_PROMPT,
  RECHECK_ANSWERS_PROMPT,
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
  if (!(error instanceof AiWorkLimitError)) return false;
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
  question: { type: Type.STRING, description: 'The complete question text.' },
  raw_text: { type: Type.STRING, description: 'Legacy alias for question text.' },
  options: { type: Type.ARRAY, items: { type: Type.STRING } },
  answer: { type: Type.STRING },
  type: { type: Type.STRING },
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
    required: ['question', 'options', 'answer', 'type']
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

function normalizeGeneratedQuestion(raw: any, expectedType: string, difficulty: string) {
  if (!raw || typeof raw !== 'object') return null;
  const question = String(raw.question || raw.raw_text || '').trim()
    .replace(/^(?:Question|Q)\s*\d*\s*[:.)-]\s*/i, '');
  const rawAnswer = String(raw.answer ?? raw.correct_answer_letter ?? '').trim();
  if (!question || !rawAnswer) return null;

  const normalized: any = {
    question,
    options: [],
    answer: rawAnswer,
    type: expectedType,
    difficulty
  };
  if (typeof raw.solution === 'string' && raw.solution.trim()) normalized.solution = raw.solution.trim();

  if (expectedType === 'multiple_choice' || expectedType === 'multiple_choice_multi') {
    const sourceOptions = Array.isArray(raw.options) ? raw.options : [];
    if (sourceOptions.length < 4) return null;
    normalized.options = sourceOptions.slice(0, 4).map((option: unknown, index: number) => {
      const text = String(option ?? '').trim().replace(/^[A-D][).]\s*/i, '');
      return `${String.fromCharCode(65 + index)}) ${text}`;
    });
    if (normalized.options.some((option: string) => !option.replace(/^[A-D]\)\s*/, '').trim())) return null;

    const answerLetters = Array.from(rawAnswer.toUpperCase().matchAll(/(?:^|[\s,;])([A-D])(?=$|[\s,;.)])/g))
      .map(match => match[1])
      .filter((letter, index, all) => all.indexOf(letter) === index);
    let answerLetter = answerLetters[0] || '';
    if (!answerLetter && expectedType === 'multiple_choice') {
      const answerText = rawAnswer.replace(/^[A-D][).]\s*/i, '').trim().toLowerCase();
      const matchIndex = normalized.options.findIndex((option: string) =>
        option.replace(/^[A-D]\)\s*/, '').trim().toLowerCase() === answerText
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
    normalized.options = ['A) True', 'B) False'];
    if (/^(?:a|true)(?:\b|[).])/i.test(rawAnswer)) normalized.answer = 'A';
    else if (/^(?:b|false)(?:\b|[).])/i.test(rawAnswer)) normalized.answer = 'B';
    else return null;
  }

  return normalized;
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
            required: ['question', 'options', 'answer', 'type']
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
    api_key,
    ollama_url,
    model_name = 'gemini-3.5-flash-lite',
    topic,
    subject: requestedSubject = 'General',
    custom_subject,
    question_style = 'Mixed',
    test_type = 'Mixed',
    quiz_mode = 'back_and_forth'
  } = req.body || {};

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
  const isNonMath = ['english', 'history', 'biology', 'social studies'].includes(subject.toLowerCase());
  const subjectRules = isNonMath ? NON_MATH_RULES : SHARED_LATEX_RULES;
  const model = String(model_name || 'gemini-3.5-flash-lite').trim();
  const isOllama = model.toLowerCase().startsWith('ollama:');
  const ai = isOllama ? null : getGeminiClient(api_key);
  if (!isOllama && !ai) {
    return fail(400, 'No Gemini API key is configured. Add a browser key or set GEMINI_API_KEY/API_KEY on the server.');
  }

  let aiLease: AiWorkLease;
  try {
    const plannedBatches = Math.ceil(totalQuestions / batchSize);
    const plannedCost = Math.max(totalQuestions, plannedBatches * 3);
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
    let remainingImages = imagesCount;

    for (let offset = 0; offset < totalQuestions; offset += batchSize) {
      const batchTypes = typePlan.slice(offset, offset + batchSize);
      const batchDifficulties = difficultyPlan.slice(offset, offset + batchTypes.length);
      const batchImages = Math.min(remainingImages, batchTypes.length);
      remainingImages -= batchImages;
      const questionPlan = batchTypes
        .map((type, index) => `${index + 1}. type="${type}", difficulty="${batchDifficulties[index] || 'average'}"`)
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
          const response = await ai!.models.generateContent({
            model: getRealModelName(model),
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: questionArraySchema,
              maxOutputTokens: 8192
            }
          });
          parsed = safeParseJSON(response.text || '');
        }

        const rawQuestions = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.questions) ? parsed.questions : []);
        if (rawQuestions.length >= batchTypes.length) {
          const candidates = batchTypes.map((type, index) =>
            normalizeGeneratedQuestion(rawQuestions[index], type, batchDifficulties[index] || 'average')
          );
          if (candidates.every(Boolean)) normalizedBatch = candidates as any[];
        }

        if (!normalizedBatch) {
          prompt += '\n\nYour previous response was incomplete or did not match the required types. Return every planned question with a non-empty answer and all required options.';
        }
      }

      if (!normalizedBatch) {
        throw new Error(`The model could not produce a valid batch beginning at question ${offset + 1}.`);
      }
      generatedQuestions.push(...normalizedBatch);
    }

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
    api_key,
    ollama_url,
    model_name = 'gemini-3.5-flash-lite'
  } = req.body || {};
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
    aiLease = acquireRequestAiWork(req, 1, api_key);

    const contents: any[] = [];
    const prepared = prepareVisionText(getOriginalQuestionText(existing_question), contents);
    const isNonMath = ['english', 'history', 'biology', 'social studies'].includes(String(subject).toLowerCase());
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
      .replace('{subject_rules}', isNonMath ? NON_MATH_RULES : SHARED_LATEX_RULES);
    contents.unshift(prompt);

    let parsed: any;
    if (isOllama) {
      parsed = await requestOllamaQuestions(ollama_url, String(model_name), prompt);
    } else {
      const response = await ai!.models.generateContent({
        model: getRealModelName(model_name),
        contents,
        config: {
          responseMimeType: 'application/json',
          responseSchema: questionArraySchema,
          maxOutputTokens: 4096
        }
      });
      parsed = safeParseJSON(response.text || '');
    }
    const rawQuestion = Array.isArray(parsed)
      ? parsed[0]
      : (Array.isArray(parsed?.questions) ? parsed.questions[0] : parsed);
    const normalized = normalizeGeneratedQuestion(rawQuestion, target_type, 'average');
    if (!normalized) {
      return res.status(502).json({ success: false, error: 'The model returned an invalid question' });
    }
    normalized.question = restoreVisionText(normalized.question, prepared);
    return res.json({ success: true, question: normalized });
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
    aiLease = acquireRequestAiWork(req, questions.length, api_key);

    const contents: any[] = [];
    const preparedQuestions = questions.map((q: any) => {
      const prepared = prepareVisionText(getOriginalQuestionText(q), contents);
      return {
        prepared,
        clean: {
          ...q,
          raw_text: prepared.text,
          question: prepared.text
        }
      };
    });

    const cleanQuestions = preparedQuestions.map(item => item.clean);
    const prompt = mode === 'RECHECK_ANSWERS'
      ? RECHECK_ANSWERS_PROMPT
          .replace('{golden_reference}', JSON.stringify(golden_reference || {}))
          .replace('{batch_json}', JSON.stringify(cleanQuestions))
      : `${LATEX_POLISH_PROMPT}\n\nHere are the questions to polish. Preserve their order and return exactly ${questions.length} objects. Output ONLY the JSON array containing the polished questions matching the exact schema.\n\n${JSON.stringify(cleanQuestions)}`;
    contents.unshift(prompt);

    const response = await ai.models.generateContent({
      model: getRealModelName(model_name),
      contents: contents,
      config: {
        responseMimeType: 'application/json',
        responseSchema: questionArraySchema,
        maxOutputTokens: 8192
      }
    });
    
    const text = response.text || '';
    const parsed = safeParseJSON(text);
    
    if (Array.isArray(parsed) && parsed.length > 0) {
      const merged = questions.map((originalQ: any, i: number) => {
        const polishedQ = parsed[i];
        if (!polishedQ || typeof polishedQ !== 'object') return originalQ;

        const finalQuestion = restoreVisionText(
          polishedQ.question || polishedQ.raw_text,
          preparedQuestions[i].prepared
        );
        const mergedQuestion = {
          ...originalQ,
          ...polishedQ,
          question: finalQuestion || getOriginalQuestionText(originalQ)
        };
        if (Object.prototype.hasOwnProperty.call(originalQ, 'raw_text')) {
          mergedQuestion.raw_text = finalQuestion || originalQ.raw_text;
        }
        if (!Array.isArray(polishedQ.options)) mergedQuestion.options = originalQ.options;
        if (polishedQ.answer === undefined || polishedQ.answer === null || String(polishedQ.answer).trim() === '') {
          mergedQuestion.answer = originalQ.answer;
        }
        if (!polishedQ.type) mergedQuestion.type = originalQ.type;
        return mergedQuestion;
      });
      return res.json({ success: true, questions: merged });
    } else {
      return res.status(500).json({ success: false, error: 'Failed to parse model output as array' });
    }
  } catch (err: any) {
    if (respondAiWorkLimit(res, err)) return;
    console.error('Polish questions error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    aiLease?.release();
  }
});

router.post('/api/resolve_question', tokenRequired, async (req: AuthRequest, res) => {
  const { question_data, source_context, api_key, subject = 'General', topic = 'Quiz' } = req.body;
  if (!question_data) return res.status(400).json({ success: false, error: 'No question data' });

  let aiLease: AiWorkLease | null = null;
  try {
    const ai = getGeminiClient(api_key);
    if (!ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });
    aiLease = acquireRequestAiWork(req, 2, api_key);

    const contents31: any[] = [];
    const prepared = prepareVisionText(getOriginalQuestionText(question_data, source_context), contents31);

    if (prepared.assets.length === 0) {
      if (!appendDataUrlVision(contents31, source_context?.crop_data_url)) {
        appendDataUrlVision(contents31, question_data?.image_url);
      }
    }
    const contents35 = [...contents31];

    const existingOptions = Array.isArray(question_data.options) ? question_data.options : [];

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
3. CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside your answer and solution with LaTeX dollar signs (e.g. $x^2$, $130/10$, $\\$$40). Do NOT use asterisks for math.

Return STRICTLY a JSON object with keys:
- "options": array of strings (choices if multiple choice, else [])
- "answer": string (the exact correct answer)
- "type": string (one of "multiple_choice", "multiple_choice_multi", "identification", "open_ended", "graphing", "true_false")
- "solution": string (detailed step-by-step worked solution)
`;

    contents31.unshift(solverPromptText);
    contents35.unshift(solverPromptText);

    const [res31, res35] = await Promise.allSettled([
      ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: contents31,
        config: {
          responseMimeType: 'application/json',
          maxOutputTokens: 4096
        }
      }),
      ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: contents35,
        config: {
          responseMimeType: 'application/json',
          maxOutputTokens: 4096
        }
      })
    ]);

    if (res31.status === 'rejected' && res35.status === 'rejected') {
      const errMessage = `Both Gemini solvers failed. Model 3.1: ${res31.reason?.message || 'Unknown error'}. Model 3.5: ${res35.reason?.message || 'Unknown error'}`;
      console.error('[Resolve Question] Dual failures:', errMessage);
      return res.status(502).json({ success: false, error: errMessage });
    }
    if (res31.status === 'rejected') {
      console.warn('[Resolve Question] gemini-3.1-flash-lite failed:', res31.reason);
    }
    if (res35.status === 'rejected') {
      console.warn('[Resolve Question] gemini-3.5-flash-lite failed:', res35.reason);
    }

    let parsed31 = safeParseJSON(res31.status === 'fulfilled' ? res31.value.text || '' : '{}') || {};
    let parsed35 = safeParseJSON(res35.status === 'fulfilled' ? res35.value.text || '' : '{}') || {};

    let ans31 = String(parsed31.answer || '').trim();
    let ans35 = String(parsed35.answer || '').trim();

    let activeParsed = (ans31 && ans35 && ans31.toLowerCase() === ans35.toLowerCase())
      ? (parsed35.answer ? parsed35 : parsed31)
      : (parsed35.answer ? parsed35 : parsed31);

    if (activeParsed && activeParsed.answer) {
      const finalQuestion = restoreVisionText(activeParsed.question || prepared.text, prepared);

      const finalResolvedQuestion = {
        ...question_data,
        ...activeParsed,
        question: finalQuestion || getOriginalQuestionText(question_data, source_context)
      };
      if (!Array.isArray(activeParsed.options) || activeParsed.options.length === 0) {
        finalResolvedQuestion.options = question_data.options || [];
      }
      if (!activeParsed.type) finalResolvedQuestion.type = question_data.type;
      if (Object.prototype.hasOwnProperty.call(question_data, 'raw_text')) {
        finalResolvedQuestion.raw_text = question_data.raw_text;
      }
      return res.json({ success: true, question: finalResolvedQuestion });
    } else {
      return res.status(500).json({ success: false, error: 'Failed to parse model output' });
    }

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
    destination.questions.push(...selectedQuestions.map(question => clonePlainValue(question)));
    quizzes.set(destinationId, destination);
    savePersistentData();
    await syncDocToFirestore('quizzes', destinationId, destination);
    return res.json({ success: true, count: selectedQuestions.length });
  }
  return res.status(400).json({ success: false, error: 'Failed to import questions' });
});

router.post('/api/reprocess_question', tokenRequired, async (req: AuthRequest, res) => {
  const { question_data, source_context, target_type, api_key, subject = 'General', model_name = 'gemini-3.5-flash-lite' } = req.body;
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
    aiLease = acquireRequestAiWork(req, 1, api_key);

    const selectedModel = getRealModelName(model_name);
    const contents: any[] = [];
    const prepared = prepareVisionText(getOriginalQuestionText(question_data, source_context), contents);
    let cleanSourceContext: any = null;
    if (source_context && typeof source_context === 'object') {
      const {
        crop_data_url,
        image_url,
        answer: _staleAnswer,
        options: _staleOptions,
        correct_answer: _staleCorrectAnswer,
        correct_answer_letter: _staleCorrectLetter,
        solution: _staleSolution,
        explanation: _staleExplanation,
        feedback: _staleFeedback,
        ...sourceWithoutEmbeddedUrls
      } = source_context;
      cleanSourceContext = sourceWithoutEmbeddedUrls;
      const sourceText = getOriginalQuestionText(source_context);
      if (sourceText && sourceText !== prepared.original) {
        const preparedSource = prepareVisionText(sourceText, contents);
        cleanSourceContext = {
          ...cleanSourceContext,
          raw_text: preparedSource.text
        };
      }
      if (crop_data_url) cleanSourceContext.crop_data_url = '[IMAGE_PROVIDED_IN_VISION_CONTEXT]';
      if (image_url) cleanSourceContext.image_url = '[IMAGE_PROVIDED_IN_VISION_CONTEXT]';
    }

    const inputQuestion = {
        question: prepared.text,
        options: [],
        answer: "",
        type: target_type
    };

    const reprocessPrompt = `You are an expert educator.
Your task is to re-format, solve, and rewrite this question so that it strictly matches the Target Type.

Input Question Context:
${JSON.stringify(inputQuestion)}

Original Source Context (if any):
${cleanSourceContext ? JSON.stringify(cleanSourceContext) : 'None'}

Target Type: ${target_type}
Subject: ${subject}

CRITICAL RULES:
1. Target Type Formatting:
   - If the Target Type is 'multiple_choice', you MUST provide exactly 4 options starting with "A) ", "B) ", "C) ", "D) ", and the 'answer' field MUST be the single correct choice letter (e.g., "A", "B").
   - If the Target Type is 'multiple_choice_multi', you MUST provide at least 4 options and the 'answer' field MUST be a comma-separated list of all correct letters (e.g., "A, C" or "A, B, D").
   - If the Target Type is 'true_false', the options MUST be ["A) True", "B) False"] and the answer MUST be "A" or "B".
   - If the Target Type is 'identification', the options array MUST be empty [], and the 'answer' field MUST be a concise number, integer, decimal, comparison symbol, or a single exact word (no dollar signs in the answer field for identification).
   - If the Target Type is 'open_ended', the options array MUST be empty [], and the 'answer' field should be the correct answer or solution explanation.
   - If the Target Type is 'graphing', the options array MUST be empty [], and the 'answer' field should be a concise description of the expected graph.
2. MATH & LATEX RULES (For Math or Science subjects):
   - {latex_rules}
   - CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside the feedback/question with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\\$$40). Do NOT use asterisks for math.
   - Do NOT wrap plain English words or names (e.g. 'Right', 'Isosceles', 'John') in LaTeX tags.
3. PRESERVE IMAGES:
   - If the input question contains a token starting with '[IMAGE_PROVIDED_IN_VISION_CONTEXT', preserve that complete token inside your output 'question' text field exactly.
4. Return ONLY a valid JSON object matching this schema:
{
  "question": "The rewritten question text",
  "options": ["A) ...", "B) ..."],
  "answer": "The correct answer value or letter(s)",
  "type": "The target type"
}
`;

    const isNonMath = ['english', 'history', 'biology', 'social studies'].includes(String(subject).toLowerCase());
    const prompt = reprocessPrompt.replace('{latex_rules}', isNonMath ? NON_MATH_RULES : SHARED_LATEX_RULES);
    const hasPreparedVision = contents.some(item => item && item.inlineData);
    contents.unshift(prompt);

    if (!hasPreparedVision) {
      if (!appendDataUrlVision(contents, source_context?.crop_data_url)) {
        appendDataUrlVision(contents, question_data?.image_url || source_context?.image_url);
      }
    }

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config: {
        responseMimeType: 'application/json',
        responseSchema: reprocessedQuestionSchema,
        maxOutputTokens: 4096
      }
    });

    const text = response.text || '';
    const parsed = safeParseJSON(text);

    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
        if (parsed.answer === undefined || parsed.answer === null || String(parsed.answer).trim() === '') {
          return res.status(502).json({ success: false, error: 'The model returned an empty answer' });
        }
        let options = Array.isArray(parsed.options) ? parsed.options.map((value: unknown) => String(value)) : [];
        if (target_type === 'multiple_choice' || target_type === 'multiple_choice_multi') {
          if (options.length < 4) {
            return res.status(502).json({ success: false, error: 'The model returned too few answer choices' });
          }
          options = options.map((option: string, index: number) =>
            `${String.fromCharCode(65 + index)}) ${option.replace(/^[A-Z][).]\s*/i, '').trim()}`
          );
        } else if (target_type === 'true_false') {
          options = ['A) True', 'B) False'];
        } else {
          options = [];
        }
        const finalQuestion = restoreVisionText(parsed.question, prepared);

        const finalReprocessed = {
            ...question_data,
            ...parsed,
            question: finalQuestion || getOriginalQuestionText(question_data, source_context),
            options,
            type: target_type
        };
        if (Object.prototype.hasOwnProperty.call(question_data, 'raw_text')) {
          finalReprocessed.raw_text = question_data.raw_text;
        }
        return res.json({ success: true, question: finalReprocessed });
    } else {
        return res.status(500).json({ success: false, error: 'Failed to parse model output' });
    }

  } catch (err: any) {
      if (respondAiWorkLimit(res, err)) return;
      console.error('Reprocess question error:', err);
      res.status(500).json({ success: false, error: err.message });
  } finally {
      aiLease?.release();
  }
});

export default router;
