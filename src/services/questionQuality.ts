import { mathText, verifyMathematicalAnswer, verifyMathExpression, verifySolutionForQuestion, type MathEvidence } from './mathVerification.ts';
import { analyzeDiagram, isSafeTikzSource } from './diagramEvidence.ts';

export interface QualityIssue { code: string; message: string; action: string }
export interface QualityEvidence { version: string; mathematical: MathEvidence; explanation: MathEvidence; diagram: { outcome: string; rendered: boolean; source_validated?: boolean; render_validated?: boolean; semantic_validated?: boolean; source_digest?: string }; issues: QualityIssue[] }
const issue = (code: string, message: string, action: string): QualityIssue => ({ code, message, action });

/** Source validation is distinct from rendering and visual correctness. No TeX execution. */
export function checkDiagram(question: unknown): { outcome: string; rendered: boolean; issues: QualityIssue[] } {
  const text = String(question ?? ''), issues: QualityIssue[] = [];
  const blocks = [...text.matchAll(/\[TIKZ\]([\s\S]*?)\[\/TIKZ\]/gi)];
  const tags = text.match(/\[\/?TIKZ\]/gi) || [];
  const hasImage = /<img\b[^>]*\bsrc\s*=\s*["'][^"']+["']/i.test(text);
  if (tags.length !== blocks.length * 2) issues.push(issue('invalid_diagram', 'TikZ block delimiters are incomplete.', 'Repair the diagram source and preview it.'));
  if (/\b(?:shown|below|above|following|given)\s+(?:in\s+the\s+)?(?:graph|diagram|figure)|\b(?:graph|diagram|figure)\s+(?:shown|below|above)|\baccording to the (?:graph|diagram|figure)/i.test(text) && !blocks.length && !hasImage) {
    issues.push(issue('missing_diagram', 'The question refers to a diagram that is absent.', 'Attach the original diagram before re-solving.'));
  }
  for (const block of blocks) {
    const code = block[1].replace(/(?<!\\)%[^\r\n]*/g, '');
    if (!isSafeTikzSource(code)) issues.push(issue('invalid_diagram','TikZ uses commands outside the safe preview vocabulary.','Remove unsupported commands and preview again.'));
    const stack: string[] = []; let depth = 0, bad = !code.trim();
    for (const char of code.replace(/\\[{}]/g, '')) { if (char === '{') depth++; if (char === '}' && --depth < 0) bad = true; }
    for (const m of code.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
      if (m[1] === 'begin') stack.push(m[2]); else if (stack.pop() !== m[2]) bad = true;
    }
    if (depth !== 0 || stack.length || bad || /\\(?:input|include|write|read|openout|openin|catcode|csname|def|edef|gdef|xdef|loop|repeat|directlua|usepackage|documentclass|usetikzlibrary|includegraphics|addplot)(?=[^a-z]|$)|pgfplots|\\begin\s*\{axis\}/i.test(code)) {
      issues.push(issue('invalid_diagram', 'TikZ syntax or commands violate the supported diagram contract.', 'Use balanced base TikZ and preview the result.'));
    }
    if (/\\(?:draw|path|node|coordinate)\b[^;]*$/.test(code.trim().replace(/\\end\{tikzpicture\}\s*$/, ''))) issues.push(issue('invalid_diagram', 'A TikZ drawing command has no terminating semicolon.', 'Repair the command and preview the diagram.'));
    for (const coord of code.matchAll(/\\coordinate\s*\(([A-Za-z]\w*)\)\s*at\s*\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g)) {
      const prose = text.replace(/\[TIKZ\][\s\S]*?\[\/TIKZ\]/gi,'');
      const stated = prose.match(new RegExp(`\\b${coord[1]}\\s*(?:=|is at)?\\s*\\$?\\((-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)\\)`));
      if (stated && (Number(stated[1]) !== Number(coord[2]) || Number(stated[2]) !== Number(coord[3]))) issues.push(issue('diagram_coordinate_conflict','A named diagram coordinate contradicts the question text.','Correct the coordinate or the question, then re-solve.'));
    }
  }
  if (blocks.length) for (const problem of analyzeDiagram(text).issues.filter(p=>!p.startsWith('Structured renderer'))) {
    issues.push(issue('diagram_consistency',problem,'Correct the source coordinates, visible labels or shape, then preview and re-solve.'));
  }
  // Remote Kroki/browser rendering is not an independently verified visual representation.
  if (blocks.length && !issues.length) issues.push(issue('diagram_render_unverified', 'Diagram source was checked; rendering and visual correctness need review.', 'Preview the graph, labels, scale and placement before approving.'));
  if (hasImage && !/src\s*=\s*["']data:image\/(?:png|jpeg|webp|gif);base64,/i.test(text)) issues.push(issue('diagram_context_unavailable','The verifier has no attached vision data for this image.','Attach the diagram as an image and re-solve.'));
  return { outcome: issues.length ? 'inconclusive' : hasImage ? 'vision_consensus_only' : 'not_applicable', rendered: false, issues };
}

function choiceValue(value: unknown, index: number): string {
  return String(value ?? '').replace(new RegExp(`^\\s*${String.fromCharCode(65+index)}[).]\\s*`),'').trim();
}
export function evaluateQuestionQuality(question: any): QualityEvidence {
  const text = String(question?.question ?? question?.raw_text ?? question?.statement ?? '');
  const options = Array.isArray(question?.options) ? question.options.map(choiceValue) : [];
  const type = String(question?.type || '');
  const choices = type === 'multiple_choice' || type === 'multiple_choice_multi';
  const letters = Array.isArray(question?.answer) ? question.answer : String(question?.answer ?? '').split(/\s*[,;]\s*/);
  const values = choices ? letters.map((v: unknown) => { const i = String(v).trim().toUpperCase().charCodeAt(0)-65; return /^[A-Z]$/i.test(String(v).trim()) ? options[i] : undefined; }) : [String(question?.answer ?? '')];
  const mathematical = verifyMathematicalAnswer(text, type === 'multiple_choice_multi' ? values.join(',') : values[0]);
  const explanation = verifySolutionForQuestion(text, question?.solution);
  const diagram = checkDiagram(text);
  const issues = [...diagram.issues];
  issues.push(...extractionQualityIssues(question).filter(i=>['missing_worksheet_content','truncated_expression'].includes(i.code)));
  if (mathematical.outcome === 'fail') issues.push(issue('incorrect_mathematical_answer', mathematical.reason, 'Correct the answer or conditions and run Re-solve.'));
  if (explanation.outcome === 'fail') issues.push(issue('unverified_explanation', explanation.reason, 'Correct the worked calculation and run Re-solve.'));
  if (choices && mathematical.outcome !== 'inconclusive') {
    const checks = options.map((o: string) => verifyMathematicalAnswer(text,o,true));
    const correct = checks.flatMap((c: MathEvidence,i: number) => c.outcome === 'pass' ? [i] : []);
    const selected = letters.map((v: unknown) => String(v).trim().toUpperCase().charCodeAt(0)-65).sort((a: number,b: number)=>a-b);
    if (checks.every((c: MathEvidence) => c.outcome !== 'inconclusive')) {
      if (!correct.length) issues.push(issue('missing_correct_choice','No answer choice satisfies the supported question.','Replace a distractor with the correct value and re-solve.'));
      if (type === 'multiple_choice' && correct.length > 1) issues.push(issue('multiple_correct_choices','More than one choice satisfies this single-answer question.','Replace equivalent or correct distractors and re-solve.'));
      if (JSON.stringify(selected) !== JSON.stringify(correct)) issues.push(issue('incorrect_choice_mapping','The answer letters do not match all and only the correct choices.','Correct the answer mapping and re-solve.'));
    }
    for (let i=0;i<options.length;i++) for (let j=0;j<i;j++) {
      const a=mathText(options[i]).replace(/^x\s*=\s*/,''),b=mathText(options[j]).replace(/^x\s*=\s*/,'');
      if (verifyMathExpression(a,b).outcome === 'pass') issues.push(issue('equivalent_options','Two choices are exactly mathematically equivalent.','Replace one with a distinct misconception-based distractor.'));
    }
  }
  if (/\b(?:correct answer\b\s*:|answer is\b|answer\s*:)\s*(?:[A-D](?=\s*(?:[.!]|$))|\$)/i.test(text)) issues.push(issue('answer_leak','The question reveals an answer.','Remove the answer hint from the question.'));
  if (/\b(?:all|none) of the above\b/i.test(options.join(' '))) issues.push(issue('ambiguous_choices','Choices depend on other choices rather than a standalone answer.','Use explicit choices and confirm a unique answer.'));
  const evidence = analyzeDiagram(text);
  return { version:'question-quality-v2', mathematical, explanation, diagram:{outcome:diagram.outcome,rendered:evidence.render_validated,source_validated:evidence.source_validated,render_validated:evidence.render_validated,semantic_validated:evidence.semantic_validated,source_digest:evidence.source_digest}, issues };
}

/** Safe extraction warnings; no missing text is fabricated and source identifiers are untouched. */
export function extractionQualityIssues(question: any): QualityIssue[] {
  const text = String(question?.raw_text ?? question?.question ?? question?.statement ?? '').trim();
  const issues = checkDiagram(text).issues.filter(i=>i.code!=='diagram_render_unverified');
  if (!text || /(?:[+\-*/=^]|\\(?:frac|dfrac|sqrt))\s*\$?\s*$/.test(text) || /\b(?:continued|see next page)\s*[.]?$/i.test(text)) issues.push(issue('missing_worksheet_content','Extracted question appears incomplete.','Compare the source page and recover only this item.'));
  const blocks = [...text.matchAll(/\$\$?([^$]+)\$\$?/g)];
  if (blocks.some(m => { const s=mathText(m[1]); return (s.match(/\(/g)||[]).length !== (s.match(/\)/g)||[]).length; })) issues.push(issue('truncated_expression','An extracted mathematical expression has unmatched parentheses.','Check the fraction, radical or continuation on the source page.'));
  return issues;
}

/** Only explicitly printed IDs at text-run boundaries, never gaps inferred from array positions. */
export function detectPrintedSourceIds(sourceText: string): string[] {
  const ids: string[] = [];
  for (const line of sourceText.slice(0,100_000).split(/\r?\n/)) {
    const m=line.match(/^\s*(?:Question\s+|Q\s*)?(\d+[a-z]?(?:\([ivxlcdm]+\))?|[IVXLCDM]+|[A-Z]-\d+)\s*[.)](?:\s+\S|\s*$)/);
    if (m && ids.length<500) ids.push(m[1]);
  }
  return ids;
}

/** Compares only explicit per-ID text spans. Layout/OCR ambiguity is a warning, never reconstructed text. */
export function compareWorksheetTextLayer(sourceText: string, id: string, extracted: unknown): QualityIssue[] {
  const lines = sourceText.slice(0,100000).split(/\r?\n/);
  const entries: {id:string;text:string}[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:Question\s+|Q\s*)?(\d+[a-z]?(?:\([ivxlcdm]+\))?|[IVXLCDM]+|[A-Z]-\d+)\s*[.)](?:\s+|$)(.*)$/);
    if (match) entries.push({id:match[1],text:match[2]});
    else if(entries.length) entries.at(-1)!.text += ' '+line;
  }
  const matches=entries.filter(e=>e.id===id);
  if(matches.length!==1) return [];
  const signature=(v:unknown)=>mathText(v).match(/\d+(?:\.\d+)?/g) || [];
  const a=signature(matches[0].text),b=signature(extracted);
  if(!a.length || JSON.stringify(a)===JSON.stringify(b))return [];
  return [issue('worksheet_text_disagreement','Extracted numeric content differs from the PDF text layer for this printed item.','Inspect fractions, exponents, radicals, options and page continuation; recover only this item/page. Text-layer layout may also be incomplete.')];
}
