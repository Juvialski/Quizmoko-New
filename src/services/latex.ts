/**
 * Preserves AI-authored LaTeX verbatim. Formatting correctness belongs in the
 * model prompt; broad post-processing can corrupt otherwise balanced math.
 */
export function normalizeAiLatexText(value: unknown): string {
  return String(value ?? '');
}

export function hasBalancedLatexDelimiters(value: unknown): boolean {
  const text = String(value ?? '');
  let mode: 'inline' | 'display' | null = null;
  let openingIndex = -1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '$') continue;
    let precedingSlashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) precedingSlashes += 1;
    if (precedingSlashes % 2 === 1) continue;
    const tokenStart = index;
    const tokenMode = text[index + 1] === '$' ? 'display' : 'inline';
    if (tokenMode === 'display') index += 1;
    if (mode === null) {
      mode = tokenMode;
      openingIndex = tokenStart;
    } else if (mode === tokenMode) {
      const delimiterWidth = mode === 'display' ? 2 : 1;
      const content = text.slice(openingIndex + delimiterWidth, tokenStart).trim();
      if (!content || /^(?:or|and|to|through|,|;|:)$/i.test(content)) return false;
      mode = null;
      openingIndex = -1;
    }
    else return false;
  }
  return mode === null;
}
