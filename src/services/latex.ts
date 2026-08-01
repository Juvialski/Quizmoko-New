/**
 * Repairs common model/browser math-formatting mistakes without attempting to
 * reinterpret valid LaTeX. This is applied to AI-authored feedback and again
 * at display time for historical records created before the prompt fix.
 */
export function normalizeAiLatexText(value: unknown): string {
  let text = String(value ?? '');

  // Historical prompts accidentally encouraged forms such as `$\$$40`.
  text = text.replace(
    /\$\\\$\$?([0-9][\d,]*(?:\.\d+)?)/g,
    (_match, amount: string) => `$\\text{\\$${amount}}$`
  );

  // A raw currency marker is an unmatched MathJax `$` delimiter. Convert only
  // complete currency tokens followed by prose punctuation/space/end, leaving
  // valid expressions such as `$15$` and `$15\\%$` untouched.
  text = text.replace(
    /(^|[\s(])\$(\d[\d,]*(?:\.\d{1,2})?)(?=$|[\s.,;:!?)])/g,
    (_match, prefix: string, amount: string) => `${prefix}$\\text{\\$${amount}}$`
  );

  // Percent signs inside TeX must be escaped or they comment out the rest of
  // the math line. Wrap only raw prose percentages, not an existing `\%` form.
  text = text.replace(
    /(^|[^\d\\$])(-?\d[\d,]*(?:\.\d+)?)%(?!\s*\$)/g,
    (_match, prefix: string, amount: string) => `${prefix}$${amount}\\%$`
  );

  return text;
}
