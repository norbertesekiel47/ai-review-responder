import { franc } from 'franc-min';

const MIN_WORD_COUNT = 20;

/**
 * Maps ISO 639-3 (franc output) → ISO 639-1 (our contract).
 * Covers all 82 languages franc-min supports (8M+ native speakers).
 */
const iso3to1: Record<string, string> = {
  afr: 'af',
  amh: 'am',
  arb: 'ar',
  aze: 'az',
  bel: 'be',
  ben: 'bn',
  bos: 'bs',
  bul: 'bg',
  cat: 'ca',
  // ceb (Cebuano) has no ISO 639-1 code — omitted, falls back to 'en'
  ces: 'cs',
  cmn: 'zh',
  dan: 'da',
  deu: 'de',
  ell: 'el',
  eng: 'en',
  epo: 'eo',
  est: 'et',
  fin: 'fi',
  fra: 'fr',
  guj: 'gu',
  hat: 'ht',
  hau: 'ha',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ibo: 'ig',
  // ilo (Iloko) has no ISO 639-1 code — omitted, falls back to 'en'
  ind: 'id',
  ita: 'it',
  jav: 'jv',
  jpn: 'ja',
  kan: 'kn',
  kat: 'ka',
  kaz: 'kk',
  khm: 'km',
  kin: 'rw',
  kor: 'ko',
  kur: 'ku',
  lao: 'lo',
  lav: 'lv',
  lit: 'lt',
  lug: 'lg',
  mal: 'ml',
  mar: 'mr',
  mkd: 'mk',
  mlg: 'mg',
  msa: 'ms',
  mya: 'my',
  nep: 'ne',
  nld: 'nl',
  nno: 'nn',
  nob: 'nb',
  nya: 'ny',
  ori: 'or',
  orm: 'om',
  pan: 'pa',
  pes: 'fa',
  pol: 'pl',
  por: 'pt',
  pus: 'ps',
  ron: 'ro',
  run: 'rn',
  rus: 'ru',
  sin: 'si',
  slk: 'sk',
  slv: 'sl',
  sna: 'sn',
  som: 'so',
  spa: 'es',
  sqi: 'sq',
  srp: 'sr',
  sun: 'su',
  swa: 'sw',
  swe: 'sv',
  tam: 'ta',
  tel: 'te',
  tgl: 'tl',
  tha: 'th',
  tir: 'ti',
  tur: 'tr',
  ukr: 'uk',
  urd: 'ur',
  uzb: 'uz',
  vie: 'vi',
  yor: 'yo',
  zul: 'zu',
};

/**
 * Detect language of review text. Returns ISO 639-1 code.
 *
 * Short texts (<20 words) default to 'en' — franc is unreliable on them,
 * and the LLM prompt says "respond in the same language as the review"
 * so it self-corrects anyway.
 */
export function detectLanguage(text: string | null): string {
  if (!text) return 'en';

  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < MIN_WORD_COUNT) return 'en';

  const code = franc(text);
  if (code === 'und') return 'en';

  return iso3to1[code] ?? 'en';
}

/**
 * Detect language of LLM-generated response text. Returns ISO 639-1 code.
 *
 * Unlike detectLanguage (for review text), this does NOT skip short texts.
 * LLM responses can be short (e.g. rating-only review → brief thank-you),
 * but we still need accurate metadata for the response language.
 * Uses franc with minLength: 3 for aggressive detection.
 */
export function detectResponseLanguage(text: string): string {
  if (!text) return 'en';

  const code = franc(text, { minLength: 3 });
  if (code === 'und') return 'en';

  return iso3to1[code] ?? 'en';
}
