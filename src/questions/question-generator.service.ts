import { Injectable, OnModuleInit } from '@nestjs/common';
import { Ayah, QuranService } from '../quran/quran.service';
import {
  AyahRef,
  DEFAULT_TIME_LIMIT_SECONDS,
  QuestionData,
  QuestionType,
} from './question.types';
import { ayahCountLabel, splitWords } from './quran-text';

type Random = () => number;

/** يمين يسار: openings in each player's run. */
export const RIGHT_LEFT_PER_PLAYER = 6;

interface Indexed {
  ayah: Ayah;
  shown: string[];
  norm: string[];
}

/**
 * Builds questions for every round straight from the Quran text, so every
 * answer key is exact.
 */
@Injectable()
export class QuestionGeneratorService implements OnModuleInit {
  private ayahs: Indexed[] = [];
  /** First n words (joined) → ayah indexes, for n = 1..4. */
  private openings = new Map<number, Map<string, number[]>>();
  /** Word → ayah indexes containing it. */
  private byWord = new Map<string, number[]>();
  /** Page → ayah indexes on it, in order. */
  private byPage = new Map<number, number[]>();

  constructor(private readonly quran: QuranService) {}

  onModuleInit() {
    this.buildIndex();
  }

  /** Builds the lookup tables (call again after reloading the Quran). */
  buildIndex() {
    this.ayahs = this.quran.ayahs.map((ayah) => ({ ayah, ...splitWords(ayah.text) }));
    this.openings = new Map();
    this.byWord = new Map();
    this.byPage = new Map();
    for (let n = 1; n <= 4; n++) this.openings.set(n, new Map());
    this.ayahs.forEach((a, i) => {
      push(this.byPage, a.ayah.page, i);
      for (let n = 1; n <= 4 && n <= a.norm.length; n++) {
        push(this.openings.get(n)!, a.norm.slice(0, n).join(' '), i);
      }
      for (const w of new Set(a.norm)) push(this.byWord, w, i);
    });
  }

  generate(type: QuestionType, count: number, random: Random = Math.random): QuestionData[] {
    const make = {
      what_do_you_know: () => this.whatDoYouKnow(random),
      ayah_number: () => this.ayahNumber(random),
      auction: () => this.auction(random),
      similar: () => this.similar(random),
      sard: () => this.sard(random),
      right_left: () => this.rightLeft(random),
      buzzer: () => this.buzzer(random),
    }[type];
    const out: QuestionData[] = [];
    const seen = new Set<string>();
    for (let tries = 0; out.length < count && tries < count * 50; tries++) {
      const q = make();
      // يمين يسار shares one prompt; its ayahs tell questions apart.
      const key = q && `${q.prompt}|${q.refs.map((r) => `${r.surah}:${r.ayah}`).join(',')}`;
      if (q && key && !seen.has(key)) {
        seen.add(key);
        out.push(q);
      }
    }
    return out;
  }

  /**
   * رقم الآيات: the first ayah of a page is read out; players guess how many
   * ayahs that page has.
   */
  ayahNumber(random: Random): QuestionData | null {
    const page = 1 + Math.floor(random() * this.byPage.size);
    return this.pageQuestion(page);
  }

  /** The رقم الآيات question for [page], or null if there is no such page. */
  pageQuestion(page: number): QuestionData | null {
    const onPage = this.byPage.get(page);
    if (!onPage) return null;
    const first = this.ayahs[onPage[0]].ayah;
    return this.question('ayah_number', first.text, String(onPage.length), [ref(first)], {
      page,
      ayahCount: onPage.length,
      surahName: this.quran.surah(first.surah).nameArabic,
    });
  }

  /** ماذا تعرف: name the ayahs that start with a phrase, or contain a word. */
  whatDoYouKnow(random: Random): QuestionData | null {
    if (random() < 0.5) {
      const found = this.pickOpening(random, 2, 4, 15);
      if (!found) return null;
      return this.question(
        'what_do_you_know',
        `اذكر آيات تبدأ بـ «${found.phrase}»`,
        ayahCountLabel(found.refs.length),
        found.refs,
        { kind: 'starts_with', phrase: found.phrase },
      );
    }
    const a = pick(this.ayahs, random);
    const i = Math.floor(random() * a.norm.length);
    const word = a.norm[i];
    if (!word || word.length < 4) return null;
    const hits = this.byWord.get(word) ?? [];
    if (hits.length < 4 || hits.length > 12) return null;
    return this.question(
      'what_do_you_know',
      `اذكر آيات فيها لفظ «${a.shown[i]}»`,
      ayahCountLabel(hits.length),
      hits.map((h) => ref(this.ayahs[h].ayah)),
      { kind: 'contains_word', word: a.shown[i] },
    );
  }

  /** المزاد: a category with a known total; players bid how many they can recite. */
  auction(random: Random): QuestionData | null {
    const n = random() < 0.6 ? 1 : 2;
    const found = this.pickOpening(random, n, 10, 40);
    if (!found) return null;
    return this.question(
      'auction',
      `كم آية تستطيع أن تذكر تبدأ بـ «${found.phrase}»؟`,
      ayahCountLabel(found.refs.length),
      found.refs,
      { total: found.refs.length, phrase: found.phrase },
    );
  }

  /**
   * المتشابهات: the first 3–4 words shared by ayahs in 2–5 different surahs.
   * The answer is the shared opening.
   */
  similar(random: Random): QuestionData | null {
    const words = random() < 0.5 ? 3 : 4;
    const a = pick(this.ayahs, random);
    if (a.norm.length <= words) return null;
    const group = this.openings.get(words)!.get(a.norm.slice(0, words).join(' ')) ?? [];
    const surahs = [...new Set(group.map((g) => this.ayahs[g].ayah.surah))];
    if (group.length < 2 || group.length > 6 || surahs.length < 2 || surahs.length > 5) {
      return null;
    }
    const names = surahs.map((s) => this.quran.surah(s).nameArabic).join('، ');
    return this.question(
      'similar',
      `متشابهة في أول ${words} كلمات بين سور: ${names}. ما هي؟`,
      a.shown.slice(0, words).join(' '),
      group.map((g) => ref(this.ayahs[g].ayah)),
      { words, surahs },
    );
  }

  /** الجرس: a quick question with one short answer. */
  buzzer(random: Random): QuestionData | null {
    const kinds = [
      () => this.surahEnding(random),
      () => this.surahOpening(random),
      () => this.ayahSurah(random),
      () => this.surahLength(random),
    ];
    return pick(kinds, random)();
  }

  private surahEnding(random: Random): QuestionData | null {
    const surah = pick(this.quran.surahs, random);
    const last = this.lastAyahOf(surah.number);
    const tail = last.norm.slice(-3).join(' ');
    // The ending must belong to this surah only.
    const clash = this.quran.surahs.some(
      (s) => s.number !== surah.number && this.lastAyahOf(s.number).norm.slice(-3).join(' ') === tail,
    );
    if (clash || last.norm.length < 3) return null;
    return this.question(
      'buzzer',
      `ما السورة التي تنتهي بقوله تعالى: «${last.shown.slice(-3).join(' ')}»؟`,
      surah.nameArabic,
      [ref(last.ayah)],
      { kind: 'surah_ending' },
    );
  }

  private surahOpening(random: Random): QuestionData | null {
    const surah = pick(this.quran.surahs, random);
    const first = this.ayahs.find((a) => a.ayah.surah === surah.number)!;
    if (first.norm.length < 3) return null;
    const head = first.norm.slice(0, 3).join(' ');
    const clash = this.quran.surahs.some((s) => {
      if (s.number === surah.number) return false;
      const other = this.ayahs.find((a) => a.ayah.surah === s.number)!;
      return other.norm.slice(0, 3).join(' ') === head;
    });
    if (clash) return null;
    return this.question(
      'buzzer',
      `ما السورة التي تبدأ بقوله تعالى: «${first.shown.slice(0, 3).join(' ')}»؟`,
      surah.nameArabic,
      [ref(first.ayah)],
      { kind: 'surah_opening' },
    );
  }

  private ayahSurah(random: Random): QuestionData | null {
    const a = pick(this.ayahs, random);
    if (a.norm.length < 4 || a.norm.length > 10) return null;
    const text = a.norm.join(' ');
    // Skip ayahs that repeat elsewhere: the answer must be one surah.
    const twins = (this.openings.get(Math.min(4, a.norm.length))!.get(a.norm.slice(0, 4).join(' ')) ?? [])
      .filter((i) => this.ayahs[i].norm.join(' ') === text);
    if (twins.length > 1) return null;
    return this.question(
      'buzzer',
      `في أي سورة وردت الآية: «${a.ayah.text}»؟`,
      this.quran.surah(a.ayah.surah).nameArabic,
      [ref(a.ayah)],
      { kind: 'ayah_surah' },
    );
  }

  private surahLength(random: Random): QuestionData | null {
    const surah = pick(this.quran.surahs, random);
    return this.question(
      'buzzer',
      `كم عدد آيات سورة ${surah.nameArabic}؟`,
      String(surah.ayahCount),
      [],
      { kind: 'surah_length' },
    );
  }

  /** A random opening of [n] words shared by [min]–[max] ayahs. */
  private pickOpening(random: Random, n: number, min: number, max: number) {
    const a = pick(this.ayahs, random);
    if (a.norm.length <= n) return null;
    const group = this.openings.get(n)!.get(a.norm.slice(0, n).join(' ')) ?? [];
    if (group.length < min || group.length > max) return null;
    return {
      phrase: a.shown.slice(0, n).join(' '),
      refs: group.map((g) => ref(this.ayahs[g].ayah)),
    };
  }

  /**
   * يمين يسار: [RIGHT_LEFT_PER_PLAYER] × 2 ayahs with unique openings, from
   * different pages (see [rightLeftQuestion]).
   */
  rightLeft(random: Random): QuestionData | null {
    const refs: AyahRef[] = [];
    const pages = new Set<number>();
    for (let tries = 0; refs.length < RIGHT_LEFT_PER_PLAYER * 2 && tries < 400; tries++) {
      const a = pick(this.ayahs, random).ayah;
      if (pages.has(a.page) || !this.sardQuestion(ref(a))) continue;
      pages.add(a.page);
      refs.push(ref(a));
    }
    return refs.length === RIGHT_LEFT_PER_PLAYER * 2 ? this.rightLeftQuestion(refs) : null;
  }

  /**
   * يمين يسار from its ayahs: each one's shortest unique opening, and
   * whether its page is on the right (odd pages in the Madani mushaf) or the
   * left. The first half is the first player's run, the second half the
   * other's. Null if an ayah has no unique opening.
   */
  rightLeftQuestion(refs: AyahRef[]): QuestionData | null {
    const items = [];
    for (const r of refs) {
      const q = this.sardQuestion(r);
      if (!q) return null;
      const a = this.quran.ayahs.find((x) => x.surah === r.surah && x.numberInSurah === r.ayah)!;
      items.push({
        text: q.prompt,
        page: a.page,
        side: a.page % 2 === 1 ? 'right' : 'left',
        surah: r.surah,
        ayah: r.ayah,
        surahName: this.quran.surah(r.surah).nameArabic,
      });
    }
    return this.question(
      'right_left',
      'في أي صفحة: اليمنى أم اليسرى؟',
      `${items.length / 2} بدايات لكل متسابق`,
      refs,
      { items },
    );
  }

  /** السرد: a random ayah's question (see [sardQuestion]). */
  sard(random: Random): QuestionData | null {
    const a = pick(this.ayahs, random).ayah;
    return this.sardQuestion(ref(a));
  }

  /**
   * السرد: the fewest opening words of an ayah that no other ayah starts
   * with (one word if it is unique, more while other ayahs share them);
   * players say the ayah's last word. Null when the ayah has no such
   * opening (it repeats word for word) or no word is left after it.
   */
  sardQuestion(r: AyahRef): QuestionData | null {
    const index = this.ayahs.findIndex(
      (x) => x.ayah.surah === r.surah && x.ayah.numberInSurah === r.ayah,
    );
    const a = this.ayahs[index];
    if (!a) return null;
    let sharing = this.ayahs.map((_, i) => i).filter((i) => i !== index);
    for (let k = 1; k < a.norm.length; k++) {
      sharing = sharing.filter((i) => this.ayahs[i].norm[k - 1] === a.norm[k - 1]);
      if (sharing.length === 0) {
        return this.question(
          'sard',
          a.shown.slice(0, k).join(' '),
          a.shown[a.shown.length - 1],
          [r],
          {
            words: k,
            surahName: this.quran.surah(a.ayah.surah).nameArabic,
            ayah: a.ayah.numberInSurah,
          },
        );
      }
    }
    return null;
  }

  private lastAyahOf(surah: number): Indexed {
    const s = this.quran.surah(surah);
    const firstIndex = this.ayahs.findIndex((a) => a.ayah.surah === surah);
    return this.ayahs[firstIndex + s.ayahCount - 1];
  }

  private question(
    type: QuestionType,
    prompt: string,
    answer: string,
    refs: AyahRef[],
    meta: Record<string, unknown>,
  ): QuestionData {
    return {
      type,
      source: 'generated',
      prompt,
      answer,
      refs,
      timeLimitSeconds: DEFAULT_TIME_LIMIT_SECONDS,
      meta,
    };
  }
}

function push<K>(map: Map<K, number[]>, key: K, value: number) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function pick<T>(items: T[], random: Random): T {
  return items[Math.floor(random() * items.length)];
}

function ref(a: Ayah): AyahRef {
  return { surah: a.surah, ayah: a.numberInSurah };
}
