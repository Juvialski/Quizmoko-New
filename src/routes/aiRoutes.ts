import { Router } from 'express';
import { quizzes, savePersistentData, syncDocToFirestore } from '../store/db.ts';
import { getGeminiClient, getRealModelName, safeParseJSON } from '../services/gemini.ts';
import {
  SHARED_LATEX_RULES,
  WORKSHEET_SOLVER_PROMPT,
  WORKSHEET_SOLVER_PROMPT_NON_MATH,
  LATEX_POLISH_PROMPT
} from '../../prompts.ts';

const router = Router();

router.post('/api/polish_questions', async (req, res) => {
  const { questions, api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;
  if (!questions || !Array.isArray(questions)) {
    return res.status(400).json({ success: false, error: 'No questions provided' });
  }
  
  try {
    const ai = getGeminiClient(api_key);
    if (!ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });

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

    const prompt = `${LATEX_POLISH_PROMPT}\n\nHere are the questions to polish. Output ONLY the JSON array containing the polished questions matching the exact schema.\n\n${JSON.stringify(cleanQuestions)}`;
    contents.unshift(prompt);

    const response = await ai.models.generateContent({
      model: getRealModelName(model_name),
      contents: contents,
      config: { responseMimeType: 'application/json' }
    });
    
    const text = response.text || '';
    const parsed = safeParseJSON(text);
    
    if (Array.isArray(parsed) && parsed.length > 0) {
      const merged = parsed.map((polishedQ: any, i: number) => {
          let finalQuestion = polishedQ.question || questions[i].question;
          const origText = questions[i].question || questions[i].raw_text || '';
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
              ...questions[i],
              ...polishedQ,
              question: polishedQ.question || questions[i].question
          };
      });
      return res.json({ success: true, questions: merged });
    } else {
      return res.status(500).json({ success: false, error: 'Failed to parse model output as array' });
    }
  } catch (err: any) {
    console.error('Polish questions error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/resolve_question', async (req, res) => {
  const { question_data, source_context, api_key, subject = 'General', topic = 'Quiz', model_name = 'gemini-3.5-flash-lite' } = req.body;
  if (!question_data) return res.status(400).json({ success: false, error: 'No question data' });

  try {
    const ai = getGeminiClient(api_key);
    if (!ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });

    const isNonMath = ['English', 'History', 'Biology', 'Social Studies'].includes(subject);
    const solverPromptTemplate = isNonMath ? WORKSHEET_SOLVER_PROMPT_NON_MATH : WORKSHEET_SOLVER_PROMPT;
    const selectedModel = getRealModelName(model_name);

    let extractedMime = null;
    let extractedB64 = null;
    const rawTextToSearch = question_data.question || (source_context ? source_context.raw_text : '');
    const imgMatch = rawTextToSearch.match(/src="data:([^;]+);base64,([^"]+)"/);
    if (imgMatch) {
        extractedMime = imgMatch[1];
        extractedB64 = imgMatch[2];
    }
    
    const cleanRawText = rawTextToSearch.replace(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi, '[IMAGE_PROVIDED_IN_VISION_CONTEXT]').replace(/<br\s*\/?>/gi, '\n').trim();

    const inputQuestion = {
        ...question_data,
        answer: "",
        options: [],
        correct_answer_letter: "",
        question: cleanRawText,
        raw_text: cleanRawText,
    };

    const prompt = solverPromptTemplate
      .replace('{subject}', subject)
      .replace('{topic}', topic)
      .replace('{questions_json}', JSON.stringify([inputQuestion]))
      .replace('{latex_rules}', SHARED_LATEX_RULES);

    const contents: any[] = [prompt];
    
    if (extractedB64) {
        contents.push({
            inlineData: {
                data: extractedB64,
                mimeType: extractedMime || 'image/png'
            }
        });
    } else if (source_context && source_context.crop_data_url) {
        const b64 = source_context.crop_data_url.split(',')[1];
        if (b64) {
            contents.push({
                inlineData: {
                    data: b64,
                    mimeType: 'image/png'
                }
            });
        }
    } else if (question_data.image_url) {
        const b64 = question_data.image_url.split(',')[1];
        if (b64) {
             contents.push({
                inlineData: {
                    data: b64,
                    mimeType: 'image/png'
                }
            });
        }
    }

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config: { responseMimeType: 'application/json' }
    });

    const text = response.text || '';
    const parsed = safeParseJSON(text);
    
    let resolvedData = null;
    if (Array.isArray(parsed) && parsed.length > 0) {
        resolvedData = parsed[0];
    } else if (parsed && typeof parsed === 'object') {
        resolvedData = parsed;
    }

    if (resolvedData) {
        let finalQuestion = resolvedData.question || question_data.question || question_data.raw_text || '';
        const origText = question_data.question || question_data.raw_text || '';
        const imgMatches = origText.match(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi);
        if (imgMatches && finalQuestion) {
            finalQuestion = finalQuestion.replace(/\[IMAGE_PROVIDED_IN_VISION_CONTEXT\]/gi, '');
            imgMatches.forEach(img => {
                if (!finalQuestion.includes(img)) {
                    finalQuestion += '\n' + '<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;">' + img + '</div></div>';
                }
            });
        }
        
        const finalResolvedQuestion = {
            ...question_data,
            ...resolvedData, 
            question: finalQuestion
        };
        return res.json({ success: true, question: finalResolvedQuestion });
    } else {
        return res.status(500).json({ success: false, error: 'Failed to parse model output' });
    }

  } catch (err: any) {
      console.error('Resolve question error:', err);
      res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/transfer_question', (req, res) => {
  const { source_quiz_id, target_quiz_id, question_index } = req.body;
  const src = quizzes.get(source_quiz_id);
  const tgt = quizzes.get(target_quiz_id);
  if (src && tgt && src.questions[question_index]) {
    tgt.questions.push(src.questions[question_index]);
    quizzes.set(target_quiz_id, tgt);
    savePersistentData();
    syncDocToFirestore('quizzes', target_quiz_id, tgt);
    return res.json({ success: true });
  }
  res.json({ success: false, error: 'Failed to transfer question' });
});

router.post('/api/bulk_import_questions', (req, res) => {
  const { quiz_id, questions } = req.body;
  const quiz = quizzes.get(quiz_id);
  if (quiz && Array.isArray(questions)) {
    quiz.questions.push(...questions);
    quizzes.set(quiz_id, quiz);
    savePersistentData();
    syncDocToFirestore('quizzes', quiz_id, quiz);
    return res.json({ success: true });
  }
  res.json({ success: false, error: 'Failed to import questions' });
});

router.post('/api/reprocess_question', async (req, res) => {
  const { question_data, source_context, target_type, api_key, subject = 'General', model_name = 'gemini-3.5-flash-lite' } = req.body;
  if (!question_data || !target_type) {
    return res.status(400).json({ success: false, error: 'Missing question_data or target_type' });
  }

  try {
    const ai = getGeminiClient(api_key);
    if (!ai) return res.status(400).json({ success: false, error: 'No valid API key provided' });

    const selectedModel = getRealModelName(model_name);

    let extractedMime = null;
    let extractedB64 = null;
    const rawTextToSearch = question_data.question || (source_context ? source_context.raw_text : '');
    const imgMatch = rawTextToSearch.match(/src="data:([^;]+);base64,([^"]+)"/);
    if (imgMatch) {
        extractedMime = imgMatch[1];
        extractedB64 = imgMatch[2];
    }
    
    const cleanRawText = rawTextToSearch.replace(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi, '[IMAGE_PROVIDED_IN_VISION_CONTEXT]').replace(/<br\s*\/?>/gi, '\n').trim();

    const inputQuestion = {
        question: cleanRawText,
        options: [],
        answer: "",
        type: target_type
    };

    const reprocessPrompt = `You are an expert educator.
Your task is to re-format, solve, and rewrite this question so that it strictly matches the Target Type.

Input Question Context:
\${JSON.stringify(inputQuestion)}

Original Source Context (if any):
\${source_context ? JSON.stringify(source_context) : 'None'}

Target Type: \${target_type}
Subject: \${subject}

CRITICAL RULES:
1. Target Type Formatting:
   - If the Target Type is 'multiple_choice', you MUST provide exactly 4 options starting with "A) ", "B) ", "C) ", "D) ", and the 'answer' field MUST be the single correct choice letter (e.g., "A", "B").
   - If the Target Type is 'multiple_choice_multi', you MUST provide at least 4 options and the 'answer' field MUST be a comma-separated list of all correct letters (e.g., "A, C" or "A, B, D").
   - If the Target Type is 'true_false', the options MUST be ["A) True", "B) False"] and the answer MUST be "A" or "B".
   - If the Target Type is 'identification', the options array MUST be empty [], and the 'answer' field MUST be a concise number, integer, decimal, comparison symbol, or a single exact word (no dollar signs in the answer field for identification).
   - If the Target Type is 'open_ended', the options array MUST be empty [], and the 'answer' field should be the correct answer or solution explanation.
2. MATH & LATEX RULES (For Math or Science subjects):
   - {latex_rules}
   - CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside the feedback/question with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\\$$40). Do NOT use asterisks for math.
   - Do NOT wrap plain English words or names (e.g. 'Right', 'Isosceles', 'John') in LaTeX tags.
3. PRESERVE IMAGES:
   - If the input question contains '[IMAGE_PROVIDED_IN_VISION_CONTEXT]', you MUST preserve '[IMAGE_PROVIDED_IN_VISION_CONTEXT]' inside your output 'question' text field exactly.
4. Return ONLY a valid JSON object matching this schema:
{
  "question": "The rewritten question text",
  "options": ["A) ...", "B) ..."],
  "answer": "The correct answer value or letter(s)",
  "type": "The target type"
}
`;

    const prompt = reprocessPrompt.replace('{latex_rules}', SHARED_LATEX_RULES);
    const contents: any[] = [prompt];
    
    if (extractedB64) {
        contents.push({
            inlineData: {
                data: extractedB64,
                mimeType: extractedMime || 'image/png'
            }
        });
    }

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config: { responseMimeType: 'application/json' }
    });

    const text = response.text || '';
    const parsed = safeParseJSON(text);

    if (parsed && typeof parsed === 'object') {
        let finalQuestion = parsed.question || question_data.question || '';
        const origText = question_data.question || '';
        const imgMatches = origText.match(/<img[^>]+src="data:image\/[^">]+"[^>]*>/gi);
        if (imgMatches && finalQuestion) {
            finalQuestion = finalQuestion.replace(/\[IMAGE_PROVIDED_IN_VISION_CONTEXT\]/gi, '');
            imgMatches.forEach(img => {
                if (!finalQuestion.includes(img)) {
                    finalQuestion += '\\n' + '<div class="resizable-image-wrapper"><div class="image-content-box" style="width: 100%;">' + img + '</div></div>';
                }
            });
        }

        const finalReprocessed = {
            ...question_data,
            ...parsed,
            question: finalQuestion
        };
        return res.json({ success: true, question: finalReprocessed });
    } else {
        return res.status(500).json({ success: false, error: 'Failed to parse model output' });
    }

  } catch (err: any) {
      console.error('Reprocess question error:', err);
      res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
