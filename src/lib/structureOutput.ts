/**
 * structureOutput.ts
 * Auto-detects document structure and converts extracted text to JSON.
 *
 * Supported output formats:
 *   - numbered_qa   : Catechisms, study guides, Q&A documents
 *   - sectioned     : Documents with identifiable section headers
 *   - pages         : Generic fallback — one entry per page
 */

import { fixEncoding } from './fixEncoding'

// ── Types ──────────────────────────────────────────────────────────────────

export type StructureFormat = 'numbered_qa' | 'sectioned' | 'pages'

export interface QAItem {
  number: number
  question: string
  answer: string
}

export interface PageItem {
  page: number
  content: string
}

export interface Section {
  id: string
  title: string
  content: string
  items?: QAItem[]
}

export interface TranscribeResult {
  source_file: string
  page_count: number
  extraction_method: 'text' | 'ocr' | 'needs-ocr'
  encoding_fixed: boolean
  format: StructureFormat
  correction_count: number
  // format-specific payloads (only one will be populated)
  questions?: QAItem[]        // numbered_qa
  sections?: Section[]        // sectioned
  pages?: PageItem[]          // pages
  // metadata
  detected_language?: string
  average_ocr_confidence?: number
}

// ── Text cleaning ──────────────────────────────────────────────────────────

function cleanLine(line: string): string {
  return line.trim()
}

function cleanBlock(text: string): string {
  return text
    .split('\n')
    .map(cleanLine)
    .filter(l => !/^\d+$/.test(l))          // remove standalone page numbers
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')             // collapse 3+ blank lines to 2
    .trim()
}

// ── Structure detection ────────────────────────────────────────────────────

/**
 * Detect whether the text looks like a numbered Q&A document.
 * Requires at least 5 numbered items to trigger.
 */
function isNumberedQA(text: string): boolean {
  const matches = text.match(/\n\s*\d{1,3}\.\s+\S/g)
  return (matches?.length ?? 0) >= 5
}

/**
 * Detect whether the text has identifiable section headers.
 * Heuristic: short lines (< 60 chars) with heavy leading whitespace,
 * appearing more than 3 times.
 */
function isSectioned(text: string): boolean {
  const lines = text.split('\n')
  const headerCount = lines.filter(l => {
    const stripped = l.trim()
    const leadingSpaces = l.length - l.trimStart().length
    return stripped.length > 3 && stripped.length < 60 && leadingSpaces >= 12
  }).length
  return headerCount >= 4
}

/**
 * Detect predominant script in text.
 */
function detectLanguage(text: string): string {
  const ethiopicChars = (text.match(/[\u1200-\u137F]/g) ?? []).length
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) ?? []).length
  const latinChars = (text.match(/[a-zA-Z]/g) ?? []).length
  const total = ethiopicChars + arabicChars + latinChars
  if (total === 0) return 'unknown'
  if (ethiopicChars / total > 0.4) return 'ethiopic'
  if (arabicChars / total > 0.4) return 'arabic'
  return 'latin'
}

// ── Formatters ─────────────────────────────────────────────────────────────

/**
 * Parse text with numbered items into Q&A pairs.
 * Handles items like:
 *   1. ጥያቄ ምንድን ነው?\nመልስ ይህ ነው።
 *   42. Question text\nAnswer spanning\nmultiple lines.
 */
function parseNumberedQA(text: string): QAItem[] {
  const items: QAItem[] = []
  // Split on numbered item boundaries
  const parts = text.split(/\n(\d{1,3})\.\s+/)
  // parts = [pre, num1, body1, num2, body2, ...]
  let i = 1
  while (i < parts.length - 1) {
    const num = parseInt(parts[i], 10)
    const body = cleanBlock(parts[i + 1] ?? '')
    const lines = body.split('\n').filter(l => l.trim())
    const question = lines[0]?.trim() ?? ''
    const answer = lines.slice(1).join('\n').trim()
    if (question) {
      items.push({ number: num, question, answer })
    }
    i += 2
  }
  return items
}

/**
 * Extract sections based on indented header heuristic.
 */
function parseSections(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  let current: Section | null = null
  let contentLines: string[] = []

  function flush() {
    if (current) {
      current.content = cleanBlock(contentLines.join('\n'))
      // If section content itself has numbered items, parse those too
      if (isNumberedQA(current.content)) {
        current.items = parseNumberedQA(current.content)
      }
      sections.push(current)
    }
  }

  for (const line of lines) {
    const stripped = line.trim()
    if (!stripped) { contentLines.push(''); continue }
    // Standalone page number
    if (/^\d+$/.test(stripped)) continue
    const leadingSpaces = line.length - line.trimStart().length
    // Header heuristic
    if (leadingSpaces >= 12 && stripped.length < 60 && stripped.length > 3) {
      flush()
      const id = stripped.toLowerCase().replace(/\s+/g, '_').replace(/[^\w_]/g, '')
      current = { id, title: stripped, content: '' }
      contentLines = []
    } else {
      contentLines.push(line)
    }
  }
  flush()
  return sections.filter(s => s.content.length > 20 || (s.items?.length ?? 0) > 0)
}

/**
 * Simple page-level structuring — generic fallback.
 */
function parsePages(pages: string[]): PageItem[] {
  return pages
    .map((content, idx) => ({ page: idx + 1, content: cleanBlock(content) }))
    .filter(p => p.content.length > 10)
}

// ── Correction counter ─────────────────────────────────────────────────────

function countCorrections(original: string, fixed: string): number {
  let count = 0
  const minLen = Math.min(original.length, fixed.length)
  for (let i = 0; i < minLen; i++) {
    if (original[i] !== fixed[i]) count++
  }
  return count
}

// ── Main pipeline ──────────────────────────────────────────────────────────

export interface StructureOptions {
  fixEncodingFlag?: boolean   // default true
  forceFormat?: StructureFormat
  extraWordMap?: Record<string, string>
}

/**
 * Full structuring pipeline:
 *   1. Join pages into full text
 *   2. Fix encoding (optional)
 *   3. Auto-detect or use forced format
 *   4. Parse into structured output
 *   5. Return TranscribeResult
 */
export function structureOutput(
  pages: string[],
  filename: string,
  extractionMethod: 'text' | 'ocr' | 'needs-ocr',
  options: StructureOptions = {}
): TranscribeResult {
  const {
    fixEncodingFlag = true,
    forceFormat,
    extraWordMap = {},
  } = options

  const rawText = pages.join('\n')
  const detectedLanguage = detectLanguage(rawText)

  // Encoding fix
  const fixedText = fixEncodingFlag ? fixEncoding(rawText, extraWordMap) : rawText
  const correctionCount = fixEncodingFlag ? countCorrections(rawText, fixedText) : 0

  // Fix pages array too (for page-level output)
  const fixedPages = fixEncodingFlag
    ? pages.map(p => fixEncoding(p, extraWordMap))
    : pages

  // Determine format
  const format: StructureFormat =
    forceFormat ??
    (isNumberedQA(fixedText)
      ? 'numbered_qa'
      : isSectioned(fixedText)
      ? 'sectioned'
      : 'pages')

  const base: TranscribeResult = {
    source_file: filename,
    page_count: pages.length,
    extraction_method: extractionMethod,
    encoding_fixed: fixEncodingFlag,
    format,
    correction_count: correctionCount,
    detected_language: detectedLanguage,
  }

  switch (format) {
    case 'numbered_qa':
      return { ...base, questions: parseNumberedQA(fixedText) }

    case 'sectioned':
      return { ...base, sections: parseSections(fixedText) }

    case 'pages':
    default:
      return { ...base, pages: parsePages(fixedPages) }
  }
}
