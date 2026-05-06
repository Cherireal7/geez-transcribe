"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Copy, Download, FileCode, FileText, FileType, GripVertical, History, Play, RotateCcw, Upload } from "lucide-react";
import styles from "./page.module.css";
import {
  OCR_PROFILES,
  downloadDocx,
  downloadJson,
  downloadTxt,
  transcribePdf,
  type OcrProfileId,
  type PipelineProgress,
  type PipelineResult,
  type TranscribeResult,
} from "@/lib";

const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_RECENT_ITEMS = 8;
const RECENT_STORAGE_KEY = "geez-transcribe-recent";

type OutputFormat = "JSON" | "DOCX" | "TXT";
type StructureDetection = "Auto" | "Pages";

interface RecentUpload {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  pageCount?: number;
  extractionMethod?: string;
  outputStructure?: string;
}

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

function toPlainTextOutput(result: TranscribeResult): string {
  if (result.format === "numbered_qa" && result.questions) {
    return result.questions.map((q) => `${q.number}. ${q.question}\n${q.answer}`).join("\n\n");
  }
  if (result.format === "sectioned" && result.sections) {
    return result.sections.map((s) => `== ${s.title} ==\n\n${s.content}`).join("\n\n---\n\n");
  }
  if (result.format === "pages" && result.pages) {
    return result.pages.map((p) => `[Page ${p.page}]\n${p.content}`).join("\n\n");
  }
  return "";
}

export default function Home() {
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("JSON");
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
  const [recentUploads, setRecentUploads] = useState<RecentUpload[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_ITEMS) : [];
    } catch {
      return [];
    }
  });

  const [mainPanePercent, setMainPanePercent] = useState(56);
  const [isResizing, setIsResizing] = useState(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  const currentPdfUrl = useMemo(() => {
    if (!currentFile) return null;
    return URL.createObjectURL(currentFile);
  }, [currentFile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentUploads.slice(0, MAX_RECENT_ITEMS)));
  }, [recentUploads]);

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

  const runTranscription = useCallback(
    async (file: File) => {
      setError(null);
      setCopied(false);
      setResult(null);
      setProgress({ step: "extracting", message: "Starting..." });

      try {
        const response = await transcribePdf(
          file,
          {
            fixEncoding: fixEncodingToggle,
            forceOcr,
            ocrProfileId,
            lowConfidenceThreshold: confidenceThreshold,
            retryLowConfidence,
            forceFormat: structureDetection === "Pages" ? "pages" : undefined,
          },
          (p) => setProgress(p),
        );

        setResult(response);
        setProgress(null);
        setRecentUploads((prev) => {
          const next: RecentUpload = {
            id: `${Date.now()}-${file.name}`,
            name: file.name,
            size: file.size,
            uploadedAt: new Date().toISOString(),
            pageCount: response.data.page_count,
            extractionMethod: response.data.extraction_method,
            outputStructure: response.data.format,
          };
          return [next, ...prev.filter((item) => item.name !== file.name)].slice(0, MAX_RECENT_ITEMS);
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "An error occurred during transcription";
        setError(message);
        setProgress(null);
      }
    },
    [confidenceThreshold, fixEncodingToggle, forceOcr, ocrProfileId, retryLowConfidence, structureDetection],
  );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      setCurrentFile(file);
      void runTranscription(file);
    },
    [runTranscription],
  );

  const onDropRejected = useCallback((rejections: FileRejection[]) => {
    const first = rejections[0];
    const firstError = first?.errors[0];
    if (!firstError) {
      setError("Unable to read the file. Please upload a PDF.");
      return;
    }

    if (firstError.code === "file-too-large") {
      setError(`File too large. Maximum supported size is ${MAX_FILE_SIZE_MB}MB.`);
      return;
    }

    if (firstError.code === "file-invalid-type") {
      setError("Unsupported file type. Please upload a PDF file.");
      return;
    }

    setError(firstError.message);
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    onDropRejected,
    noClick: true,
    multiple: false,
    accept: { "application/pdf": [".pdf"] },
    maxSize: MAX_FILE_SIZE_BYTES,
  });

  const previewText = useMemo(() => {
    if (!result) return "";

    if (outputFormat === "JSON") {
      return JSON.stringify(result.data, null, 2);
    }

    return toPlainTextOutput(result.data);
  }, [outputFormat, result]);

  const selectedFormatLabel = useMemo(() => {
    if (outputFormat === "DOCX") return "Formatted DOCX";
    if (outputFormat === "TXT") return "Plain Text";
    return "JSON";
  }, [outputFormat]);

  const downloadSelectedFormat = useCallback(() => {
    if (!result) return;
    if (outputFormat === "JSON") {
      downloadJson(result.data);
      return;
    }
    if (outputFormat === "DOCX") {
      void downloadDocx(result.data);
      return;
    }
    downloadTxt(result.data);
  }, [outputFormat, result]);

  const downloadAllFormats = useCallback(() => {
    if (!result) return;
    downloadJson(result.data);
    void downloadDocx(result.data);
    downloadTxt(result.data);
  }, [result]);

  const copyPreview = useCallback(async () => {
    if (!previewText) return;
    await navigator.clipboard.writeText(previewText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [previewText]);

  const runGenerate = useCallback(() => {
    if (!currentFile || progress) return;
    void runTranscription(currentFile);
  }, [currentFile, progress, runTranscription]);

  const canGenerate = Boolean(currentFile) && !progress;
  const showRegenerate = Boolean(result);

  return (
    <div className={styles.pageRoot}>
      <div className={styles.container}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>GEEZ TRANSCRIBE</div>
          <div className={styles.tagline}>Ethiopic PDF to structured output</div>

          <div className={styles.divider} />

          <div className={styles.sectionTitle}>Output file</div>
          <div className={styles.segmentedControl}>
            {(["JSON", "DOCX", "TXT"] as OutputFormat[]).map((format) => (
              <button
                key={format}
                type="button"
                className={`${styles.segmentBtn} ${outputFormat === format ? styles.active : ""}`}
                onClick={() => setOutputFormat(format)}
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
          <div className={styles.limitText}>Max file size: {MAX_FILE_SIZE_MB}MB per PDF.</div>
          <div className={styles.limitText}>OCR runs in browser and depends on device memory and CPU.</div>

          <div className={styles.divider} />

          <div className={styles.recentHeader}>
            <History size={14} aria-hidden />
            <span className={styles.sectionTitle}>Recent uploads</span>
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
                    {item.pageCount ? `${item.pageCount} pages` : "Pages unknown"} | {item.extractionMethod ?? "method"} |{" "}
                    {item.outputStructure ?? "format"}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={styles.sidebarFoot}>Amharic | Geez</div>
        </aside>

        <div className={styles.workspace} ref={workspaceRef}>
          <main
            {...getRootProps({
              className: styles.main,
              style: { flexBasis: `${mainPanePercent}%` },
            })}
          >
            <input {...getInputProps()} />

            {isDragActive && <div className={styles.dragOverlay}>Drop PDF to start transcription</div>}

            {!currentPdfUrl ? (
              <div className={styles.uploadZone}>
                <Upload size={36} aria-hidden />
                <div className={styles.uploadTitle}>Drop PDF here</div>
                <div className={styles.uploadSubtitle}>or choose a file from your device</div>
                <button type="button" className={styles.primaryBtn} onClick={open}>
                  <Upload size={15} aria-hidden />
                  Select PDF
                </button>
                <div className={styles.uploadMeta}>PDF only | up to {MAX_FILE_SIZE_MB}MB</div>
              </div>
            ) : (
              <div className={styles.pdfShell}>
                <div className={styles.pdfHeader}>
                  <div>
                    <div className={styles.pdfName}>{currentFile?.name}</div>
                    <div className={styles.pdfMeta}>{currentFile ? formatBytes(currentFile.size) : "-"}</div>
                  </div>
                  <div className={styles.pdfHeaderActions}>
                    <button type="button" className={styles.primaryBtn} onClick={runGenerate} disabled={!canGenerate}>
                      {showRegenerate ? <RotateCcw size={15} aria-hidden /> : <Play size={15} aria-hidden />}
                      {showRegenerate ? "Regenerate" : "Generate"}
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={open}>
                      Replace PDF
                    </button>
                  </div>
                </div>
                <div className={styles.pdfFrameWrap}>
                  <iframe
                    src={currentPdfUrl}
                    title={currentFile?.name ?? "Uploaded PDF preview"}
                    className={styles.pdfFrame}
                  />
                </div>
              </div>
            )}

            {error && <div className={styles.errorBanner}>Error: {error}</div>}
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
            aria-label="Resize PDF and output panels"
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
              </div>
            ) : (
              result && (
                <div className={styles.panelContent}>
                  <div className={styles.resultHead}>
                    <h3 className={styles.successHeading}>Complete</h3>
                    <div className={styles.resultMeta}>Structure: {result.data.format}</div>
                    <div className={styles.resultMeta}>Corrections: {result.data.correction_count}</div>
                    <div className={styles.resultMeta}>Extraction: {result.data.extraction_method}</div>
                    <div className={styles.resultMeta}>Pages: {result.data.page_count}</div>
                    {result.data.pipeline_version && <div className={styles.resultMeta}>Pipeline: {result.data.pipeline_version}</div>}
                    {result.data.language_profile && <div className={styles.resultMeta}>Profile: {result.data.language_profile}</div>}
                    {result.data.ocr_engine && <div className={styles.resultMeta}>OCR engine: {result.data.ocr_engine}</div>}
                    {result.data.ocr_language && <div className={styles.resultMeta}>OCR language: {result.data.ocr_language}</div>}
                    {typeof result.data.average_ocr_confidence === "number" && (
                      <div className={styles.resultMeta}>
                        OCR confidence: {result.data.average_ocr_confidence.toFixed(2)}%
                      </div>
                    )}
                    {result.data.low_confidence_pages && result.data.low_confidence_pages.length > 0 && (
                      <div className={styles.resultMeta}>
                        Low-confidence pages: {result.data.low_confidence_pages.join(", ")}
                      </div>
                    )}
                  </div>

                  {result.data.quality_warnings && result.data.quality_warnings.length > 0 && (
                    <div className={styles.warningList}>
                      {result.data.quality_warnings.map((warning, index) => (
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
                      Download {outputFormat}
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={downloadAllFormats}>
                      <Download size={15} aria-hidden />
                      Download all
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={() => void copyPreview()}>
                      <Copy size={15} aria-hidden />
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>

                  <div className={styles.previewLabel}>
                    Preview ({selectedFormatLabel})
                    {outputFormat === "DOCX" && <span className={styles.previewHint}> - final styling is in the downloaded DOCX</span>}
                  </div>
                  <pre className={styles.previewBox}>{previewText}</pre>
                </div>
              )
            )}
          </aside>
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerText}>Built by Cheri</span>
          <span className={styles.footerDot}>•</span>
          <a href="https://github.com/Cherireal7" target="_blank" rel="noreferrer" className={styles.footerLink}>
            Contact
          </a>
          <span className={styles.footerDot}>•</span>
          <span className={styles.footerText}>Geez Transcribe</span>
        </div>
      </footer>
    </div>
  );
}
