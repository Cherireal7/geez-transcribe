const GENERIC_MAP: Record<string, string> = {
  'A': 'አ',  // U+12A0
  'E': 'እ',  // U+12A5
  'I': 'ኢ',  // U+12A2
}

export const O_WORD_MAP: Record<string, string> = {
  'ሲOልም': 'ሲኦልም',
  'ጣOት': 'ጣዖት',
  'ሳOል': 'ሳኦል',
  'ስምOን': 'ስምዖን',
  'ባOልን': 'ባዖልን',
  'AጽንOት': 'አጽንዖት',
  'Oግስቡርግ': 'ኦግስቡርግ',
  'ጣOታት': 'ጣዖታት',
  'ጣOቶቻቸውን': 'ጣዖቶቻቸውን',
}

const ETHIOPIC = /[\u1200-\u137F]/
const ETHIOPIC_CLASS = '\u1200-\u137F'

/**
 * Normalize punctuation to Ge'ez / Ethiopic forms, but only when it
 * unambiguously sits inside Ethiopic text. Preserves Latin punctuation
 * inside mixed lines like verse references or English asides.
 */
export function normalizeGeezPunctuation(text: string): string {
  const E = ETHIOPIC_CLASS
  return text
    // Tesseract sometimes emits two word-spaces where a sentence terminator belongs.
    .replace(new RegExp(`([${E}])\u1361\u1361`, 'g'), '$1\u1362')
    // Latin colon between Ethiopic \u2192 Ethiopic word separator (\u1361)
    .replace(new RegExp(`([${E}])\\s*:\\s*(?=[${E}])`, 'g'), '$1\u1361')
    // Latin comma between Ethiopic \u2192 Ethiopic comma (\u1363)
    .replace(new RegExp(`([${E}])\\s*,\\s*(?=[${E}])`, 'g'), '$1\u1363 ')
    // Latin semicolon between Ethiopic \u2192 Ethiopic semicolon (\u1364)
    .replace(new RegExp(`([${E}])\\s*;\\s*(?=[${E}])`, 'g'), '$1\u1364 ')
    // Latin question mark after Ethiopic \u2192 Ethiopic question mark (\u1367)
    .replace(new RegExp(`([${E}])\\s*\\?`, 'g'), '$1\u1367')
    // ".." after Ethiopic \u2192 Ethiopic full stop (\u1362)
    .replace(new RegExp(`([${E}])\\s*\\.\\.`, 'g'), '$1\u1362')
    // Stray Latin period directly after Ethiopic (safe: only if followed by space/newline/end)
    .replace(new RegExp(`([${E}])\\s*\\.(?=\\s|$)`, 'g'), '$1\u1362')
    // Collapse repeated sentence terminators
    .replace(/\u1362{2,}/g, '\u1362')
    // Kill space between an Ethiopic char and its trailing punctuation
    .replace(new RegExp(`([${E}])\\s+([\u1362\u1363\u1364\u1367])`, 'g'), '$1$2')
}

export interface FixEncodingOptions {
  extraMap?: Record<string, string>
  geezPunctuation?: boolean  // default true
}

export function fixEncoding(
  text: string,
  extraMapOrOptions: Record<string, string> | FixEncodingOptions = {}
): string {
  const options: FixEncodingOptions = isOptions(extraMapOrOptions)
    ? extraMapOrOptions
    : { extraMap: extraMapOrOptions }
  const extraMap = options.extraMap ?? {}
  const geezPunctuation = options.geezPunctuation ?? true

  let result = text

  const combined = { ...O_WORD_MAP, ...extraMap }
  const sortedKeys = Object.keys(combined).sort((a, b) => b.length - a.length)

  for (const wrong of sortedKeys) {
    const correct = combined[wrong]
    result = result.split(wrong).join(correct)
  }

  result = result.replace(/[AEI]/g, (char, pos) => {
    const start = Math.max(0, pos - 2)
    const end = Math.min(result.length, pos + 3)
    const win = result.slice(start, end).replace(char, '')
    return ETHIOPIC.test(win) ? GENERIC_MAP[char] : char
  })

  if (geezPunctuation && ETHIOPIC.test(result)) {
    result = normalizeGeezPunctuation(result)
  }

  return result
}

function isOptions(value: unknown): value is FixEncodingOptions {
  if (typeof value !== 'object' || value === null) return false
  return 'extraMap' in value || 'geezPunctuation' in value
}

export function fixJsonObject(obj: any, extraMap?: Record<string,string>): any {
  if (typeof obj === 'string') return fixEncoding(obj, extraMap);
  if (Array.isArray(obj)) return obj.map(item => fixJsonObject(item, extraMap));
  if (obj !== null && typeof obj === 'object') {
    const res: any = {};
    for (const key in obj) res[key] = fixJsonObject(obj[key], extraMap);
    return res;
  }
  return obj;
}

export function countEncodingIssues(text: string): number {
  let count = 0;
  const fixed = fixEncoding(text);
  for (let i=0; i<Math.min(text.length, fixed.length); i++) {
    if (text[i] !== fixed[i]) count++;
  }
  return count;
}

export interface CorrectionEntry {
  lineNumber: number;
  original: string;
  corrected: string;
}

export function generateDiff(text: string, extraMap?: Record<string,string>): CorrectionEntry[] {
  const lines = text.split('\n');
  const diff: CorrectionEntry[] = [];
  
  for (let i=0; i<lines.length; i++) {
    const original = lines[i];
    const corrected = fixEncoding(original, extraMap);
    if (original !== corrected) {
      diff.push({ lineNumber: i + 1, original, corrected });
    }
  }
  return diff;
}
