import { QuranService } from '../quran/quran.service';
import { ayahCountLabel } from './quran-text';
import {
  AyahRef,
  DEFAULT_TIME_LIMIT_SECONDS,
  QUESTION_TYPES,
  QuestionData,
  QuestionType,
} from './question.types';

export class QuestionValidationError extends Error {}

/**
 * Checks a question sent by the dashboard and fills what can be derived
 * (the ayah text for رقم الآيات, the total for المزاد).
 */
export function validateQuestion(
  body: unknown,
  quran: QuranService,
  /** Builds the رقم الآيات question of a page (see QuestionGeneratorService). */
  pageQuestion?: (page: number) => QuestionData | null,
  /** Builds the السرد question of an ayah (see QuestionGeneratorService). */
  sardQuestion?: (ref: AyahRef) => QuestionData | null,
  /** Builds the يمين يسار question of its ayahs. */
  rightLeftQuestion?: (refs: AyahRef[]) => QuestionData | null,
  /** Builds the آية بآية question of its first ayah. */
  ayahByAyahQuestion?: (ref: AyahRef) => QuestionData | null,
): QuestionData {
  const b = (body ?? {}) as Record<string, unknown>;
  const type = b.type as QuestionType;
  if (!QUESTION_TYPES.includes(type)) throw new QuestionValidationError('invalid_type');

  const refs = parseRefs(b.refs, quran);
  let prompt = str(b.prompt);
  let answer = str(b.answer);
  const meta = isObject(b.meta) ? { ...b.meta } : {};

  const time = b.timeLimitSeconds === undefined ? DEFAULT_TIME_LIMIT_SECONDS : Number(b.timeLimitSeconds);
  if (!Number.isInteger(time) || time < 5 || time > 600) {
    throw new QuestionValidationError('invalid_time_limit');
  }

  switch (type) {
    case 'ayah_number': {
      // Given by page number: the page's first ayah, and its ayah count.
      const page = Number(b.page ?? meta.page);
      const built = Number.isInteger(page) && pageQuestion ? pageQuestion(page) : null;
      if (!built) throw new QuestionValidationError('ayah_number_needs_page');
      prompt = built.prompt;
      answer = built.answer;
      refs.splice(0, refs.length, ...built.refs);
      Object.assign(meta, built.meta);
      break;
    }
    case 'what_do_you_know':
    case 'auction':
      if (!prompt) throw new QuestionValidationError('prompt_required');
      if (refs.length === 0) throw new QuestionValidationError('answers_required');
      if (type === 'auction') meta.total = refs.length;
      if (!answer) answer = ayahCountLabel(refs.length);
      break;
    case 'similar':
      if (!prompt || !answer) throw new QuestionValidationError('prompt_and_answer_required');
      if (refs.length < 2) throw new QuestionValidationError('similar_needs_two_ayahs');
      break;
    case 'buzzer':
      if (!prompt || !answer) throw new QuestionValidationError('prompt_and_answer_required');
      break;
    case 'right_left': {
      // Given by its ayahs (an even number: half for each player).
      if (refs.length < 2 || refs.length % 2 !== 0 || !rightLeftQuestion) {
        throw new QuestionValidationError('right_left_needs_even_ayahs');
      }
      const built = rightLeftQuestion(refs);
      if (!built) throw new QuestionValidationError('right_left_ayah_not_unique');
      prompt = built.prompt;
      answer = built.answer;
      Object.assign(meta, built.meta);
      break;
    }
    case 'ayah_by_ayah': {
      // Given by its first ayah: the opening and the next ayahs are derived.
      if (refs.length !== 1 || !ayahByAyahQuestion) {
        throw new QuestionValidationError('ayah_by_ayah_needs_ayah');
      }
      const built = ayahByAyahQuestion(refs[0]);
      if (!built) throw new QuestionValidationError('ayah_by_ayah_no_next');
      prompt = built.prompt;
      answer = built.answer;
      Object.assign(meta, built.meta);
      break;
    }
    case 'sard': {
      // Given by its ayah: the opening words and last word are derived.
      if (refs.length !== 1 || !sardQuestion) throw new QuestionValidationError('sard_needs_ayah');
      const built = sardQuestion(refs[0]);
      if (!built) throw new QuestionValidationError('sard_ayah_not_unique');
      prompt = built.prompt;
      answer = built.answer;
      Object.assign(meta, built.meta);
      break;
    }
  }

  return {
    type,
    source: b.source === 'generated' ? 'generated' : 'manual',
    prompt: prompt.slice(0, 2000),
    answer: answer.slice(0, 500),
    refs,
    timeLimitSeconds: time,
    meta,
  };
}

function parseRefs(value: unknown, quran: QuranService): AyahRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 300) throw new QuestionValidationError('invalid_refs');
  return value.map((r) => {
    const ref = { surah: Number((r as AyahRef)?.surah), ayah: Number((r as AyahRef)?.ayah) };
    ayahOf(ref, quran);
    return ref;
  });
}

function ayahOf(ref: AyahRef, quran: QuranService) {
  const s = quran.surahs[ref.surah - 1];
  if (!s || !Number.isInteger(ref.ayah) || ref.ayah < 1 || ref.ayah > s.ayahCount) {
    throw new QuestionValidationError(`no_such_ayah ${ref.surah}:${ref.ayah}`);
  }
  return quran.ayahs.find((a) => a.surah === ref.surah && a.numberInSurah === ref.ayah)!;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
