/**
 * index.ts — public API for the lib package
 * Import from here in components, not from individual files.
 */

export {
  fixEncoding,
  fixJsonObject,
  countEncodingIssues,
  generateDiff,
  normalizeGeezPunctuation,
  O_WORD_MAP,
} from './fixEncoding'
export type { CorrectionEntry, FixEncodingOptions } from './fixEncoding'

export { extractPdfText, getPdfPageCount } from './extractPdf'
export type { ExtractionResult, ExtractionProgress } from './extractPdf'

export { ocrPdf, ocrSinglePage, OCR_PROFILES, isAbortError } from './ocrPdf'
export type { OcrResult, OcrProgress, OcrPageMetric, OcrProfile, OcrProfileId, OcrOptions } from './ocrPdf'

export { ocrImage, isImageFile, SUPPORTED_IMAGE_EXTENSIONS, SUPPORTED_IMAGE_MIME_TYPES } from './ocrImage'

export { enhanceCanvas } from './preprocess'
export type { EnhanceOptions, EnhanceResult } from './preprocess'

export { structureOutput } from './structureOutput'
export type { TranscribeResult, QAItem, Section, PageItem, StructureFormat, StructureOptions } from './structureOutput'

export { exportToDocx, downloadDocx, downloadJson, downloadTxt } from './exportDocx'

export {
  transcribeFile,
  transcribePdf,
  isSupportedFile,
} from './pipeline'
export type { PipelineOptions, PipelineProgress, PipelineResult, PipelineStep } from './pipeline'

export { detectLanguageProfile, mergeEditsIntoResult } from './resultUtils'
export type { LanguageProfileScore } from './resultUtils'

export { recentUploadsStore } from './recentStore'
export type { RecentUploadEntry } from './recentStore'
