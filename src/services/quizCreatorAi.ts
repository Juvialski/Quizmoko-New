import type { Quiz, User } from '../types.ts';
import { users } from '../store/db.ts';
import { getGeminiClient, sanitizeApiKey } from './gemini.ts';

type GeminiClient = NonNullable<ReturnType<typeof getGeminiClient>>;

export function canUserManageApiKeys(user: Partial<User> | null | undefined): boolean {
  if (!user) return false;
  const role = typeof user.role === 'string' ? user.role.toLowerCase() : '';
  if (role === 'student') return false;
  return role === 'admin' || role === 'teacher' || (!role && Boolean(user.uid));
}

/**
 * Resolves an AI key only from the authoritative quiz creator's server-side
 * profile. Request bodies and browser storage are deliberately excluded.
 */
export function getQuizCreatorApiKey(
  quiz: Pick<Quiz, 'user_id'> | null | undefined
): string {
  const creatorId = typeof quiz?.user_id === 'string' && quiz.user_id.trim()
    ? quiz.user_id.trim()
    : 'teacher_test';
  const creator = users.get(creatorId);
  if (!canUserManageApiKeys(creator)) return '';
  const storedKey = typeof creator?.stored_custom_key === 'string'
    ? creator.stored_custom_key
    : '';
  return sanitizeApiKey(storedKey) || '';
}

export function getQuizCreatorGeminiClients(
  quiz: Pick<Quiz, 'user_id'> | null | undefined
): GeminiClient[] {
  const apiKey = getQuizCreatorApiKey(quiz);
  try {
    // getGeminiClient will use sanitized creator apiKey or fall back to GEMINI_API_KEY / API_KEY
    const client = getGeminiClient(apiKey);
    return client ? [client] : [];
  } catch (error) {
    console.warn('[Grading] The quiz creator\'s Gemini client is unavailable:', error);
    return [];
  }
}
