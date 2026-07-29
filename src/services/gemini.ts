import { GoogleGenAI } from '@google/genai';

export function getGeminiClient(customApiKey?: string) {
  // Google AI Studio exports historically inject API_KEY, while Render and
  // current local setups conventionally use GEMINI_API_KEY.
  const apiKey = customApiKey || process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

export function getRealModelName(modelName?: string): string {
  const model = (modelName || '').toLowerCase().trim();
  if (!model) return 'gemini-3.6-flash';

  if (model.startsWith('ollama:')) return model;

  // Preserve an explicit supported selection. Older builds collapsed every
  // Flash-Lite choice to 3.1 and every Flash choice to 3.6, which made the
  // model picker misleading and could silently move workloads between price
  // and latency tiers.
  const supportedModels = new Set([
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ]);
  if (supportedModels.has(model)) return model;

  // Compatibility aliases from older AI Studio exports.
  if (model === 'gemini-3.0-flash' || model === 'gemini-3-flash-preview') {
    return 'gemini-3.6-flash';
  }
  if (model === 'gemini-flash-latest') return 'gemini-3.5-flash';
  if (model.includes('pro')) return 'gemini-3.1-pro-preview';

  return 'gemini-3.6-flash';
}

export function fixJsonLatexEscapes(jsonStr: string): string {
  let result = '';
  let inString = false;
  const latexCommands = new Set([
    // Commands beginning with b/f/n/r/t/u need special handling because
    // those initials are also legal one-character JSON control escapes.
    'backslash', 'bar', 'because', 'begin', 'beta', 'bf', 'big', 'Big',
    'bigg', 'Bigg', 'bigcirc', 'binom', 'bmod', 'boxed', 'brace', 'bullet',
    'flat', 'forall', 'frac',
    'nabla', 'natural', 'ne', 'neg', 'neq', 'ni', 'nmid', 'not', 'notin',
    'nparallel', 'nu',
    'rangle', 'rceil', 'Re', 'rightarrow', 'Rightarrow', 'rfloor', 'rho',
    'right', 'rm',
    'tan', 'text', 'textbf', 'textit', 'texttt', 'tfrac', 'therefore',
    'theta', 'times', 'to', 'triangle',
    'underbrace', 'underline', 'union', 'uparrow', 'Uparrow', 'upsilon',
    // Common commands with unambiguous (non-control-escape) initials.
    'cdot', 'cos', 'dfrac', 'div', 'displaystyle', 'end', 'ge', 'geq',
    'infty', 'left', 'le', 'leq', 'log', 'mathrm', 'overline', 'pi',
    'sin', 'sqrt', 'sum', 'vec'
  ]);

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (char === '"') {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && jsonStr[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        inString = !inString;
      }
      result += char;
    } else if (inString && char === '\\') {
      const nextChar = i + 1 < jsonStr.length ? jsonStr[i + 1] : '';
      const commandMatch = jsonStr.slice(i + 1).match(/^([A-Za-z]+)/);
      const command = commandMatch?.[1] || '';
      const isKnownLatexCommand = latexCommands.has(command);
      const isUnicodeEscape = nextChar === 'u' && /^[0-9a-fA-F]{4}/.test(jsonStr.slice(i + 2, i + 6));
      const isJsonControlEscape = ['b', 'f', 'n', 'r', 't'].includes(nextChar) && !isKnownLatexCommand;

      if (nextChar === '\\' || nextChar === '"' || nextChar === '/' || isUnicodeEscape || isJsonControlEscape) {
        result += char + nextChar;
        i++; // skip nextChar
      } else {
        result += '\\\\';
      }
    } else if (inString && char === '\n') {
      result += '\\n';
    } else if (inString && char === '\r') {
      result += '\\r';
    } else if (inString && char === '\t') {
      result += '\\t';
    } else {
      result += char;
    }
  }
  return result;
}

export function sanitizeParsedJSON(data: any): any {
  if (typeof data === 'string') {
    // JSON.parse already converts valid \n and \r escapes to real control
    // characters. Do not replace literal "\\n"/"\\r" sequences here: doing
    // so corrupts valid LaTeX commands such as \neq, \nabla, \right and \rho.
    return data.replace(/\u000c/g, '');
  }
  if (Array.isArray(data)) {
    return data.map(item => sanitizeParsedJSON(item));
  }
  if (data && typeof data === 'object') {
    const cleaned: Record<string, any> = {};
    for (const key of Object.keys(data)) {
      cleaned[key] = sanitizeParsedJSON(data[key]);
    }
    return cleaned;
  }
  return data;
}

export function safeParseJSON(rawText: string): any {
  if (!rawText || typeof rawText !== 'string') return null;

  let cleaned = rawText.replace(/```json/gi, '').replace(/```/gi, '').trim();

  const firstArray = cleaned.indexOf('[');
  const lastArray = cleaned.lastIndexOf(']');
  const firstObj = cleaned.indexOf('{');
  const lastObj = cleaned.lastIndexOf('}');

  let start = -1;
  let end = -1;

  if (firstArray !== -1 && (firstObj === -1 || firstArray < firstObj)) {
    start = firstArray;
    end = lastArray;
  } else if (firstObj !== -1) {
    start = firstObj;
    end = lastObj;
  }

  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.substring(start, end + 1);
  }

  try {
    const fixed = fixJsonLatexEscapes(cleaned);
    const parsed = JSON.parse(fixed);
    return sanitizeParsedJSON(parsed);
  } catch (e1) {
    try {
      const parsed = JSON.parse(cleaned);
      return sanitizeParsedJSON(parsed);
    } catch (e2) {
      console.warn('safeParseJSON failed after all repair attempts:', e2, '\nRaw text sample:', rawText.substring(0, 300));
      return null;
    }
  }
}
