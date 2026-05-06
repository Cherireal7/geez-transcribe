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

export function fixEncoding(text: string, extraMap: Record<string,string> = {}): string {
  let result = text;
  
  const combined = { ...O_WORD_MAP, ...extraMap }
  const sortedKeys = Object.keys(combined).sort((a,b) => b.length - a.length);
  
  for (const wrong of sortedKeys) {
    const correct = combined[wrong];
    result = result.split(wrong).join(correct);
  }
  
  return result.replace(/[AEI]/g, (char, pos) => {
    const start = Math.max(0, pos - 2);
    const end = Math.min(result.length, pos + 3);
    const win = result.slice(start, end).replace(char, '');
    return ETHIOPIC.test(win) ? GENERIC_MAP[char] : char;
  });
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
