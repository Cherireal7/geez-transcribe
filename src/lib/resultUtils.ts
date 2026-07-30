/**
 * resultUtils.ts
 * Helpers for language detection and applying user edits back onto a
 * TranscribeResult before export.
 */

import type { TranscribeResult, PageItem, QAItem, Section } from './structureOutput'

export interface LanguageProfileScore {
  ethiopic: number
  latin: number
  hebrew: number
  greek: number
  arabic: number
  dominant: 'ethiopic' | 'latin' | 'hebrew' | 'greek' | 'arabic' | 'unknown'
}

const RANGES = {
  ethiopic: /[ሀ-፿]/g,
  latin: /[a-zA-Z]/g,
  hebrew: /[֐-׿]/g,
  greek: /[Ͱ-Ͽἀ-῿]/g,
  arabic: /[؀-ۿ]/g,
}

export function detectLanguageProfile(text: string): LanguageProfileScore {
  const ethiopic = (text.match(RANGES.ethiopic) ?? []).length
  const latin = (text.match(RANGES.latin) ?? []).length
  const hebrew = (text.match(RANGES.hebrew) ?? []).length
  const greek = (text.match(RANGES.greek) ?? []).length
  const arabic = (text.match(RANGES.arabic) ?? []).length
  const total = ethiopic + latin + hebrew + greek + arabic
  if (total === 0) {
    return { ethiopic: 0, latin: 0, hebrew: 0, greek: 0, arabic: 0, dominant: 'unknown' }
  }
  const scores = { ethiopic, latin, hebrew, greek, arabic }
  const dominantKey = (Object.entries(scores) as Array<[keyof typeof scores, number]>).reduce(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    ['unknown' as 'unknown' | keyof typeof scores, 0] as ['unknown' | keyof typeof scores, number],
  )[0]
  return {
    ethiopic: ethiopic / total,
    latin: latin / total,
    hebrew: hebrew / total,
    greek: greek / total,
    arabic: arabic / total,
    dominant: dominantKey === 'unknown' ? 'unknown' : dominantKey,
  }
}

/**
 * Edit shape: map of pageNumber → new content string.
 * For sectioned + numbered_qa, we treat the whole payload as a single
 * "page 0" edit surface, since those formats don't have a linear page map.
 */
export type EditMap = Record<number, string>

/**
 * Apply user edits back onto a TranscribeResult so downstream exports
 * (DOCX/TXT/JSON) reflect the user's corrections.
 *
 * For page-structured output, edits map 1:1 by page number.
 * For sectioned / numbered_qa, we currently attach the merged text as an
 * additional "user_edited" field on each page; the DOCX/TXT exporters
 * prefer that value when present.
 */
export function mergeEditsIntoResult(result: TranscribeResult, edits: EditMap): TranscribeResult {
  if (!edits || Object.keys(edits).length === 0) return result

  if (result.format === 'pages' && result.pages) {
    const mergedPages: PageItem[] = result.pages.map(p => {
      const edited = edits[p.page]
      return typeof edited === 'string' ? { ...p, content: edited } : p
    })
    return { ...result, pages: mergedPages }
  }

  if (result.format === 'numbered_qa' && result.questions) {
    const mergedQuestions: QAItem[] = result.questions.map(q => {
      const edited = edits[q.number]
      if (typeof edited !== 'string') return q
      const lines = edited.split('\n').filter(l => l.trim())
      const question = lines[0]?.trim() ?? q.question
      const answer = lines.slice(1).join('\n').trim()
      return { ...q, question, answer }
    })
    return { ...result, questions: mergedQuestions }
  }

  if (result.format === 'sectioned' && result.sections) {
    const mergedSections: Section[] = result.sections.map((section, index) => {
      const edited = edits[index + 1]
      return typeof edited === 'string' ? { ...section, content: edited, items: undefined } : section
    })
    return { ...result, sections: mergedSections }
  }

  return result
}
