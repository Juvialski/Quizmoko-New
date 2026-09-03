import fs from 'node:fs';

function replaceExact(file, before, after) {
  const content = fs.readFileSync(file, 'utf8');
  if (!content.includes(before)) {
    throw new Error(`Expected patch target not found in ${file}: ${before.slice(0, 120)}`);
  }
  fs.writeFileSync(file, content.replace(before, after));
}

// 1. Do not globally collapse repeated printed identifiers. Dedupe only within
// the same uploaded source page, and preserve conflicting same-page candidates.
replaceExact(
  'src/services/worksheetPipeline.ts',
  '  const questionIndexesBySourceId = new Map<string, number>();',
  '  const questionIndexesBySourceLocation = new Map<string, number>();'
);

replaceExact(
  'src/services/worksheetPipeline.ts',
`      const sourceMatchKey = worksheetSourceIdentifierMatchKey(sourceId);
      const existingIndex = questionIndexesBySourceId.get(sourceMatchKey);
      if (existingIndex !== undefined) {
        const existing = questions[existingIndex];
        const existingComparableText = normalizedComparableText(withoutWorksheetImageMarkup(existing.question));
        const duplicateComparableText = normalizedComparableText(withoutWorksheetImageMarkup(candidate.question));
        if (existingComparableText && duplicateComparableText && existingComparableText !== duplicateComparableText) {
          diagnostics.push(diagnostic('duplicate_source_id', \`Extracted duplicate source ID "\${sourceId}" has conflicting text.\`, sourceId));
        }
        questions[existingIndex] = mergeDuplicateWorksheetQuestion(existing, candidate);
        continue;
      }
      questionIndexesBySourceId.set(sourceMatchKey, questions.length);
      sourceOrder += 1;
      questions.push(candidate);`,
`      const sourceMatchKey = worksheetSourceIdentifierMatchKey(sourceId);
      const sourceLocationKey = JSON.stringify([
        page.source_file,
        page.page_number,
        sourceMatchKey
      ]);
      const existingIndex = questionIndexesBySourceLocation.get(sourceLocationKey);
      if (existingIndex !== undefined) {
        const existing = questions[existingIndex];
        const existingComparableText = normalizedComparableText(withoutWorksheetImageMarkup(existing.question));
        const duplicateComparableText = normalizedComparableText(withoutWorksheetImageMarkup(candidate.question));
        if (existingComparableText && duplicateComparableText && existingComparableText !== duplicateComparableText) {
          diagnostics.push(diagnostic('duplicate_source_id', \`Extracted duplicate source ID "\${sourceId}" has conflicting text. Both candidates were preserved for review.\`, sourceId));
          sourceOrder += 1;
          questions.push(candidate);
          continue;
        }
        questions[existingIndex] = mergeDuplicateWorksheetQuestion(existing, candidate);
        continue;
      }
      questionIndexesBySourceLocation.set(sourceLocationKey, questions.length);
      sourceOrder += 1;
      questions.push(candidate);`
);

// 2. Frontend recovery equality must not equate Roman IV with Arabic 4.
for (const file of ['views/worksheet_upload.ejs', 'views/worksheet_answers_upload.ejs']) {
  replaceExact(
    file,
`            const romanMatch = comparable.match(/^\\(?([IVXLCDM]+)\\)?(.*)$/i);
            const roman = romanMatch && (!romanMatch[2] || /^[.):\\-]/.test(romanMatch[2].trim()))
                ? romanIdentifierValue(romanMatch[1])
                : null;
            return roman !== null
                ? \`numeric:\${roman}:\${romanMatch[2].trim().toLowerCase()}\`
                : \`text:\${comparable.toLowerCase()}\`;`,
`            const romanMatch = comparable.match(/^\\(?([IVXLCDM]+)\\)?(.*)$/i);
            if (romanMatch && (!romanMatch[2] || /^[.):\\-]/.test(romanMatch[2].trim()))) {
                const roman = romanIdentifierValue(romanMatch[1]);
                if (roman !== null) {
                    return \`roman:\${romanMatch[1].toUpperCase()}:\${romanMatch[2].trim().toLowerCase()}\`;
                }
            }
            return \`text:\${comparable.toLowerCase()}\`;`
  );
}

// 3. Printable worksheet should honor source_id for legacy/public payloads.
replaceExact(
  'views/worksheet.ejs',
`                <% const printedQuestionId = q && q.source && q.source.original_index !== undefined
                    ? q.source.original_index
                    : (q && q.original_index !== undefined ? q.original_index : qIdx + 1); %>`,
`                <% const printedQuestionId = q && q.source && q.source.original_index !== undefined
                    ? q.source.original_index
                    : (q && q.original_index !== undefined
                        ? q.original_index
                        : (q && q.source_id !== undefined ? q.source_id : qIdx + 1)); %>`
);

const quizFlowTest = 'test/quiz-flows.test.ts';
let quizFlowContent = fs.readFileSync(quizFlowTest, 'utf8');
const quizMarker = "test('worksheet source identity review regressions'";
if (!quizFlowContent.includes(quizMarker)) {
  quizFlowContent += `\n\ntest('worksheet source identity review regressions', () => {\n  const repeatedAcrossPages = reconcileWorksheetPages([\n    { source_file: 'worksheet.pdf', page_number: 1, questions: [\n      { original_index: '1', question: 'First section question.', type: 'identification', options: [] }\n    ] },\n    { source_file: 'worksheet.pdf', page_number: 2, questions: [\n      { original_index: '1', question: 'Second section question.', type: 'identification', options: [] }\n    ] },\n    { source_file: 'worksheet-2.pdf', page_number: 1, questions: [\n      { original_index: '1', question: 'Different uploaded file question.', type: 'identification', options: [] }\n    ] }\n  ]);\n  assert.equal(repeatedAcrossPages.questions.length, 3, 'restarted numbering across pages/files must not lose questions');\n\n  const conflictingSamePage = reconcileWorksheetPages([{\n    source_file: 'worksheet.pdf',\n    page_number: 3,\n    questions: [\n      { original_index: '7', question: 'First extracted wording.', type: 'identification', options: [] },\n      { original_index: '7', question: 'Conflicting extracted wording.', type: 'identification', options: [] }\n    ]\n  }]);\n  assert.equal(conflictingSamePage.questions.length, 2, 'conflicting duplicates must be preserved for teacher review');\n  assert.equal(conflictingSamePage.diagnostics.some(item => item.code === 'duplicate_source_id'), true);\n\n  assert.equal(worksheetSourceIdentifiersEqual('Question IV', 'IV'), true);\n  assert.equal(worksheetSourceIdentifiersEqual('IV', '4'), false, 'Roman and Arabic printed identifiers are distinct metadata');\n});\n`;
  fs.writeFileSync(quizFlowTest, quizFlowContent);
}
