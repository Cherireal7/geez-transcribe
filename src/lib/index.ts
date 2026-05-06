/**
 * index.ts — public API for the lib package
 * Import from here in components, not from individual files.
 */

export { fixEncoding, fixJsonObject, countEncodingIssues, generateDiff, O_WORD_MAP } from './fixEncoding'
export type { CorrectionEntry } from './fixEncoding'

export { extractPdfText, getPdfPageCount } from './extractPdf'
export type { ExtractionResult, ExtractionProgress } from './extractPdf'

export { ocrPdf, ocrSinglePage } from './ocrPdf'
export type { OcrResult, OcrProgress } from './ocrPdf'

export { structureOutput } from './structureOutput'
export type { TranscribeResult, QAItem, Section, PageItem, StructureFormat, StructureOptions } from './structureOutput'

export { exportToDocx, downloadDocx, downloadJson, downloadTxt } from './exportDocx'

export { transcribePdf } from './pipeline'
export type { PipelineOptions, PipelineProgress, PipelineResult, PipelineStep } from './pipeline'
