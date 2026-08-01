import assert from 'node:assert/strict';
import test from 'node:test';
import { cropImageBoundingBox, sortQuestionsByIndex } from '../src/services/pdf.ts';

test('source sorting keeps alphanumeric worksheet identifiers distinct', () => {
  const questions = [
    { original_index: '11b' },
    { original_index: '2' },
    { original_index: '11a' },
    { original_index: '01' },
    { original_index: 'Section A-3' }
  ];
  sortQuestionsByIndex(questions);
  assert.deepEqual(
    questions.map(question => question.original_index),
    ['01', '2', '11a', '11b', 'Section A-3']
  );
  assert.notEqual(questions[2].original_index, questions[3].original_index);
});

test('invalid crop boxes fail without invoking image processing', async () => {
  assert.equal(await cropImageBoundingBox(Buffer.alloc(0), []), null);
  assert.equal(await cropImageBoundingBox(Buffer.alloc(0), [0, 0, 1200, 1200]), null);
});
