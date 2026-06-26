import { useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';

/**
 * Live camera QR scanner. Prefers the rear camera. Calls onCode for every
 * decoded frame — the parent is responsible for debouncing / pausing after a
 * hit (pass `paused` to stop the stream). Falls back to a message + manual
 * entry when no camera or permission is available.
 */
export function QrScanner({ onCode, paused }: { onCode: (code: string) => void; paused?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
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

  if (error) {
    return <div className="notice">Camera unavailable ({error}). Type the code below instead.</div>;
  }
  return (
    <div className="scanbox">
      <video ref={videoRef} muted playsInline />
      <div className="scan-reticle" />
    </div>
  );
}
