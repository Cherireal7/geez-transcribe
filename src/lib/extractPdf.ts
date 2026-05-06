export interface ExtractionProgress {
  page: number
  total: number
}

export interface ExtractionResult {
  pages: string[]
  method: 'text' | 'needs-ocr'
  pageCount: number
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>
  getViewport(options: { scale: number }): { width: number; height: number }
  render(options: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
    canvas: HTMLCanvasElement
  }): { promise: Promise<void> }
}

interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  cleanup?: () => void
  destroy?: () => Promise<void> | void
}

interface PdfJsLike {
  version: string
  GlobalWorkerOptions: { workerSrc: string }
  getDocument(options: { data: ArrayBuffer }): { promise: Promise<PdfDocumentLike> }
}

export interface PdfDocumentSession {
  pdf: PdfDocumentLike
  pageCount: number
  release: () => Promise<void>
}

interface PdfTextItemLike {
  str: string
}

function isPdfTextItemLike(item: unknown): item is PdfTextItemLike {
  if (typeof item !== 'object' || item === null) return false
  const candidate = item as { str?: unknown }
  return typeof candidate.str === 'string'
}

async function getPdfJs(): Promise<PdfJsLike> {
  const pdfjsLib = (await import('pdfjs-dist')) as unknown as PdfJsLike
  if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`
  }
  return pdfjsLib
}

export async function openPdfDocument(file: File): Promise<PdfDocumentSession> {
  const pdfjsLib = await getPdfJs()
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise

  return {
    pdf,
    pageCount: pdf.numPages,
    release: async () => {
      pdf.cleanup?.()
      if (pdf.destroy) {
        await pdf.destroy()
      }
    },
  }
}

function detectExtractionMethod(pages: string[]): 'text' | 'needs-ocr' {
  if (pages.length === 0) return 'needs-ocr'

  const textDensity = pages.map(page => page.replace(/\s+/g, '').length)
  const pagesWithReadableText = textDensity.filter(chars => chars >= 24).length
  const averageChars = textDensity.reduce((sum, chars) => sum + chars, 0) / pages.length
  const lowCoverage = pagesWithReadableText <= Math.max(1, Math.floor(pages.length * 0.35))

  return lowCoverage || averageChars < 45 ? 'needs-ocr' : 'text'
}

export async function extractPdfText(
  file: File,
  onProgress?: (p: ExtractionProgress) => void
): Promise<ExtractionResult> {
  const session = await openPdfDocument(file)
  try {
    const pages: string[] = []
    for (let i = 1; i <= session.pageCount; i++) {
      const page = await session.pdf.getPage(i)
      const content = await page.getTextContent()
      const text = content.items
        .filter(isPdfTextItemLike)
        .map(item => item.str)
        .join(' ')
      pages.push(text)
      onProgress?.({ page: i, total: session.pageCount })
    }

    return {
      pages,
      method: detectExtractionMethod(pages),
      pageCount: session.pageCount,
    }
  } finally {
    await session.release()
  }
}

export async function getPdfPageCount(file: File): Promise<number> {
  const session = await openPdfDocument(file)
  try {
    return session.pageCount
  } finally {
    await session.release()
  }
}

export async function rasterizePageFromSession(
  session: PdfDocumentSession,
  pageNumber: number,
  scale = 2.0
): Promise<HTMLCanvasElement> {
  const page = await session.pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const canvasContext = canvas.getContext('2d')
  if (!canvasContext) {
    throw new Error('Unable to initialize PDF canvas context')
  }

  await page.render({ canvasContext, viewport, canvas }).promise
  return canvas
}

export async function rasterizePage(file: File, pageNumber: number, scale = 2.0): Promise<HTMLCanvasElement> {
  const session = await openPdfDocument(file)
  try {
    return await rasterizePageFromSession(session, pageNumber, scale)
  } finally {
    await session.release()
  }
}
