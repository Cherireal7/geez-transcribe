export interface ExtractionProgress {
  page: number;
  total: number;
}

export interface ExtractionResult {
  pages: string[];
  method: 'text' | 'needs-ocr';
  pageCount: number;
}

async function getPdfJs() {
  const pdfjsLib = await import('pdfjs-dist');
  if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  }
  return pdfjsLib;
}

export async function extractPdfText(
  file: File, 
  onProgress?: (p: ExtractionProgress) => void
): Promise<ExtractionResult> {
  const pdfjsLib = await getPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: string[] = [];
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(' ');
    pages.push(text);
    if (onProgress) onProgress({ page: i, total: pdf.numPages });
  }
  
  const totalChars = pages.join('').length;
  const method = totalChars < pdf.numPages * 50 ? 'needs-ocr' : 'text';
  
  return { pages, method, pageCount: pdf.numPages };
}

export async function getPdfPageCount(file: File): Promise<number> {
  const pdfjsLib = await getPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  return pdf.numPages;
}

export async function rasterizePage(file: File, pageNumber: number, scale: number = 2.0): Promise<HTMLCanvasElement> {
  const pdfjsLib = await getPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
  
  return canvas;
}
