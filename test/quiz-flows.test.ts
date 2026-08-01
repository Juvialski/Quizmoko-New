import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import gradingRoutes from '../src/routes/gradingRoutes.ts';
import quizRoutes from '../src/routes/quizRoutes.ts';
import { stripStudentSuppliedAiKeys } from '../src/middleware/auth.ts';
import { liveSessions, quizzes, results, users } from '../src/store/db.ts';
import { normalizeAiLatexText } from '../src/services/latex.ts';
import { updateLiveSession } from '../src/services/socket.ts';
import {
  gradeQuestionLocally,
  normalizeGradeScore,
  normalizeQuestion,
  normalizeQuestionForStorage,
  scoreQuizDetails
} from '../src/services/grading.ts';
import {
  createAnswerDigest,
  createGradeProof,
  createSnapshotDigest,
  verifyGradeProof
} from '../src/services/gradeProof.ts';
import {
  gradeSemanticQuestion,
  normalizeSemanticModelGrade
} from '../src/services/semanticGrading.ts';
import {
  clearAttemptRevisionState,
  inspectAnswerRevision,
  observeAnswerRevision
} from '../src/services/resultSession.ts';
import {
  canUserManageApiKeys,
  getQuizCreatorApiKey
} from '../src/services/quizCreatorAi.ts';
import {
  adjudicateWorksheetSolverCandidates,
  applyGoldenAnswers,
  diagnoseGoldenCoverage,
  getWorksheetSourceId,
  indexGoldenAnswers,
  mapWorksheetAnswerToCanonical,
  mergeWorksheetRecheckByStableId,
  normalizeWorksheetSourceId,
  reconcileWorksheetPages,
  validateWorksheetQuestion,
  validateWorksheetQuizForPublication
} from '../src/services/worksheetPipeline.ts';
import {
  parseWorksheetSolverBatchOutput,
  runBoundedWorksheetModelRequest,
  solveWorksheetBatchWithConsensus,
  solveWorksheetQuestionsInBatches
} from '../src/services/worksheetSolver.ts';

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function question(overrides: Record<string, unknown> = {}) {
  return {
    question: 'Choose the correct option.',
    type: 'multiple_choice',
    options: ['A) Alpha', 'B) Beta', 'C) Gamma'],
    answer: 'B',
    points: 1,
    ...overrides
  };
}

describe('quiz creator AI-key isolation', () => {
  test('only teacher/admin profiles can supply the server-side checker key', () => {
    const creatorId = uniqueId('teacher_creator');
    const studentId = uniqueId('student_creator');
    users.set(creatorId, {
      uid: creatorId,
      email: 'teacher@example.invalid',
      name: 'Teacher',
      role: 'teacher',
      stored_custom_key: 'creator-server-key'
    });
    users.set(studentId, {
      uid: studentId,
      email: 'student@example.invalid',
      name: 'Student',
      role: 'student',
      stored_custom_key: 'student-key-must-not-be-used'
    });
    try {
      assert.equal(canUserManageApiKeys(users.get(creatorId)), true);
      assert.equal(canUserManageApiKeys(users.get(studentId)), false);
      assert.equal(getQuizCreatorApiKey({ user_id: creatorId }), 'creator-server-key');
      assert.equal(getQuizCreatorApiKey({ user_id: studentId }), '');
      const studentBody = {
        api_key: 'student-key',
        geminiApiKey: 'student-key-alias',
        answer: 'preserved'
      };
      stripStudentSuppliedAiKeys(studentBody, users.get(studentId));
      assert.deepEqual(studentBody, { answer: 'preserved' });
    } finally {
      users.delete(creatorId);
      users.delete(studentId);
    }
  });
});

describe('live score and LaTeX display safety', () => {
  test('uses the persisted weighted score instead of a browser-supplied live score', () => {
    const quizId = uniqueId('quiz_live_score');
    const sessionId = uniqueId('sess_live_score');
    quizzes.set(quizId, {
      id: quizId,
      title: 'Weighted live score',
      questions: [question({ points: 2 }), question({ points: 3 })]
    } as any);
    results.set(`res_${sessionId}`, {
      id: `res_${sessionId}`,
      quiz_id: quizId,
      session_id: sessionId,
      total_score: 4,
      max_score: 5,
      is_in_progress: true
    } as any);
    try {
      const updated = updateLiveSession(quizId, {
        session_id: sessionId,
        student_name: 'Live Student',
        score: 999,
        current_q: 2
      });
      assert.equal(updated.session?.score, 4);
      assert.equal(updated.session?.max_score, 5);
    } finally {
      quizzes.delete(quizId);
      results.delete(`res_${sessionId}`);
      liveSessions.delete(quizId);
    }
  });

  test('repairs currency and raw percentages without changing valid math', () => {
    assert.equal(
      normalizeAiLatexText('Each bag costs $13.89. The tax is 8.25%.'),
      'Each bag costs $\\text{\\$13.89}$. The tax is $8.25\\%$.'
    );
    assert.equal(
      normalizeAiLatexText('The total is $\\$$40.'),
      'The total is $\\text{\\$40}$.'
    );
    assert.equal(
      normalizeAiLatexText('Keep $15\\%$ and $x^2$ unchanged.'),
      'Keep $15\\%$ and $x^2$ unchanged.'
    );
  });
});

describe('canonical deterministic grading', () => {
  test('normalizes multiple-choice letters and exact option text', () => {
    const q = question();
    assert.equal(gradeQuestionLocally(q, 'B').isCorrect, true);
    assert.equal(gradeQuestionLocally(q, 'Beta').isCorrect, true);
    assert.equal(gradeQuestionLocally(q, 'B. Beta').isCorrect, true);
    assert.equal(gradeQuestionLocally(q, 'A').isCorrect, false);

    const invalid = gradeQuestionLocally(q, 'Z');
    assert.equal(invalid.isCorrect, false);
    assert.equal(invalid.scoreFraction, 0);
    assert.ok(invalid.errors.some(error => error.code === 'answer_out_of_range'));
  });

  test('fails closed for duplicate option ambiguity and unsupported explicit types', () => {
    const duplicate = gradeQuestionLocally(question({
      options: ['A) Same', 'B) same'],
      answer: 'Same'
    }), 'Same');
    assert.equal(duplicate.gradeStatus, 'invalid_response');
    assert.equal(duplicate.authoritative, false);
    assert.ok(duplicate.errors.some(error => error.code === 'duplicate_options'));

    const unknown = gradeQuestionLocally({
      question: 'Unsupported',
      type: 'mystery_type',
      answer: 'x'
    }, 'x');
    assert.equal(unknown.gradeStatus, 'invalid_response');
    assert.equal(unknown.authoritative, false);
  });

  test('supports validated true/false legacy forms and option mappings', () => {
    const implicit = { question: 'The sky is blue.', type: 'true_false', answer: 'T' };
    assert.equal(gradeQuestionLocally(implicit, 'True').isCorrect, true);
    assert.equal(gradeQuestionLocally(implicit, 'A').isCorrect, true);
    assert.equal(gradeQuestionLocally(implicit, 'F').isCorrect, false);
    assert.equal(gradeQuestionLocally({ ...implicit, answer: 'B' }, 'False').isCorrect, true);

    const reversed = {
      question: 'Mapped choices',
      type: 'true_false',
      options: ['A) False', 'B) True'],
      answer: 'A'
    };
    assert.equal(gradeQuestionLocally(reversed, 'False').isCorrect, true);
    assert.equal(gradeQuestionLocally(reversed, 'B').isCorrect, false);

    const malformed = gradeQuestionLocally({
      question: 'Bad mapping',
      type: 'true_false',
      options: ['A) Yes', 'B) No'],
      answer: 'A'
    }, 'A');
    assert.equal(malformed.gradeStatus, 'invalid_response');
  });

  test('grades multiple-select sets independent of order with duplicate rejection and defined partial credit', () => {
    const q = question({
      type: 'multiple_choice_multi',
      options: ['A) Alpha', 'B) Beta', 'C) Gamma'],
      answer: ['A', 'B'],
      points: 4
    });
    const exact = gradeQuestionLocally(q, ['B', 'A']);
    assert.equal(exact.isCorrect, true);
    assert.equal(exact.scoreFraction, 1);
    assert.equal(exact.earnedPoints, 4);

    const duplicate = gradeQuestionLocally(q, ['A', 'A']);
    assert.equal(duplicate.scoreFraction, 0);
    assert.ok(duplicate.errors.some(error => error.code === 'duplicate_selection'));

    const extra = gradeQuestionLocally(q, ['A', 'B', 'C']);
    assert.equal(extra.isCorrect, false);
    assert.equal(extra.scoreFraction, 0.75);
    assert.equal(extra.earnedPoints, 3);

    const mixed = gradeQuestionLocally(q, ['Alpha', 'Gamma']);
    assert.equal(mixed.scoreFraction, 0.25);
    assert.equal(mixed.earnedPoints, 1);
  });

  test('normalizes deliberate numeric identification forms without unsafe punctuation equivalence', () => {
    const id = (answer: string, extra: Record<string, unknown> = {}) => ({
      question: 'Enter the value.',
      type: 'identification',
      answer,
      ...extra
    });

    assert.equal(gradeQuestionLocally(id('-42'), '-42').isCorrect, true);
    assert.equal(gradeQuestionLocally(id('0.75'), '.75').isCorrect, true);
    assert.equal(gradeQuestionLocally(id('1,234.50'), '1234.5').isCorrect, true);
    assert.equal(gradeQuestionLocally(id('$\\dfrac{1}{2}$'), '0.5').isCorrect, true);
    assert.equal(gradeQuestionLocally(id('50%'), '50%').isCorrect, true);
    assert.equal(gradeQuestionLocally(id('0.5'), '50%').isCorrect, false);
    assert.equal(gradeQuestionLocally(id('0.5', {
      answer_policy: { allow_percentage: true, percentage_as_fraction: true }
    }), '50%').isCorrect, true);
    assert.equal(gradeQuestionLocally(id('50', {
      answer_policy: { allow_percentage: true }
    }), '50%').isCorrect, true);

    const requiresMeters = id('5', { answer_policy: { required_unit: 'm' } });
    assert.equal(gradeQuestionLocally(requiresMeters, '5').isCorrect, false);
    assert.equal(gradeQuestionLocally(requiresMeters, '5 m').isCorrect, true);
    assert.equal(gradeQuestionLocally(requiresMeters, '5 cm').isCorrect, false);
    assert.equal(gradeQuestionLocally(id('5', {
      answer_policy: { required_unit: 'm', allow_omitted_unit: true }
    }), '5').isCorrect, true);

    assert.equal(gradeQuestionLocally(id('x^2'), 'x2').gradeStatus, 'pending');
    assert.equal(gradeQuestionLocally(id("can't"), 'cant').isCorrect, false);
  });

  test('handles blank answers, aliases, canonical storage, points, and shared rounding', () => {
    const blank = gradeQuestionLocally(question({ points: 2.5 }), 'No Answer');
    assert.equal(blank.gradeStatus, 'graded');
    assert.equal(blank.scoreFraction, 0);
    assert.equal(blank.earnedPoints, 0);

    const corrected = {
      question: 'Corrected key',
      type: 'multiple_choice',
      options: ['A) Old', 'B) Correct'],
      answer: 'A',
      correct_answer: 'B',
      points: 2.5
    };
    assert.equal(gradeQuestionLocally(corrected, 'B').earnedPoints, 2.5);
    const storage = normalizeQuestionForStorage(corrected);
    assert.equal(storage.valid, true);
    if (!storage.valid) return;
    assert.equal(storage.question.answer, 'B');
    assert.equal(Object.hasOwn(storage.question, 'correct_answer'), false);
    assert.equal(Object.hasOwn(storage.question, 'correctAnswer'), false);
    assert.equal(Object.hasOwn(storage.question, 'correct_answer_letter'), false);

    const correctedConflict = normalizeQuestion({
      ...corrected,
      correctAnswer: 'A'
    });
    assert.equal(correctedConflict.valid, false);
    if (!correctedConflict.valid) {
      assert.ok(correctedConflict.errors.some(error => error.code === 'conflicting_answer_aliases'));
    }

    assert.equal(normalizeGradeScore(Number.NaN), null);
    assert.equal(normalizeGradeScore(Number.POSITIVE_INFINITY), null);
    assert.equal(normalizeGradeScore(-3), 0);
    assert.equal(normalizeGradeScore(3), 1);
    assert.equal(normalizeGradeScore(0.333333), 0.3333);

    const weightedQuestions = [
      question({ points: 3 }),
      question({ points: 2.5 })
    ];
    const summary = scoreQuizDetails(weightedQuestions, [
      { grade_status: 'graded', score_fraction: 0.333333, is_correct: true },
      { grade_status: 'graded', score_fraction: 0.75, is_correct: false }
    ] as any);
    assert.equal(summary.earned_points, 2.8749);
    assert.equal(summary.max_points, 5.5);
    assert.equal(summary.grading_complete, true);
    // Scoring follows score_fraction and cannot be contradicted by is_correct.
    assert.equal(summary.accuracy_pct, 52.2709);
  });

  test('semantic work and infrastructure failures never become authoritative academic zeroes', async () => {
    const open = {
      question: 'Explain why the theorem applies.',
      type: 'open_ended',
      answer: 'A reasoned explanation.'
    };
    const local = gradeQuestionLocally(open, 'My explanation');
    assert.equal(local.gradeStatus, 'pending');
    assert.equal(local.authoritative, false);
    assert.equal(local.requiresSemanticGrading, true);

    const algebra = gradeQuestionLocally({
      question: 'Give an equivalent expression.',
      type: 'identification',
      answer: 'x + 3'
    }, '3+x');
    assert.equal(algebra.gradeStatus, 'pending');
    assert.equal(algebra.authoritative, false);

    const unavailable = await gradeSemanticQuestion({
      clients: [],
      question: open,
      studentAnswer: 'My explanation'
    });
    assert.equal(unavailable.gradeStatus, 'retryable_error');
    assert.equal(unavailable.retryable, true);
    assert.equal(unavailable.scoreFraction, undefined);
    assert.equal(unavailable.isCorrect, undefined);

    const contradictory = normalizeSemanticModelGrade({
      is_correct: true,
      score_fraction: 0.5,
      feedback: 'Half correct.'
    });
    assert.equal(contradictory.gradeStatus, 'graded');
    assert.equal(contradictory.scoreFraction, 0.5);
    assert.equal(contradictory.isCorrect, false);
    assert.equal(normalizeSemanticModelGrade({
      is_correct: true,
      score_fraction: Number.NaN,
      feedback: 'Invalid.'
    }).gradeStatus, 'invalid_response');
  });

  test('mocked semantic responses derive correctness from score and fail closed on missing fields', async () => {
    const open = {
      question: 'Explain why the conclusion follows.',
      type: 'open_ended',
      answer: 'A supported explanation.'
    };
    const clientReturning = (payload: unknown) => ({
      models: {
        generateContent: async (request: any) => {
          assert.deepEqual(request.config.responseSchema.required, ['score_fraction', 'feedback']);
          return { text: JSON.stringify(payload) };
        }
      }
    });

    const contradictory = await gradeSemanticQuestion({
      clients: [clientReturning({
        is_correct: true,
        score_fraction: 0.25,
        feedback: 'Only part of the reasoning is supported.'
      })],
      question: open,
      studentAnswer: 'A partial explanation.',
      maxModelAttempts: 1
    });
    assert.equal(contradictory.gradeStatus, 'graded');
    assert.equal(contradictory.scoreFraction, 0.25);
    assert.equal(contradictory.isCorrect, false);

    let retryCalls = 0;
    const retryingClient = {
      models: {
        generateContent: async () => {
          retryCalls += 1;
          if (retryCalls === 1) throw new Error('temporary transport failure');
          return {
            text: JSON.stringify({
              score_fraction: 0.75,
              feedback: 'The retry produced an authoritative partial-credit grade.'
            })
          };
        }
      }
    };
    const recovered = await gradeSemanticQuestion({
      clients: [retryingClient],
      question: open,
      studentAnswer: 'A mostly supported explanation.',
      maxModelAttempts: 2
    });
    assert.equal(retryCalls, 2);
    assert.equal(recovered.gradeStatus, 'graded');
    assert.equal(recovered.scoreFraction, 0.75);
    assert.equal(recovered.isCorrect, false);

    for (const invalidPayload of [
      { is_correct: false, feedback: 'Missing score.' },
      { is_correct: false, score_fraction: 0 },
      { is_correct: false, score_fraction: '0', feedback: 'Wrong score type.' }
    ]) {
      const invalid = await gradeSemanticQuestion({
        clients: [clientReturning(invalidPayload)],
        question: open,
        studentAnswer: 'An unsupported explanation.',
        maxModelAttempts: 1
      });
      assert.equal(invalid.gradeStatus, 'invalid_response');
      assert.equal(invalid.retryable, false);
      assert.equal(invalid.scoreFraction, undefined);
      assert.equal(invalid.isCorrect, undefined);
    }
  });
});

describe('grade proof v2 security identity', () => {
  const quizId = 'quiz_proof_security';
  const sessionId = 'sess_proof_security';
  const answer = 'A supported explanation';
  const snapshots = ['data:image/png;base64,AAAA'];
  const q = {
    id: 'proof-question',
    question: 'Explain the result.',
    type: 'open_ended',
    answer: 'A supported explanation',
    points: 3
  };

  function proof(overrides: Record<string, unknown> = {}): string {
    return createGradeProof({
      quizId,
      sessionId,
      questionIndex: 0,
      answerRevision: 7,
      question: q,
      studentAnswer: answer,
      solutionSnapshots: snapshots,
      gradeStatus: 'graded',
      scoreFraction: 0.5,
      isCorrect: true,
      feedback: 'Signed server feedback.',
      ...overrides
    });
  }

  function expected(overrides: Record<string, unknown> = {}) {
    return {
      quizId,
      sessionId,
      questionIndex: 0,
      answerRevision: 7,
      question: q,
      studentAnswer: answer,
      solutionSnapshots: snapshots,
      ...overrides
    };
  }

  test('verifies only the exact signed attempt and derives correctness from score', () => {
    const token = proof();
    const verified = verifyGradeProof(token, expected());
    assert.ok(verified);
    assert.equal(verified.scoreFraction, 0.5);
    assert.equal(verified.isCorrect, false);
    assert.equal(verified.feedback, 'Signed server feedback.');
    assert.equal(verified.answer_revision, 7);
    assert.equal(verified.snapshot_digest, createSnapshotDigest(snapshots));
  });

  test('rejects quiz, session, question index, question, answer, revision, and snapshot mismatches', () => {
    const token = proof();
    assert.equal(verifyGradeProof(token, expected({ quizId: 'quiz_other' })), null);
    assert.equal(verifyGradeProof(token, expected({ sessionId: 'sess_other' })), null);
    assert.equal(verifyGradeProof(token, expected({ questionIndex: 1 })), null);
    assert.equal(verifyGradeProof(token, expected({ question: { ...q, question: 'Changed prompt.' } })), null);
    assert.equal(verifyGradeProof(token, expected({ studentAnswer: 'Different answer' })), null);
    assert.equal(verifyGradeProof(token, expected({ answerRevision: 8 })), null);
    assert.equal(verifyGradeProof(token, expected({ solutionSnapshots: [] })), null);
  });

  test('rejects expired, malformed, tampered, and non-graded proofs', () => {
    const now = Date.now();
    const expired = proof({ issuedAt: now - 10_000, expiresAt: now - 1_000 });
    assert.equal(verifyGradeProof(expired, expected()), null);
    assert.equal(verifyGradeProof('not-a-proof', expected()), null);
    assert.equal(verifyGradeProof('qmg2.bad.bad', expected()), null);

    const token = proof();
    const pieces = token.split('.');
    const tampered = `${pieces[0]}.${pieces[1]}A.${pieces[2]}`;
    assert.equal(verifyGradeProof(tampered, expected()), null);
    assert.throws(() => createGradeProof({
      quizId,
      sessionId,
      questionIndex: 0,
      answerRevision: 7,
      question: q,
      studentAnswer: answer,
      solutionSnapshots: snapshots,
      gradeStatus: 'pending',
      scoreFraction: 0
    }), /Only authoritative graded results/);
  });
});

describe('result-session revision identity', () => {
  test('allows an exact idempotent identity but rejects equal revisions with changed digests', () => {
    const quizId = uniqueId('quiz_revision_identity');
    const sessionId = uniqueId('sess_revision_identity');
    const base = {
      quizId,
      sessionId,
      questionIndex: 0,
      answerRevision: 4,
      persistedRevision: 4,
      answerDigest: createAnswerDigest('Answer B'),
      snapshotDigest: createSnapshotDigest(['data:image/png;base64,AAAA'])
    };

    try {
      const first = observeAnswerRevision(base);
      assert.deepEqual(first, { accepted: true, currentRevision: 4 });

      const exactRetry = observeAnswerRevision(base);
      assert.deepEqual(exactRetry, { accepted: true, currentRevision: 4 });

      const changedAnswer = inspectAnswerRevision({
        ...base,
        answerDigest: createAnswerDigest('Different answer')
      });
      assert.deepEqual(changedAnswer, {
        accepted: false,
        currentRevision: 4,
        identityConflict: true
      });

      const changedSnapshot = inspectAnswerRevision({
        ...base,
        snapshotDigest: createSnapshotDigest(['data:image/png;base64,BBBB'])
      });
      assert.deepEqual(changedSnapshot, {
        accepted: false,
        currentRevision: 4,
        identityConflict: true
      });
    } finally {
      clearAttemptRevisionState(quizId, sessionId);
    }
  });
});

describe('authoritative grading HTTP flow', () => {
  let server: Server;
  let baseUrl = '';
  const cleanupQuizIds = new Set<string>();
  const cleanupResultIds = new Set<string>();

  before(async () => {
    const app = express();
    // Keep the harness above the route's own 10 MB snapshot ceiling so tests
    // reach the grading validator instead of being intercepted by body parsing.
    app.use(express.json({ limit: '14mb' }));
    app.set('io', { to: () => ({ emit: () => undefined }) });
    app.use(quizRoutes);
    app.use(gradingRoutes);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const id of cleanupResultIds) results.delete(id);
    for (const id of cleanupQuizIds) quizzes.delete(id);
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  async function post(path: string, body: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as any;
    return { response, payload };
  }

  test('public quiz payload removes answer keys and teacher-only worksheet metadata', async () => {
    const quizId = uniqueId('quiz_public');
    cleanupQuizIds.add(quizId);
    quizzes.set(quizId, {
      id: quizId,
      title: 'Public sanitizer test',
      answer_key: { 1: 'B' },
      worksheet_validation: { hidden: true },
      questions: [{
        question: 'Public question',
        type: 'multiple_choice',
        options: ['A) No', 'B) Yes'],
        answer: 'B',
        correct_answer: 'B',
        solution: 'Hidden solution',
        golden_answer: 'B',
        source: { original_index: '11a' },
        verification: {
          answer_source: 'golden_key',
          verification_status: 'verified',
          solver_answer: 'A'
        }
      }]
    } as any);

    const response = await fetch(`${baseUrl}/api/quiz/${quizId}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(Object.hasOwn(payload, 'answer_key'), false);
    assert.equal(Object.hasOwn(payload, 'worksheet_validation'), false);
    const publicQuestion = payload.questions[0];
    for (const field of ['answer', 'correct_answer', 'solution', 'golden_answer', 'source', 'verification']) {
      assert.equal(Object.hasOwn(publicQuestion, field), false, `public question leaked ${field}`);
    }
  });

  test('newer individual grade remains authoritative when an older revision arrives afterward', async () => {
    const quizId = uniqueId('quiz_grade_order');
    const sessionId = uniqueId('sess_grade_order');
    const resultId = `res_${sessionId}`;
    cleanupQuizIds.add(quizId);
    cleanupResultIds.add(resultId);
    quizzes.set(quizId, {
      id: quizId,
      title: 'Individual grade ordering',
      quiz_mode: 'sequential',
      questions: [question({ points: 2 })]
    } as any);

    const gradeRequest = (studentAnswer: string, answerRevision: number) => ({
      quiz_id: quizId,
      session_id: sessionId,
      student_name: 'Ordering Student',
      question_index: 0,
      student_answer: studentAnswer,
      solution_snapshots: [],
      answer_revision: answerRevision,
      answer_digest: createAnswerDigest(studentAnswer),
      snapshot_digest: createSnapshotDigest([])
    });

    try {
      const newerB = await post('/api/grade_individual', gradeRequest('B', 2));
      assert.equal(newerB.response.status, 200, JSON.stringify(newerB.payload));
      assert.equal(newerB.payload.grade_status, 'graded');
      assert.equal(newerB.payload.answer_revision, 2);
      assert.equal(newerB.payload.score_fraction, 1);

      const staleA = await post('/api/grade_individual', gradeRequest('A', 1));
      assert.equal(staleA.response.status, 409);
      assert.equal(staleA.payload.stale, true);
      assert.equal(staleA.payload.current_revision, 2);

      const stored = results.get(resultId) as any;
      assert.equal(stored.answers['0'], 'B');
      assert.equal(stored.answer_revisions['0'], 2);
      assert.equal(stored.graded_details[0].user_answer, 'B');
      assert.equal(stored.graded_details[0].score_fraction, 1);
      assert.equal(stored.total_score, 2);
    } finally {
      clearAttemptRevisionState(quizId, sessionId);
    }
  });

  test('invalid and oversized snapshots are rejected without producing an academic zero', async () => {
    const quizId = uniqueId('quiz_snapshot_rejection');
    cleanupQuizIds.add(quizId);
    quizzes.set(quizId, {
      id: quizId,
      title: 'Snapshot validation',
      questions: [{
        question: 'Graph the requested relationship.',
        type: 'graphing',
        answer: 'A correctly drawn graph.',
        points: 3
      }]
    } as any);

    const assertRejected = async (sessionId: string, snapshots: string[]) => {
      const resultId = `res_${sessionId}`;
      cleanupResultIds.add(resultId);
      const rejected = await post('/api/grade_individual', {
        quiz_id: quizId,
        session_id: sessionId,
        student_name: 'Snapshot Student',
        question_index: 0,
        student_answer: '',
        solution_snapshots: snapshots,
        answer_revision: 1
      });
      assert.equal(rejected.response.status, 413, JSON.stringify(rejected.payload));
      assert.equal(rejected.payload.grade_status, 'invalid_response');
      assert.equal(rejected.payload.retryable, false);
      assert.equal(Object.hasOwn(rejected.payload, 'score_fraction'), false);
      assert.equal(results.has(resultId), false);
    };

    const invalidSession = uniqueId('sess_invalid_snapshot');
    await assertRejected(invalidSession, ['data:text/plain;base64,AAAA']);

    const oversizedSession = uniqueId('sess_oversized_snapshot');
    const oversizedSnapshot = `data:image/png;base64,${'A'.repeat(10 * 1024 * 1024 + 1)}`;
    await assertRejected(oversizedSession, [oversizedSnapshot]);
  });

  test('graphing progressive save and secure load preserve snapshot and answer revision', async () => {
    const quizId = uniqueId('quiz_graph_restore');
    const sessionId = uniqueId('sess_graph_restore');
    const resultId = `res_${sessionId}`;
    cleanupQuizIds.add(quizId);
    cleanupResultIds.add(resultId);
    quizzes.set(quizId, {
      id: quizId,
      title: 'Graph restore',
      questions: [{
        question: 'Graph a line through the origin.',
        type: 'graphing',
        answer: 'A line through the origin.',
        points: 2
      }]
    } as any);
    const snapshot = 'data:image/png;base64,AAAA';
    const answer = '';
    const answerRevision = 7;

    try {
      const saved = await post('/api/save_progressive_result', {
        quiz_id: quizId,
        session_id: sessionId,
        student_name: 'Graph Student',
        session_revision: 3,
        answers: { 0: answer },
        answer_revisions: { 0: answerRevision },
        answer_digests: { 0: createAnswerDigest(answer) },
        snapshot_digests: { 0: createSnapshotDigest([snapshot]) },
        solution_snapshots: { 0: [snapshot] },
        progressive_results: []
      });
      assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
      assert.equal(saved.payload.session_revision, 3);

      const loaded = await post('/api/load_progressive_result', {
        quiz_id: quizId,
        session_id: sessionId
      });
      assert.equal(loaded.response.status, 200, JSON.stringify(loaded.payload));
      assert.equal(loaded.payload.finalized, false);
      assert.equal(loaded.payload.session_revision, 3);
      assert.equal(loaded.payload.answer_revisions['0'], answerRevision);
      assert.deepEqual(loaded.payload.solution_snapshots['0'], [snapshot]);
      assert.equal(loaded.payload.progressive_results[0].answer_revision, answerRevision);
      assert.equal(loaded.payload.progressive_results[0].snapshot_digest, createSnapshotDigest([snapshot]));
    } finally {
      clearAttemptRevisionState(quizId, sessionId);
    }
  });

  test('malformed canonical answer containers are rejected instead of becoming blank grades', async () => {
    const quizId = uniqueId('quiz_malformed_attempt');
    const sessionId = uniqueId('sess_malformed_attempt');
    const resultId = `res_${sessionId}`;
    cleanupQuizIds.add(quizId);
    cleanupResultIds.add(resultId);
    quizzes.set(quizId, {
      id: quizId,
      title: 'Malformed attempt payload',
      questions: [question({ points: 2 })]
    } as any);

    const malformed = await post('/submit', {
      quiz_id: quizId,
      session_id: sessionId,
      session_revision: 1,
      answers: [],
      answer_revisions: 'not-a-map',
      graded_details: [{ is_correct: true, score_fraction: 1 }]
    });
    assert.equal(malformed.response.status, 409);
    assert.equal(malformed.payload.grading_incomplete, true);
    assert.match(malformed.payload.details.join(' '), /answers must be an object/i);
    assert.match(malformed.payload.details.join(' '), /answer_revisions must be an object/i);
    assert.equal(results.has(resultId), false);
  });

  test('semantic infrastructure failure keeps final submission retryable and in progress', async () => {
    const quizId = uniqueId('quiz_semantic_incomplete');
    const sessionId = uniqueId('sess_semantic_incomplete');
    const resultId = `res_${sessionId}`;
    cleanupQuizIds.add(quizId);
    cleanupResultIds.add(resultId);
    quizzes.set(quizId, {
      id: quizId,
      title: 'Semantic incomplete grading',
      questions: [{
        question: 'Explain the evidence for the conclusion.',
        type: 'open_ended',
        answer: 'A reasoned explanation.',
        points: 3
      }]
    } as any);

    try {
      const individual = await post('/api/grade_individual', {
        quiz_id: quizId,
        session_id: sessionId,
        student_name: 'Semantic Student',
        question_index: 0,
        student_answer: 'My explanation.',
        answer_revision: 1,
        api_key: 'student-controlled-key-must-be-ignored'
      });
      assert.equal(individual.response.status, 503, JSON.stringify(individual.payload));
      assert.equal(individual.payload.grade_status, 'retryable_error');

      const incomplete = await post('/submit', {
        quiz_id: quizId,
        session_id: sessionId,
        student_name: 'Semantic Student',
        session_revision: 1,
        answers: { 0: 'My explanation.' },
        answer_revisions: { 0: 1 },
        graded_details: []
      });
      assert.equal(incomplete.response.status, 503, JSON.stringify(incomplete.payload));
      assert.equal(incomplete.payload.success, false);
      assert.equal(incomplete.payload.grading_incomplete, true);
      assert.equal(incomplete.payload.retryable, true);
      assert.equal(incomplete.payload.incomplete_questions[0].grade_status, 'retryable_error');

      const stored = results.get(resultId) as any;
      assert.equal(stored.is_in_progress, true);
      assert.equal(stored.finalized_at, undefined);
      assert.equal(stored.graded_details[0].grade_status, 'retryable_error');
      assert.equal(stored.graded_details[0].score_fraction, undefined);
      assert.equal(stored.graded_details[0].is_correct, undefined);
    } finally {
      clearAttemptRevisionState(quizId, sessionId);
    }
  });

  test('latest answers win, forged grade fields are ignored, and finalization is idempotent', async () => {
    const quizId = uniqueId('quiz_authority');
    const sessionId = uniqueId('sess_authority');
    const resultId = `res_${sessionId}`;
    cleanupQuizIds.add(quizId);
    cleanupResultIds.add(resultId);
    const quiz = {
      id: quizId,
      title: 'Authority and weighted score',
      quiz_mode: 'sequential',
      questions: [
        {
          question: 'Pick Beta.',
          type: 'multiple_choice',
          options: ['A) Alpha', 'B) Beta'],
          answer: 'A',
          correct_answer: 'B',
          points: 2
        },
        {
          question: 'Enter the signed integer.',
          type: 'identification',
          answer: '-42',
          points: 1.5
        },
        {
          question: 'Select Alpha and Beta.',
          type: 'multiple_choice_multi',
          options: ['A) Alpha', 'B) Beta', 'C) Gamma'],
          answer: ['A', 'B'],
          points: 4
        },
        {
          question: 'This statement is false.',
          type: 'true_false',
          answer: 'F',
          points: 0.5
        }
      ]
    };
    quizzes.set(quizId, quiz as any);

    const answers = { 0: 'B', 1: '-42', 2: ['A', 'C'], 3: 'A' };
    const forgedDetails = quiz.questions.map((_q, index) => ({
      question_index: index,
      user_answer: index === 0 ? 'A' : 'stale answer',
      correct_answer: 'FORGED KEY',
      is_correct: true,
      score_fraction: 1,
      earned_points: 999,
      ai_feedback: '<script>forged feedback</script>',
      feedback: 'forged feedback',
      grade_proof: 'qmg2.forged.forged'
    }));
    const submission = {
      quiz_id: quizId,
      session_id: sessionId,
      student_name: 'Integrity Student',
      answers,
      answer_revisions: { 0: 4, 1: 3, 2: 6, 3: 2 },
      graded_details: forgedDetails,
      total_score: 999,
      max_score: 999,
      accuracy_pct: 100,
      session_revision: 9
    };

    const first = await post('/submit', submission);
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.success, true);
    assert.equal(first.payload.idempotent, false);
    assert.equal(first.payload.result_id, resultId);
    assert.equal(first.payload.total_score, 4.5);
    assert.equal(first.payload.max_score, 8);
    assert.equal(first.payload.accuracy_pct, 56.25);

    const details = first.payload.graded_details;
    assert.deepEqual(details.map((detail: any) => detail.user_answer), ['B', '-42', ['A', 'C'], 'A']);
    assert.deepEqual(details.map((detail: any) => detail.score_fraction), [1, 1, 0.25, 0]);
    assert.deepEqual(details.map((detail: any) => detail.earned_points), [2, 1.5, 1, 0]);
    assert.deepEqual(details.map((detail: any) => detail.is_correct), [true, true, false, false]);
    assert.ok(details.every((detail: any) => detail.grade_status === 'graded'));
    assert.ok(details.every((detail: any) => detail.ai_feedback === ''));
    assert.equal(details[0].correct_answer, 'B');
    assert.notEqual(details[0].correct_answer, 'FORGED KEY');
    assert.equal(details.reduce((sum: number, detail: any) => sum + detail.earned_points, 0), first.payload.total_score);

    const stored = results.get(resultId) as any;
    assert.ok(stored);
    assert.equal(stored.is_in_progress, false);
    assert.equal(stored.total_score, 4.5);
    assert.equal(stored.max_score, 8);
    assert.deepEqual(stored.answers, { '0': 'B', '1': '-42', '2': ['A', 'C'], '3': 'A' });
    assert.deepEqual(stored.graded_details, details);
    const finalizedSnapshot = JSON.parse(JSON.stringify(stored));

    const repeated = await post('/api/submit_quiz', {
      ...submission,
      answers: { 0: 'A', 1: '0', 2: ['C'], 3: 'False' },
      answer_revisions: { 0: 100, 1: 100, 2: 100, 3: 100 },
      total_score: 0
    });
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.payload.idempotent, true);
    assert.equal(repeated.payload.result_id, resultId);
    assert.equal(repeated.payload.total_score, 4.5);
    assert.deepEqual(results.get(resultId), finalizedSnapshot);

    const delayedProgress = await post('/api/save_progressive_result', {
      quiz_id: quizId,
      session_id: sessionId,
      student_name: 'Tampered Student',
      session_revision: 999,
      answers: { 0: 'A', 1: '0', 2: ['C'], 3: 'False' },
      answer_revisions: { 0: 999, 1: 999, 2: 999, 3: 999 },
      progressive_results: forgedDetails
    });
    assert.equal(delayedProgress.response.status, 200);
    assert.equal(delayedProgress.payload.ignored, true);
    assert.equal(delayedProgress.payload.finalized, true);
    assert.deepEqual(results.get(resultId), finalizedSnapshot);
  });

  test('stale progressive session revisions cannot overwrite newer answers', async () => {
    const quizId = uniqueId('quiz_progress');
    const sessionId = uniqueId('sess_progress');
    const resultId = `res_${sessionId}`;
    cleanupQuizIds.add(quizId);
    cleanupResultIds.add(resultId);
    quizzes.set(quizId, {
      id: quizId,
      title: 'Progress ordering',
      questions: [question({ points: 2 })]
    } as any);

    const newer = await post('/api/save_progressive_result', {
      quiz_id: quizId,
      session_id: sessionId,
      student_name: 'Progress Student',
      session_revision: 2,
      answers: { 0: 'B' },
      answer_revisions: { 0: 2 },
      progressive_results: [{ user_answer: 'B', is_correct: false, score_fraction: 0 }]
    });
    assert.equal(newer.response.status, 200);
    assert.equal(newer.payload.total_score, 2);

    const stale = await post('/api/save_progressive_result', {
      quiz_id: quizId,
      session_id: sessionId,
      student_name: 'Progress Student',
      session_revision: 1,
      answers: { 0: 'A' },
      answer_revisions: { 0: 1 },
      progressive_results: [{ user_answer: 'A', is_correct: true, score_fraction: 1 }]
    });
    assert.equal(stale.response.status, 200);
    assert.equal(stale.payload.ignored, true);
    assert.equal(stale.payload.stale, true);
    const stored = results.get(resultId) as any;
    assert.equal(stored.answers['0'], 'B');
    assert.equal(stored.answer_revisions['0'], 2);
    assert.equal(stored.total_score, 2);

    const staleFinal = await post('/submit', {
      quiz_id: quizId,
      session_id: sessionId,
      student_name: 'Progress Student',
      session_revision: 1,
      answers: { 0: 'B' },
      answer_revisions: { 0: 2 },
      graded_details: []
    });
    assert.equal(staleFinal.response.status, 409);
    assert.equal(staleFinal.payload.stale, true);
    assert.equal(staleFinal.payload.current_session_revision, 2);
    assert.equal((results.get(resultId) as any).is_in_progress, true);
  });
});

function worksheetQuestion(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: sourceId,
    source_id: sourceId,
    original_index: sourceId,
    source: {
      source_file: 'worksheet.pdf',
      page_number: 1,
      original_index: sourceId,
      crop_or_image_reference: `crop-${sourceId}`
    },
    question: `Worksheet question ${sourceId}`,
    type: 'multiple_choice',
    options: ['A) Alpha', 'B) Beta', 'C) Gamma'],
    answer: 'A',
    points: 1,
    solution: 'A concise worked solution.',
    verification: {
      answer_source: 'solver_consensus',
      verification_status: 'verified',
      reason: 'Independent solvers agreed.',
      solver_models: ['solver-a', 'solver-b']
    },
    worksheet_qa: {
      solver_candidates: [
        { model: 'solver-a', status: 'fulfilled', answer: 'A' },
        { model: 'solver-b', status: 'fulfilled', answer: 'A' }
      ]
    },
    ...overrides
  };
}

describe('worksheet golden-key identity and authority', () => {
  test('preserves exact source IDs including 01, 11a, and 11b', () => {
    assert.equal(normalizeWorksheetSourceId(' 01 '), '01');
    assert.equal(normalizeWorksheetSourceId('11a'), '11a');
    assert.equal(normalizeWorksheetSourceId('11b'), '11b');
    assert.notEqual(normalizeWorksheetSourceId('11a'), normalizeWorksheetSourceId('11b'));

    const questions = [worksheetQuestion('01'), worksheetQuestion('11a'), worksheetQuestion('11b')];
    assert.deepEqual(questions.map(getWorksheetSourceId), ['01', '11a', '11b']);
    const coverage = diagnoseGoldenCoverage(questions, {
      '01': 'A',
      '11a': 'B',
      '11b': 'C'
    });
    assert.deepEqual(coverage.question_ids, ['01', '11a', '11b']);
    assert.equal(coverage.diagnostics.length, 0);
  });

  test('maps golden option text to exactly one canonical letter and preserves it as authority', () => {
    const noExistingAnswer = worksheetQuestion('11a');
    delete (noExistingAnswer as any).answer;
    const applied = applyGoldenAnswers([noExistingAnswer], { '11a': 'Beta' });
    assert.equal(applied.diagnostics.length, 0);
    assert.equal(applied.questions[0].answer, 'B');
    assert.deepEqual(applied.questions[0].verification, {
      answer_source: 'golden_key',
      verification_status: 'verified',
      reason: 'Answer mapped deterministically from the golden key.'
    });
    assert.equal((applied.questions[0].worksheet_qa as any).golden_answer, 'B');

    const conflict = applyGoldenAnswers([worksheetQuestion('11b', { answer: 'A' })], { '11b': 'Gamma' });
    assert.equal(conflict.questions[0].answer, 'C');
    assert.equal((conflict.questions[0].verification as any).answer_source, 'golden_key');
    assert.equal((conflict.questions[0].verification as any).verification_status, 'review_required');
    assert.ok(conflict.diagnostics.some(item => item.code === 'review_required' && item.source_id === '11b'));
    assert.equal((conflict.questions[0].worksheet_qa as any).golden_answer, 'C');
    assert.deepEqual((conflict.questions[0].worksheet_qa as any).solver_candidates[0].answer, 'A');
  });

  test('rejects ambiguous golden text instead of silently choosing a duplicate option', () => {
    const ambiguous = worksheetQuestion('ambiguous', {
      options: ['A) Same', 'B) same'],
      answer: ''
    });
    const applied = applyGoldenAnswers([ambiguous], { ambiguous: 'Same' });
    assert.equal(applied.questions[0].answer, '');
    assert.ok(applied.diagnostics.some(item =>
      item.source_id === 'ambiguous'
      && ['ambiguous_option_answer', 'invalid_golden_answer', 'duplicate_option'].includes(item.code)
    ));
    const publication = validateWorksheetQuizForPublication(applied.questions, {
      require_verification: true,
      prior_diagnostics: applied.diagnostics
    });
    assert.equal(publication.valid, false);
  });

  test('reports duplicate question/key IDs plus missing and unmatched golden entries', () => {
    const questions = [
      worksheetQuestion('11a'),
      worksheetQuestion('11a', { question: 'Duplicate source question' }),
      worksheetQuestion('11b')
    ];
    const golden = [
      { source_id: '11a', answer: 'A' },
      { source_id: '11a', answer: 'B' },
      { source_id: 'orphan', answer: 'C' }
    ];
    const indexed = indexGoldenAnswers(golden);
    assert.ok(indexed.diagnostics.some(item => item.code === 'duplicate_golden_id' && item.source_id === '11a'));

    const coverage = diagnoseGoldenCoverage(questions, golden);
    assert.ok(coverage.diagnostics.some(item => item.code === 'duplicate_source_id' && item.source_id === '11a'));
    assert.ok(coverage.diagnostics.some(item => item.code === 'missing_golden_id' && item.source_id === '11b'));
    assert.ok(coverage.diagnostics.some(item => item.code === 'unmatched_golden_id' && item.source_id === 'orphan'));
    assert.ok(coverage.diagnostics.some(item => item.code === 'duplicate_golden_id' && item.source_id === '11a'));
  });
});

describe('worksheet independent solver/checker consensus', () => {
  const base = worksheetQuestion('solver-1', { answer: '' });
  const candidate = (model: string, answer: unknown, extra: Record<string, unknown> = {}) => ({
    model,
    status: 'fulfilled' as const,
    output: { answer, type: 'multiple_choice', solution: `${model} solution`, ...extra }
  });

  test('publishes only normalized independent agreement', () => {
    const consensus = adjudicateWorksheetSolverCandidates(base, [
      candidate('solver-a', 'B'),
      candidate('solver-b', 'Beta')
    ]);
    assert.equal(consensus.publishable, true);
    assert.equal(consensus.question.answer, 'B');
    assert.equal(consensus.verification.answer_source, 'solver_consensus');
    assert.equal(consensus.verification.verification_status, 'verified');
    assert.deepEqual(consensus.verification.solver_models, ['solver-a', 'solver-b']);
  });

  test('marks solver infrastructure failure or invalid coverage for teacher review', () => {
    const failure = adjudicateWorksheetSolverCandidates(base, [
      candidate('solver-a', 'B'),
      { model: 'solver-b', status: 'failed', error: 'service unavailable' }
    ]);
    assert.equal(failure.publishable, false);
    assert.equal(failure.verification.verification_status, 'review_required');
    assert.ok(failure.diagnostics.some(item => item.code === 'solver_failure'));
    assert.equal(failure.worksheet_qa.solver_candidates?.[1].status, 'failed');

    const malformed = adjudicateWorksheetSolverCandidates(base, [
      candidate('solver-a', 'B'),
      candidate('solver-b', 'B', { type: 'unsupported_type' })
    ]);
    assert.equal(malformed.publishable, false);
    assert.ok(malformed.diagnostics.some(item => item.code === 'unsupported_question_type'));
    assert.ok(malformed.diagnostics.some(item => item.code === 'solver_failure'));
  });

  test('does not accept disagreement when checker is absent, failed, or false without a correction', () => {
    const candidates = [candidate('solver-a', 'A'), candidate('solver-b', 'B')];
    const absent = adjudicateWorksheetSolverCandidates(base, candidates);
    assert.equal(absent.publishable, false);
    assert.ok(absent.diagnostics.some(item => item.code === 'solver_disagreement'));

    const failed = adjudicateWorksheetSolverCandidates(base, candidates, {
      status: 'failed',
      reason: 'checker unavailable'
    });
    assert.equal(failed.publishable, false);
    assert.ok(failed.diagnostics.some(item => item.code === 'solver_disagreement'));

    const incomplete = adjudicateWorksheetSolverCandidates(base, candidates, {
      status: 'fulfilled',
      verified: false,
      reason: 'Neither answer is fully supported.'
    });
    assert.equal(incomplete.publishable, false);
    assert.equal(incomplete.verification.verification_status, 'review_required');
    assert.ok(incomplete.diagnostics.some(item => item.code === 'invalid_checker_response'));
  });

  test('accepts a complete valid adjudicator correction but rejects invalid corrections', () => {
    const candidates = [candidate('solver-a', 'A'), candidate('solver-b', 'B')];
    const corrected = adjudicateWorksheetSolverCandidates(base, candidates, {
      status: 'fulfilled',
      verified: false,
      corrected_answer: 'Gamma',
      corrected_solution: 'Independent adjudication supports Gamma.',
      corrected_type: 'multiple_choice',
      reason: 'Adjudicated independently.'
    });
    assert.equal(corrected.publishable, true);
    assert.equal(corrected.question.answer, 'C');
    assert.equal(corrected.verification.verification_status, 'verified');

    const outsideOptions = adjudicateWorksheetSolverCandidates(base, candidates, {
      status: 'fulfilled',
      verified: false,
      corrected_answer: 'Z',
      corrected_type: 'multiple_choice',
      reason: 'Invalid correction.'
    });
    assert.equal(outsideOptions.publishable, false);
    assert.ok(outsideOptions.diagnostics.some(item => item.code === 'invalid_checker_response'));
  });
});

describe('worksheet reconciliation, validation, and recheck coverage', () => {
  test('attaches adjacent-page choices to exactly one incomplete question and preserves source order', () => {
    const reconciled = reconcileWorksheetPages([
      {
        source_file: 'worksheet.pdf',
        page_number: 1,
        file_order: 0,
        questions: [{
          source_id: '11a',
          question: 'Which value is correct?',
          type: 'multiple_choice',
          options: []
        }]
      },
      {
        source_file: 'worksheet.pdf',
        page_number: 2,
        file_order: 1,
        questions: [],
        fragments: [{
          kind: 'choices',
          options: ['A) One', 'B) Two', 'C) Three']
        }]
      }
    ]);
    assert.equal(reconciled.questions.length, 1);
    assert.equal(reconciled.questions[0].source_id, '11a');
    assert.equal(reconciled.questions[0].source_order, 0);
    assert.equal(reconciled.questions[0].source.page_number, 1);
    assert.deepEqual(reconciled.questions[0].options, ['A) One', 'B) Two', 'C) Three']);
    assert.equal(reconciled.unresolved_fragments.length, 0);
  });

  test('reports unresolved cross-page fragments when attachment is ambiguous', () => {
    const reconciled = reconcileWorksheetPages([
      {
        source_file: 'worksheet.pdf',
        page_number: 1,
        questions: [
          { source_id: '11a', question: 'First incomplete?', type: 'multiple_choice', options: [] },
          { source_id: '11b', question: 'Second incomplete?', type: 'multiple_choice', options: [] }
        ]
      },
      {
        source_file: 'worksheet.pdf',
        page_number: 2,
        questions: [],
        fragments: [{ kind: 'choices', options: ['A) One', 'B) Two'] }]
      }
    ]);
    assert.equal(reconciled.unresolved_fragments.length, 1);
    assert.ok(reconciled.diagnostics.some(item => item.code === 'unresolved_fragment'));
  });

  test('rejects malformed type, answers outside options, and duplicate normalized options', () => {
    const malformedType = validateWorksheetQuestion(worksheetQuestion('bad-type', { type: 'mystery' }));
    assert.equal(malformedType.valid, false);
    assert.ok(malformedType.diagnostics.some(item => item.code === 'unsupported_question_type'));

    const outside = validateWorksheetQuestion(worksheetQuestion('bad-answer', { answer: 'Z' }));
    assert.equal(outside.valid, false);
    assert.ok(outside.diagnostics.some(item => item.code === 'invalid_answer'));

    const duplicate = validateWorksheetQuestion(worksheetQuestion('bad-options', {
      options: ['A) Same', 'B) same'],
      answer: 'A'
    }));
    assert.equal(duplicate.valid, false);
    assert.ok(duplicate.diagnostics.some(item => item.code === 'duplicate_option'));
  });

  test('enforces required solutions and retains provenance plus verification metadata', () => {
    const missing = validateWorksheetQuestion(worksheetQuestion('solution-required', {
      solution: ''
    }), { require_solution: true });
    assert.equal(missing.valid, false);
    assert.ok(missing.diagnostics.some(item => item.code === 'missing_solution'));

    const source = {
      source_file: 'algebra.pdf',
      page_number: 7,
      original_index: 'Section A-3',
      crop_or_image_reference: 'crop-ref-7'
    };
    const retained = validateWorksheetQuizForPublication([
      worksheetQuestion('Section A-3', {
        source,
        source_id: 'Section A-3',
        original_index: 'Section A-3',
        worksheet_qa: {
          golden_answer: 'B',
          solver_candidates: [{ model: 'solver-a', status: 'fulfilled', answer: 'B' }]
        },
        answer: 'B'
      })
    ], { require_solution: true, require_verification: true });
    assert.equal(retained.valid, true, JSON.stringify(retained.diagnostics));
    assert.deepEqual(retained.questions[0].source, source);
    assert.equal(retained.questions[0].verification?.verification_status, 'verified');
    assert.equal(retained.questions[0].worksheet_qa?.golden_answer, 'B');

    const reviewRequired = validateWorksheetQuizForPublication([
      worksheetQuestion('review-me', {
        verification: {
          answer_source: 'golden_key',
          verification_status: 'review_required',
          reason: 'Golden key conflicts with solver.'
        }
      })
    ]);
    assert.equal(reviewRequired.valid, false);
    assert.ok(reviewRequired.diagnostics.some(item => item.code === 'review_required'));
  });

  test('uses identical canonical answer interpretation in generation validation and student grading', () => {
    const generated = validateWorksheetQuestion(worksheetQuestion('canonical-consistency', {
      answer: 'Beta',
      points: 2
    }));
    assert.equal(generated.valid, true, JSON.stringify(generated.diagnostics));
    if (!generated.valid || !generated.question) return;
    assert.equal(generated.question.answer, 'B');
    assert.equal(mapWorksheetAnswerToCanonical(generated.question, 'Beta').answer, 'B');
    const letterGrade = gradeQuestionLocally(generated.question, 'B');
    const textGrade = gradeQuestionLocally(generated.question, 'Beta');
    assert.equal(letterGrade.isCorrect, true);
    assert.equal(textGrade.isCorrect, true);
    assert.equal(letterGrade.scoreFraction, textGrade.scoreFraction);
    assert.equal(letterGrade.earnedPoints, 2);
  });

  test('merges complete rechecks by stable ID rather than array position', () => {
    const originals = [
      worksheetQuestion('11a', { answer: 'A' }),
      worksheetQuestion('11b', { answer: 'B' })
    ];
    const reorderedOutputs = [
      { source: { original_index: '11b' }, answer: 'Beta' },
      { source: { original_index: '11a' }, answer: 'Gamma' }
    ];
    const merged = mergeWorksheetRecheckByStableId(originals, reorderedOutputs);
    assert.equal(merged.success, true, JSON.stringify(merged.diagnostics));
    assert.deepEqual(merged.summary.changed, ['11a']);
    assert.deepEqual(merged.summary.unchanged, ['11b']);
    assert.deepEqual(merged.questions.map(getWorksheetSourceId), ['11a', '11b']);
    assert.equal(merged.questions[0].answer, 'C');
    assert.equal(merged.questions[1].answer, 'B');

    const missing = mergeWorksheetRecheckByStableId(originals, [reorderedOutputs[0]]);
    assert.equal(missing.success, false);
    assert.deepEqual(missing.summary.missing, ['11a']);
    assert.ok(missing.diagnostics.some(item => item.code === 'missing_recheck_output'));

    const unexpected = mergeWorksheetRecheckByStableId(originals, [
      ...reorderedOutputs,
      { source: { original_index: 'extra' }, answer: 'A' }
    ]);
    assert.equal(unexpected.success, false);
    assert.deepEqual(unexpected.summary.unexpected, ['extra']);
    assert.ok(unexpected.diagnostics.some(item => item.code === 'unexpected_recheck_output'));

    const omittedAnswer = mergeWorksheetRecheckByStableId(originals, [
      { source: { original_index: '11a' } },
      reorderedOutputs[0]
    ]);
    assert.equal(omittedAnswer.success, false);
    assert.deepEqual(omittedAnswer.summary.invalid, ['11a']);
    assert.ok(omittedAnswer.diagnostics.some(item => item.code === 'invalid_recheck_output'));
  });
});

describe('worksheet bounded batch solving', () => {
  function promptQuestions(request: any): any[] {
    const prompt = String(request?.contents?.[0] || '');
    const match = prompt.match(/QUESTIONS TO PROCESS \(JSON\):\s*([\s\S]*?)\s*CRITICAL RULES:/);
    assert.ok(match, 'worksheet solver prompt should contain a JSON batch');
    return JSON.parse(match[1]);
  }

  function solvedBatch(request: any, answerForModel: (model: string) => string = () => 'B') {
    const questions = promptQuestions(request);
    return questions.map((item: any, sourceIndex: number) => ({
      options: item.options,
      answer: answerForModel(String(request.model || '')),
      type: 'multiple_choice',
      source_index: sourceIndex,
      source_id: item.source_id,
      solution: 'Concise verified solution.'
    }));
  }

  test('strictly rejects missing, duplicate, or mismatched batch coverage', () => {
    const questions = [worksheetQuestion('1'), worksheetQuestion('2')];
    assert.throws(
      () => parseWorksheetSolverBatchOutput(JSON.stringify([{
        source_index: 0,
        source_id: '1'
      }]), questions),
      /coverage mismatch/
    );
    assert.throws(
      () => parseWorksheetSolverBatchOutput(JSON.stringify([
        { source_index: 0, source_id: '1' },
        { source_index: 0, source_id: '2' }
      ]), questions),
      /duplicate source_index/
    );
    assert.throws(
      () => parseWorksheetSolverBatchOutput(JSON.stringify([
        { source_index: 0, source_id: '2' },
        { source_index: 1, source_id: '1' }
      ]), questions),
      /wrong source_id/
    );
  });

  test('uses two requests per true batch, runs two batches concurrently, and preserves source order', async () => {
    const questions = Array.from({ length: 6 }, (_value, index) => worksheetQuestion(String(index + 1), { answer: '' }));
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const ai = {
      models: {
        async generateContent(request: any) {
          calls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const sourceId = promptQuestions(request)[0].source_id;
          await new Promise(resolve => setTimeout(resolve, sourceId === '1' ? 20 : 5));
          active -= 1;
          return { text: JSON.stringify(solvedBatch(request)) };
        }
      }
    } as any;
    const completed: number[] = [];
    const results = await solveWorksheetQuestionsInBatches({
      ai,
      questions,
      batchSize: 3,
      concurrency: 2,
      subject: 'Mathematics',
      topic: 'Batch test',
      requestedModel: 'gemini-3.5-flash-lite',
      deadlineAt: Date.now() + 2_000,
      onBatchComplete: progress => completed.push(progress.completed)
    });

    assert.equal(calls, 4, 'six questions should use two model calls per three-question batch');
    assert.ok(maximumActive >= 3, 'two batches should overlap instead of running serially');
    assert.deepEqual(results.map(result => getWorksheetSourceId(result.question)), ['1', '2', '3', '4', '5', '6']);
    assert.ok(results.every(result => result.publishable && result.question.answer === 'B'));
    assert.deepEqual(completed, [3, 6]);
  });

  test('retries a transient failure and terminates a hung request at its deadline', async () => {
    let attempts = 0;
    const recovered = await runBoundedWorksheetModelRequest({
      label: 'transient solver',
      deadlineAt: Date.now() + 1_000,
      timeoutMs: 100,
      maxAttempts: 2,
      operation: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('temporary outage'), { status: 503 });
        return 'recovered';
      }
    });
    assert.equal(recovered, 'recovered');
    assert.equal(attempts, 2);

    await assert.rejects(
      runBoundedWorksheetModelRequest({
        label: 'hung solver',
        deadlineAt: Date.now() + 1_000,
        timeoutMs: 15,
        maxAttempts: 1,
        operation: signal => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('request aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        })
      }),
      /hung solver failed after 1 bounded attempt/
    );
  });

  test('runs adjudication only when the two normalized solver answers disagree', async () => {
    const question = worksheetQuestion('verify-1', { answer: '' });
    let calls = 0;
    const ai = {
      models: {
        async generateContent(request: any) {
          calls += 1;
          const prompt = String(request?.contents?.[0] || '');
          if (prompt.includes('senior educational adjudicator')) {
            return {
              text: JSON.stringify({
                verified: true,
                accepted_model: 'gemini-3.5-flash-lite',
                reason: 'The primary candidate is correct.'
              })
            };
          }
          return {
            text: JSON.stringify(solvedBatch(
              request,
              model => model === 'gemini-3.5-flash-lite' ? 'A' : 'B'
            ))
          };
        }
      }
    } as any;

    const [result] = await solveWorksheetBatchWithConsensus({
      ai,
      questions: [question],
      subject: 'Mathematics',
      topic: 'Verification test',
      requestedModel: 'gemini-3.5-flash-lite',
      deadlineAt: Date.now() + 2_000
    });
    assert.equal(calls, 3);
    assert.equal(result.publishable, true);
    assert.equal(result.question.answer, 'A');
    assert.equal(result.verification.verification_status, 'verified');
    assert.match(result.verification.reason || '', /primary candidate/i);
  });

  test('retries only review-required questions as focused single-question batches', async () => {
    const questions = [
      worksheetQuestion('1', { answer: '' }),
      worksheetQuestion('2', { answer: '' })
    ];
    let adjudications = 0;
    let calls = 0;
    const ai = {
      models: {
        async generateContent(request: any) {
          calls += 1;
          const prompt = String(request?.contents?.[0] || '');
          if (prompt.includes('senior educational adjudicator')) {
            adjudications += 1;
            return adjudications === 1
              ? { text: JSON.stringify({ verified: false, reason: 'Retry this item independently.' }) }
              : {
                  text: JSON.stringify({
                    verified: true,
                    accepted_model: 'gemini-3.5-flash-lite',
                    reason: 'Focused retry verified the primary answer.'
                  })
                };
          }
          const output = solvedBatch(request);
          output.forEach((item: any) => {
            if (item.source_id === '2') {
              item.answer = request.model === 'gemini-3.5-flash-lite' ? 'A' : 'B';
            }
          });
          return { text: JSON.stringify(output) };
        }
      }
    } as any;

    const results = await solveWorksheetQuestionsInBatches({
      ai,
      questions,
      batchSize: 2,
      subject: 'Mathematics',
      topic: 'Focused retry test',
      requestedModel: 'gemini-3.5-flash-lite',
      deadlineAt: Date.now() + 2_000,
      retryReviewRequired: true
    });

    assert.equal(calls, 6);
    assert.equal(adjudications, 2);
    assert.ok(results.every(result => result.publishable));
    assert.deepEqual(results.map(result => result.question.answer), ['B', 'A']);
  });

  test('retries malformed solver output and never accepts one-model coverage', async () => {
    const question = worksheetQuestion('invalid-model-1', { answer: '' });
    let malformedCalls = 0;
    const ai = {
      models: {
        async generateContent(request: any) {
          const output = solvedBatch(request);
          if (request.model === 'gemini-3.5-flash-lite') {
            malformedCalls += 1;
            output[0].type = 'unsupported_type';
          }
          return { text: JSON.stringify(output) };
        }
      }
    } as any;

    const [result] = await solveWorksheetBatchWithConsensus({
      ai,
      questions: [question],
      subject: 'Mathematics',
      topic: 'Malformed solver test',
      requestedModel: 'gemini-3.5-flash-lite',
      deadlineAt: Date.now() + 2_000
    });
    assert.equal(malformedCalls, 2);
    assert.equal(result.publishable, false);
    assert.equal(result.verification.verification_status, 'review_required');
    assert.ok(result.diagnostics.some(item => item.code === 'solver_failure'));
  });
});
