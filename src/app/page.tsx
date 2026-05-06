"use client";

import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import styles from './page.module.css';
import { transcribePdf, type PipelineProgress, type PipelineResult } from '@/lib';

export default function Home() {
  const [outputFormat, setOutputFormat] = useState('JSON');
  const [forceOcr, setForceOcr] = useState(false);
  const [fixEncodingToggle, setFixEncodingToggle] = useState(true);
  const [structureDetection, setStructureDetection] = useState('Auto');
  
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    
    setError(null);
    setResult(null);
    setProgress({ step: 'extracting', message: 'Starting...' });

    try {
      const res = await transcribePdf(
        file,
        {
          fixEncoding: fixEncodingToggle,
          forceOcr,
          forceFormat: structureDetection === 'Pages' ? 'pages' : undefined
        },
        (p) => setProgress(p)
      );
      setResult(res);
      setProgress(null);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred during transcription');
      setProgress(null);
    }
  }, [fixEncodingToggle, forceOcr, structureDetection]);
  
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxSize: 10485760, // 10MB
  });

  return (
    <div className={styles.container}>
      {/* Left Sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.brand}>GEEZ TRANSCRIBE</div>
        <div className={styles.tagline}>Ethiopic PDF → clean JSON</div>
        
        <div className={styles.divider} />
        
        <div className={styles.sectionTitle}>Output format</div>
        <div className={styles.segmentedControl}>
          {['JSON', 'DOCX', 'TXT'].map(fmt => (
            <div 
              key={fmt}
              className={`${styles.segmentBtn} ${outputFormat === fmt ? styles.active : ''}`}
              onClick={() => setOutputFormat(fmt)}
            >
              {fmt}
            </div>
          ))}
        </div>
        
        <div className={styles.sectionTitle}>OCR mode</div>
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>Force OCR</span>
          <button 
            className={`${styles.toggleSwitch} ${forceOcr ? styles.toggleOn : ''}`}
            onClick={() => setForceOcr(!forceOcr)}
          />
        </div>

        <div className={styles.divider} style={{ margin: '1rem 0' }} />

        <div className={styles.sectionTitle}>Processing</div>
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>Fix encoding</span>
          <button 
            className={`${styles.toggleSwitch} ${fixEncodingToggle ? styles.toggleOn : ''}`}
            onClick={() => setFixEncodingToggle(!fixEncodingToggle)}
          />
        </div>
        
        <div className={styles.toggleRow} style={{ marginTop: '0.5rem' }}>
          <span className={styles.toggleLabel}>Structure det.</span>
          <button 
            className={`${styles.toggleSwitch} ${structureDetection === 'Auto' ? styles.toggleOn : ''}`}
            onClick={() => setStructureDetection(structureDetection === 'Auto' ? 'Pages' : 'Auto')}
          />
        </div>
        
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          Amharic · Ge'ez
        </div>
      </aside>

      {/* Center Main */}
      <main className={styles.main}>
        <div {...getRootProps()} className={styles.uploadZone}>
          <input {...getInputProps()} />
          
          <div className={`${styles.regMark} ${styles.tl}`} />
          <div className={`${styles.regMark} ${styles.tr}`} />
          <div className={`${styles.regMark} ${styles.bl}`} />
          <div className={`${styles.regMark} ${styles.br}`} />
          
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--border-stone)" strokeWidth="1" strokeLinecap="square" strokeLinejoin="miter" className={styles.crossGhost}>
            {/* Minimalist geometric cross representation */}
            <path d="M12 2v20M2 12h20M12 6h-4v-4M12 18h4v4M6 12v4h-4M18 12v-4h4" />
          </svg>
          
          <div className={styles.uploadTitle}>
            {isDragActive ? "DROP PDF NOW" : "DROP PDF HERE"}
          </div>
          <div className={styles.uploadSubtitle}>or click to browse</div>
          <div className={styles.uploadSubtitle} style={{ marginTop: '1rem', opacity: 0.5 }}>
            10MB · PDF only
          </div>
        </div>
        
        <div className={styles.pillRow}>
          <div className={styles.pill}>Amharic</div>
          <div className={styles.pill}>Ge'ez</div>
        </div>
        
        {error && (
          <div style={{ marginTop: '2rem', color: '#ff4d4f', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
            Error: {error}
          </div>
        )}
      </main>

      {/* Right Panel */}
      <aside className={styles.panel}>
        {!progress && !result ? (
          <div className={styles.emptyState}>
            <div className={styles.ghostNumeral}>01</div>
            <div className={styles.emptyMessage}>Output will appear here</div>
          </div>
        ) : progress ? (
          <div style={{ padding: '2rem', fontFamily: 'var(--font-mono)', fontSize: '13px' }}>
            <h3 style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>PROCESSING</h3>
            <div style={{ color: 'var(--accent-gold)' }}>Step: {progress.step}</div>
            {progress.message && <div>{progress.message}</div>}
            {progress.page && progress.totalPages && (
              <div>Page: {progress.page} / {progress.totalPages}</div>
            )}
          </div>
        ) : result ? (
          <div style={{ padding: '2rem', fontFamily: 'var(--font-mono)', fontSize: '13px', overflowY: 'auto', height: '100%' }}>
            <h3 style={{ color: 'var(--success)', marginBottom: '1rem' }}>COMPLETE</h3>
            <div style={{ marginBottom: '1rem' }}>Format: {result.data.format}</div>
            <div style={{ marginBottom: '1rem' }}>Corrections: {result.data.correction_count}</div>
            
            <div style={{ borderTop: '1px solid var(--border-stone)', paddingTop: '1rem', marginTop: '1rem' }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)' }}>
                {JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
