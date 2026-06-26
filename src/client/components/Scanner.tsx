import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';

/**
 * Live camera QR scanner. Prefers the rear camera. Calls onCode for every
 * decoded frame — the parent is responsible for debouncing / pausing after a
 * hit (pass `paused` to stop the stream). When no camera/permission is
 * available it falls back to a manual code-entry box that also calls onCode.
 */
export function QrScanner({ onCode, paused }: { onCode: (code: string) => void; paused?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (paused) return;
    let controls: IScannerControls | undefined;
    let cancelled = false;
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 200 });
    void (async () => {
      try {
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          videoRef.current!,
          (result) => {
            if (result) onCodeRef.current(result.getText());
          },
        );
        if (cancelled) controls.stop();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'camera unavailable');
      }
    })();
    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [paused]);

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const v = manual.trim();
    if (v) {
      onCodeRef.current(v);
      setManual('');
    }
  }

  if (error) {
    return (
      <div className="notice">
        <div className="small" style={{ marginBottom: 8 }}>No camera available — enter a code manually:</div>
        <form className="row" onSubmit={submitManual}>
          <input
            className="grow"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="e.g. OBJ-000123"
            style={{ padding: 12, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
          />
          <button className="btn primary">Enter</button>
        </form>
      </div>
    );
  }
  return (
    <div className="scanbox">
      <video ref={videoRef} muted playsInline />
      <div className="scan-reticle" />
    </div>
  );
}
