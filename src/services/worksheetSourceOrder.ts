interface WorksheetSourceRecord {
  source?: {
    original_index?: unknown;
  };
  original_index?: unknown;
  source_id?: unknown;
  id?: unknown;
}

interface NaturalSourceKey {
  parsed: boolean;
  numeric?: bigint;
  suffix: string;
}

const SOURCE_PREFIX_PATTERN = /^(?:(?:question|q)\s*[:#.-]?\s*|#\s*)/i;
const SUFFIX_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base'
});

function isRecord(value: unknown): value is WorksheetSourceRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

function romanValue(value: string): bigint | null {
  const normalized = value.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(normalized)) return null;
  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1_000
  };
  let total = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const current = values[normalized[index]];
    const next = values[normalized[index + 1]] || 0;
    total += current < next ? -current : current;
  }
  // Accept only canonical Roman spellings so ordinary words are not treated
  // as numbered identifiers.
  const canonical = [
    ['', 'M', 'MM', 'MMM'],
    ['', 'C', 'CC', 'CCC', 'CD', 'D', 'DC', 'DCC', 'DCCC', 'CM'],
    ['', 'X', 'XX', 'XXX', 'XL', 'L', 'LX', 'LXX', 'LXXX', 'XC'],
    ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']
  ];
  const thousands = Math.floor(total / 1_000);
  const hundreds = Math.floor((total % 1_000) / 100);
  const tens = Math.floor((total % 100) / 10);
  const ones = total % 10;
  const canonicalValue = thousands <= 3
    ? `${canonical[0][thousands]}${canonical[1][hundreds]}${canonical[2][tens]}${canonical[3][ones]}`
    : '';
  return total > 0 && canonicalValue === normalized ? BigInt(total) : null;
}

/**
 * Returns the source identifier without changing its spelling. In particular,
 * leading zeroes and alphanumeric suffixes are part of the worksheet metadata.
 */
export function getWorksheetSourceIdentifier(value: unknown): string {
  if (!isRecord(value)) return textValue(value);
  const source = isRecord(value.source) ? value.source : undefined;
  return textValue(
    source?.original_index
      ?? value.original_index
      ?? value.source_id
      ?? value.id
  );
}

function naturalSourceKey(value: unknown): NaturalSourceKey {
  const raw = textValue(value);
  const comparable = raw.replace(SOURCE_PREFIX_PATTERN, '').trim();
  const numericMatch = comparable.match(/^(\d+)(.*)$/);
  if (numericMatch) {
    return {
      parsed: true,
      numeric: BigInt(numericMatch[1]),
      suffix: numericMatch[2].trim()
    };
  }
  const romanMatch = comparable.match(/^\(?([IVXLCDM]+)\)?(.*)$/i);
  if (romanMatch && (!romanMatch[2] || /^[.):\-]/.test(romanMatch[2].trim()))) {
    const numeric = romanValue(romanMatch[1]);
    if (numeric !== null) {
      return { parsed: true, numeric, suffix: romanMatch[2].trim() };
    }
  }
  return { parsed: false, suffix: '' };
}

function compareBigInts(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Compares worksheet identifiers naturally while leaving unparseable values
 * equal. The caller supplies a stable tie-breaker for the latter case.
 */
export function compareWorksheetSourceIdentifiers(left: unknown, right: unknown): number {
  const leftKey = naturalSourceKey(left);
  const rightKey = naturalSourceKey(right);
  if (leftKey.parsed !== rightKey.parsed) return leftKey.parsed ? -1 : 1;
  if (!leftKey.parsed || !rightKey.parsed) return 0;

  const numericComparison = compareBigInts(leftKey.numeric!, rightKey.numeric!);
  if (numericComparison !== 0) return numericComparison;
  return SUFFIX_COLLATOR.compare(leftKey.suffix, rightKey.suffix);
}

/**
 * Compares identifiers for matching recovery output to a requested source ID.
 * This permits legacy display prefixes such as "Question 15" while retaining
 * distinctions such as "01" versus "1" and "11a" versus "11b".
 */
export function worksheetSourceIdentifierMatchKey(value: unknown): string {
  const raw = textValue(value);
  const comparable = raw.replace(SOURCE_PREFIX_PATTERN, '').trim();
  const numericMatch = comparable.match(/^(\d+)(.*)$/);
  if (numericMatch) {
    return `numeric:${numericMatch[1]}:${numericMatch[2].trim().toLocaleLowerCase('en')}`;
  }
  return `text:${comparable.toLocaleLowerCase('en')}`;
}

export function worksheetSourceIdentifiersEqual(left: unknown, right: unknown): boolean {
  return worksheetSourceIdentifierMatchKey(left) === worksheetSourceIdentifierMatchKey(right);
}

/**
 * Sorts in place and returns the same array. Decorated indices make the
 * stable extraction-order fallback explicit even on runtimes with an
 * implementation that does not guarantee stable Array#sort.
 */
export function sortWorksheetQuestionsBySourceId<T>(
  questions: T[],
  getSourceId: (question: T) => unknown = question => getWorksheetSourceIdentifier(question)
): T[] {
  if (!Array.isArray(questions)) return questions;
  const decorated = questions.map((question, index) => ({ question, index }));
  decorated.sort((left, right) => (
    compareWorksheetSourceIdentifiers(getSourceId(left.question), getSourceId(right.question))
    || left.index - right.index
  ));
  questions.splice(0, questions.length, ...decorated.map(item => item.question));
  return questions;
}

/**
 * Gap reporting is intentionally conservative. Without a source pre-scan,
 * only a sequence that visibly starts at 1 is known to imply contiguous
 * numbering. Non-1 starts and intentional gaps therefore remain unflagged.
 */
export function findMissingPlainNumericWorksheetSourceIds(values: readonly unknown[]): string[] {
  const ids = values.map(getWorksheetSourceIdentifier);
  if (ids.length === 0 || ids.some(id => !/^(?:0|[1-9]\d*)$/.test(id))) return [];
  const numbers = ids.map(Number);
  if (
    numbers.some(value => !Number.isSafeInteger(value))
    || new Set(numbers).size !== numbers.length
    || Math.min(...numbers) !== 1
  ) return [];

  const maximum = Math.max(...numbers);
  const found = new Set(numbers);
  const missing: string[] = [];
  for (let value = 1; value <= maximum; value += 1) {
    if (!found.has(value)) missing.push(String(value));
  }
  return missing;
}
