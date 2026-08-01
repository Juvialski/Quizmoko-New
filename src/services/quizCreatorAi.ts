import type { Quiz, User } from '../types.ts';
import { users } from '../store/db.ts';
import { getGeminiClient } from './gemini.ts';

type GeminiClient = NonNullable<ReturnType<typeof getGeminiClient>>;

export function canUserManageApiKeys(user: Pick<User, 'role'> | null | undefined): boolean {
  return user?.role === 'teacher' || user?.role === 'admin';
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
  return typeof creator?.stored_custom_key === 'string'
    ? creator.stored_custom_key.trim().slice(0, 512)
    : '';
}

export function getQuizCreatorGeminiClients(
  quiz: Pick<Quiz, 'user_id'> | null | undefined
): GeminiClient[] {
  const apiKey = getQuizCreatorApiKey(quiz);
  if (!apiKey) return [];
  try {
    const client = getGeminiClient(apiKey);
    return client ? [client] : [];
  } catch (error) {
    console.warn('[Grading] The quiz creator\'s Gemini client is unavailable:', error);
    return [];
  }
}
