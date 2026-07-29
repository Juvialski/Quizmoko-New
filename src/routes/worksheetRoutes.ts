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
  pdfPageToImage,
  extractPdfPages,
  getPdfPageCount,
  getFilesByField,
  sortQuestionsByIndex
} from '../services/pdf.ts';
import { getGeminiClient, getRealModelName, safeParseJSON } from '../services/gemini.ts';
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

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

router.post('/api/extract_worksheet', tokenRequired, upload.any(), async (req: AuthRequest, res) => {
  const {
    api_key,
    model_name = 'gemini-3.5-flash-lite',
    topic_hint = '',
    subject = 'General',
    session_id = 'ws_1'
  } = req.body;

  const files = (req.files as Express.Multer.File[]) || [];
  const wsFiles = getFilesByField(files, ['files', 'worksheet_files']);

  sessionProgress.set(session_id, { message: '📄 Processing uploaded worksheet files...', percentage: 20, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let questions: any[] = [];

    if (ai && wsFiles.length > 0) {
      const selectedModel = getRealModelName(model_name);
      const pdfFile = wsFiles.find(f => f.mimetype === 'application/pdf');
      const imgFile = wsFiles.find(f => f.mimetype && f.mimetype.startsWith('image/'));

      const extractionSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            raw_text: {
              type: Type.STRING,
              description: "The literal text transcript of the question."
            },
            options: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "The choices (e.g. ['A) 10', 'B) 20']) if multiple choice."
            },
            type: {
              type: Type.STRING,
              description: "The type: 'multiple_choice', 'multiple_choice_multi', 'identification', 'open_ended', 'graphing', 'true_false'."
            },
            original_index: {
              type: Type.STRING,
              description: "The question number/index on the worksheet."
            },
            bounding_box: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
              description: "Four normalized integers [ymin, xmin, ymax, xmax] (0 to 1000) of any diagram. Empty array [] if no diagram."
            }
          },
          required: ["raw_text", "options", "type", "original_index"]
        }
      };

      if (pdfFile && !imgFile) {
        const pageCount = getPdfPageCount(pdfFile.buffer);
        console.log(`[QUIZ] Processing PDF with page count: ${pageCount}`);

        const chunkSize = 1;
        const totalChunks = Math.ceil(pageCount / chunkSize);

        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
          const startPage = chunkIdx * chunkSize + 1;
          const endPage = Math.min((chunkIdx + 1) * chunkSize, pageCount);

          sessionProgress.set(session_id, {
            message: `🔍 Extracting Questions from Page ${chunkIdx + 1} of ${pageCount}...`,
            percentage: Math.round(20 + (chunkIdx / totalChunks) * 60),
            status: 'processing'
          });

          const chunkBuffer = await extractPdfPages(pdfFile.buffer, startPage, endPage);
          if (!chunkBuffer) continue;

          const chunkPageImage = await pdfPageToImage(pdfFile.buffer, startPage - 1);

          const isNonMath = ['English', 'History', 'Biology', 'Social Studies'].includes(subject);
          let basePrompt = isNonMath ? WORKSHEET_EXTRACTION_PROMPT_NON_MATH : WORKSHEET_EXTRACTION_PROMPT;
          let prompt = basePrompt
            .replace('{latex_rules}', SHARED_LATEX_RULES)
            .replace('{subject_rules}', isNonMath ? NON_MATH_RULES : '')
            .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

          let contents: any[] = [
            prompt,
            {
              inlineData: { data: chunkBuffer.toString('base64'), mimeType: 'application/pdf' }
            }
          ];

          const response = await ai.models.generateContent({
            model: selectedModel,
            contents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const text = response.text || '';
          const parsed = safeParseJSON(text);
          if (Array.isArray(parsed)) {
            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && chunkPageImage) {
                const imgUri = await cropImageBoundingBox(chunkPageImage, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Source Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      } else {
        const isNonMath = ['English', 'History', 'Biology', 'Social Studies'].includes(subject);
        let basePrompt = isNonMath ? WORKSHEET_EXTRACTION_PROMPT_NON_MATH : WORKSHEET_EXTRACTION_PROMPT;
        let prompt = basePrompt
          .replace('{latex_rules}', SHARED_LATEX_RULES)
          .replace('{subject_rules}', isNonMath ? NON_MATH_RULES : '')
          .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

        const totalFiles = wsFiles.length;
        for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
          const f = wsFiles[fileIdx];
          sessionProgress.set(session_id, {
            message: `🤖 Analyzing worksheet file ${fileIdx + 1} of ${totalFiles} with Gemini AI...`,
            percentage: Math.round(30 + (fileIdx / totalFiles) * 50),
            status: 'processing'
          });

          let contents: any[] = [
            prompt,
            {
              inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
            }
          ];

          const response = await ai.models.generateContent({
            model: selectedModel,
            contents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const text = response.text || '';
          const parsed = safeParseJSON(text);
          if (Array.isArray(parsed)) {
            let currentImageBuffer: Buffer | null = null;
            if (f.mimetype === 'application/pdf') {
              currentImageBuffer = await pdfPageToImage(f.buffer, 0);
            } else if (f.mimetype && f.mimetype.startsWith('image/')) {
              currentImageBuffer = f.buffer;
            }

            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
                const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Source Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      }
    }

    if (!questions || questions.length === 0) {
      questions = [
        {
          raw_text: '1. What is $5 + 5$?',
          type: 'multiple_choice',
          options: ['A) $10$', 'B) $20$', 'C) $30$', 'D) $40$'],
          original_index: 1,
          answer: 'A) $10$'
        }
      ];
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

    sessionProgress.set(session_id, { message: '✅ Worksheet extraction complete!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions, missing_indices: missingIndices });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
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

  sessionProgress.set(session_id, { message: '⚡ Preparing to solve worksheet questions...', percentage: 10, status: 'processing' });

  res.json({ success: true });

  (async () => {
    try {
      const ai = getGeminiClient(api_key);
      const isNonMath = ['English', 'History', 'Biology', 'Social Studies'].includes(subject);
      const solverPromptTemplate = isNonMath ? WORKSHEET_SOLVER_PROMPT_NON_MATH : WORKSHEET_SOLVER_PROMPT;
      const selectedModel = getRealModelName(model_name);

      let solvedResults: any[] = [];
      const batchNum = parseInt(batch_size) || 3;
      const totalQuestions = questions.length;

      for (let i = 0; i < totalQuestions; i += batchNum) {
        const batch = questions.slice(i, i + batchNum);
        const currentProgress = Math.round(10 + ((i + batch.length) / totalQuestions) * 80);

        sessionProgress.set(session_id, {
          message: `✨ Solving questions ${i + 1} to ${Math.min(i + batch.length, totalQuestions)} of ${totalQuestions}...`,
          percentage: currentProgress,
          status: 'processing'
        });

        if (ai) {
          try {
            const contents: any[] = [];
            const cleanBatch = batch.map((q: any) => {
                let cleanRawText = q.raw_text || q.question || '';
                const imgMatches = [...cleanRawText.matchAll(/src="data:([^;]+);base64,([^"]+)"/g)];
                for (const match of imgMatches) {
                    contents.push({
                        inlineData: {
                            mimeType: match[1] || 'image/png',
                            data: match[2]
                        }
                    });
                }
                cleanRawText = cleanRawText.replace(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi, '[IMAGE_PROVIDED_IN_VISION_CONTEXT]').replace(/<br\s*\/?>/gi, '\n').trim();
                return { ...q, raw_text: cleanRawText, question: cleanRawText };
            });

            const prompt = solverPromptTemplate
              .replace('{subject}', subject)
              .replace('{topic}', topic)
              .replace('{questions_json}', JSON.stringify(cleanBatch))
              .replace('{latex_rules}', SHARED_LATEX_RULES);
            
            contents.unshift(prompt);

            const response = await ai.models.generateContent({
              model: selectedModel,
              contents: contents,
              config: { responseMimeType: 'application/json' }
            });
            const text = response.text || '';
            const batchSolved = safeParseJSON(text);

            if (Array.isArray(batchSolved)) {
              const restoredBatch = batchSolved.map((solvedItem, index) => {
                  let finalQuestion = solvedItem.question || batch[index].question || batch[index].raw_text || '';
                  const origText = batch[index].question || batch[index].raw_text || '';
                  const imgMatches = origText.match(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi);
                  if (imgMatches && finalQuestion) {
                      finalQuestion = finalQuestion.replace(/\[IMAGE_PROVIDED_IN_VISION_CONTEXT\]/gi, '');
                      imgMatches.forEach(img => {
                          if (!finalQuestion.includes(img)) {
                              finalQuestion += '\n' + '<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;">' + img + '</div></div>';
                          }
                      });
                  }
                  return {
                      ...solvedItem,
                      question: finalQuestion,
                      raw_text: batch[index].raw_text
                  };
              });
              solvedResults.push(...restoredBatch);
            }
          } catch (e) {
            console.warn(`Error solving batch starting at index ${i}:`, e);
          }
        }
      }

      const finalQuestions = questions.map((orig: any, idx: number) => {
        const solved = solvedResults[idx] || {};
        return {
          question: orig.raw_text || orig.question || orig.statement || `Question ${idx + 1}`,
          options: Array.isArray(solved.options) && solved.options.length > 0 ? solved.options : (Array.isArray(orig.options) ? orig.options : []),
          answer: solved.answer !== undefined ? String(solved.answer) : (orig.answer || ''),
          type: solved.type || orig.type || 'multiple_choice'
        };
      });

      const uniqueTitle = getUniqueQuizTitle(topic || 'Worksheet Quiz');
      const newQuizId = `quiz_${Date.now()}`;
      const newQuiz = {
        id: newQuizId,
        user_id: req.user ? req.user.uid : 'teacher_test',
        title: uniqueTitle,
        subject: subject || 'General',
        time_limit: parseInt(time_limit) || 20,
        quiz_mode: quiz_mode || 'back_and_forth',
        require_solution: require_solution || false,
        questions: finalQuestions,
        created_at: new Date().toISOString()
      };

      quizzes.set(newQuizId, newQuiz);
      savePersistentData();
      syncDocToFirestore('quizzes', newQuizId, newQuiz);

      sessionProgress.set(session_id, {
        message: '🚀 Quiz created! Redirecting...',
        percentage: 100,
        status: 'completed',
        quiz_id: newQuizId
      });
    } catch (err: any) {
      sessionProgress.set(session_id, {
        message: `❌ Error: ${err.message}`,
        percentage: 100,
        status: 'error',
        error: err.message
      });
    }
  })();
});

router.post('/api/extract_rmxflash', tokenRequired, upload.any(), async (req: AuthRequest, res) => {
  const { api_key, model_name = 'gemini-3.5-flash-lite', session_id = 'rmx_1' } = req.body;
  const files = (req.files as Express.Multer.File[]) || [];

  const wsFiles = getFilesByField(files, ['worksheet_files', 'files']);
  const ansFiles = getFilesByField(files, ['answer_files']);

  sessionProgress.set(session_id, { message: '⚡ Extracting RMXFlash questions...', percentage: 25, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let rmxQuestions: any[] = [];
    let goldenKey: Record<string, string> = {};

    if (ai) {
      const selectedModel = getRealModelName(model_name);

      let prompt = RMX_FLASH_EXTRACTION_PROMPT
        .replace('{latex_rules}', SHARED_LATEX_RULES)
        .replace('{prompt_additions}', 'CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].');

      const totalFiles = wsFiles.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        const f = wsFiles[fileIdx];
        sessionProgress.set(session_id, {
          message: `⚡ Extracting questions from file ${fileIdx + 1} of ${totalFiles}...`,
          percentage: Math.round(25 + (fileIdx / totalFiles) * 40),
          status: 'processing'
        });

        let contents: any[] = [
          prompt,
          {
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          }
        ];

        const response = await ai.models.generateContent({
          model: selectedModel,
          contents,
          config: { responseMimeType: 'application/json', maxOutputTokens: 8192 }
        });

        const text = response.text || '';
        const parsed = safeParseJSON(text);
        if (Array.isArray(parsed)) {
          let currentImageBuffer: Buffer | null = null;
          if (f.mimetype === 'application/pdf') {
            currentImageBuffer = await pdfPageToImage(f.buffer, 0);
          } else if (f.mimetype && f.mimetype.startsWith('image/')) {
            currentImageBuffer = f.buffer;
          }

          for (const q of parsed) {
            if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
              const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
              if (imgUri) {
                const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                q.statement = (q.statement || '') + '\n' + imgHtml;
              }
            }
          }
          rmxQuestions.push(...parsed);
        }
      }

      if (ansFiles.length > 0) {
        sessionProgress.set(session_id, { message: '⚡ Matching Golden Answer Key...', percentage: 80, status: 'processing' });
        let keyPrompt = `Extract the Golden Answer Key from these files as a JSON object where key is question number (e.g. "1") and value is answer choice letter or text.`;
        let keyContents: any[] = [keyPrompt];
        ansFiles.forEach(f => {
          keyContents.push({
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          });
        });

        const keyResp = await ai.models.generateContent({
          model: selectedModel,
          contents: keyContents,
          config: { responseMimeType: 'application/json' }
        });

        const keyText = keyResp.text || '';
        const parsedKey = safeParseJSON(keyText);
        if (parsedKey && typeof parsedKey === 'object') {
          goldenKey = parsedKey;
        }

        if (Object.keys(goldenKey).length > 0) {
          const matchPrompt = RMX_FLASH_MATCH_PROMPT
            .replace('{questions_json}', JSON.stringify(rmxQuestions))
            .replace('{golden_key}', JSON.stringify(goldenKey));

          const matchResp = await ai.models.generateContent({
            model: selectedModel,
            contents: [matchPrompt],
            config: { responseMimeType: 'application/json' }
          });

          const matchText = matchResp.text || '';
          const matched = safeParseJSON(matchText);
          if (Array.isArray(matched)) rmxQuestions = matched;
        }
      }
    }

    if (!rmxQuestions || rmxQuestions.length === 0) {
      rmxQuestions = [
        {
          identifier: 'a1B2c3D4e5F6',
          original_index: 1,
          statement: 'Sample RMX Question 1: What is $2 + 2$?',
          choices: ['A) $3$', 'B) $4$', 'C) $5$', 'D) $6$'],
          answer: 'B'
        }
      ];
    }

    sortQuestionsByIndex(rmxQuestions);

    sessionProgress.set(session_id, { message: '✅ RMXFlash extraction complete!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions: rmxQuestions });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
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

router.post('/api/extract_worksheet_with_answers', tokenRequired, upload.any(), async (req: AuthRequest, res) => {
  const { session_id = 'sess_ans_1', topic_hint = '', subject = 'General', api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  const files = (req.files as Express.Multer.File[]) || [];

  const wsFiles = getFilesByField(files, ['files', 'worksheet_files']);
  const ansFiles = getFilesByField(files, ['answer_files']);

  sessionProgress.set(session_id, { message: '📄 Processing worksheet & answer key files...', percentage: 15, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let questions: any[] = [];
    let goldenReference: Record<string, string> = {};

    if (ai) {
      const selectedModel = getRealModelName(model_name);
      const pdfFileWs = wsFiles.find(f => f.mimetype === 'application/pdf');
      const imgFileWs = wsFiles.find(f => f.mimetype && f.mimetype.startsWith('image/'));

      const extractionSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            raw_text: {
              type: Type.STRING,
              description: "The literal text transcript of the question."
            },
            options: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "The choices (e.g. ['A) 10', 'B) 20']) if multiple choice."
            },
            type: {
              type: Type.STRING,
              description: "The type: 'multiple_choice', 'multiple_choice_multi', 'identification', 'open_ended', 'graphing', 'true_false'."
            },
            original_index: {
              type: Type.STRING,
              description: "The question number/index on the worksheet."
            },
            bounding_box: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
              description: "Four normalized integers [ymin, xmin, ymax, xmax] (0 to 1000) of any diagram. Empty array [] if no diagram."
            }
          },
          required: ["raw_text", "options", "type", "original_index"]
        }
      };

      if (pdfFileWs && !imgFileWs) {
        const pageCount = getPdfPageCount(pdfFileWs.buffer);
        console.log(`[QUIZ] Processing PDF with Answers page count: ${pageCount}`);

        const chunkSize = 1;
        const totalChunks = Math.ceil(pageCount / chunkSize);

        for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
          const startPage = chunkIdx * chunkSize + 1;
          const endPage = Math.min((chunkIdx + 1) * chunkSize, pageCount);

          sessionProgress.set(session_id, {
            message: `🔍 Extracting Questions from Page ${chunkIdx + 1} of ${pageCount}...`,
            percentage: Math.round(20 + (chunkIdx / totalChunks) * 50),
            status: 'processing'
          });

          const chunkBuffer = await extractPdfPages(pdfFileWs.buffer, startPage, endPage);
          if (!chunkBuffer) continue;

          const chunkPageImage = await pdfPageToImage(pdfFileWs.buffer, startPage - 1);

          let extractionPrompt = WORKSHEET_EXTRACTION_PROMPT
            .replace('{latex_rules}', SHARED_LATEX_RULES)
            .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

          let wsContents: any[] = [
            extractionPrompt,
            {
              inlineData: { data: chunkBuffer.toString('base64'), mimeType: 'application/pdf' }
            }
          ];

          const wsResponse = await ai.models.generateContent({
            model: selectedModel,
            contents: wsContents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const wsText = wsResponse.text || '';
          const parsed = safeParseJSON(wsText);
          if (Array.isArray(parsed)) {
            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && chunkPageImage) {
                const imgUri = await cropImageBoundingBox(chunkPageImage, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      } else {
        let extractionPrompt = WORKSHEET_EXTRACTION_PROMPT
          .replace('{latex_rules}', SHARED_LATEX_RULES)
          .replace('{prompt_additions}', `Subject: ${subject}. Topic / Context: ${topic_hint}. CRITICAL: ONLY output "bounding_box" if the specific question actually contains a visual diagram, illustration, graph, chart, map, coordinate axis, or geometry drawing. For purely text or simple equations with no associated diagram, "bounding_box" MUST be an empty array [].`);

        const totalFiles = wsFiles.length;
        for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
          const f = wsFiles[fileIdx];
          sessionProgress.set(session_id, {
            message: `🤖 Extracting questions from worksheet file ${fileIdx + 1} of ${totalFiles} with Gemini AI...`,
            percentage: Math.round(30 + (fileIdx / totalFiles) * 40),
            status: 'processing'
          });

          let wsContents: any[] = [
            extractionPrompt,
            {
              inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
            }
          ];

          const wsResponse = await ai.models.generateContent({
            model: selectedModel,
            contents: wsContents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: extractionSchema,
              maxOutputTokens: 8192
            }
          });

          const wsText = wsResponse.text || '';
          const parsed = safeParseJSON(wsText);
          if (Array.isArray(parsed)) {
            let currentImageBuffer: Buffer | null = null;
            if (f.mimetype === 'application/pdf') {
              currentImageBuffer = await pdfPageToImage(f.buffer, 0);
            } else if (f.mimetype && f.mimetype.startsWith('image/')) {
              currentImageBuffer = f.buffer;
            }

            for (const q of parsed) {
              if (!q.raw_text && q.question) q.raw_text = q.question;
              if (!q.raw_text && q.statement) q.raw_text = q.statement;

              if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
                const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
                if (imgUri) {
                  const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                  q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
                }
              }
            }
            questions.push(...parsed);
          }
        }
      }

      if (ansFiles.length > 0) {
        sessionProgress.set(session_id, { message: '🔑 Extracting Golden Answer Key from answer files...', percentage: 70, status: 'processing' });
        let ansPrompt = `Extract the Golden Answer Key / Master Answers from these answer key files as a JSON key-value map.
Keys MUST be the question numbers as strings (e.g., "1", "2", "3").
Values MUST be the correct answers as strings (e.g. "A", "180 degrees", "3.14").
Return ONLY a valid JSON object map like {"1": "A", "2": "B", "3": "42"}.`;

        let ansContents: any[] = [ansPrompt];
        ansFiles.forEach(f => {
          ansContents.push({
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          });
        });

        const ansResponse = await ai.models.generateContent({
          model: selectedModel,
          contents: ansContents,
          config: { responseMimeType: 'application/json' }
        });

        const ansText = ansResponse.text || '';
        const parsedAns = safeParseJSON(ansText);
        if (parsedAns && typeof parsedAns === 'object') {
          goldenReference = parsedAns;
        }
      }
    }

    if (!questions || questions.length === 0) {
      questions = [
        {
          raw_text: '1. What is the capital of France?',
          question: 'What is the capital of France?',
          type: 'multiple_choice',
          options: ['A) Paris', 'B) London', 'C) Berlin', 'D) Madrid'],
          original_index: 1,
          answer: 'A) Paris'
        },
        {
          raw_text: '2. Solve $2x + 6 = 14$',
          question: 'Solve $2x + 6 = 14$',
          type: 'identification',
          options: [],
          original_index: 2,
          answer: '4'
        }
      ];
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

    sessionProgress.set(session_id, { message: '✅ Questions and answers extracted successfully!', percentage: 100, status: 'completed' });
    res.json({ success: true, questions, golden_reference: goldenReference, missing_indices: missingIndices });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/recover_questions', tokenRequired, upload.any(), async (req: AuthRequest, res) => {
  const { missing_numbers, topic_hint = 'General', api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  const files = (req.files as Express.Multer.File[]) || [];

  let missingNums: number[] = [];
  try {
    missingNums = typeof missing_numbers === 'string' ? JSON.parse(missing_numbers) : missing_numbers;
  } catch (e) {
    missingNums = [];
  }

  try {
    const ai = getGeminiClient(api_key);
    let recovered: any[] = [];

    if (ai && files.length > 0) {
      const selectedModel = getRealModelName(model_name);
      const prompt = RECOVERY_PROMPT
        .replace('{topic_hint}', topic_hint)
        .replace('{missing_numbers}', JSON.stringify(missingNums));

      const totalFiles = files.length;
      for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
        const f = files[fileIdx];

        let contents: any[] = [
          prompt,
          {
            inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype }
          }
        ];

        const extractionSchema = {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              raw_text: { type: Type.STRING, description: "The literal text transcript of the question." },
              options: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Choices if multiple choice." },
              type: { type: Type.STRING, description: "The type: 'multiple_choice', 'multiple_choice_multi', 'identification', 'open_ended', 'graphing', 'true_false'." },
              original_index: { type: Type.STRING, description: "The question number/index on the worksheet." },
              bounding_box: { type: Type.ARRAY, items: { type: Type.INTEGER }, description: "Four normalized integers [ymin, xmin, ymax, xmax] (0 to 1000) of any diagram. Empty array [] if no diagram." }
            },
            required: ["raw_text", "options", "type", "original_index"]
          }
        };
        const response = await ai.models.generateContent({
          model: selectedModel,
          contents,
          config: { responseMimeType: 'application/json', responseSchema: extractionSchema, maxOutputTokens: 8192 }
        });

        const text = response.text || '';
        const parsedRec = safeParseJSON(text);
        if (Array.isArray(parsedRec)) {
          let currentImageBuffer: Buffer | null = null;
          if (f.mimetype === 'application/pdf') {
            currentImageBuffer = await pdfPageToImage(f.buffer, 0);
          } else if (f.mimetype && f.mimetype.startsWith('image/')) {
            currentImageBuffer = f.buffer;
          }

          for (const q of parsedRec) {
            if (!q.raw_text && q.question) q.raw_text = q.question;
            if (!q.raw_text && q.statement) q.raw_text = q.statement;

            if (q.bounding_box && q.bounding_box.length === 4 && currentImageBuffer) {
              const imgUri = await cropImageBoundingBox(currentImageBuffer, q.bounding_box);
              if (imgUri) {
                const imgHtml = `<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;"><img src="${imgUri}" alt="Diagram"></div></div>`;
                q.raw_text = (q.raw_text || '') + '\n' + imgHtml;
              }
            }
          }
          recovered.push(...parsedRec);
        }
      }
    }

    if (!recovered || recovered.length === 0) {
      recovered = missingNums.map(num => ({
        original_index: num,
        question: `Question ${num} (Recovered)`,
        type: 'identification',
        options: [],
        answer: 'Recovered Answer'
      }));
    }

    sortQuestionsByIndex(recovered);

    res.json({ success: true, recovered });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/generate_quiz_from_extracted', tokenRequired, async (req: AuthRequest, res) => {
  const {
    questions = [],
    golden_reference = {},
    topic = 'Matched Quiz',
    subject = 'General',
    time_limit = 30,
    quiz_mode = 'back_and_forth',
    model_name = 'gemini-3.5-flash-lite',
    api_key,
    session_id = 'gen_1'
  } = req.body;

  sessionProgress.set(session_id, { message: '✨ Finalizing and polishing quiz...', percentage: 30, status: 'processing' });

  try {
    const ai = getGeminiClient(api_key);
    let finalQuestions = questions;

    if (ai && questions.length > 0) {
      try {
        sessionProgress.set(session_id, { message: '📐 Re-checking equations & answer key consistency...', percentage: 65, status: 'processing' });
        const contents: any[] = [];
        const cleanQuestions = questions.map((q: any) => {
            let cleanRawText = q.raw_text || q.question || '';
            const imgMatches = [...cleanRawText.matchAll(/src="data:([^;]+);base64,([^"]+)"/g)];
            for (const match of imgMatches) {
                contents.push({
                    inlineData: {
                        mimeType: match[1] || 'image/png',
                        data: match[2]
                    }
                });
            }
            cleanRawText = cleanRawText.replace(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi, '[IMAGE_PROVIDED_IN_VISION_CONTEXT]').replace(/<br\s*\/?>/gi, '\n').trim();
            return { ...q, raw_text: cleanRawText, question: cleanRawText };
        });

        const prompt = RECHECK_ANSWERS_PROMPT
          .replace('{golden_reference}', JSON.stringify(golden_reference))
          .replace('{batch_json}', JSON.stringify(cleanQuestions));
        
        const selectedModel = getRealModelName(model_name);
        contents.unshift(prompt);

        const response = await ai.models.generateContent({
          model: selectedModel,
          contents: contents,
          config: { responseMimeType: 'application/json' }
        });
        const text = response.text || '';
        const parsed = safeParseJSON(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          finalQuestions = parsed.map((solvedItem: any, index: number) => {
              let finalQuestion = solvedItem.question || questions[index].question || questions[index].raw_text || '';
              const origText = questions[index].question || questions[index].raw_text || '';
              const imgMatches = origText.match(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi);
              if (imgMatches && finalQuestion) {
                  finalQuestion = finalQuestion.replace(/\[IMAGE_PROVIDED_IN_VISION_CONTEXT\]/gi, '');
                  imgMatches.forEach(img => {
                      if (!finalQuestion.includes(img)) {
                          finalQuestion += '\n' + '<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;">' + img + '</div></div>';
                      }
                  });
              }
              return {
                  ...solvedItem,
                  question: finalQuestion,
                  raw_text: questions[index].raw_text
              };
          });
        }
      } catch (e) {
        console.warn('AI polish fallback:', e);
      }
    }

    sortQuestionsByIndex(finalQuestions);

    const formattedQuestions = finalQuestions.map((q: any, i: number) => ({
      question: q.question || q.raw_text || q.statement || `Question ${i + 1}`,
      options: Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : []),
      answer: q.answer !== undefined ? String(q.answer) : (q.options && q.options[0] ? q.options[0] : ''),
      type: q.type || (q.options && q.options.length > 0 ? 'multiple_choice' : 'identification')
    }));

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
    syncDocToFirestore('quizzes', newQuizId, newQuiz);

    sessionProgress.set(session_id, { message: '🚀 Quiz created! Redirecting...', percentage: 100, status: 'completed', quiz_id: newQuizId });
    res.json({ success: true, quiz_id: newQuizId });
  } catch (err: any) {
    sessionProgress.set(session_id, { message: `❌ Error: ${err.message}`, percentage: 100, status: 'error' });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/worksheet_answers', tokenRequired, (req, res) => {
  res.render('worksheet_answers_upload');
});

router.get('/worksheet_upload', tokenRequired, (req, res) => {
  res.render('worksheet_upload');
});

router.get('/worksheet/:quiz_id', tokenRequired, (req, res) => {
  const quiz = quizzes.get(req.params.quiz_id);
  if (quiz) {
    return res.render('worksheet', { quiz });
  }
  res.status(404).send('Worksheet not found');
});

export default router;
