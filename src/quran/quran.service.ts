import { Injectable, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface Surah {
  number: number;
  nameArabic: string;
  ayahCount: number;
}

export interface Ayah {
  surah: number;
  numberInSurah: number;
  page: number;
  text: string;
}

/** The same Tanzil Uthmani text the app bundles (data/quran_uthmani.json). */
@Injectable()
export class QuranService implements OnModuleInit {
  surahs: Surah[] = [];
  ayahs: Ayah[] = [];

  onModuleInit() {
    this.load(join(process.cwd(), 'data', 'quran_uthmani.json'));
  }

  load(path: string) {
    const json = JSON.parse(readFileSync(path, 'utf-8')) as {
      surahs: { n: number; ar: string; c: number }[];
      ayahs: [number, number, number, number, number, number, string][];
    };
    this.surahs = json.surahs.map((s) => ({
      number: s.n,
      nameArabic: s.ar,
      ayahCount: s.c,
    }));
    this.ayahs = json.ayahs.map((a) => ({
      surah: a[0],
      numberInSurah: a[1],
      page: a[2],
      text: a[6],
    }));
  }

  surah(n: number): Surah {
    return this.surahs[n - 1];
  }
}
