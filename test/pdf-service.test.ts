import assert from 'node:assert/strict';
import test from 'node:test';
import { cropImageBoundingBox, sortQuestionsByIndex } from '../src/services/pdf.ts';
import { findMissingPlainNumericWorksheetSourceIds } from '../src/services/worksheetSourceOrder.ts';

test('source sorting restores out-of-order extraction chunks without renumbering', () => {
  const questions = [
    { original_index: '3' },
    { original_index: '1' },
    { original_index: '2' }
  ];
  sortQuestionsByIndex(questions);
  assert.deepEqual(questions.map(question => question.original_index), ['1', '2', '3']);
});

test('source sorting preserves a worksheet that starts at question 21', () => {
  const questions = [
    { original_index: '23' },
    { original_index: '21' },
    { original_index: '22' }
  ];
  sortQuestionsByIndex(questions);
  assert.deepEqual(questions.map(question => question.original_index), ['21', '22', '23']);
  assert.deepEqual(findMissingPlainNumericWorksheetSourceIds(questions), []);
});

test('source sorting preserves non-1 starts and intentional numeric gaps', () => {
  const questions = [
    { original_index: '15' },
    { original_index: '10' },
    { original_index: '12' }
  ];
  sortQuestionsByIndex(questions);
  assert.deepEqual(questions.map(question => question.original_index), ['10', '12', '15']);
  assert.deepEqual(
    findMissingPlainNumericWorksheetSourceIds(questions),
    [],
    'a non-1 or intentionally gapped worksheet must not create false recovery targets'
  );
  assert.deepEqual(
    findMissingPlainNumericWorksheetSourceIds([{ original_index: '1' }, { original_index: '3' }]),
    ['2'],
    'contiguous numbering that visibly starts at 1 still supports targeted recovery'
  );
});

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

test('source sorting naturally orders prefixed and nested worksheet identifiers', () => {
  const questions = [
    { original_index: 'Question 10' },
    { source: { original_index: '3' } },
    { source_id: '2' },
    { original_index: '#11' },
    { original_index: 'Q9' }
  ];
  sortQuestionsByIndex(questions);
  assert.deepEqual(
    questions.map(question => question.source?.original_index ?? question.original_index ?? question.source_id),
    ['2', '3', 'Q9', 'Question 10', '#11']
  );
});

test('source sorting keeps unparseable identifiers in stable extraction order', () => {
  const questions = [
    { original_index: 'Section Z' },
    { original_index: 'Section A' },
    { original_index: '2' },
    { original_index: 'Section M' }
  ];
  sortQuestionsByIndex(questions);
  assert.deepEqual(
    questions.map(question => question.original_index),
    ['2', 'Section Z', 'Section A', 'Section M']
  );
});

test('source sorting recognizes canonical Roman numerals without rewriting them', () => {
  const questions = [
    { original_index: 'III' },
    { original_index: 'I' },
    { original_index: 'II' }
  ];
  sortQuestionsByIndex(questions);
  assert.deepEqual(questions.map(question => question.original_index), ['I', 'II', 'III']);
});

test('invalid crop boxes fail without invoking image processing', async () => {
  assert.equal(await cropImageBoundingBox(Buffer.alloc(0), []), null);
  assert.equal(await cropImageBoundingBox(Buffer.alloc(0), [0, 0, 1200, 1200]), null);
});
