const TIKZ_BLOCK_PATTERN = /\[TIKZ\]([\s\S]*?)\[\/TIKZ\]/gi;

export interface TikzRequirementCheck {
  valid: boolean;
  count: number;
  reason?: string;
}

export function buildTikzRequirementPlan(totalQuestions: number, requestedDiagrams: number): boolean[] {
  const total = Math.max(0, Math.floor(Number(totalQuestions) || 0));
  const requested = Math.min(total, Math.max(0, Math.floor(Number(requestedDiagrams) || 0)));
  const plan = Array<boolean>(total).fill(false);
  if (requested === 0 || total === 0) return plan;

  // Spread requested diagrams through the quiz instead of front-loading them
  // into the first generation batch. Because total/requested >= 1, these
  // midpoint indices are distinct whenever requested <= total.
  for (let index = 0; index < requested; index += 1) {
    const position = Math.min(total - 1, Math.floor(((index + 0.5) * total) / requested));
    plan[position] = true;
  }
  return plan;
}

export function extractTikzBlocks(value: unknown): string[] {
  const source = String(value ?? '');
  return Array.from(source.matchAll(TIKZ_BLOCK_PATTERN), match => String(match[1] || '').trim());
}

export function hasTikzDiagram(value: unknown): boolean {
  return extractTikzBlocks(value).some(block => block.length > 0);
}

export function validateTikzRequirement(value: unknown, required: boolean): TikzRequirementCheck {
  const blocks = extractTikzBlocks(value);
  if (!required) {
    return blocks.length === 0
      ? { valid: true, count: 0 }
      : { valid: false, count: blocks.length, reason: 'This question was not assigned a diagram but contains a [TIKZ] block.' };
  }

  if (blocks.length !== 1) {
    return {
      valid: false,
      count: blocks.length,
      reason: blocks.length === 0
        ? 'This question requires exactly one TikZ diagram, but none was returned.'
        : 'This question requires exactly one TikZ diagram, but multiple [TIKZ] blocks were returned.'
    };
  }

  const code = blocks[0];
  if (!code) return { valid: false, count: 1, reason: 'The required [TIKZ] block is empty.' };

  // QuizMoKo renders with the base TikZ package. pgfplots/axis output will not
  // compile in the current Kroki wrapper unless extra packages are introduced.
  if (/\\begin\s*\{axis\}|\\addplot\b|pgfplots/i.test(code)) {
    return {
      valid: false,
      count: 1,
      reason: 'The TikZ diagram uses pgfplots/axis commands, which are unsupported by the current renderer. Use base TikZ drawing/plot commands only.'
    };
  }

  if (!/\\(?:draw|path|node|fill|filldraw|coordinate)\b/i.test(code)) {
    return {
      valid: false,
      count: 1,
      reason: 'The TikZ block does not contain a usable drawing command.'
    };
  }

  return { valid: true, count: 1 };
}
