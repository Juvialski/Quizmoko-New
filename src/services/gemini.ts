import { GoogleGenAI } from '@google/genai';

export function getGeminiClient(customApiKey?: string) {
  const apiKey = customApiKey || process.env.GEMINI_API_KEY;
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

  // Map to the correct, existing Gemini models
  if (model.includes('gemini-3.1-flash-lite') || model.includes('gemini-3.5-flash-lite') || model.includes('gemini-2.5-flash-lite')) {
    return 'gemini-3.1-flash-lite';
  }
  if (model.includes('gemini-3.1-pro-preview') || model.includes('pro')) {
    return 'gemini-3.1-pro-preview';
  }
  if (model.includes('gemini-3.6-flash') || model.includes('gemini-3.5-flash') || model.includes('gemini-3.0-flash') || model.includes('gemini-2.5-flash') || model.includes('flash')) {
    return 'gemini-3.6-flash';
  }

  return 'gemini-3.6-flash';
}

export function fixJsonLatexEscapes(jsonStr: string): string {
  let result = '';
  let inString = false;

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
      if (nextChar === '\\' || nextChar === '"' || nextChar === '/' || nextChar === 'b' || nextChar === 'f' || nextChar === 'n' || nextChar === 'r' || nextChar === 't' || nextChar === 'u') {
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

export function sanitizeNewlines(data: any): any {
  if (typeof data === 'string') {
    return data
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\f/g, '')
      .replace(/\u000c/g, '');
  }
  if (Array.isArray(data)) {
    return data.map(item => sanitizeNewlines(item));
  }
  if (data && typeof data === 'object') {
    const cleaned: Record<string, any> = {};
    for (const key of Object.keys(data)) {
      cleaned[key] = sanitizeNewlines(data[key]);
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
    return sanitizeNewlines(parsed);
  } catch (e1) {
    try {
      const lineFixed = cleaned.replace(/\r?\n/g, '\\n');
      const fixed = fixJsonLatexEscapes(lineFixed);
      const parsed = JSON.parse(fixed);
      return sanitizeNewlines(parsed);
    } catch (e2) {
      try {
        const parsed = JSON.parse(cleaned);
        return sanitizeNewlines(parsed);
      } catch (e3) {
        console.warn('safeParseJSON failed after all repair attempts:', e3, '\nRaw text sample:', rawText.substring(0, 300));
        return null;
      }
    }
  }
}
