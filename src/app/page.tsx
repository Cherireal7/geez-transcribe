"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import {
  Copy,
  Download,
  FileCode,
  FileText,
  FileType,
  GripVertical,
  History,
  Play,
  RotateCcw,
  Sparkles,
  StopCircle,
  Trash2,
  Upload,
} from "lucide-react";
import styles from "./page.module.css";
import {
  OCR_PROFILES,
  SUPPORTED_IMAGE_EXTENSIONS,
  detectLanguageProfile,
  downloadDocx,
  downloadJson,
  downloadTxt,
  isImageFile,
  isSupportedFile,
  mergeEditsIntoResult,
  recentUploadsStore,
  transcribeFile,
  type OcrProfileId,
  type PipelineProgress,
  type PipelineResult,
  type RecentUploadEntry,
  type TranscribeResult,
} from "@/lib";

const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const SAMPLE_PDF_URL = "/samples/geez-sample.pdf";
const SAMPLE_PDF_NAME = "geez-sample.pdf";
const SAMPLE_IMAGE_NAME = "geez-sample.png";
const SAMPLE_LINES = [
  "እግዚአብሔር በመጀመሪያ ሰማይንና ምድርን ፈጠረ።",
  "ምድርም ባዶና ጨለማ ነበረች፤ የእግዚአብሔር",
  "መንፈስም በውኃው ላይ ይንቀሳቀስ ነበር።",
  "እግዚአብሔርም አለ፦ ብርሃን ይሁን፤ ብርሃንም",
  "ሆነ። እግዚአብሔርም ብርሃኑ ጥሩ እንደሆነ አየ።",
  "",
  "ዘፍጥረት ፩፥፩–፬",
];

async function synthesizeSampleImage(): Promise<File | null> {
  if (typeof document === "undefined") return null;
  const width = 1400;
  const height = 900;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "top";
  ctx.font = "700 44px 'Noto Sans Ethiopic', 'Nyala', 'Kefa', serif";
  const paddingX = 80;
  let y = 90;
  for (const line of SAMPLE_LINES) {
    ctx.fillText(line, paddingX, y);
    y += 78;
  }
  ctx.font = "italic 22px 'Georgia', serif";
  ctx.fillStyle = "#555555";
  ctx.fillText("Sample generated for Geez Transcribe · rendered client-side", paddingX, height - 60);
  return await new Promise<File | null>((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      resolve(new File([blob], SAMPLE_IMAGE_NAME, { type: "image/png" }));
    }, "image/png");
  });
}

type DownloadFormat = "DOCX" | "TXT" | "JSON";
type StructureDetection = "Auto" | "Pages";
type WorkspaceMode = "edit" | "json";

type EditMap = Record<number, string>;

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, power);
  return `${value.toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function asReadableTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function confidenceColorClass(confidence: number | undefined): string {
  if (typeof confidence !== "number") return styles.chipNeutral;
  if (confidence >= 80) return styles.chipHigh;
  if (confidence >= 65) return styles.chipMedium;
  return styles.chipLow;
}

interface EditablePage {
  page: number;
  original: string;
  content: string;
  confidence?: number;
  dominantScript?: string;
  headerLabel: string;
}

function buildEditablePages(result: TranscribeResult): EditablePage[] {
  const confidenceByPage = new Map<number, number>();
  if (result.ocr_page_confidence) {
    for (const metric of result.ocr_page_confidence) {
      confidenceByPage.set(metric.page, metric.confidence);
    }
  }

  if (result.format === "pages" && result.pages) {
    return result.pages.map((page) => {
      const script = detectLanguageProfile(page.content).dominant;
      return {
        page: page.page,
        original: page.content,
        content: page.content,
        confidence: confidenceByPage.get(page.page),
        dominantScript: script,
        headerLabel: `Page ${page.page}`,
      };
    });
  }

  if (result.format === "numbered_qa" && result.questions) {
    return result.questions.map((q) => {
      const merged = `${q.question}\n${q.answer}`.trim();
      return {
        page: q.number,
        original: merged,
        content: merged,
        headerLabel: `#${q.number}`,
        dominantScript: detectLanguageProfile(merged).dominant,
      };
    });
  }

  if (result.format === "sectioned" && result.sections) {
    return result.sections.map((section, index) => ({
      page: index + 1,
      original: section.content,
      content: section.content,
      headerLabel: section.title || `Section ${index + 1}`,
      dominantScript: detectLanguageProfile(section.content).dominant,
    }));
  }

  return [];
}

function applyEditsToResult(result: TranscribeResult, edits: EditMap): TranscribeResult {
  return mergeEditsIntoResult(result, edits);
}

function editsAreClean(edits: EditMap): boolean {
  return Object.keys(edits).length === 0;
}

export default function Home() {
  const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>("DOCX");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("edit");
  const [forceOcr, setForceOcr] = useState(false);
  const [fixEncodingToggle, setFixEncodingToggle] = useState(true);
  const [structureDetection, setStructureDetection] = useState<StructureDetection>("Auto");
  const [ocrProfileId, setOcrProfileId] = useState<OcrProfileId>("ethiopic");
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [retryLowConfidence, setRetryLowConfidence] = useState(true);

  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [recentUploads, setRecentUploads] = useState<RecentUploadEntry[]>([]);

  const [editablePages, setEditablePages] = useState<EditablePage[]>([]);
  const [edits, setEdits] = useState<EditMap>({});

  const [mainPanePercent, setMainPanePercent] = useState(56);
  const [isResizing, setIsResizing] = useState(false);
  const [pdfHashPage, setPdfHashPage] = useState<number | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const currentPdfUrl = useMemo(() => {
    if (!currentFile) return null;
    return URL.createObjectURL(currentFile);
  }, [currentFile]);

  const isImage = useMemo(() => (currentFile ? isImageFile(currentFile) : false), [currentFile]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await recentUploadsStore.list();
      if (!cancelled) setRecentUploads(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentPdfUrl) return;
    return () => URL.revokeObjectURL(currentPdfUrl);
  }, [currentPdfUrl]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const bounds = workspace.getBoundingClientRect();
      const nextPercent = ((event.clientX - bounds.left) / bounds.width) * 100;
      setMainPanePercent(Math.min(72, Math.max(30, nextPercent)));
    };

    const handleMouseUp = () => setIsResizing(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  const mergedResult = useMemo(() => {
    if (!result) return null;
    return editsAreClean(edits) ? result.data : applyEditsToResult(result.data, edits);
  }, [edits, result]);

  const jsonPreviewText = useMemo(() => {
    if (!mergedResult) return "";
    return JSON.stringify(mergedResult, null, 2);
  }, [mergedResult]);

  const iframeSrc = useMemo(() => {
    if (!currentPdfUrl || isImage) return null;
    return pdfHashPage ? `${currentPdfUrl}#page=${pdfHashPage}` : currentPdfUrl;
  }, [currentPdfUrl, isImage, pdfHashPage]);

  const runTranscription = useCallback(
    async (file: File) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      setCopied(false);
      setResult(null);
      setEdits({});
      setEditablePages([]);
      setProgress({ step: "extracting", message: "Starting..." });

      try {
        const response = await transcribeFile(
          file,
          {
            fixEncoding: fixEncodingToggle,
            forceOcr,
            ocrProfileId,
            lowConfidenceThreshold: confidenceThreshold,
            retryLowConfidence,
            forceFormat: structureDetection === "Pages" ? "pages" : undefined,
            signal: controller.signal,
          },
          (p) => setProgress(p),
        );

        setResult(response);
        setEditablePages(buildEditablePages(response.data));
        setProgress(null);

        const entry: RecentUploadEntry = {
          id: `${Date.now()}-${file.name}`,
          name: file.name,
          size: file.size,
          uploadedAt: new Date().toISOString(),
          pageCount: response.data.page_count,
          extractionMethod: response.data.extraction_method,
          outputStructure: response.data.format,
          averageConfidence: response.data.average_ocr_confidence,
          kind: response.kind,
        };
        await recentUploadsStore.put(entry);
        const refreshed = await recentUploadsStore.list();
        setRecentUploads(refreshed);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setError("Transcription cancelled.");
        } else {
          const message = err instanceof Error ? err.message : "An error occurred during transcription";
          setError(message);
        }
        setProgress(null);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [confidenceThreshold, fixEncodingToggle, forceOcr, ocrProfileId, retryLowConfidence, structureDetection],
  );

  const acceptFile = useCallback(
    (file: File) => {
      if (!isSupportedFile(file)) {
        setError("Unsupported file type. Upload a PDF or image (PNG, JPG, WebP).");
        return;
      }
      setCurrentFile(file);
      setPdfHashPage(null);
      void runTranscription(file);
    },
    [runTranscription],
  );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      acceptFile(file);
    },
    [acceptFile],
  );

  const onDropRejected = useCallback((rejections: FileRejection[]) => {
    const first = rejections[0];
    const firstError = first?.errors[0];
    if (!firstError) {
      setError("Unable to read the file. Please upload a PDF or image.");
      return;
    }
    if (firstError.code === "file-too-large") {
      setError(`File too large. Maximum supported size is ${MAX_FILE_SIZE_MB}MB.`);
      return;
    }
    if (firstError.code === "file-invalid-type") {
      setError("Unsupported file type. Upload a PDF or image (PNG, JPG, WebP).");
      return;
    }
    setError(firstError.message);
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    onDropRejected,
    noClick: true,
    multiple: false,
    accept: {
      "application/pdf": [".pdf"],
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/webp": [".webp"],
      "image/bmp": [".bmp"],
    },
    maxSize: MAX_FILE_SIZE_BYTES,
  });

  const loadSample = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(SAMPLE_PDF_URL);
      if (response.ok) {
        const blob = await response.blob();
        const sampleFile = new File([blob], SAMPLE_PDF_NAME, {
          type: blob.type || "application/pdf",
        });
        acceptFile(sampleFile);
        return;
      }
    } catch {
      // fall through to synthesized image
    }
    const synthesized = await synthesizeSampleImage();
    if (!synthesized) {
      setError("Could not generate a sample. Please upload your own PDF or image.");
      return;
    }
    acceptFile(synthesized);
  }, [acceptFile]);

  const cancelJob = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const updatePageContent = useCallback((page: number, value: string) => {
    setEditablePages((prev) => prev.map((p) => (p.page === page ? { ...p, content: value } : p)));
    setEdits((prev) => ({ ...prev, [page]: value }));
  }, []);

  const resetPage = useCallback((page: number) => {
    setEditablePages((prev) =>
      prev.map((p) => (p.page === page ? { ...p, content: p.original } : p)),
    );
    setEdits((prev) => {
      const next = { ...prev };
      delete next[page];
      return next;
    });
  }, []);

  const resetAllEdits = useCallback(() => {
    setEditablePages((prev) => prev.map((p) => ({ ...p, content: p.original })));
    setEdits({});
  }, []);

  const jumpToPage = useCallback(
    (page: number) => {
      if (!currentFile || isImage) return;
      setPdfHashPage(page);
    },
    [currentFile, isImage],
  );

  const runGenerate = useCallback(() => {
    if (!currentFile || progress) return;
    void runTranscription(currentFile);
  }, [currentFile, progress, runTranscription]);

  const canGenerate = Boolean(currentFile) && !progress;
  const showRegenerate = Boolean(result);

  const downloadSelectedFormat = useCallback(() => {
    if (!mergedResult) return;
    if (downloadFormat === "JSON") return downloadJson(mergedResult);
    if (downloadFormat === "DOCX") return void downloadDocx(mergedResult);
    return downloadTxt(mergedResult);
  }, [downloadFormat, mergedResult]);

  const downloadAllFormats = useCallback(() => {
    if (!mergedResult) return;
    downloadJson(mergedResult);
    void downloadDocx(mergedResult);
    downloadTxt(mergedResult);
  }, [mergedResult]);

  const copyPreview = useCallback(async () => {
    if (!mergedResult) return;
    const text = workspaceMode === "json" ? jsonPreviewText : editablePages.map((p) => `${p.headerLabel}\n${p.content}`).join("\n\n---\n\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [editablePages, jsonPreviewText, mergedResult, workspaceMode]);

  const clearRecent = useCallback(async () => {
    await recentUploadsStore.clear();
    setRecentUploads([]);
  }, []);

  const supportedExtSummary = useMemo(() => {
    const exts = [".pdf", ...SUPPORTED_IMAGE_EXTENSIONS];
    return exts.join(" · ").replace(/^\./, "").replaceAll(" · .", " · ");
  }, []);

  return (
    <div className={styles.pageRoot}>
      <div className={styles.container}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>GEEZ TRANSCRIBE</div>
          <div className={styles.tagline}>Ethiopic PDF & image to structured output</div>

          <div className={styles.divider} />

          <div className={styles.sectionTitle}>Download format</div>
          <div className={styles.segmentedControl}>
            {(["DOCX", "TXT", "JSON"] as DownloadFormat[]).map((format) => (
              <button
                key={format}
                type="button"
                className={`${styles.segmentBtn} ${downloadFormat === format ? styles.active : ""}`}
                onClick={() => setDownloadFormat(format)}
              >
                {format === "JSON" && <FileCode size={14} aria-hidden />}
                {format === "DOCX" && <FileType size={14} aria-hidden />}
                {format === "TXT" && <FileText size={14} aria-hidden />}
                {format}
              </button>
            ))}
          </div>

          <div className={styles.sectionTitle}>OCR mode</div>
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>Force OCR</span>
            <button
              type="button"
              className={`${styles.toggleSwitch} ${forceOcr ? styles.toggleOn : ""}`}
              onClick={() => setForceOcr((v) => !v)}
              aria-pressed={forceOcr}
              aria-label="Toggle force OCR"
            />
          </div>

          <div className={styles.sectionTitle}>Processing</div>
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>Fix encoding</span>
            <button
              type="button"
              className={`${styles.toggleSwitch} ${fixEncodingToggle ? styles.toggleOn : ""}`}
              onClick={() => setFixEncodingToggle((v) => !v)}
              aria-pressed={fixEncodingToggle}
              aria-label="Toggle encoding fixes"
            />
          </div>

          <div className={styles.sectionTitle}>Structure</div>
          <div className={styles.segmentedControl}>
            {(["Auto", "Pages"] as StructureDetection[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`${styles.segmentBtn} ${structureDetection === mode ? styles.active : ""}`}
                onClick={() => setStructureDetection(mode)}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className={styles.sectionTitle}>Language profile</div>
          <select
            className={styles.selectControl}
            value={ocrProfileId}
            onChange={(event) => setOcrProfileId(event.target.value as OcrProfileId)}
            aria-label="OCR language profile"
          >
            {Object.values(OCR_PROFILES).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
          <div className={styles.limitText}>{OCR_PROFILES[ocrProfileId].description}</div>

          <div className={styles.sectionTitle}>Reliability</div>
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>Retry low confidence</span>
            <button
              type="button"
              className={`${styles.toggleSwitch} ${retryLowConfidence ? styles.toggleOn : ""}`}
              onClick={() => setRetryLowConfidence((v) => !v)}
              aria-pressed={retryLowConfidence}
              aria-label="Toggle low confidence retry"
            />
          </div>
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>Low confidence</span>
            <select
              className={styles.inlineSelect}
              value={String(confidenceThreshold)}
              onChange={(event) => setConfidenceThreshold(Number(event.target.value))}
              aria-label="Low confidence threshold"
            >
              <option value="65">&lt; 65</option>
              <option value="70">&lt; 70</option>
              <option value="75">&lt; 75</option>
              <option value="80">&lt; 80</option>
            </select>
          </div>

          <div className={styles.sectionTitle}>Limits</div>
          <div className={styles.limitText}>Accepts {supportedExtSummary}, up to {MAX_FILE_SIZE_MB}MB.</div>
          <div className={styles.limitText}>OCR runs in browser and depends on device memory and CPU.</div>

          <div className={styles.divider} />

          <div className={styles.recentHeader}>
            <History size={14} aria-hidden />
            <span className={styles.sectionTitle}>Recent</span>
            {recentUploads.length > 0 && (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => void clearRecent()}
                aria-label="Clear recent uploads"
              >
                Clear
              </button>
            )}
          </div>
          {recentUploads.length === 0 ? (
            <div className={styles.recentEmpty}>No recent files yet.</div>
          ) : (
            <div className={styles.recentList}>
              {recentUploads.map((item) => (
                <div key={item.id} className={styles.recentItem}>
                  <div className={styles.recentName}>{item.name}</div>
                  <div className={styles.recentMeta}>
                    {formatBytes(item.size)} | {asReadableTime(item.uploadedAt)}
                  </div>
                  <div className={styles.recentMeta}>
                    {item.pageCount ? `${item.pageCount} pages` : "Pages unknown"} |{" "}
                    {item.extractionMethod ?? "method"} |{" "}
                    {typeof item.averageConfidence === "number"
                      ? `${Math.round(item.averageConfidence)}% confidence`
                      : item.outputStructure ?? "format"}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={styles.sidebarFoot}>Amharic · Ge&apos;ez · Greek · Hebrew</div>
        </aside>

        <div className={styles.workspace} ref={workspaceRef}>
          <main
            {...getRootProps({
              className: styles.main,
              style: { flexBasis: `${mainPanePercent}%` },
            })}
          >
            <input {...getInputProps()} />

            {isDragActive && <div className={styles.dragOverlay}>Drop PDF or image to start</div>}

            {!currentFile ? (
              <div className={styles.uploadZone}>
                <Upload size={36} aria-hidden />
                <div className={styles.uploadTitle}>Drop a PDF or image</div>
                <div className={styles.uploadSubtitle}>
                  or choose a file from your device
                </div>
                <div className={styles.uploadActions}>
                  <button type="button" className={styles.primaryBtn} onClick={open}>
                    <Upload size={15} aria-hidden />
                    Select file
                  </button>
                  <button type="button" className={styles.secondaryBtn} onClick={() => void loadSample()}>
                    <Sparkles size={15} aria-hidden />
                    Try a sample
                  </button>
                </div>
                <div className={styles.uploadMeta}>
                  PDF / PNG / JPG / WebP · up to {MAX_FILE_SIZE_MB}MB
                </div>
              </div>
            ) : (
              <div className={styles.pdfShell}>
                <div className={styles.pdfHeader}>
                  <div>
                    <div className={styles.pdfName}>{currentFile?.name}</div>
                    <div className={styles.pdfMeta}>
                      {currentFile ? formatBytes(currentFile.size) : "-"}
                      {isImage ? " · image" : " · PDF"}
                    </div>
                  </div>
                  <div className={styles.pdfHeaderActions}>
                    {progress ? (
                      <button type="button" className={styles.dangerBtn} onClick={cancelJob}>
                        <StopCircle size={15} aria-hidden />
                        Cancel
                      </button>
                    ) : (
                      <button type="button" className={styles.primaryBtn} onClick={runGenerate} disabled={!canGenerate}>
                        {showRegenerate ? <RotateCcw size={15} aria-hidden /> : <Play size={15} aria-hidden />}
                        {showRegenerate ? "Regenerate" : "Generate"}
                      </button>
                    )}
                    <button type="button" className={styles.secondaryBtn} onClick={open}>
                      Replace
                    </button>
                  </div>
                </div>
                <div className={styles.pdfFrameWrap}>
                  {isImage ? (
                    <img
                      src={currentPdfUrl ?? undefined}
                      alt={currentFile?.name ?? "Uploaded image"}
                      className={styles.imagePreview}
                    />
                  ) : iframeSrc ? (
                    <iframe
                      src={iframeSrc}
                      title={currentFile?.name ?? "Uploaded PDF preview"}
                      className={styles.pdfFrame}
                    />
                  ) : null}
                </div>
              </div>
            )}

            {error && <div className={styles.errorBanner}>{error}</div>}
          </main>

          <button
            type="button"
            className={styles.splitter}
            onMouseDown={() => setIsResizing(true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                setMainPanePercent((prev) => Math.max(30, prev - 2));
              }
              if (event.key === "ArrowRight") {
                setMainPanePercent((prev) => Math.min(72, prev + 2));
              }
            }}
            aria-label="Resize source and output panels"
          >
            <GripVertical size={16} aria-hidden />
          </button>

          <aside className={styles.panel} style={{ flexBasis: `${100 - mainPanePercent}%` }}>
            {!progress && !result ? (
              <div className={styles.emptyState}>
                <div className={styles.ghostNumeral}>01</div>
                <div className={styles.emptyMessage}>Output will appear here</div>
              </div>
            ) : progress ? (
              <div className={styles.progressBlock}>
                <h3 className={styles.panelHeading}>Processing</h3>
                <div className={styles.progressLine}>
                  Step: <span>{progress.step}</span>
                </div>
                {progress.message && (
                  <div className={styles.progressLine}>
                    Status: <span>{progress.message}</span>
                  </div>
                )}
                {progress.page && progress.totalPages && (
                  <div className={styles.progressLine}>
                    Page:{" "}
                    <span>
                      {progress.page} / {progress.totalPages}
                    </span>
                  </div>
                )}
                <div className={styles.progressActions}>
                  <button type="button" className={styles.dangerBtn} onClick={cancelJob}>
                    <StopCircle size={15} aria-hidden />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              result && mergedResult && (
                <div className={styles.panelContent}>
                  <div className={styles.resultHead}>
                    <h3 className={styles.successHeading}>Complete</h3>
                    <div className={styles.resultMeta}>Structure: {mergedResult.format}</div>
                    <div className={styles.resultMeta}>Corrections: {mergedResult.correction_count}</div>
                    <div className={styles.resultMeta}>Extraction: {mergedResult.extraction_method}</div>
                    <div className={styles.resultMeta}>Pages: {mergedResult.page_count}</div>
                    {mergedResult.language_profile && (
                      <div className={styles.resultMeta}>Profile: {mergedResult.language_profile}</div>
                    )}
                    {typeof mergedResult.average_ocr_confidence === "number" && (
                      <div className={styles.resultMeta}>
                        OCR confidence: {mergedResult.average_ocr_confidence.toFixed(1)}%
                      </div>
                    )}
                    {mergedResult.low_confidence_pages && mergedResult.low_confidence_pages.length > 0 && (
                      <div className={styles.chipRow}>
                        <span className={styles.chipRowLabel}>Low-confidence:</span>
                        {mergedResult.low_confidence_pages.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={`${styles.pageChip} ${styles.chipLow}`}
                            onClick={() => jumpToPage(n)}
                            aria-label={`Jump PDF to page ${n}`}
                          >
                            p{n}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {mergedResult.quality_warnings && mergedResult.quality_warnings.length > 0 && (
                    <div className={styles.warningList}>
                      {mergedResult.quality_warnings.map((warning, index) => (
                        <div key={`${warning}-${index}`} className={styles.warningItem}>
                          {warning}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className={styles.actionRow}>
                    <button type="button" className={styles.secondaryBtn} onClick={runGenerate} disabled={!canGenerate}>
                      <RotateCcw size={15} aria-hidden />
                      Regenerate
                    </button>
                    <button type="button" className={styles.primaryBtn} onClick={downloadSelectedFormat}>
                      <Download size={15} aria-hidden />
                      Download {downloadFormat}
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={downloadAllFormats}>
                      <Download size={15} aria-hidden />
                      All formats
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={() => void copyPreview()}>
                      <Copy size={15} aria-hidden />
                      {copied ? "Copied" : "Copy"}
                    </button>
                    {!editsAreClean(edits) && (
                      <button type="button" className={styles.secondaryBtn} onClick={resetAllEdits}>
                        <Trash2 size={15} aria-hidden />
                        Reset edits
                      </button>
                    )}
                  </div>

                  <div className={styles.modeSwitcher}>
                    <button
                      type="button"
                      className={`${styles.modeBtn} ${workspaceMode === "edit" ? styles.active : ""}`}
                      onClick={() => setWorkspaceMode("edit")}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={`${styles.modeBtn} ${workspaceMode === "json" ? styles.active : ""}`}
                      onClick={() => setWorkspaceMode("json")}
                    >
                      JSON
                    </button>
                    {!editsAreClean(edits) && (
                      <span className={styles.editBadge}>
                        {Object.keys(edits).length} edited
                      </span>
                    )}
                  </div>

                  {workspaceMode === "json" ? (
                    <pre className={styles.previewBox}>{jsonPreviewText}</pre>
                  ) : (
                    <div className={styles.pageList}>
                      {editablePages.length === 0 ? (
                        <div className={styles.recentEmpty}>No editable content.</div>
                      ) : (
                        editablePages.map((page) => {
                          const edited = edits[page.page] !== undefined;
                          return (
                            <div key={page.page} className={styles.pageCard}>
                              <div className={styles.pageCardHeader}>
                                <button
                                  type="button"
                                  className={styles.pageLabelBtn}
                                  onClick={() => jumpToPage(page.page)}
                                  disabled={isImage || !currentFile}
                                >
                                  {page.headerLabel}
                                </button>
                                {typeof page.confidence === "number" && (
                                  <span className={`${styles.pageChip} ${confidenceColorClass(page.confidence)}`}>
                                    {Math.round(page.confidence)}%
                                  </span>
                                )}
                                {page.dominantScript && page.dominantScript !== "unknown" && (
                                  <span className={`${styles.pageChip} ${styles.chipNeutral}`}>
                                    {page.dominantScript}
                                  </span>
                                )}
                                {edited && (
                                  <>
                                    <span className={styles.editedBadge}>edited</span>
                                    <button
                                      type="button"
                                      className={styles.linkBtn}
                                      onClick={() => resetPage(page.page)}
                                    >
                                      revert
                                    </button>
                                  </>
                                )}
                              </div>
                              <textarea
                                className={styles.pageTextarea}
                                value={page.content}
                                onChange={(event) => updatePageContent(page.page, event.target.value)}
                                spellCheck={false}
                                rows={Math.max(4, Math.min(18, page.content.split("\n").length + 1))}
                              />
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            )}
          </aside>
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerText}>Built by Cheri</span>
          <span className={styles.footerDot}>|</span>
          <a href="https://github.com/Cherireal7" target="_blank" rel="noreferrer" className={styles.footerLink}>
            Contact
          </a>
          <span className={styles.footerDot}>|</span>
          <span className={styles.footerText}>Geez Transcribe</span>
        </div>
      </footer>
    </div>
  );
}
