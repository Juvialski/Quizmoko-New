import { Router } from 'express';
import { tokenRequired } from '../middleware/auth.ts';
import { quizzes, results, savePersistentData, syncDocToFirestore } from '../store/db.ts';
import { getGeminiClient, getRealModelName } from '../services/gemini.ts';

const router = Router();

function stripLatex(str: string): string {
  return str
    .replace(/\$/g, '')                 // Remove all dollar signs
    .replace(/\\dfrac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2') // Convert \dfrac{a}{b} to a/b
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2')   // Convert \frac{a}{b} to a/b
    .replace(/\\text\{([^}]+)\}/g, '$1') // Convert \text{abc} to abc
    .replace(/\\times/g, '*')            // Convert \times to *
    .replace(/\\div/g, '/')              // Convert \div to /
    .trim();
}

router.post('/api/grade_individual', tokenRequired, async (req, res) => {
  const { quiz_id, q_index, student_answer, solution_snapshots } = req.body;
  const quiz = quizzes.get(quiz_id);
  const api_key = req.body.api_key || (quiz && (quiz as any).api_key) || '';

  if (!quiz || !quiz.questions[q_index]) {
    return res.json({ success: false, is_correct: false, correct_answer: '' });
  }

  const q = quiz.questions[q_index];
  const qType = q.type || 'multiple_choice';
  const expected = (q.answer || '').toString().trim();
  const actual = (student_answer || '').toString().trim();

  let isCorrect = false;
  let aiFeedback = '';

  if (qType === 'multiple_choice' || qType === 'true_false' || qType === 'identification') {
    const expectedLower = expected.toLowerCase();
    const actualLower = actual.toLowerCase();
    const expectedCleaned = stripLatex(expectedLower);
    const actualCleaned = stripLatex(actualLower);

    if (qType === 'multiple_choice') {
      const expectedLetter = expectedCleaned.replace(/[^a-d]/gi, '')[0];
      const actualLetter = actualCleaned.replace(/[^a-d]/gi, '')[0];
      isCorrect = expectedLetter && actualLetter ? expectedLetter === actualLetter : expectedCleaned === actualCleaned;
    } else {
      const cleanExpected = expectedCleaned.replace(/[^a-z0-9.<>=+-/]/gi, '');
      const cleanActual = actualCleaned.replace(/[^a-z0-9.<>=+-/]/gi, '');
      if (cleanExpected === cleanActual && cleanExpected !== '') {
        isCorrect = true;
      } else {
        const numExpected = expectedCleaned.replace(/[^0-9.-]/g, '');
        const numActual = actualCleaned.replace(/[^0-9.-]/g, '');
        if (numExpected && numActual) {
          const floatE = parseFloat(numExpected);
          const floatA = parseFloat(numActual);
          if (!isNaN(floatE) && !isNaN(floatA) && floatE === floatA) {
            isCorrect = true;
          } else {
            isCorrect = (numExpected === numActual);
          }
        }
      }
    }
  } else {
    const expectedLower = expected.toLowerCase();
    const actualLower = actual.toLowerCase();

    if (expectedLower === actualLower || actualLower === expectedLower) {
      isCorrect = true;
      aiFeedback = 'Great work!';
    } else {
      const ai = getGeminiClient(api_key);
      if (ai) {
        try {
          const prompt = `You are an expert teacher grading a quiz.
Question Type: ${qType}
Question: "${q.question}"
Correct Answer Key: "${expected}"
Student's Response: "${actual}"

Evaluate if the student's response is correct or mathematically/semantically equivalent based on the answer key.
If it is correct, set "is_correct" to true, and optionally provide brief encouraging feedback.
If it is incorrect, set "is_correct" to false, and provide a brief 1-2 sentence explanation of why. CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, and fractions inside your feedback with LaTeX dollar signs (e.g., $x^2$, $130/10$). Do NOT use asterisks for math.
Return your response STRICTLY as a JSON object in the format: {"is_correct": boolean, "feedback": "string"}`;

          let parts: any[] = [{ text: prompt }];

          if (solution_snapshots && Array.isArray(solution_snapshots) && solution_snapshots.length > 0) {
             for (const snap of solution_snapshots) {
                 if (snap && typeof snap === 'string' && snap.startsWith('data:image/')) {
                    const base64Data = snap.split(',')[1];
                    const mimeType = snap.substring(snap.indexOf(':')+1, snap.indexOf(';'));
                    parts.push({
                       inlineData: {
                           data: base64Data,
                           mimeType: mimeType
                       }
                    });
                 }
             }
          }

          console.log(`[AI Grading] QType: ${qType}, Q: "${q.question}", Expected: "${expected}", Actual: "${actual}"`);
          const response = await ai.models.generateContent({
            model: getRealModelName('gemini-3.5-flash-lite'),
            contents: [{ role: 'user', parts }],
            config: { responseMimeType: 'application/json' }
          });
          
          const textResult = response.text ? response.text.trim() : '{}';
          console.log(`[AI Grading] Response: ${textResult}`);
          const parsed = JSON.parse(textResult);
          isCorrect = !!parsed.is_correct;
          aiFeedback = parsed.feedback || '';
        } catch (err) {
          console.error("AI individual grading error:", err);
          const numExpected = expectedLower.replace(/[^0-9.-]/g, '');
          const numActual = actualLower.replace(/[^0-9.-]/g, '');
          isCorrect = !!(numExpected && numActual && numExpected === numActual) || expectedLower === actualLower;
          aiFeedback = isCorrect ? '' : 'Incorrect based on simple match (AI grading failed).';
        }
      } else {
        const numExpected = expectedLower.replace(/[^0-9.-]/g, '');
        const numActual = actualLower.replace(/[^0-9.-]/g, '');
        if (numExpected && numActual) {
          const floatE = parseFloat(numExpected);
          const floatA = parseFloat(numActual);
          if (!isNaN(floatE) && !isNaN(floatA) && floatE === floatA) {
            isCorrect = true;
          } else {
            isCorrect = (numExpected === numActual) || expectedLower === actualLower;
          }
        } else {
          isCorrect = expectedLower === actualLower;
        }
        aiFeedback = isCorrect ? '' : 'Incorrect. (Note: AI grading is currently unavailable due to missing API key).';
      }
    }
  }

  res.json({
    success: true,
    is_correct: isCorrect,
    correct_answer: q.answer,
    score_fraction: isCorrect ? 1.0 : 0.0,
    ai_feedback: aiFeedback
  });
});

router.post(['/submit', '/api/submit_quiz'], tokenRequired, async (req, res) => {
  const { quiz_id, session_id, student_name, answers = {}, graded_details, total_score, time_active_seconds, time_paused_seconds, total_duration_seconds, accuracy_pct } = req.body;
  const quiz = quizzes.get(quiz_id);

  let finalDetails = graded_details;
  let finalScore = total_score;
  let maxScore = quiz ? quiz.questions.length : (graded_details ? graded_details.length : 1);

  if (!finalDetails && quiz) {
    finalScore = 0;
    finalDetails = [];
    quiz.questions.forEach((q: any, i: number) => {
      const userAns = answers[i] || 'No Answer';
      const expected = (q.answer || '').toString().trim().toLowerCase();
      const actual = userAns.toString().trim().toLowerCase();

      const expectedCleaned = stripLatex(expected);
      const actualCleaned = stripLatex(actual);

      let isCorrect = false;
      const qType = q.type || 'multiple_choice';
      if (qType === 'multiple_choice') {
        const expectedLetter = expectedCleaned.replace(/[^a-d]/gi, '')[0];
        const actualLetter = actualCleaned.replace(/[^a-d]/gi, '')[0];
        isCorrect = expectedLetter && actualLetter ? expectedLetter === actualLetter : expectedCleaned === actualCleaned;
      } else if (qType === 'true_false' || qType === 'identification') {
        const cleanExpected = expectedCleaned.replace(/[^a-z0-9.<>=+-/]/gi, '');
        const cleanActual = actualCleaned.replace(/[^a-z0-9.<>=+-/]/gi, '');
        if (cleanExpected === cleanActual && cleanExpected !== '') {
          isCorrect = true;
        } else {
          const numExpected = expectedCleaned.replace(/[^0-9.-]/g, '');
          const numActual = actualCleaned.replace(/[^0-9.-]/g, '');
          if (numExpected && numActual) {
            const floatE = parseFloat(numExpected);
            const floatA = parseFloat(numActual);
            if (!isNaN(floatE) && !isNaN(floatA) && floatE === floatA) {
              isCorrect = true;
            } else {
              isCorrect = (numExpected === numActual);
            }
          }
        }
      } else {
        isCorrect = expectedCleaned === actualCleaned || actualCleaned.includes(expectedCleaned);
      }

      if (isCorrect) finalScore += 1;

      finalDetails.push({
        question: q.question,
        type: qType,
        user_answer: userAns,
        correct_answer: q.answer,
        is_correct: isCorrect,
        score_fraction: isCorrect ? 1.0 : 0.0
      });
    });
  }

  const resultId = session_id ? `res_${session_id}` : `res_${Date.now()}`;
  const resultObj = {
    id: resultId,
    quiz_id: quiz_id || 'quiz_1',
    quiz_title: quiz ? quiz.title : 'Quiz Results',
    student_name: student_name || 'Anonymous',
    total_score: finalScore || 0,
    max_score: maxScore || 1,
    graded_details: finalDetails || [],
    created_at: new Date().toISOString(),
    time_active_seconds: time_active_seconds || 0,
    time_paused_seconds: time_paused_seconds || 0,
    total_duration_seconds: total_duration_seconds || 0,
    accuracy_pct: accuracy_pct || 0,
    completion_note: ''
  };

  results.set(resultId, resultObj);
  savePersistentData();
  syncDocToFirestore('results', resultId, resultObj);

  // Broadcast to results page about final submission
  const io = req.app.get('io');
  if (io) {
    io.to(`quiz_${quiz_id}`).emit('progressive_result_update', {
      result_id: resultId,
      result: resultObj
    });
  }

  res.json({
    success: true,
    result_id: resultId,
    total_score: finalScore || 0,
    max_score: maxScore || 1
  });
});

router.post('/api/save_progressive_result', tokenRequired, async (req, res) => {
  const { quiz_id, session_id, student_name, progressive_results, score, time_active_seconds, time_paused_seconds, total_duration_seconds, accuracy_pct } = req.body;
  if (!quiz_id || !session_id) {
    return res.status(400).json({ error: 'Missing quiz_id or session_id' });
  }

  const quiz = quizzes.get(quiz_id);
  const resultId = `res_${session_id}`;

  const resultObj = {
    id: resultId,
    quiz_id,
    quiz_title: quiz ? quiz.title : 'Quiz Results',
    student_name: student_name || 'Anonymous',
    total_score: score || 0,
    max_score: quiz ? quiz.questions.length : 1,
    graded_details: progressive_results || [],
    time_active_seconds: time_active_seconds || 0,
    time_paused_seconds: time_paused_seconds || 0,
    total_duration_seconds: total_duration_seconds || 0,
    accuracy_pct: accuracy_pct || 0,
    created_at: new Date().toISOString(),
    is_in_progress: true
  };

  results.set(resultId, resultObj as any);
  savePersistentData();
  syncDocToFirestore('results', resultId, resultObj as any);

  const io = req.app.get('io');
  if (io) {
    io.to(`quiz_${quiz_id}`).emit('progressive_result_update', {
      result_id: resultId,
      result: resultObj
    });
  }

  res.json({ success: true, result_id: resultId });
});

router.post('/api/explain', async (req, res) => {
  const { question, user_answer, correct_answer, api_key, model_name = 'gemini-3.5-flash-lite' } = req.body;

  const ai = getGeminiClient(api_key);

  if (ai) {
    try {
      const prompt = `Explain clearly and concisely in 2-3 sentences why the student's answer was incorrect for this quiz question and how to solve or get the correct answer.
Question: "${question}"
Student's Answer: "${user_answer}"
Correct Answer: "${correct_answer}"

CRUCIAL: You MUST enclose ALL mathematical expressions, numbers, fractions, and currency amounts inside your feedback with LaTeX dollar signs (e.g., $x^2$, $130/10$, $\$$40). Do NOT use asterisks for math. Do NOT wrap plain English words or labels in LaTeX tags.`;

      const response = await ai.models.generateContent({
        model: getRealModelName(model_name),
        contents: [prompt]
      });

      return res.json({ success: true, explanation: response.text });
    } catch (err: any) {
      console.warn('Gemini explain fallback:', err);
    }
  }

  return res.json({
    success: true,
    explanation: `The correct answer is "${correct_answer}". Your answer was "${user_answer}". Review the solution steps to verify your answer.`
  });
});

router.post('/api/reformat_answer', (req, res) => {
  const { answer } = req.body;
  res.json({ success: true, formatted: (answer || '').trim() });
});

export default router;
