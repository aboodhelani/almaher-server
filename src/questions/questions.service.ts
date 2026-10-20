import { Inject, Injectable } from '@nestjs/common';
import { QUESTIONS_STORE } from '../database/questions-store';
import type { QuestionsStore } from '../database/questions-store';
import { QuranService } from '../quran/quran.service';
import { QuestionGeneratorService } from './question-generator.service';
import { validateQuestion } from './question-validation';
import { QuestionData, QuestionType } from './question.types';

/** The question bank: generate, add, list and delete. */
@Injectable()
export class QuestionsService {
  constructor(
    private readonly quran: QuranService,
    private readonly generator: QuestionGeneratorService,
    @Inject(QUESTIONS_STORE) private readonly store: QuestionsStore,
  ) {}

  /** Generated questions, not saved — the dashboard saves the ones it keeps. */
  generate(type: QuestionType, count: number) {
    return this.generator.generate(type, count).map((q) => this.withAyahs(q));
  }

  /** Checks a question (as for [add]) without saving it to the bank. */
  prepare(body: unknown) {
    return this.withAyahs(
      validateQuestion(
        body,
        this.quran,
        (page) => this.generator.pageQuestion(page),
        (ref) => this.generator.sardQuestion(ref),
        (refs) => this.generator.rightLeftQuestion(refs),
      ),
    );
  }

  async add(body: unknown) {
    const saved = await this.store.create(
      validateQuestion(
        body,
        this.quran,
        (page) => this.generator.pageQuestion(page),
        (ref) => this.generator.sardQuestion(ref),
        (refs) => this.generator.rightLeftQuestion(refs),
      ),
    );
    return this.withAyahs(saved);
  }

  async list(type?: QuestionType, limit?: number) {
    return (await this.store.list(type, limit)).map((q) => this.withAyahs(q));
  }

  /**
   * [count] questions of [type] for a match: saved bank questions first (in
   * random order), topped up with freshly generated ones.
   */
  /** [count] questions for a match: saved ones first (unless [generatedOnly]), topped up with generated ones. */
  async forMatch(type: QuestionType, count: number, generatedOnly = false) {
    const saved = generatedOnly ? [] : shuffle(await this.store.list(type, 500)).slice(0, count);
    const fresh = this.generator.generate(type, count - saved.length);
    return [...saved, ...fresh].map((q) => this.withAyahs(q));
  }

  count() {
    return this.store.count();
  }

  remove(id: string) {
    return this.store.remove(id);
  }

  /** Adds each ref's surah name and text for display. */
  private withAyahs<T extends QuestionData>(q: T) {
    return {
      ...q,
      refs: q.refs.map((r) => {
        const a = this.quran.ayahs.find((x) => x.surah === r.surah && x.numberInSurah === r.ayah);
        return {
          ...r,
          surahName: this.quran.surah(r.surah).nameArabic,
          text: a?.text ?? '',
        };
      }),
    };
  }
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
