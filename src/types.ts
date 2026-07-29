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
  answer?: string;
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
  student_name?: string;
  score?: number;
  total_questions?: number;
  submitted_at?: string;
  answers?: Record<string, any>;
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
