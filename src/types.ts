export interface User {
  uid: string;
  email: string;
  name: string;
  role: 'admin' | 'teacher' | 'student';
  rmx_authorized?: boolean;
  total_ai_calls?: number;
  [key: string]: any;
}

export interface Question {
  question: string;
  options?: string[];
  answer?: any;
  correct_answer?: any;
  correctAnswer?: any;
  correct_answer_letter?: string;
  type?: string;
  solution?: string;
  points?: number;
  [key: string]: any;
}

export interface Quiz {
  id: string;
  user_id?: string;
  title: string;
  subject?: string;
  time_limit?: number;
  quiz_mode?: string;
  require_solution?: boolean;
  created_at?: string;
  questions: Question[];
  [key: string]: any;
}

export interface QuizResult {
  id: string;
  quiz_id?: string;
  quiz_title?: string;
  session_id?: string;
  student_name?: string;
  total_score?: number;
  max_score?: number;
  graded_details?: any[];
  created_at?: string;
  // Legacy aliases are retained for older AI Studio exports.
  score?: number;
  total?: number;
  details?: any[];
  timestamp?: string;
  total_questions?: number;
  submitted_at?: string;
  answers?: Record<string, any>;
  solution_snapshots?: Record<string, string[]>;
  time_active_seconds?: number;
  time_paused_seconds?: number;
  total_duration_seconds?: number;
  accuracy_pct?: number;
  completion_note?: string;
  is_in_progress?: boolean;
  /** SHA-256 hash only. The raw result access token is never persisted. */
  access_token_hash?: string;
  [key: string]: any;
}

export interface LiveSessionStudent {
  name: string;
  student_name: string;
  current_q: number;
  current_question: number;
  total_questions: number;
  score: number;
  status: string;
  last_active: number;
  whiteboard_disabled: boolean;
  [key: string]: any;
}

export interface LiveSessionState {
  paused: boolean;
  terminated: boolean;
  sessions: Record<string, LiveSessionStudent>;
}
