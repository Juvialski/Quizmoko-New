export type LatexIssueCode =
  | 'unbalanced_delimiter'
  | 'mixed_delimiter'
  | 'empty_math'
  | 'unbalanced_brace'
  | 'bare_latex_command'
  | 'nested_delimiter'
  | 'invalid_currency'
  | 'literal_newline_escape';

export interface LatexIssue {
  code: LatexIssueCode;
  message: string;
  index?: number;
}

const BARE_COMMAND_PATTERN = /\\(?:d?frac|sqrt|left|right|cdot|times|div|sum|prod|int|begin|end|boxed|overline|underline|vec|pi|theta|alpha|beta|gamma|neq|leq|geq|infty)\b/g;

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function normalizeMathBody(body: string): string {
  let normalized = body
    .replace(/\\text\{\$([^{}]*)\}/g, '\\text{\\$$1}')
    .replace(/\\text\{\\?\$([^{}]*)\}/g, '\\text{\\$$1}');

  // A percent sign starts a TeX comment unless escaped. Escape only inside math.
  normalized = normalized.replace(/(^|[^\\])%/g, '$1\\%');
  return normalized;
}

const LATEX_N_COMMAND_SUFFIX_PATTERN = /^(?:abla\b|atural\b|e(?:q)?\b|eg\b|i\b|mid\b|ot(?:in)?\b|parallel\b|u\b)/;

/**
 * Some structured model responses double-escape a logical newline, so after
 * JSON parsing the stored text still contains the two characters "\\n".
 * Decode only separators that cannot be a known LaTeX command such as
 * \neq, \nabla, \not, or \nu.
 */
function looksLikeLogicalLineBreak(source: string, index: number, tokenWidth: number): boolean {
  const before = source.slice(0, index);
  const after = source.slice(index + tokenWidth);
  const trimmedBefore = before.replace(/[ \t]+$/g, '');
  const trimmedAfter = after.replace(/^[ \t]+/g, '');
  const previous = trimmedBefore.slice(-1);

  // Backtick-delimited code should keep literal escape sequences such as `\n`.
  const backticksBefore = (before.match(/`/g) || []).length;
  if (backticksBefore % 2 === 1) return false;

  if (/^(?:\$|<(?:div|img|br)\b|\[TIKZ\]|[•*-][ \t]+|\(?[a-h]\)?[.)]?[ \t]+|\(?i{1,3}\)?[.)]?[ \t]+)/.test(trimmedAfter)) {
    return true;
  }
  if (/^(?:\\(?:d?frac|sqrt|begin|left|boxed|overline|underline)\b)/.test(trimmedAfter)) {
    return true;
  }
  if (/[.?!:;]$/.test(trimmedBefore) && /^[A-Za-z0-9$<"'(\[]/.test(trimmedAfter)) {
    return true;
  }
  if (previous === ')' && /^(?:[a-h][.)]|\([a-h]\))\s+/.test(trimmedAfter)) {
    return true;
  }
  return false;
}

export function decodeLiteralNewlineEscapes(value: unknown): string {
  const source = String(value ?? '').replace(/\r\n?/g, '\n');
  let output = '';
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\' && source[index + 1] === 'r' && source[index + 2] === '\\' && source[index + 3] === 'n') {
      if (looksLikeLogicalLineBreak(source, index, 4)) {
        output += '\n';
        index += 3;
        continue;
      }
    }
    if (source[index] === '\\' && source[index + 1] === 'n') {
      const suffix = source.slice(index + 2);
      if (!LATEX_N_COMMAND_SUFFIX_PATTERN.test(suffix) && looksLikeLogicalLineBreak(source, index, 2)) {
        output += '\n';
        index += 1;
        continue;
      }
    }
    output += source[index];
  }
  return output;
}

function normalizeLetteredMultipartLayout(value: string): string {
  const markerPattern = /(?:^|[ \t])(?:\([a-h]\)|[a-h][.)])(?=[ \t]+)/g;
  const markers = Array.from(value.matchAll(markerPattern)).map(match => {
    const token = match[0].trim();
    const letter = token.replace(/[().]/g, '');
    return { letter };
  });
  const hasSequentialParts = markers.some((marker, index) =>
    marker.letter === 'a' && markers.slice(index + 1).some(next => next.letter === 'b')
  );
  if (!hasSequentialParts) return value;

  return value.replace(/([^\n])[ \t]+(\([a-h]\)|[a-h][.)])(?=[ \t]+)/g, '$1\n$2');
}

function normalizeRomanMultipartLayout(value: string): string {
  const markerPattern = /(?:^|[ \t])(?:\((i{1,3}|iv|v)\)|(i{1,3}|iv|v)[.)])(?=[ \t]+)/g;
  const markers = Array.from(value.matchAll(markerPattern)).map(match => ({
    label: match[1] || match[2] || ''
  }));
  const hasSequentialParts = markers.some((marker, index) =>
    marker.label === 'i' && markers.slice(index + 1).some(next => next.label === 'ii')
  );
  if (!hasSequentialParts) return value;

  return value.replace(/([^\n])[ \t]+(\((?:i{1,3}|iv|v)\)|(?:i{1,3}|iv|v)[.)])(?=[ \t]+)/g, '$1\n$2');
}

/**
 * Normalizes student-facing question layout without changing wording. Literal
 * newline escapes are decoded, and genuine multi-part a./b. or (i)/(ii)
 * questions are placed on separate lines. A sequential pair is required so a
 * single abbreviation or personal initial is not reflowed accidentally.
 */
export function normalizeQuestionLayoutText(value: unknown): string {
  let text = normalizeAiLatexText(value)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  text = normalizeLetteredMultipartLayout(text);
  text = normalizeRomanMultipartLayout(text);
  return text;
}

/**
 * Conservative repairs only. This function must never rewrite the meaning of a
 * question; larger formatting changes are handled through guarded AI patches.
 */
export function normalizeAiLatexText(value: unknown): string {
  const source = decodeLiteralNewlineEscapes(value)
    .replace(/\u000c/g, '')
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${normalizeMathBody(body.trim())}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${normalizeMathBody(body.trim())}$`)
    .replace(/\$\\text\{\$([^{}]*)\}\$/g, (_match, amount: string) => `$\\text{\\$${amount}}$`);

  let output = '';
  let mode: 'inline' | 'display' | null = null;
  let bodyStart = -1;
  let cursor = 0;

  while (cursor < source.length) {
    if (source[cursor] !== '$' || isEscaped(source, cursor)) {
      output += source[cursor];
      cursor += 1;
      continue;
    }

    const tokenMode: 'inline' | 'display' = source[cursor + 1] === '$' ? 'display' : 'inline';
    const width = tokenMode === 'display' ? 2 : 1;
    if (mode === null) {
      mode = tokenMode;
      bodyStart = output.length + width;
      output += tokenMode === 'display' ? '$$' : '$';
      cursor += width;
      continue;
    }

    if (mode !== tokenMode) {
      output += tokenMode === 'display' ? '$$' : '$';
      cursor += width;
      continue;
    }

    const body = output.slice(bodyStart);
    output = output.slice(0, bodyStart) + normalizeMathBody(body);
    output += mode === 'display' ? '$$' : '$';
    mode = null;
    bodyStart = -1;
    cursor += width;
  }

  return output;
}


const STANDALONE_NUMBER_PATTERN = /(^|[^A-Za-z0-9_#&\\])([-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:\s*\/\s*[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))?)(%?)(?![A-Za-z0-9_])/g;

function formatPlainMathNumberSegment(segment: string): string {
  return segment.replace(STANDALONE_NUMBER_PATTERN, (_match, prefix: string, numericValue: string, percent: string) => {
    const compact = numericValue.replace(/\s+/g, '');
    const fraction = compact.match(/^([-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))\/([-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))$/);
    const body = fraction
      ? `\\dfrac{${fraction[1]}}{${fraction[2]}}`
      : compact;
    return `${prefix}$${body}${percent ? '\\%' : ''}$`;
  });
}

/**
 * QuizMoKo's math-facing display convention requires every standalone numeric
 * value in question text/options/solutions to be enclosed in math delimiters.
 * Existing LaTeX, HTML/image markup, and TikZ blocks are preserved verbatim so
 * this formatter cannot corrupt diagrams or already-valid expressions.
 */
export function normalizeMathQuestionText(value: unknown): string {
  const source = normalizeAiLatexText(value);
  let output = '';
  let plain = '';

  const flushPlain = () => {
    if (!plain) return;
    output += formatPlainMathNumberSegment(plain);
    plain = '';
  };

  const findClosingDelimiter = (start: number, delimiter: '$' | '$$'): number => {
    for (let cursor = start + delimiter.length; cursor < source.length; cursor += 1) {
      if (source[cursor] !== '$' || isEscaped(source, cursor)) continue;
      if (delimiter === '$$') {
        if (source[cursor + 1] === '$') return cursor;
        continue;
      }
      if (source[cursor + 1] !== '$') return cursor;
      cursor += 1;
    }
    return -1;
  };

  for (let cursor = 0; cursor < source.length;) {
    if (source.startsWith('[TIKZ]', cursor)) {
      flushPlain();
      const end = source.indexOf('[/TIKZ]', cursor + 6);
      if (end < 0) {
        output += source.slice(cursor);
        break;
      }
      output += source.slice(cursor, end + 7);
      cursor = end + 7;
      continue;
    }

    if (source[cursor] === '<') {
      const end = source.indexOf('>', cursor + 1);
      if (end >= 0) {
        flushPlain();
        output += source.slice(cursor, end + 1);
        cursor = end + 1;
        continue;
      }
    }

    if (source[cursor] === '$' && !isEscaped(source, cursor)) {
      const delimiter: '$' | '$$' = source[cursor + 1] === '$' ? '$$' : '$';
      const closing = findClosingDelimiter(cursor, delimiter);
      if (closing >= 0) {
        flushPlain();
        output += source.slice(cursor, closing + delimiter.length);
        cursor = closing + delimiter.length;
        continue;
      }

      // An unmatched dollar sign followed by a number is almost always source
      // currency, not an intended opening math delimiter. Convert it safely.
      const currency = source.slice(cursor).match(/^\$([-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))/);
      if (currency) {
        flushPlain();
        output += `$\\text{\\$${currency[1]}}$`;
        cursor += currency[0].length;
        continue;
      }
    }

    plain += source[cursor];
    cursor += 1;
  }

  flushPlain();
  return output;
}


export function validateLatexText(value: unknown): LatexIssue[] {
  const text = String(value ?? '');
  const issues: LatexIssue[] = [];
  let mode: 'inline' | 'display' | null = null;
  let openingIndex = -1;
  let braceDepth = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === '$' && !isEscaped(text, index)) {
      const tokenMode: 'inline' | 'display' = text[index + 1] === '$' ? 'display' : 'inline';
      const width = tokenMode === 'display' ? 2 : 1;
      if (mode === null) {
        mode = tokenMode;
        openingIndex = index;
        braceDepth = 0;
      } else if (mode === tokenMode) {
        const contentStart = openingIndex + (mode === 'display' ? 2 : 1);
        const content = text.slice(contentStart, index).trim();
        if (!content) {
          issues.push({ code: 'empty_math', message: 'Empty LaTeX delimiters are not allowed.', index: openingIndex });
        }
        if (braceDepth !== 0) {
          issues.push({ code: 'unbalanced_brace', message: 'A LaTeX expression has unbalanced braces.', index: openingIndex });
        }
        mode = null;
        openingIndex = -1;
        braceDepth = 0;
      } else {
        issues.push({ code: 'mixed_delimiter', message: 'Inline and display math delimiters are mixed.', index });
      }
      index += width;
      continue;
    }

    if (mode !== null && !isEscaped(text, index)) {
      if (char === '{') braceDepth += 1;
      if (char === '}') {
        braceDepth -= 1;
        if (braceDepth < 0) {
          issues.push({ code: 'unbalanced_brace', message: 'A LaTeX expression closes a brace that was never opened.', index });
          braceDepth = 0;
        }
      }
    }
    index += 1;
  }

  if (mode !== null) {
    issues.push({ code: 'unbalanced_delimiter', message: 'A LaTeX dollar delimiter is not closed.', index: openingIndex });
  }

  // Find commands that are outside any math segment.
  let outside = '';
  mode = null;
  for (index = 0; index < text.length; index += 1) {
    if (text[index] === '$' && !isEscaped(text, index)) {
      const tokenMode: 'inline' | 'display' = text[index + 1] === '$' ? 'display' : 'inline';
      if (mode === null) mode = tokenMode;
      else if (mode === tokenMode) mode = null;
      if (tokenMode === 'display') index += 1;
      outside += ' ';
    } else {
      outside += mode === null ? text[index] : ' ';
    }
  }

  for (const match of outside.matchAll(BARE_COMMAND_PATTERN)) {
    issues.push({
      code: 'bare_latex_command',
      message: `LaTeX command ${match[0]} appears outside math delimiters.`,
      index: match.index
    });
  }

  if (/\\n(?=\$|\\(?:d?frac|sqrt|begin|left))/i.test(text)) {
    issues.push({
      code: 'literal_newline_escape',
      message: 'The text contains a literal \\n sequence before LaTeX instead of a parsed newline.'
    });
  }

  if (/\$\\text\{\$/.test(text) || /\$\$[^$]*\$[^$]*\$\$/s.test(text)) {
    issues.push({ code: 'nested_delimiter', message: 'Nested dollar delimiters are not allowed.' });
  }

  return issues;
}

export function hasBalancedLatexDelimiters(value: unknown): boolean {
  return !validateLatexText(value).some(issue =>
    issue.code === 'unbalanced_delimiter'
    || issue.code === 'mixed_delimiter'
    || issue.code === 'empty_math'
    || issue.code === 'unbalanced_brace'
    || issue.code === 'nested_delimiter'
  );
}

export function validateQuestionLatex(question: any): LatexIssue[] {
  if (!question || typeof question !== 'object') return [];
  const issues: LatexIssue[] = [];
  const fields: Array<[string, unknown]> = [
    ['question', question.question ?? question.raw_text ?? question.statement],
    ['solution', question.solution]
  ];
  if (Array.isArray(question.options)) {
    question.options.forEach((option: unknown, index: number) => fields.push([`options[${index}]`, option]));
  }
  if (String(question.type || '').toLowerCase() !== 'identification') {
    fields.push(['answer', question.answer]);
  }

  for (const [field, value] of fields) {
    if (value === undefined || value === null || value === '') continue;
    for (const issue of validateLatexText(value)) {
      issues.push({ ...issue, message: `${field}: ${issue.message}` });
    }
  }
  return issues;
}
