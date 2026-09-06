// QR scanning, for the NWC connection string.
//
// The string is long and every wallet already shows it as a QR, so on a phone the camera is
// the only realistic way in. The camera is opened when asked and the stream is stopped on
// every exit path — including cancel and decode failure.
//
// Decoding prefers the native `BarcodeDetector` (Chrome, Android WebView): no bytes shipped
// and no per-frame copy. Safari has no such API, so jsQR is imported dynamically — only on
// the browsers that need it, and only once the button is pressed.

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
};

/** Whether to offer the button at all. A desktop without a camera shouldn't see it. */
export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

type Decode = (video: HTMLVideoElement) => Promise<string | null>;

async function makeDecoder(): Promise<Decode> {
  const Detector = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (Detector) {
    // Present but without QR support is possible; asking is cheap and the fallback is there.
    const formats = await Detector.getSupportedFormats?.().catch((): string[] => []);
    if (!formats || formats.length === 0 || formats.includes('qr_code')) {
      const detector = new Detector({ formats: ['qr_code'] });
      return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
    }
  }

  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return async (video) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null; // first frames arrive before the dimensions do
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data ?? null;
  };
}

/**
 * Open the camera and resolve with the first QR payload, or `null` if the user cancels.
 *
 * Rejects only when the camera itself is unavailable — denied permission, no device, or an
 * insecure origin. Those are worth showing; a frame that won't decode is not.
 */
export async function scanQr(): Promise<string | null> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
  });

  const overlay = document.createElement('div');
  overlay.className = 'scanner';
  overlay.innerHTML = `
    <video playsinline muted></video>
    <p class="dim small">Point the camera at the connection QR in your wallet.</p>
    <button class="action" type="button">Cancel</button>`;
  const video = overlay.querySelector('video')!;
  video.muted = true;
  video.playsInline = true;
  document.body.appendChild(overlay);

  try {
    video.srcObject = stream;
    await video.play();
    const decode = await makeDecoder();

    return await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };

      overlay.querySelector('button')!.onclick = () => finish(null);
      overlay.onclick = (e) => {
        if (e.target === overlay) finish(null); // tapping the backdrop cancels
      };

      const tick = async () => {
        if (done) return;
        try {
          const text = await decode(video);
          if (text) return finish(text);
        } catch {
          // Most frames don't contain a code, and some decoders throw rather than return
          // null. Neither is an error worth surfacing — keep looking.
        }
        requestAnimationFrame(() => void tick());
      };
      void tick();
    });
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    overlay.remove();
  }
}
