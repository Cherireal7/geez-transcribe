/**
 * exportDocx.ts
 * Exports a TranscribeResult to a formatted DOCX file.
 * Runs entirely client-side using the `docx` npm package.
 *
 * Install: npm install docx
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
} from 'docx'
import type { TranscribeResult, QAItem } from './structureOutput'

// ── Helpers ────────────────────────────────────────────────────────────────

function heading1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, bold: true, size: 28 })],
    spacing: { before: 400, after: 200 },
  })
}

function heading2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, bold: true, size: 24 })],
    spacing: { before: 300, after: 160 },
  })
}

function body(text: string, opts: { bold?: boolean; italic?: boolean } = {}): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italic,
        size: 22,
      }),
    ],
    spacing: { after: 120 },
  })
}

function metaRow(label: string, value: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 18, color: '666666' }),
      new TextRun({ text: value, size: 18, color: '444444' }),
    ],
    spacing: { after: 60 },
  })
}

function divider(): Paragraph {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
    spacing: { after: 200 },
    children: [],
  })
}

function qaBlock(item: QAItem): Paragraph[] {
  return [
    new Paragraph({
      children: [
        new TextRun({ text: `${item.number}. `, bold: true, size: 22, color: '333333' }),
        new TextRun({ text: item.question, bold: true, size: 22 }),
      ],
      spacing: { before: 160, after: 80 },
    }),
    ...(item.answer
      ? item.answer.split('\n').filter(l => l.trim()).map(
          line =>
            new Paragraph({
              children: [new TextRun({ text: line.trim(), size: 21 })],
              indent: { left: 360 },
              spacing: { after: 60 },
            })
        )
      : []),
  ]
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Convert a TranscribeResult to a DOCX Blob for download.
 */
export async function exportToDocx(result: TranscribeResult): Promise<Blob> {
  const children: Paragraph[] = []

  // ── Cover metadata ──
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: result.source_file,
          bold: true,
          size: 32,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    })
  )
  children.push(metaRow('Pages', String(result.page_count)))
  children.push(metaRow('Extraction', result.extraction_method))
  children.push(metaRow('Format', result.format))
  if (result.encoding_fixed) {
    children.push(metaRow('Encoding corrections', String(result.correction_count)))
  }
  children.push(divider())

  // ── Content by format ──
  if (result.format === 'numbered_qa' && result.questions) {
    children.push(heading1('Questions & Answers'))
    for (const item of result.questions) {
      children.push(...qaBlock(item))
    }
  } else if (result.format === 'sectioned' && result.sections) {
    for (const section of result.sections) {
      children.push(heading1(section.title))
      if (section.items && section.items.length > 0) {
        // Section has nested Q&A
        for (const item of section.items) {
          children.push(...qaBlock(item))
        }
      } else {
        // Plain section content — split into paragraphs
        const paras = section.content.split('\n\n').filter(p => p.trim())
        for (const para of paras) {
          const lines = para.split('\n').filter(l => l.trim())
          if (lines.length === 1 && lines[0].length < 80) {
            // Looks like a sub-heading
            children.push(heading2(lines[0]))
          } else {
            children.push(body(para.replace(/\n/g, ' ').trim()))
          }
        }
      }
      children.push(divider())
    }
  } else if (result.format === 'pages' && result.pages) {
    for (const page of result.pages) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Page ${page.page}`,
              size: 16,
              color: '999999',
              bold: true,
            }),
          ],
          spacing: { before: 240, after: 80 },
        })
      )
      const paras = page.content.split('\n\n').filter(p => p.trim())
      for (const para of paras) {
        children.push(body(para.replace(/\n/g, ' ').trim()))
      }
    }
  }

  // ── Build document ──
  const doc = new Document({
    creator: 'GeezTranscribe — geeztranscribe.com',
    description: `Transcribed from ${result.source_file}`,
    sections: [
      {
        properties: {},
        children,
      },
    ],
    styles: {
      default: {
        document: {
          run: {
            font: 'Noto Serif',
            size: 22,
          },
        },
      },
    },
  })

  const blob = await Packer.toBlob(doc)
  return new Blob([blob], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

/**
 * Trigger a browser download of the DOCX file.
 */
export async function downloadDocx(result: TranscribeResult): Promise<void> {
  const blob = await exportToDocx(result)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = result.source_file.replace(/\.pdf$/i, '') + '_transcribed.docx'
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Trigger a browser download of the JSON result.
 */
export function downloadJson(result: TranscribeResult): void {
  const json = JSON.stringify(result, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = result.source_file.replace(/\.pdf$/i, '') + '_transcribed.json'
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Trigger a browser download of plain text.
 */
export function downloadTxt(result: TranscribeResult): void {
  let text = ''
  if (result.format === 'numbered_qa' && result.questions) {
    text = result.questions
      .map(q => `${q.number}. ${q.question}\n${q.answer}`)
      .join('\n\n')
  } else if (result.format === 'sectioned' && result.sections) {
    text = result.sections
      .map(s => `== ${s.title} ==\n\n${s.content}`)
      .join('\n\n---\n\n')
  } else if (result.format === 'pages' && result.pages) {
    text = result.pages.map(p => `[Page ${p.page}]\n${p.content}`).join('\n\n')
  }
  const blob = new Blob([text], { type: 'text/plain; charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = result.source_file.replace(/\.pdf$/i, '') + '_transcribed.txt'
  a.click()
  URL.revokeObjectURL(url)
}
