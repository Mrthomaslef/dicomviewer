/// <reference lib="webworker" />

export interface WorkerEncodeRequest {
  id: number;
  physicalPixels: Float32Array;
  srcWidth: number;
  srcHeight: number;
  targetWidth: number;
  targetHeight: number;
  windowCenter: number;
  windowWidth: number;
  masks: { x: number; y: number; width: number; height: number }[];
  quality: number;
}

export interface WorkerEncodeResponse {
  id: number;
  webpBytes?: Uint8Array;
  error?: string;
}

self.onmessage = async (event: MessageEvent<WorkerEncodeRequest>) => {
  const {
    id,
    physicalPixels,
    srcWidth,
    srcHeight,
    targetWidth,
    targetHeight,
    windowCenter,
    windowWidth,
    masks,
    quality,
  } = event.data;

  try {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas non supporté dans ce Web Worker');
    }

    // 1. Application de la LUT 8 bits sur la matrice source
    const srcCanvas = new OffscreenCanvas(srcWidth, srcHeight);
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) {
      throw new Error('Contexte 2D OffscreenCanvas indisponible');
    }

    const imgData = srcCtx.createImageData(srcWidth, srcHeight);
    const data = imgData.data;
    const minVal = windowCenter - windowWidth / 2;
    const invWW = 255 / Math.max(1e-5, windowWidth);
    const totalPixels = srcWidth * srcHeight;

    for (let i = 0; i < totalPixels; i++) {
      const val = physicalPixels[i];
      let v8 = ((val - minVal) * invWW) | 0;
      if (v8 < 0) v8 = 0;
      else if (v8 > 255) v8 = 255;

      const idx = i * 4;
      data[idx] = v8;
      data[idx + 1] = v8;
      data[idx + 2] = v8;
      data[idx + 3] = 255;
    }

    srcCtx.putImageData(imgData, 0, 0);

    // 2. Redimensionnement matriciel éventuel + Masquage Burned-in PHI
    let outCanvas: OffscreenCanvas = srcCanvas;
    let outCtx = srcCtx;

    if (targetWidth !== srcWidth || targetHeight !== srcHeight) {
      outCanvas = new OffscreenCanvas(targetWidth, targetHeight);
      const scaledCtx = outCanvas.getContext('2d');
      if (!scaledCtx) {
        throw new Error('Contexte 2D OffscreenCanvas cible indisponible');
      }
      scaledCtx.imageSmoothingEnabled = true;
      scaledCtx.imageSmoothingQuality = 'high';
      scaledCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
      outCtx = scaledCtx;
    }

    // 3. Anonymisation par Destruction Physique (rectangles noirs sur les pixels)
    if (masks && masks.length > 0) {
      outCtx.fillStyle = '#000000';
      for (const m of masks) {
        const rx = Math.round(m.x * targetWidth);
        const ry = Math.round(m.y * targetHeight);
        const rw = Math.round(m.width * targetWidth);
        const rh = Math.round(m.height * targetHeight);
        outCtx.fillRect(rx, ry, rw, rh);
      }
    }

    // 4. Encodage natif image/webp qualité 0.85
    const blob = await outCanvas.convertToBlob({
      type: 'image/webp',
      quality: quality || 0.85,
    });
    const buffer = await blob.arrayBuffer();
    const webpBytes = new Uint8Array(buffer);

    const response: WorkerEncodeResponse = { id, webpBytes };
    self.postMessage(response, [webpBytes.buffer]);
  } catch (err) {
    const response: WorkerEncodeResponse = {
      id,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
