export const PRIMARY_FLASH_LITE_MODEL = 'gemini-3.5-flash-lite';
export const PEER_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite';

export type AiTaskName =
  | 'document_extraction'
  | 'answer_key_extraction'
  | 'question_drafting'
  | 'question_solving'
  | 'question_adjudication'
  | 'latex_polish'
  | 'semantic_grading'
  | 'student_explanation';

export type AiThinkingLevel = 'minimal' | 'high';

export interface AiTaskProfile {
  task: AiTaskName;
  promptVersion: string;
  thinkingLevel: AiThinkingLevel;
  maxOutputTokens: number;
}

const PROFILES: Record<AiTaskName, AiTaskProfile> = {
  document_extraction: {
    task: 'document_extraction',
    promptVersion: 'document-extraction-v2',
    thinkingLevel: 'minimal',
    maxOutputTokens: 32_768
  },
  answer_key_extraction: {
    task: 'answer_key_extraction',
    promptVersion: 'answer-key-extraction-v2',
    thinkingLevel: 'minimal',
    maxOutputTokens: 8_192
  },
  question_drafting: {
    task: 'question_drafting',
    promptVersion: 'question-drafting-v3',
    thinkingLevel: 'high',
    maxOutputTokens: 16_384
  },
  question_solving: {
    task: 'question_solving',
    promptVersion: 'question-solving-v3',
    thinkingLevel: 'high',
    maxOutputTokens: 16_384
  },
  question_adjudication: {
    task: 'question_adjudication',
    promptVersion: 'question-adjudication-v2',
    thinkingLevel: 'high',
    maxOutputTokens: 12_288
  },
  latex_polish: {
    task: 'latex_polish',
    promptVersion: 'latex-polish-v3',
    thinkingLevel: 'minimal',
    maxOutputTokens: 12_288
  },
  semantic_grading: {
    task: 'semantic_grading',
    promptVersion: 'semantic-grading-v3',
    thinkingLevel: 'high',
    maxOutputTokens: 4_096
  },
  student_explanation: {
    task: 'student_explanation',
    promptVersion: 'student-explanation-v2',
    thinkingLevel: 'high',
    maxOutputTokens: 2_048
  }
};

export function getAiTaskProfile(task: AiTaskName): AiTaskProfile {
  return PROFILES[task];
}

/**
 * Gemini 3.5 and 3.1 Flash-Lite support `minimal` and `high` thinking levels.
 * Keep the task profile here so routes cannot accidentally use weaker settings.
 */
export function buildAiTaskConfig(
  task: AiTaskName,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const profile = getAiTaskProfile(task);
  return {
    thinkingConfig: {
      thinkingLevel: profile.thinkingLevel
    },
    maxOutputTokens: profile.maxOutputTokens,
    ...overrides
  };
}

export function getFlashLiteModelPair(preferred?: string): [string, string] {
  const normalized = String(preferred || '').trim().toLowerCase();
  if (normalized === PEER_FLASH_LITE_MODEL) {
    return [PEER_FLASH_LITE_MODEL, PRIMARY_FLASH_LITE_MODEL];
  }
  return [PRIMARY_FLASH_LITE_MODEL, PEER_FLASH_LITE_MODEL];
}

export function isFlashLiteModel(model: unknown): boolean {
  const value = String(model || '').trim().toLowerCase();
  return value === PRIMARY_FLASH_LITE_MODEL || value === PEER_FLASH_LITE_MODEL;
}
