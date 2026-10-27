import dicomParser from 'dicom-parser';

export interface ParsedDicomSlice {
  fileName: string;
  fileSizeBytes: number;
  instanceNumber: number;
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  rows: number;
  columns: number;
  pixelSpacing: [number, number]; // [rowSpacing_mm, colSpacing_mm]
  sliceThickness: number;
  imagePositionPatient?: [number, number, number];
  imageOrientationPatient?: [number, number, number, number, number, number];
  zProjection: number;
  windowCenter?: number;
  windowWidth?: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  pixelRepresentation: number;
  bitsAllocated: number;
  photometricInterpretation: string;
  physicalPixels: Float32Array;
  minVal: number;
  maxVal: number;
}

export interface ParsedDicomSeries {
  seriesInstanceUID: string;
  description: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  width: number;
  height: number;
  pixelSpacing: [number, number];
  sliceThickness: number;
  defaultWindowCenter: number;
  defaultWindowWidth: number;
  totalRawBytes: number;
  slices: ParsedDicomSlice[];
}

function parseNumberList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split('\\')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n));
}

function normalizeModality(raw: string | undefined): "MR" | "CT" | "CR" | "DX" | "XA" | "US" {
  const m = (raw || 'CT').trim().toUpperCase();
  if (m === 'MR' || m === 'CT' || m === 'CR' || m === 'DX' || m === 'XA' || m === 'US') {
    return m;
  }
  return 'CT';
}

/**
 * Calcule le vecteur normal au plan de coupe par produit vectoriel des cosinus directeurs
 * ligne (r) et colonne (c), puis projette ImagePositionPatient sur cette normale.
 */
export function computeSpatialProjection(
  ipp?: [number, number, number],
  iop?: [number, number, number, number, number, number],
  fallbackInstanceNumber: number = 0
): number {
  if (!ipp) return fallbackInstanceNumber;
  if (!iop) return ipp[2]; // Fallback coordonnée Z directe

  const [rx, ry, rz, cx, cy, cz] = iop;
  // Produit vectoriel N = R x C
  const nx = ry * cz - rz * cy;
  const ny = rz * cx - rx * cz;
  const nz = rx * cy - ry * cx;

  // Projection scalaire P . N
  return ipp[0] * nx + ipp[1] * ny + ipp[2] * nz;
}

/**
 * Calcule un fenêtrage automatique basé sur les percentiles 1% - 99%
 */
export function computePercentileWindow(pixels: Float32Array): { windowCenter: number; windowWidth: number } {
  if (pixels.length === 0) {
    return { windowCenter: 128, windowWidth: 256 };
  }
  // Échantillonnage rapide (max ~16384 points) pour ne pas bloquer l'UI
  const step = Math.max(1, Math.floor(pixels.length / 16384));
  const sample: number[] = [];
  for (let i = 0; i < pixels.length; i += step) {
    sample.push(pixels[i]);
  }
  sample.sort((a, b) => a - b);

  const p01 = sample[Math.floor(sample.length * 0.01)] ?? sample[0];
  const p99 = sample[Math.floor(sample.length * 0.99)] ?? sample[sample.length - 1];

  const ww = Math.max(1, p99 - p01);
  const wl = p01 + ww / 2;
  return {
    windowCenter: Math.round(wl),
    windowWidth: Math.round(ww),
  };
}

/**
 * Lit et décode un fichier DICOM binaire (.dcm) en coupe calibrée (Unités Hounsfield / Signal)
 */
export async function parseDicomFile(file: File): Promise<ParsedDicomSlice | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);
    const dataSet = dicomParser.parseDicom(byteArray);

    const pixelDataElement = dataSet.elements.x7fe00010;
    if (!pixelDataElement) {
      return null;
    }

    const rows = dataSet.uint16('x00280010') || 256;
    const columns = dataSet.uint16('x00280011') || 256;
    const bitsAllocated = dataSet.uint16('x00280100') || 16;
    const pixelRepresentation = dataSet.uint16('x00280103') ?? 0;
    const samplesPerPixel = dataSet.uint16('x00280002') || 1;
    const photometricInterpretation = (dataSet.string('x00280004') || 'MONOCHROME2').trim();

    const rescaleSlope = dataSet.floatString('x00281053') ?? 1.0;
    const rescaleIntercept = dataSet.floatString('x00281052') ?? 0.0;

    const instanceNumber = dataSet.intString('x00200013') ?? 0;
    const seriesInstanceUID = (dataSet.string('x0020000e') || 'default_series').trim();
    const seriesDescription = (dataSet.string('x0008103e') || dataSet.string('x00181030') || 'Série DICOM').trim();
    const modality = normalizeModality(dataSet.string('x00080060'));

    // PixelSpacing [row_mm, col_mm] (0028,0030) ou ImagerPixelSpacing (0018,1164)
    const psRaw = parseNumberList(dataSet.string('x00280030') || dataSet.string('x00181164'));
    const pixelSpacing: [number, number] =
      psRaw.length >= 2 && psRaw[0] > 0 && psRaw[1] > 0
        ? [psRaw[0], psRaw[1]]
        : [1.0, 1.0];

    const sliceThickness = dataSet.floatString('x00180050') || 1.0;

    const ippNums = parseNumberList(dataSet.string('x00200032'));
    const imagePositionPatient: [number, number, number] | undefined =
      ippNums.length >= 3 ? [ippNums[0], ippNums[1], ippNums[2]] : undefined;

    const iopNums = parseNumberList(dataSet.string('x00200037'));
    const imageOrientationPatient: [number, number, number, number, number, number] | undefined =
      iopNums.length >= 6
        ? [iopNums[0], iopNums[1], iopNums[2], iopNums[3], iopNums[4], iopNums[5]]
        : undefined;

    const zProjection = computeSpatialProjection(
      imagePositionPatient,
      imageOrientationPatient,
      instanceNumber
    );

    const wcList = parseNumberList(dataSet.string('x00281050'));
    const wwList = parseNumberList(dataSet.string('x00281051'));
    const windowCenter = wcList.length > 0 ? wcList[0] : undefined;
    const windowWidth = wwList.length > 0 && wwList[0] > 0 ? wwList[0] : undefined;

    const numPixels = rows * columns;
    const physicalPixels = new Float32Array(numPixels);

    const dataOffset = pixelDataElement.dataOffset;
    const byteLength = pixelDataElement.length;
    // Copie alignée en mémoire pour supporter tout offset impair sans erreur d'alignement TypedArray
    const alignedBuffer = arrayBuffer.slice(dataOffset, dataOffset + byteLength);

    let minVal = Infinity;
    let maxVal = -Infinity;

    if (bitsAllocated === 8 && samplesPerPixel === 1) {
      const raw8 = new Uint8Array(alignedBuffer);
      const limit = Math.min(numPixels, raw8.length);
      for (let i = 0; i < limit; i++) {
        const val = raw8[i] * rescaleSlope + rescaleIntercept;
        physicalPixels[i] = val;
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
      }
    } else if (bitsAllocated === 8 && samplesPerPixel >= 3) {
      // Images couleur (ex: US / secondaire) -> luminance
      const raw8 = new Uint8Array(alignedBuffer);
      for (let i = 0; i < numPixels; i++) {
        const base = i * samplesPerPixel;
        const r = raw8[base] || 0;
        const g = raw8[base + 1] || 0;
        const b = raw8[base + 2] || 0;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const val = lum * rescaleSlope + rescaleIntercept;
        physicalPixels[i] = val;
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
      }
    } else {
      // 16 bits : vérification stricte de PixelRepresentation (0028,0103)
      const raw16 =
        pixelRepresentation === 1
          ? new Int16Array(alignedBuffer)
          : new Uint16Array(alignedBuffer);
      const limit = Math.min(numPixels, raw16.length);
      for (let i = 0; i < limit; i++) {
        const val = raw16[i] * rescaleSlope + rescaleIntercept;
        physicalPixels[i] = val;
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
      }
    }

    if (!Number.isFinite(minVal)) minVal = 0;
    if (!Number.isFinite(maxVal)) maxVal = 255;

    // Si MONOCHROME1 (0 = blanc), inversion densitométrique
    if (photometricInterpretation === 'MONOCHROME1') {
      for (let i = 0; i < numPixels; i++) {
        physicalPixels[i] = maxVal + minVal - physicalPixels[i];
      }
    }

    return {
      fileName: file.name,
      fileSizeBytes: file.size,
      instanceNumber,
      seriesInstanceUID,
      seriesDescription,
      modality,
      rows,
      columns,
      pixelSpacing,
      sliceThickness,
      imagePositionPatient,
      imageOrientationPatient,
      zProjection,
      windowCenter,
      windowWidth,
      rescaleSlope,
      rescaleIntercept,
      pixelRepresentation,
      bitsAllocated,
      photometricInterpretation,
      physicalPixels,
      minVal,
      maxVal,
    };
  } catch {
    return null;
  }
}

/**
 * Lit un ensemble de fichiers DICOM, les regroupe par série et effectue le tri spatial géométrique
 */
export async function parseDicomFiles(
  files: File[],
  onProgress?: (parsedCount: number, totalCount: number) => void
): Promise<ParsedDicomSeries[]> {
  const slices: ParsedDicomSlice[] = [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    const parsed = await parseDicomFile(files[i]);
    if (parsed) {
      slices.push(parsed);
    }
    if (onProgress && (i % 5 === 0 || i === total - 1)) {
      onProgress(i + 1, total);
    }
  }

  // Regroupement par SeriesInstanceUID + dimensions (pour éviter les localizers de taille différente dans la même série)
  const seriesMap = new Map<string, ParsedDicomSlice[]>();
  for (const s of slices) {
    const key = `${s.seriesInstanceUID}_${s.columns}x${s.rows}`;
    const list = seriesMap.get(key) || [];
    list.push(s);
    seriesMap.set(key, list);
  }

  const resultSeries: ParsedDicomSeries[] = [];

  for (const [, groupSlices] of seriesMap.entries()) {
    if (groupSlices.length === 0) continue;

    // 1. Tri spatial géométrique sur la projection normale (avec fallback InstanceNumber)
    groupSlices.sort((a, b) => {
      const diffZ = a.zProjection - b.zProjection;
      if (Math.abs(diffZ) > 1e-4) {
        return diffZ;
      }
      return a.instanceNumber - b.instanceNumber;
    });

    const first = groupSlices[0];
    const mid = groupSlices[Math.floor(groupSlices.length / 2)];

    // Calcul de l'épaisseur réelle si plusieurs coupes espacées géométriquement
    let sliceThickness = first.sliceThickness;
    if (groupSlices.length > 1) {
      const totalSpan = Math.abs(
        groupSlices[groupSlices.length - 1].zProjection - groupSlices[0].zProjection
      );
      const avgSpacing = totalSpan / (groupSlices.length - 1);
      if (avgSpacing > 0.1 && avgSpacing < 50) {
        sliceThickness = Number(avgSpacing.toFixed(2));
      }
    }

    let defaultWindowCenter = mid.windowCenter;
    let defaultWindowWidth = mid.windowWidth;

    if (defaultWindowCenter === undefined || defaultWindowWidth === undefined) {
      if (first.modality === 'CT') {
        defaultWindowCenter = 50;
        defaultWindowWidth = 350;
      } else {
        const autoWin = computePercentileWindow(mid.physicalPixels);
        defaultWindowCenter = autoWin.windowCenter;
        defaultWindowWidth = autoWin.windowWidth;
      }
    }

    const totalRawBytes = groupSlices.reduce((acc, s) => acc + s.fileSizeBytes, 0);

    resultSeries.push({
      seriesInstanceUID: first.seriesInstanceUID,
      description: first.seriesDescription,
      modality: first.modality,
      width: first.columns,
      height: first.rows,
      pixelSpacing: [...first.pixelSpacing] as [number, number],
      sliceThickness,
      defaultWindowCenter,
      defaultWindowWidth,
      totalRawBytes,
      slices: groupSlices,
    });
  }

  // Trie les séries par nombre de coupes décroissant
  resultSeries.sort((a, b) => b.slices.length - a.slices.length);
  return resultSeries;
}
