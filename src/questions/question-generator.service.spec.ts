import { join } from 'path';
import { QuranService } from '../quran/quran.service';
import { QuestionGeneratorService } from './question-generator.service';
import { QuestionValidationError, validateQuestion } from './question-validation';
import { QUESTION_TYPES } from './question.types';
import { splitWords } from './quran-text';

const quran = new QuranService();
quran.load(join(__dirname, '../../data/quran_uthmani.json'));
const gen = new QuestionGeneratorService(quran);
gen.buildIndex();

/** Deterministic random numbers. */
function seeded(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
const ayah = (s: number, a: number) =>
  quran.ayahs.find((x) => x.surah === s && x.numberInSurah === a)!;
const words = (s: number, a: number) => splitWords(ayah(s, a).text).norm;

describe('QuestionGeneratorService', () => {
  it.each(QUESTION_TYPES)('generates %s questions with a 60 second limit', (type) => {
    const qs = gen.generate(type, 5, seeded(7));
    expect(qs).toHaveLength(5);
    for (const q of qs) {
      expect(q.type).toBe(type);
      expect(q.prompt).not.toBe('');
      expect(q.answer).not.toBe('');
      expect(q.timeLimitSeconds).toBe(60);
    }
  });

  it('رقم الآيات: the prompt opens a page; the answer is that page\'s ayah count', () => {
    for (const q of gen.generate('ayah_number', 10, seeded(1))) {
      const page = Number(q.meta.page);
      const onPage = quran.ayahs.filter((a) => a.page === page);
      expect(q.prompt).toBe(onPage[0].text);
      expect(q.answer).toBe(String(onPage.length));
    }
  });

  it('ماذا تعرف / المزاد: every listed ayah fits, and none is missing', () => {
    for (const type of ['what_do_you_know', 'auction'] as const) {
      for (const q of gen.generate(type, 8, seeded(3))) {
        if (q.meta.kind === 'contains_word') {
          const w = splitWords(String(q.meta.word)).norm[0];
          for (const r of q.refs) expect(words(r.surah, r.ayah)).toContain(w);
          const all = quran.ayahs.filter((a) => splitWords(a.text).norm.includes(w));
          expect(q.refs).toHaveLength(all.length);
        } else {
          const phrase = splitWords(String(q.meta.phrase)).norm;
          const starts = (s: number, a: number) =>
            words(s, a).slice(0, phrase.length).join(' ') === phrase.join(' ');
          for (const r of q.refs) expect(starts(r.surah, r.ayah)).toBe(true);
          const all = quran.ayahs.filter((a) => starts(a.surah, a.numberInSurah));
          expect(q.refs).toHaveLength(all.length);
        }
        if (type === 'auction') expect(q.meta.total).toBe(q.refs.length);
      }
    }
  });

  it('المتشابهات: the answer opens every listed ayah, across 2+ surahs', () => {
    for (const q of gen.generate('similar', 8, seeded(5))) {
      const answer = splitWords(q.answer).norm.join(' ');
      const n = Number(q.meta.words);
      for (const r of q.refs) expect(words(r.surah, r.ayah).slice(0, n).join(' ')).toBe(answer);
      expect(new Set(q.refs.map((r) => r.surah)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('الجرس: a surah ending/opening question has exactly one answer', () => {
    for (const q of gen.generate('buzzer', 20, seeded(9))) {
      if (q.meta.kind === 'surah_length') {
        expect(Number(q.answer)).toBeGreaterThan(0);
      } else {
        expect(quran.surahs.map((s) => s.nameArabic)).toContain(q.answer);
      }
    }
  });

  it('السرد: the fewest opening words no other ayah shares; the answer is the last word', () => {
    const all = quran.ayahs.map((a) => splitWords(a.text).norm);
    for (const q of gen.generate('sard', 30, seeded(3))) {
      const { surah, ayah: n } = q.refs[0];
      const w = words(surah, n);
      const k = q.meta.words as number;
      expect(k).toBeLessThan(w.length);
      const starts = (len: number) =>
        all.filter((x) => x.slice(0, len).join(' ') === w.slice(0, len).join(' ')).length;
      expect(starts(k)).toBe(1); // unique with k words
      if (k > 1) expect(starts(k - 1)).toBeGreaterThan(1); // but not with fewer
      expect(splitWords(q.answer).norm[0]).toBe(w[w.length - 1]);
    }
    // An ayah repeated word for word has no unique opening.
    expect(gen.sardQuestion({ surah: 55, ayah: 13 })).toBeNull();
  });

  it('آية بآية: a unique opening, then the next ayahs of the surah in order', () => {
    const all = quran.ayahs.map((a) => splitWords(a.text).norm);
    for (const q of gen.generate('ayah_by_ayah', 20, seeded(4))) {
      const { surah, ayah: n } = q.refs[0];
      const w = words(surah, n);
      const k = q.meta.words as number;
      const starts = (len: number) =>
        all.filter((x) => x.slice(0, len).join(' ') === w.slice(0, len).join(' ')).length;
      expect(starts(k)).toBe(1);
      if (k > 1) expect(starts(k - 1)).toBeGreaterThan(1);
      const chain = q.meta.chain as { surah: number; ayah: number; text: string; opening: string }[];
      expect(chain.length).toBeGreaterThanOrEqual(10);
      chain.forEach((c, i) => {
        expect(c).toMatchObject({ surah, ayah: n + i + 1, text: ayah(surah, n + i + 1).text });
        const opening = splitWords(c.opening).norm;
        expect(opening).toEqual(words(surah, n + i + 1).slice(0, opening.length));
      });
      expect(q.answer).toBe(chain[0].opening);
    }
    // Nothing follows a surah's last ayah.
    expect(gen.ayahByAyahQuestion({ surah: 1, ayah: 7 })).toBeNull();
  });

  it('يمين يسار: 12 unique openings from different pages; odd pages are on the right', () => {
    const [q] = gen.generate('right_left', 1, seeded(5));
    const items = q.meta.items as { text: string; page: number; side: string; surah: number; ayah: number }[];
    expect(items).toHaveLength(12);
    expect(new Set(items.map((i) => i.page)).size).toBe(12);
    for (const i of items) {
      expect(i.side).toBe(i.page % 2 === 1 ? 'right' : 'left');
      expect(gen.sardQuestion({ surah: i.surah, ayah: i.ayah })!.prompt).toBe(i.text);
    }
  });
});

describe('validateQuestion', () => {
  it('builds رقم الآيات from a page number', () => {
    const q = validateQuestion({ type: 'ayah_number', page: 2 }, quran, (p) => gen.pageQuestion(p));
    expect(q.prompt).toBe(ayah(2, 1).text);
    expect(q.answer).toBe('5'); // البقرة 1–5 are on page 2
    expect(q.timeLimitSeconds).toBe(60);
    expect(q.source).toBe('manual');
  });

  it('counts المزاد answers and keeps a custom time limit', () => {
    const q = validateQuestion(
      {
        type: 'auction',
        prompt: 'آيات تبدأ بـ فإذا',
        refs: [{ surah: 16, ayah: 98 }, { surah: 23, ayah: 101 }],
        timeLimitSeconds: 45,
      },
      quran,
    );
    expect(q.meta.total).toBe(2);
    expect(q.timeLimitSeconds).toBe(45);
  });

  it('builds السرد from its ayah', () => {
    const q = validateQuestion(
      { type: 'sard', refs: [{ surah: 2, ayah: 255 }] },
      quran,
      undefined,
      (r) => gen.sardQuestion(r),
    );
    expect(q.prompt).toBe(splitWords(ayah(2, 255).text).shown.slice(0, q.meta.words as number).join(' '));
    expect(() =>
      validateQuestion({ type: 'sard', refs: [{ surah: 55, ayah: 13 }] }, quran, undefined, (r) =>
        gen.sardQuestion(r),
      ),
    ).toThrow('sard_ayah_not_unique');
  });

  it('builds آية بآية from its first ayah', () => {
    const q = validateQuestion(
      { type: 'ayah_by_ayah', refs: [{ surah: 2, ayah: 255 }] },
      quran,
      undefined,
      undefined,
      undefined,
      (r) => gen.ayahByAyahQuestion(r),
    );
    expect((q.meta.chain as { ayah: number }[])[0].ayah).toBe(256);
    expect(() =>
      validateQuestion(
        { type: 'ayah_by_ayah', refs: [{ surah: 1, ayah: 7 }] },
        quran,
        undefined,
        undefined,
        undefined,
        (r) => gen.ayahByAyahQuestion(r),
      ),
    ).toThrow('ayah_by_ayah_no_next');
  });

  it('rejects bad input', () => {
    const bad = [
      { type: 'nope' },
      { type: 'buzzer', prompt: 'سؤال' },
      { type: 'ayah_number', page: 999 },
      { type: 'similar', prompt: 'p', answer: 'a', refs: [{ surah: 2, ayah: 1 }] },
      { type: 'buzzer', prompt: 'p', answer: 'a', timeLimitSeconds: 2 },
    ];
    for (const b of bad) expect(() => validateQuestion(b, quran)).toThrow(QuestionValidationError);
  });
});

describe('ayahCountLabel', () => {
  it('uses آيات for 3–10 and آية otherwise', () => {
    const { ayahCountLabel } = jest.requireActual('./quran-text');
    expect(ayahCountLabel(5)).toBe('٥ آيات');
    expect(ayahCountLabel(11)).toBe('١١ آية');
    expect(ayahCountLabel(103)).toBe('١٠٣ آيات');
  });
});
