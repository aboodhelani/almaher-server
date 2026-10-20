export const QUESTION_TYPES = [
  'what_do_you_know',
  'ayah_number',
  'auction',
  'similar',
  'sard',
  'right_left',
  'buzzer',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Default for every question; the show runs about a minute per question. */
export const DEFAULT_TIME_LIMIT_SECONDS = 60;

export interface AyahRef {
  surah: number;
  ayah: number;
}

/**
 * One question of any round. `refs` are the ayahs involved: the asked ayah
 * (رقم الآيات), the expected answers (ماذا تعرف، المزاد), the shared places
 * (المتشابهات) or the source (الجرس).
 */
export interface QuestionData {
  type: QuestionType;
  source: 'generated' | 'manual';
  /** What the host reads out. */
  prompt: string;
  /** The short expected answer. */
  answer: string;
  refs: AyahRef[];
  timeLimitSeconds: number;
  /** Round-specific extras, e.g. `{ total }` for المزاد, `{ words }` for المتشابهات. */
  meta: Record<string, unknown>;
}

export interface StoredQuestion extends QuestionData {
  id: string;
  createdAt: Date;
}
