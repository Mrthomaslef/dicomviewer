import { zipSync, strToU8 } from 'fflate';
import {
  AnnotationItem,
  BurnedInMaskRect,
  PedagogicalManifest,
  SeriesManifest,
  WindowPresetConfig,
} from '../types/manifest';
import { ParsedDicomSeries } from './dicomReader';
import type { WorkerEncodeRequest, WorkerEncodeResponse } from './webpEncoder.worker';

export interface StudioSeriesBuildOptions {
  series: ParsedDicomSeries;
  seriesId: string;
  description: string;
  startIndex: number;
  endIndex: number;
  step: 1 | 2 | 3 | 4;
  capMatrix512: boolean;
  doublePackCt: boolean;
  customWindowCenter: number;
  customWindowWidth: number;
  masks: BurnedInMaskRect[];
  // Map de sliceIndex (dans la série d'origine) -> liste d'annotations
  annotationsByOriginalSlice: Record<number, AnnotationItem[]>;
}

export interface TPackBuildConfig {
  caseId: string;
  title: string;
  modality: "MR" | "CT" | "RX" | "CR" | "DX" | "XA" | "US";
  anatomicalRegion?: string;
  clinicalHistory?: string;
  diagnosis?: string;
  keySliceIndex?: number;
  keyWindowKey?: string;
  seriesOptions: StudioSeriesBuildOptions[];
}

export const CT_DOUBLE_PACK_WINDOWS: WindowPresetConfig[] = [
  { key: 'bone', label: 'Os (WL 400 / WW 1800)', windowCenter: 400, windowWidth: 1800 },
  { key: 'soft', label: 'Parties Molles (WL 50 / WW 350)', windowCenter: 50, windowWidth: 350 },
];

/**
 * Projette les valeurs physiques sur [0, 255] selon WindowCenter (WL) et WindowWidth (WW) :
 * val8 = clamp(((val - (WL - WW / 2)) / WW) * 255, 0, 255)
 */
export function applyWindowLut8Bit(
  physicalPixels: Float32Array,
  width: number,
  height: number,
  windowCenter: number,
  windowWidth: number,
  targetImageData: ImageData
): void {
  const data = targetImageData.data;
  const minVal = windowCenter - windowWidth / 2;
  const invWW = 255 / Math.max(1e-5, windowWidth);
  const total = width * height;

  for (let i = 0; i < total; i++) {
    const val = physicalPixels[i];
    let val8 = ((val - minVal) * invWW) | 0;
    if (val8 < 0) val8 = 0;
    else if (val8 > 255) val8 = 255;

    const idx = i * 4;
    data[idx] = val8;
    data[idx + 1] = val8;
    data[idx + 2] = val8;
    data[idx + 3] = 255;
  }
}

/**
 * Calcule les nouvelles dimensions et le nouveau pixelSpacing si le plafonnement à 512px est actif.
 * Garantit que newSpacing = oldSpacing * (W_old / W_new) pour conserver des mesures en mm 100% exactes.
 */
export function computeTargetGeometry(
  oldWidth: number,
  oldHeight: number,
  oldPixelSpacing: [number, number],
  capMatrix512: boolean
): {
  width: number;
  height: number;
  pixelSpacing: [number, number];
} {
  if (!capMatrix512 || (oldWidth <= 512 && oldHeight <= 512)) {
    return {
      width: oldWidth,
      height: oldHeight,
      pixelSpacing: [oldPixelSpacing[0], oldPixelSpacing[1]],
    };
  }

  const maxDim = Math.max(oldWidth, oldHeight);
  const scale = 512 / maxDim;
  const newWidth = Math.max(1, Math.round(oldWidth * scale));
  const newHeight = Math.max(1, Math.round(oldHeight * scale));

  const newRowSpacing = Number((oldPixelSpacing[0] * (oldHeight / newHeight)).toFixed(4));
  const newColSpacing = Number((oldPixelSpacing[1] * (oldWidth / newWidth)).toFixed(4));

  return {
    width: newWidth,
    height: newHeight,
    pixelSpacing: [newRowSpacing, newColSpacing],
  };
}

/**
 * Fallback d'encodage WebP sur le thread principal via HTMLCanvasElement ou OffscreenCanvas
 */
export async function encodeSliceWebPMainThread(
  physicalPixels: Float32Array,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number,
  windowCenter: number,
  windowWidth: number,
  masks: BurnedInMaskRect[],
  quality: number = 0.85
): Promise<Uint8Array> {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcWidth;
  srcCanvas.height = srcHeight;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) {
    throw new Error('Impossible d’initialiser le contexte Canvas 2D');
  }

  const imageData = srcCtx.createImageData(srcWidth, srcHeight);
  applyWindowLut8Bit(physicalPixels, srcWidth, srcHeight, windowCenter, windowWidth, imageData);
  srcCtx.putImageData(imageData, 0, 0);

  let outCanvas = srcCanvas;
  let outCtx = srcCtx;

  if (targetWidth !== srcWidth || targetHeight !== srcHeight) {
    outCanvas = document.createElement('canvas');
    outCanvas.width = targetWidth;
    outCanvas.height = targetHeight;
    const scaledCtx = outCanvas.getContext('2d');
    if (!scaledCtx) {
      throw new Error('Impossible d’initialiser le contexte Canvas redimensionné');
    }
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.imageSmoothingQuality = 'high';
    scaledCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
    outCtx = scaledCtx;
  }

  if (masks.length > 0) {
    outCtx.fillStyle = '#000000';
    for (const m of masks) {
      outCtx.fillRect(
        Math.round(m.x * targetWidth),
        Math.round(m.y * targetHeight),
        Math.round(m.width * targetWidth),
        Math.round(m.height * targetHeight)
      );
    }
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Échec toBlob WebP'));
      },
      'image/webp',
      quality
    );
  });

  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Gestionnaire d'encodage WebP utilisant un Web Worker dédié (OffscreenCanvas) avec fallback HTMLCanvasElement
 */
class WebPEncoderBridge {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void }
  >();
  private workerFailed = false;

  constructor() {
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./webpEncoder.worker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = (e: MessageEvent<WorkerEncodeResponse>) => {
          const { id, webpBytes, error } = e.data;
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          if (error || !webpBytes) {
            entry.reject(new Error(error || 'Erreur encodage Worker'));
          } else {
            entry.resolve(webpBytes);
          }
        };
        this.worker.onerror = () => {
          this.workerFailed = true;
        };
      } catch {
        this.workerFailed = true;
      }
    } else {
      this.workerFailed = true;
    }
  }

  async encodeSlice(
    physicalPixels: Float32Array,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number,
    windowCenter: number,
    windowWidth: number,
    masks: BurnedInMaskRect[],
    quality: number = 0.85
  ): Promise<Uint8Array> {
    if (!this.workerFailed && this.worker) {
      try {
        const id = this.nextId++;
        const copyPixels = new Float32Array(physicalPixels);
        const req: WorkerEncodeRequest = {
          id,
          physicalPixels: copyPixels,
          srcWidth,
          srcHeight,
          targetWidth,
          targetHeight,
          windowCenter,
          windowWidth,
          masks: masks.map((m) => ({
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
          })),
          quality,
        };
        return await new Promise<Uint8Array>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.worker!.postMessage(req, [copyPixels.buffer]);
        });
      } catch {
        this.workerFailed = true;
      }
    }

    return encodeSliceWebPMainThread(
      physicalPixels,
      srcWidth,
      srcHeight,
      targetWidth,
      targetHeight,
      windowCenter,
      windowWidth,
      masks,
      quality
    );
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

/**
 * Estime le poids final de l'archive .tpack en octets avant ou pendant la configuration
 */
export function estimateTPackSizeBytes(options: StudioSeriesBuildOptions[]): {
  rawTotalBytes: number;
  estimatedTpackBytes: number;
  reductionPercentage: number;
  retainedSliceCount: number;
  totalEncodedFrames: number;
} {
  let rawTotalBytes = 0;
  let estimatedTpackBytes = 2048; // manifest.json + structure ZIP
  let retainedSliceCount = 0;
  let totalEncodedFrames = 0;

  for (const opt of options) {
    rawTotalBytes += opt.series.totalRawBytes;
    const clampedStart = Math.max(0, Math.min(opt.startIndex, opt.series.slices.length - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(opt.endIndex, opt.series.slices.length - 1));
    const count = Math.floor((clampedEnd - clampedStart) / opt.step) + 1;
    retainedSliceCount += count;

    const geom = computeTargetGeometry(
      opt.series.width,
      opt.series.height,
      opt.series.pixelSpacing,
      opt.capMatrix512
    );

    const numWindows = opt.series.modality === 'CT' && opt.doublePackCt ? 2 : 1;
    const frames = count * numWindows;
    totalEncodedFrames += frames;

    // En WebP q=0.85 8-bit médical, une coupe 512x512 pèse en moyenne ~14 à 22 Ko (~0.065 octet/pixel)
    const bytesPerFrame = Math.round(geom.width * geom.height * 0.068);
    estimatedTpackBytes += frames * bytesPerFrame;
  }

  const reductionPercentage =
    rawTotalBytes > 0
      ? Math.max(0, Math.min(99.5, ((rawTotalBytes - estimatedTpackBytes) / rawTotalBytes) * 100))
      : 96.5;

  return {
    rawTotalBytes,
    estimatedTpackBytes,
    reductionPercentage,
    retainedSliceCount,
    totalEncodedFrames,
  };
}

/**
 * Construit une archive .tpack complète (ZIP en mémoire via fflate) contenant manifest.json et les piles WebP
 */
export async function buildTPackArchive(
  config: TPackBuildConfig,
  onProgress?: (encodedFrames: number, totalFrames: number) => void
): Promise<Uint8Array> {
  const zipFiles: Record<string, Uint8Array> = {};
  const seriesManifests: SeriesManifest[] = [];
  const encoder = new WebPEncoderBridge();

  const { totalEncodedFrames } = estimateTPackSizeBytes(config.seriesOptions);
  let encodedSoFar = 0;

  try {
    for (const opt of config.seriesOptions) {
      const { series } = opt;
      const clampedStart = Math.max(0, Math.min(opt.startIndex, series.slices.length - 1));
      const clampedEnd = Math.max(clampedStart, Math.min(opt.endIndex, series.slices.length - 1));

      // Décimation longitudinale
      const selectedIndices: number[] = [];
      for (let idx = clampedStart; idx <= clampedEnd; idx += opt.step) {
        selectedIndices.push(idx);
      }

      // Géométrie cible et recalcul exact de pixelSpacing
      const geom = computeTargetGeometry(
        series.width,
        series.height,
        series.pixelSpacing,
        opt.capMatrix512
      );

      // Épaisseur effective après décimation (SliceThickness * step)
      const effectiveSliceThickness = Number((series.sliceThickness * opt.step).toFixed(2));

      // Stratégie Multi-Fenêtres (Double Pack TDM vs Fenêtre standard)
      const windowsToEncode: WindowPresetConfig[] =
        series.modality === 'CT' && opt.doublePackCt
          ? CT_DOUBLE_PACK_WINDOWS
          : [
              {
                key: 'default',
                label:
                  series.modality === 'CT'
                    ? `Fenêtre (WL ${opt.customWindowCenter} / WW ${opt.customWindowWidth})`
                    : `Standard (WL ${opt.customWindowCenter} / WW ${opt.customWindowWidth})`,
                windowCenter: opt.customWindowCenter,
                windowWidth: opt.customWindowWidth,
              },
            ];

      const availableWindows = windowsToEncode.map((w) => ({
        key: w.key,
        label: w.label,
        folderPath: `series/${opt.seriesId}/${w.key}`,
      }));

      const slicesManifest: SeriesManifest['slices'] = [];

      for (let outIdx = 0; outIdx < selectedIndices.length; outIdx++) {
        const origIdx = selectedIndices[outIdx];
        const dicomSlice = series.slices[origIdx];
        const fileName = `${String(outIdx).padStart(3, '0')}.webp`;

        for (const win of windowsToEncode) {
          const webpBytes = await encoder.encodeSlice(
            dicomSlice.physicalPixels,
            series.width,
            series.height,
            geom.width,
            geom.height,
            win.windowCenter,
            win.windowWidth,
            opt.masks,
            0.85
          );
          const zipPath = `series/${opt.seriesId}/${win.key}/${fileName}`;
          zipFiles[zipPath] = webpBytes;

          encodedSoFar++;
          if (onProgress) {
            onProgress(encodedSoFar, totalEncodedFrames);
          }
        }

        const sliceAnnotations = opt.annotationsByOriginalSlice[origIdx];
        slicesManifest.push({
          index: outIdx,
          zPosition: Number(dicomSlice.zProjection.toFixed(2)),
          ...(sliceAnnotations && sliceAnnotations.length > 0
            ? { annotations: sliceAnnotations }
            : {}),
        });
      }

      seriesManifests.push({
        id: opt.seriesId,
        description: opt.description || series.description,
        modality: series.modality,
        width: geom.width,
        height: geom.height,
        sliceCount: selectedIndices.length,
        pixelSpacing: geom.pixelSpacing,
        effectiveSliceThickness,
        availableWindows,
        slices: slicesManifest,
      });
    }
  } finally {
    encoder.terminate();
  }

  const manifest: PedagogicalManifest = {
    formatVersion: '1.0',
    caseId: config.caseId,
    title: config.title,
    modality: config.modality,
    anatomicalRegion: config.anatomicalRegion,
    clinicalHistory: config.clinicalHistory,
    diagnosis: config.diagnosis,
    keySliceIndex: config.keySliceIndex,
    keyWindowKey: config.keyWindowKey,
    series: seriesManifests,
  };

  zipFiles['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  // Compression ZIP ultra-rapide en mémoire vive (level 0 pour les .webp déjà compressés, mais manifest compressé)
  return zipSync(zipFiles, { level: 1 });
}
