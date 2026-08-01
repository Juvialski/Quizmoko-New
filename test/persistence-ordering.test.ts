import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearAttemptRevisionState,
  isLatestAnswerRevision,
  observeAnswerRevision,
  withAttemptLock
} from '../src/services/resultSession.ts';

test('attempt mutations execute monotonically for one session', async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });

  const first = withAttemptLock('quiz_order', 'session_order', async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  const second = withAttemptLock('quiz_order', 'session_order', () => {
    order.push('second');
  });

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('an older answer revision is rejected after a newer revision is observed', () => {
  clearAttemptRevisionState('quiz_revision', 'session_revision');
  assert.equal(observeAnswerRevision({
    quizId: 'quiz_revision',
    sessionId: 'session_revision',
    questionIndex: 0,
    answerRevision: 2
  }).accepted, true);
  assert.equal(observeAnswerRevision({
    quizId: 'quiz_revision',
    sessionId: 'session_revision',
    questionIndex: 0,
    answerRevision: 1
  }).accepted, false);
  assert.equal(isLatestAnswerRevision({
    quizId: 'quiz_revision',
    sessionId: 'session_revision',
    questionIndex: 0,
    answerRevision: 2
  }), true);
});
