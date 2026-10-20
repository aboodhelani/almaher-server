/** Letter-only comparison form of an Uthmani word (no tashkeel or marks). */
export function normalizeWord(word: string): string {
  let out = '';
  for (const ch of word) {
    const c = ch.codePointAt(0)!;
    if (c === 0x0671 || c === 0x0623 || c === 0x0625 || c === 0x0622)
      out += 'ا';
    else if (c === 0x0649) out += 'ي';
    else if (c === 0x0629) out += 'ه';
    else if (c >= 0x0621 && c <= 0x064a) out += ch;
  }
  return out;
}

/** The ayah's words as written and as compared; signs like ۞ are skipped. */
export function splitWords(text: string): { shown: string[]; norm: string[] } {
  const shown: string[] = [];
  const norm: string[] = [];
  for (const token of text.split(' ')) {
    const n = normalizeWord(token);
    if (n) {
      shown.push(token);
      norm.push(n);
    }
  }
  return { shown, norm };
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Arabic count of ayahs with the right noun form: ٣–١٠ آيات, otherwise آية. */
export function ayahCountLabel(n: number): string {
  const digits = String(n).replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]);
  const mod100 = n % 100;
  return `${digits} ${mod100 >= 3 && mod100 <= 10 ? 'آيات' : 'آية'}`;
}
