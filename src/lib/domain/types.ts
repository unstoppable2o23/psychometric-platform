/**
 * Shared domain vocabulary. Imported by both Server and Client Components, so this
 * module must stay free of server-only imports, secrets, and database access.
 */

export const USER_ROLES = ['student', 'teacher', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Dimension families are kept separate so they are never merged into one
 *  misleading "overall ability" number (see README: measurement integrity). */
export const DIMENSION_KINDS = ['aptitude', 'interest'] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];

export const QUESTION_TYPES = [
  'likert', // 1-5 self-report scale
  'single_choice', // correct/incorrect reasoning item
  'multi_select', // scored by exact match against a correct set
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const SESSION_STATUSES = ['in_progress', 'submitted', 'expired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  'assigned',
  'in_progress',
  'completed',
  'expired',
  'revoked',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const REPORT_STATUSES = ['pending', 'generating', 'ready', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** The five-point self-report scale shown to students. Ordinal, not interval:
 *  we only use it for ranking a student against their own dimensions. */
export const LIKERT_LABELS = [
  'Not at all like me',
  'A little like me',
  'Sometimes like me',
  'Often like me',
  'Very much like me',
] as const;
export const LIKERT_MIN = 1;
export const LIKERT_MAX = 5;

/** Academic streams explored by the Stream Selector assessment. */
export const STREAM_KEYS = ['science', 'commerce', 'arts', 'vocational'] as const;
export type StreamKey = (typeof STREAM_KEYS)[number];

/** A single scored dimension belonging to one assessment version. */
export interface Dimension {
  key: string;
  label: string;
  kind: DimensionKind;
  /** Plain-language explanation shown to students and in the PDF report. */
  description: string;
  /** Relative importance when rolling dimensions up into a stream fit. */
  weight: number;
}

/** An answer option. `isCorrect` is never serialised to the client. */
export interface QuestionOption {
  id: string;
  label: string;
  /** For likert items, the numeric value this option contributes (1-5). */
  value: number | null;
  isCorrect: boolean;
}

/**
 * A question as delivered to the student. Correct-answer flags and scoring
 * internals are stripped by `toStudentQuestion` before crossing the wire.
 */
export interface Question {
  id: string;
  dimensionKey: string;
  type: QuestionType;
  prompt: string;
  /** Short helper text, when the item needs one. */
  helpText: string | null;
  options: QuestionOption[];
  /** Likert items store their scale label set here; unused otherwise. */
  scaleLabels: readonly string[] | null;
}

export interface AssessmentVersionMeta {
  id: string;
  slug: string;
  title: string;
  description: string;
  version: number;
  durationSeconds: number;
  questionCount: number;
  instructions: string;
  minCompletionRatio: number;
}

export interface AssignmentMeta {
  id: string;
  tokenExpiresAt: string | null;
  maxAttempts: number;
  status: AssignmentStatus;
}

/** Server-computed clock, returned with every session read so the client can
 *  correct for drift instead of trusting a purely local countdown. */
export interface SessionClock {
  /** Epoch ms when the attempt was started, fixed by the server. */
  startedAtMs: number;
  /** Epoch ms at which the attempt is auto-submitted. */
  expiresAtMs: number;
  /** Epoch ms the server generated this response. */
  serverNowMs: number;
  durationSeconds: number;
  remainingSeconds: number;
}

export interface ActiveSession {
  sessionId: string;
  assignmentId: string;
  attemptNumber: number;
  status: SessionStatus;
  clock: SessionClock;
  assessment: AssessmentVersionMeta;
  questions: Question[];
  /** Question ids already answered, for restore-after-refresh. */
  answeredIds: string[];
  /**
   * The student's own saved selections. Returned on resume so a refresh does not
   * appear to discard work. These are the candidate's answers, never the answer
   * key, so this is safe to serialise to the browser.
   */
  answers: { questionId: string; value: string }[];
  flaggedIds: string[];
  minCompletionRatio: number;
}

export interface SavedAnswer {
  questionId: string;
  /** Selected option id (single_choice / multi_select) or 1-5 (likert). */
  value: number | string;
}

export interface DimensionScore {
  key: string;
  label: string;
  kind: DimensionKind;
  description: string;
  /** 0-100, normalised within the student against the version's own item pool. */
  normalizedScore: number;
  /** Raw points earned, before normalisation. */
  rawScore: number;
  maxRawScore: number;
  itemsAnswered: number;
  itemsTotal: number;
  /** Rank within this student's own profile, 1 = strongest. */
  rank: number;
}

export interface StreamMatch {
  stream: StreamKey;
  label: string;
  /** 0-100 suitability indicator. A relative fit score, not a probability. */
  fitScore: number;
  /** 0-3, used only to band the narrative. Not a validated cut-off. */
  band: 1 | 2 | 3;
  headline: string;
  rationale: string[];
  /** Human-readable "Label (score/100, weight)" strings for display. */
  contributingDimensions: string[];
  /**
   * The dimension keys behind `contributingDimensions`, strongest first.
   *
   * Kept separately from the display strings on purpose: the narrative has to
   * look content up by key, and parsing a key back out of a rendered label
   * ("Numerical Aptitude (85/100, weight 1)") silently fails.
   */
  contributingDimensionKeys: string[];
}

export interface AssessmentResult {
  sessionId: string;
  reportReference: string;
  assessmentTitle: string;
  assessmentVersion: number;
  completedAt: string;
  dimensions: DimensionScore[];
  streams: StreamMatch[];
  strongestDimensions: DimensionScore[];
  developmentDimensions: DimensionScore[];
  /** Plain-language summary paragraphs rendered on the interpretation page. */
  interpretation: string[];
  recommendations: { title: string; detail: string; dimensionKey?: string }[];
  actionPlan: { window: string; items: string[] }[];
  discussionQuestions: string[];
  disclaimer: string;
}

export interface ReportRef {
  id: string;
  reference: string;
  status: ReportStatus;
  generatedAt: string | null;
  error: string | null;
}
