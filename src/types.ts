export type CanonicalQuestionType =
  | 'multiple_choice'
  | 'multiple_choice_multi'
  | 'true_false'
  | 'identification'
  | 'open_ended'
  | 'graphing';

export type GradeStatus =
  | 'graded'
  | 'pending'
  | 'retryable_error'
  | 'invalid_response';

export interface WorksheetQuestionSource {
  source_file?: string;
  page_number?: number;
  original_index: string;
  crop_or_image_reference?: string;
}

export interface QuestionVerification {
  answer_source: 'golden_key' | 'solver_consensus' | 'manual';
  verification_status: 'verified' | 'review_required' | 'unverified' | 'invalid';
  reason?: string;
  solver_models?: string[];
  [key: string]: unknown;
}

export interface NumericAnswerPolicy {
  /** Allow a percent-marked response. The mark is otherwise significant. */
  allow_percentage?: boolean;
  /** Treat (for example) 50% as numerically equivalent to 0.5. */
  percentage_as_fraction?: boolean;
  required_unit?: string;
  accepted_units?: string[];
  allow_omitted_unit?: boolean;
  unit_case_sensitive?: boolean;
}

export interface NormalizedQuestion {
  id: string;
  type: CanonicalQuestionType;
  question: string;
  options: string[];
  answer: string | string[];
  points: number;
  grading_mode?: 'deterministic' | 'semantic';
  solution?: string;
  source?: WorksheetQuestionSource;
  verification?: QuestionVerification;
  answer_policy?: NumericAnswerPolicy;
}

export type QuestionValidationCode =
  | 'invalid_question'
  | 'missing_question_text'
  | 'unsupported_question_type'
  | 'invalid_options'
  | 'invalid_option_count'
  | 'empty_option'
  | 'duplicate_options'
  | 'missing_answer'
  | 'conflicting_answer_aliases'
  | 'invalid_answer'
  | 'ambiguous_answer'
  | 'answer_out_of_range'
  | 'duplicate_selection'
  | 'invalid_points'
  | 'invalid_true_false_mapping'
  | 'invalid_source';

export interface QuestionValidationError {
  code: QuestionValidationCode;
  message: string;
  field?: string;
  value?: unknown;
}

export type QuestionValidationResult =
  | { valid: true; question: NormalizedQuestion; errors: [] }
  | { valid: false; question?: undefined; errors: QuestionValidationError[] };

export type QuestionStorageNormalizationResult =
  | { valid: true; question: Question; normalized: NormalizedQuestion; errors: [] }
  | { valid: false; question?: undefined; normalized?: undefined; errors: QuestionValidationError[] };

export interface AnswerAttemptIdentity {
  quiz_id: string;
  session_id: string;
  question_index: number;
  answer_revision: number;
  answer_digest: string;
  snapshot_digest?: string;
}

export interface GradeResponse extends AnswerAttemptIdentity {
  success: boolean;
  grade_status: GradeStatus;
  is_correct?: boolean;
  score_fraction?: number;
  earned_points?: number;
  feedback?: string;
  ai_feedback?: string;
  grade_proof?: string;
  retryable?: boolean;
  error?: string;
}

export interface GradedDetail {
  question_index: number;
  question: string;
  type: CanonicalQuestionType;
  user_answer: unknown;
  correct_answer?: string | string[];
  grade_status: GradeStatus;
  answer_revision: number;
  answer_digest: string;
  snapshot_digest?: string;
  question_digest?: string;
  is_correct?: boolean;
  score_fraction?: number;
  points: number;
  earned_points?: number;
  ai_feedback?: string;
  grade_proof?: string;
}

export interface QuizScoreSummary {
  earned_points: number;
  max_points: number;
  accuracy_pct: number;
  grading_complete: boolean;
  incomplete_question_indexes: number[];
}

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
  id?: string;
  question: string;
  options?: string[];
  answer?: unknown;
  correct_answer?: unknown;
  correctAnswer?: unknown;
  correct_answer_letter?: string;
  correctAnswerLetter?: string;
  type?: string;
  solution?: string;
  points?: number;
  grading_mode?: 'deterministic' | 'semantic' | string;
  source?: WorksheetQuestionSource;
  verification?: QuestionVerification;
  answer_policy?: NumericAnswerPolicy;
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
  graded_details?: Array<GradedDetail | null> | any[];
  created_at?: string;
  // Legacy aliases are retained for older AI Studio exports.
  score?: number;
  total?: number;
  details?: Array<GradedDetail | null> | any[];
  timestamp?: string;
  total_questions?: number;
  submitted_at?: string;
  answers?: Record<string, any>;
  solution_snapshots?: Record<string, string[]>;
  answer_revisions?: Record<string, number>;
  session_revision?: number;
  finalized_at?: string;
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
