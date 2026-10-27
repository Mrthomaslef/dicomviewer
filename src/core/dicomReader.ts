import dicomParser from 'dicom-parser';

export type DicomSortMode =
  | 'pacs_auto'
  | 'instance_asc'
  | 'spatial_asc'
  | 'spatial_desc'
  | 'filename_asc';

export interface ParsedDicomSlice {
  fileName: string;
  relativePath: string;
  fileSizeBytes: number;
  seriesNumber: number;
  acquisitionNumber: number;
  echoNumber: number;
  instanceNumber: number;
  seriesInstanceUID: string;
  seriesDescription: string;
  imageType: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  rows: number;
  columns: number;
  pixelSpacing: [number, number];
  sliceThickness: number;
  imagePositionPatient?: [number, number, number];
  imageOrientationPatient?: [number, number, number, number, number, number];
  sliceLocation?: number;
  zProjection: number;
  hasSpatialTags: boolean;
  windowCenter?: number;
  windowWidth?: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  pixelRepresentation: number;
  bitsAllocated: number;
  bitsStored: number;
  photometricInterpretation: string;
  physicalPixels: Float32Array;
  minVal: number;
  maxVal: number;
}

export interface ParsedDicomSeries {
  seriesKey: string;
  seriesInstanceUID: string;
  seriesNumber: number;
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
 * Signature d'orientation arrondie pour séparer automatiquement les coupes Axiales, Coronales et Sagittales
 * lorsqu'un localizer ou une série multi-planaire partage le même SeriesInstanceUID.
 */
function getOrientationSignature(iop?: [number, number, number, number, number, number]): string {
  if (!iop) return 'no_iop';
  const [rx, ry, rz, cx, cy, cz] = iop;
  const nx = ry * cz - rz * cy;
  const ny = rz * cx - rx * cz;
  const nz = rx * cy - ry * cx;
  // Arrondi au dixième de la normale pour regrouper les coupes parallèles d'une même pile
  return `${Math.round(nx * 10)}_${Math.round(ny * 10)}_${Math.round(nz * 10)}`;
}

/**
 * Calcule la coordonnée projetée le long de la normale au plan de coupe (IPP . (R x C))
 */
export function computeSpatialProjection(
  ipp?: [number, number, number],
  iop?: [number, number, number, number, number, number],
  sliceLocation?: number,
  fallbackInstanceNumber: number = 0
): number {
  if (ipp && iop) {
    const [rx, ry, rz, cx, cy, cz] = iop;
    const nx = ry * cz - rz * cy;
    const ny = rz * cx - rx * cz;
    const nz = rx * cy - ry * cx;
    return ipp[0] * nx + ipp[1] * ny + ipp[2] * nz;
  }
  if (ipp) return ipp[2];
  if (sliceLocation !== undefined && !Number.isNaN(sliceLocation)) return sliceLocation;
  return fallbackInstanceNumber;
}

/**
 * Calcule un fenêtrage automatique basé sur les percentiles 1% - 99%
 */
export function computePercentileWindow(pixels: Float32Array): {
  windowCenter: number;
  windowWidth: number;
} {
  if (pixels.length === 0) {
    return { windowCenter: 128, windowWidth: 256 };
  }
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
 * Décode une coupe DICOM dont les pixels sont encapsulés (JPEG / Lossless / WebP supporté par le navigateur)
 */
async function decodeEncapsulatedFrame(
  dataSet: dicomParser.DataSet,
  pixelDataElement: dicomParser.Element,
  rows: number,
  columns: number,
  rescaleSlope: number,
  rescaleIntercept: number
): Promise<{ physicalPixels: Float32Array; minVal: number; maxVal: number } | null> {
  try {
    let fragmentBytes: Uint8Array | null = null;
    if (pixelDataElement.fragments && pixelDataElement.fragments.length > 0) {
      const hasBasicOffsetTable =
        pixelDataElement.basicOffsetTable && pixelDataElement.basicOffsetTable.length > 0;
      if (hasBasicOffsetTable) {
        fragmentBytes = dicomParser.readEncapsulatedImageFrame(dataSet, pixelDataElement, 0);
      } else {
        fragmentBytes = dicomParser.readEncapsulatedPixelDataFromFragments(
          dataSet,
          pixelDataElement,
          0,
          pixelDataElement.fragments.length
        );
      }
    }
    if (!fragmentBytes || fragmentBytes.byteLength === 0) return null;

    const blob = new Blob([
      fragmentBytes.buffer.slice(
        fragmentBytes.byteOffset,
        fragmentBytes.byteOffset + fragmentBytes.byteLength
      ) as ArrayBuffer,
    ]);
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = columns;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close();
      return null;
    }
    ctx.drawImage(bmp, 0, 0, columns, rows);
    bmp.close();

    const imgData = ctx.getImageData(0, 0, columns, rows).data;
    const numPixels = rows * columns;
    const physicalPixels = new Float32Array(numPixels);
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = 0; i < numPixels; i++) {
      const lum = imgData[i * 4];
      const val = lum * rescaleSlope + rescaleIntercept;
      physicalPixels[i] = val;
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
    return { physicalPixels, minVal, maxVal };
  } catch {
    return null;
  }
}

/**
 * Lit et décode un fichier DICOM binaire (.dcm) avec prise en compte des syntaxes implicites/explicites
 * et du masquage des bits de superposition (BitsStored < BitsAllocated).
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
    const bitsStored = dataSet.uint16('x00280101') || bitsAllocated;
    const pixelRepresentation = dataSet.uint16('x00280103') ?? 0;
    const samplesPerPixel = dataSet.uint16('x00280002') || 1;
    const photometricInterpretation = (dataSet.string('x00280004') || 'MONOCHROME2').trim();

    const rescaleSlope = dataSet.floatString('x00281053') ?? 1.0;
    const rescaleIntercept = dataSet.floatString('x00281052') ?? 0.0;

    const seriesNumber = dataSet.intString('x00200011') ?? 1;
    const acquisitionNumber = dataSet.intString('x00200012') ?? 1;
    const echoNumber = dataSet.intString('x00180086') ?? 1;
    const instanceNumber = dataSet.intString('x00200013') ?? 0;

    const seriesInstanceUID = (dataSet.string('x0020000e') || `series_${seriesNumber}`).trim();
    const rawDesc =
      dataSet.string('x0008103e') ||
      dataSet.string('x00181030') ||
      dataSet.string('x00081030') ||
      `Série #${seriesNumber}`;
    const seriesDescription = rawDesc.trim();
    const imageType = (dataSet.string('x00080008') || '').trim();
    const modality = normalizeModality(dataSet.string('x00080060'));

    const psRaw = parseNumberList(dataSet.string('x00280030') || dataSet.string('x00181164'));
    const pixelSpacing: [number, number] =
      psRaw.length >= 2 && psRaw[0] > 0 && psRaw[1] > 0
        ? [psRaw[0], psRaw[1]]
        : [1.0, 1.0];

    const sliceThickness = dataSet.floatString('x00180050') || 1.0;
    const sliceLocation = dataSet.floatString('x00201041');

    const ippNums = parseNumberList(dataSet.string('x00200032'));
    const imagePositionPatient: [number, number, number] | undefined =
      ippNums.length >= 3 ? [ippNums[0], ippNums[1], ippNums[2]] : undefined;

    const iopNums = parseNumberList(dataSet.string('x00200037'));
    const imageOrientationPatient: [number, number, number, number, number, number] | undefined =
      iopNums.length >= 6
        ? [iopNums[0], iopNums[1], iopNums[2], iopNums[3], iopNums[4], iopNums[5]]
        : undefined;

    const hasSpatialTags = Boolean(imagePositionPatient && imageOrientationPatient);
    const zProjection = computeSpatialProjection(
      imagePositionPatient,
      imageOrientationPatient,
      sliceLocation,
      instanceNumber
    );

    const wcList = parseNumberList(dataSet.string('x00281050'));
    const wwList = parseNumberList(dataSet.string('x00281051'));
    const windowCenter = wcList.length > 0 ? wcList[0] : undefined;
    const windowWidth = wwList.length > 0 && wwList[0] > 0 ? wwList[0] : undefined;

    const numPixels = rows * columns;
    let physicalPixels = new Float32Array(numPixels);
    let minVal = Infinity;
    let maxVal = -Infinity;

    if (pixelDataElement.encapsulatedPixelData) {
      const decoded = await decodeEncapsulatedFrame(
        dataSet,
        pixelDataElement,
        rows,
        columns,
        rescaleSlope,
        rescaleIntercept
      );
      if (!decoded) return null;
      physicalPixels = decoded.physicalPixels;
      minVal = decoded.minVal;
      maxVal = decoded.maxVal;
    } else {
      const dataOffset = pixelDataElement.dataOffset;
      const frameByteLength = Math.min(
        pixelDataElement.length,
        numPixels * samplesPerPixel * (bitsAllocated <= 8 ? 1 : 2)
      );
      const alignedBuffer = arrayBuffer.slice(dataOffset, dataOffset + frameByteLength);

      if (bitsAllocated <= 8 && samplesPerPixel === 1) {
        const raw8 = new Uint8Array(alignedBuffer);
        const limit = Math.min(numPixels, raw8.length);
        for (let i = 0; i < limit; i++) {
          const val = raw8[i] * rescaleSlope + rescaleIntercept;
          physicalPixels[i] = val;
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      } else if (bitsAllocated <= 8 && samplesPerPixel >= 3) {
        const raw8 = new Uint8Array(alignedBuffer);
        for (let i = 0; i < numPixels; i++) {
          const base = i * samplesPerPixel;
          const lum =
            0.299 * (raw8[base] || 0) +
            0.587 * (raw8[base + 1] || 0) +
            0.114 * (raw8[base + 2] || 0);
          const val = lum * rescaleSlope + rescaleIntercept;
          physicalPixels[i] = val;
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      } else {
        // 16 bits : gestion stricte de BitsStored (ex: 12 bits stockés dans 16 bits avec overlays dans les bits 12..15)
        const needBitMask = bitsStored > 0 && bitsStored < 16;
        const bitMask = (1 << bitsStored) - 1;
        const signBit = 1 << (bitsStored - 1);

        if (pixelRepresentation === 1) {
          const raw16 = new Int16Array(alignedBuffer);
          const limit = Math.min(numPixels, raw16.length);
          for (let i = 0; i < limit; i++) {
            let rawVal = raw16[i];
            if (needBitMask) {
              rawVal = rawVal & bitMask;
              if (rawVal & signBit) {
                rawVal = rawVal - (1 << bitsStored);
              }
            }
            const val = rawVal * rescaleSlope + rescaleIntercept;
            physicalPixels[i] = val;
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
          }
        } else {
          const raw16 = new Uint16Array(alignedBuffer);
          const limit = Math.min(numPixels, raw16.length);
          for (let i = 0; i < limit; i++) {
            const rawVal = needBitMask ? raw16[i] & bitMask : raw16[i];
            const val = rawVal * rescaleSlope + rescaleIntercept;
            physicalPixels[i] = val;
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
          }
        }
      }
    }

    if (!Number.isFinite(minVal)) minVal = 0;
    if (!Number.isFinite(maxVal)) maxVal = 255;

    if (photometricInterpretation === 'MONOCHROME1') {
      for (let i = 0; i < numPixels; i++) {
        physicalPixels[i] = maxVal + minVal - physicalPixels[i];
      }
    }

    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

    return {
      fileName: file.name,
      relativePath,
      fileSizeBytes: file.size,
      seriesNumber,
      acquisitionNumber,
      echoNumber,
      instanceNumber,
      seriesInstanceUID,
      seriesDescription,
      imageType,
      modality,
      rows,
      columns,
      pixelSpacing,
      sliceThickness,
      imagePositionPatient,
      imageOrientationPatient,
      sliceLocation,
      zProjection,
      hasSpatialTags,
      windowCenter,
      windowWidth,
      rescaleSlope,
      rescaleIntercept,
      pixelRepresentation,
      bitsAllocated,
      bitsStored,
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
 * Tri naturel alpha-numérique sur le nom de fichier (ex: IM2.dcm avant IM10.dcm)
 */
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Trie les coupes d'une série selon le mode choisi :
 * - 'pacs_auto' :
 *   1. Si les InstanceNumber (0020,0013) sont présents et distincts sur la série,
 *      utilise le tri spatial géométrique (zProjection) EN CONSERVANT LE SENS (croissant ou décroissant)
 *      dicté par InstanceNumber (pour respecter le sens Tête->Pieds ou Pieds->Tête du PACS !).
 *      Et si plusieurs coupes ont le même Z ou si les tags spatiaux sont absents, trie par InstanceNumber croissant.
 * - 'instance_asc' : Tri strict par InstanceNumber (0020,0013) croissant (1, 2, 3...)
 * - 'spatial_asc' : Tri spatial Z croissant
 * - 'spatial_desc' : Tri spatial Z décroissant
 * - 'filename_asc' : Tri par chemin/nom de fichier naturel
 */
export function sortSeriesSlices(
  slices: ParsedDicomSlice[],
  mode: DicomSortMode = 'pacs_auto'
): ParsedDicomSlice[] {
  const copy = [...slices];
  if (copy.length <= 1) return copy;

  if (mode === 'filename_asc') {
    return copy.sort((a, b) => naturalCollator.compare(a.relativePath, b.relativePath));
  }

  if (mode === 'instance_asc') {
    return copy.sort((a, b) => {
      if (a.instanceNumber !== b.instanceNumber) {
        return a.instanceNumber - b.instanceNumber;
      }
      return naturalCollator.compare(a.relativePath, b.relativePath);
    });
  }

  if (mode === 'spatial_asc') {
    return copy.sort((a, b) => {
      const dz = a.zProjection - b.zProjection;
      if (Math.abs(dz) > 1e-4) return dz;
      return a.instanceNumber - b.instanceNumber;
    });
  }

  if (mode === 'spatial_desc') {
    return copy.sort((a, b) => {
      const dz = b.zProjection - a.zProjection;
      if (Math.abs(dz) > 1e-4) return dz;
      return a.instanceNumber - b.instanceNumber;
    });
  }

  // Mode 'pacs_auto' :
  // Vérifie si chaque coupe a un InstanceNumber unique
  const uniqueInstances = new Set(copy.map((s) => s.instanceNumber));
  const hasUniqueInstanceNumbers = uniqueInstances.size === copy.length;

  // Vérifie si les positions spatiales Z sont toutes distinctes (vraie pile volumique simple)
  const roundedZs = new Set(copy.map((s) => Math.round(s.zProjection * 100)));
  const hasDistinctSpatialPositions =
    copy[0].hasSpatialTags && roundedZs.size >= Math.floor(copy.length * 0.9);

  if (hasDistinctSpatialPositions) {
    // Détermine si la console d'acquisition a numéroté les coupes dans le sens Z croissant ou Z décroissant
    let directionSign = 1;
    if (hasUniqueInstanceNumbers) {
      const byInstance = [...copy].sort((a, b) => a.instanceNumber - b.instanceNumber);
      const firstZ = byInstance[0].zProjection;
      const lastZ = byInstance[byInstance.length - 1].zProjection;
      if (lastZ < firstZ) {
        // Exemple classique : TDM acquis de la tête (+Z) vers les pieds (-Z) avec InstanceNumber 1..N
        directionSign = -1;
      }
    }

    return copy.sort((a, b) => {
      const dz = (a.zProjection - b.zProjection) * directionSign;
      if (Math.abs(dz) > 1e-4) return dz;
      if (a.instanceNumber !== b.instanceNumber) return a.instanceNumber - b.instanceNumber;
      return naturalCollator.compare(a.relativePath, b.relativePath);
    });
  }

  // Si les positions Z ne sont pas distinctes (ou absentes), InstanceNumber est la référence absolue du PACS
  if (uniqueInstances.size > 1) {
    return copy.sort((a, b) => {
      if (a.instanceNumber !== b.instanceNumber) return a.instanceNumber - b.instanceNumber;
      return naturalCollator.compare(a.relativePath, b.relativePath);
    });
  }

  return copy.sort((a, b) => naturalCollator.compare(a.relativePath, b.relativePath));
}

/**
 * Lit un ensemble de fichiers DICOM, les organise par série (et sous-série d'orientation / écho)
 * comme sur une console PACS et applique le tri anatomique PACS.
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

  // Regroupement PACS intelligent :
  // Sépare par SeriesInstanceUID + dimensions + orientation du plan (Axial/Coronal/Sagittal) + EchoNumber
  const seriesMap = new Map<string, ParsedDicomSlice[]>();
  for (const s of slices) {
    const orientSig = getOrientationSignature(s.imageOrientationPatient);
    const key = `${s.seriesInstanceUID}_${s.columns}x${s.rows}_${orientSig}_echo${s.echoNumber}`;
    const list = seriesMap.get(key) || [];
    list.push(s);
    seriesMap.set(key, list);
  }

  // Vérifie si au sein d'un groupe il y a plusieurs phases au même Z (ex: dynamique multiphasique)
  const finalGroups = new Map<string, ParsedDicomSlice[]>();
  for (const [key, groupSlices] of seriesMap.entries()) {
    if (groupSlices.length > 4) {
      const acqSet = new Set(groupSlices.map((s) => s.acquisitionNumber));
      const zSet = new Set(groupSlices.map((s) => Math.round(s.zProjection * 10)));
      // Si plusieurs acquisitions partagent les mêmes positions Z, on les sépare par AcquisitionNumber
      if (acqSet.size > 1 && zSet.size * 1.5 < groupSlices.length) {
        for (const s of groupSlices) {
          const subKey = `${key}_acq${s.acquisitionNumber}`;
          const subList = finalGroups.get(subKey) || [];
          subList.push(s);
          finalGroups.set(subKey, subList);
        }
        continue;
      }
    }
    finalGroups.set(key, groupSlices);
  }

  const resultSeries: ParsedDicomSeries[] = [];

  for (const [seriesKey, rawGroupSlices] of finalGroups.entries()) {
    if (rawGroupSlices.length === 0) continue;

    const groupSlices = sortSeriesSlices(rawGroupSlices, 'pacs_auto');
    const first = groupSlices[0];
    const mid = groupSlices[Math.floor(groupSlices.length / 2)];

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

    // Ajoute une indication claire si la série comporte un numéro de série ou écho multiple
    let label = first.seriesDescription;
    if (first.seriesNumber > 0 && !label.startsWith(`S${first.seriesNumber}`)) {
      label = `S${first.seriesNumber} — ${label}`;
    }
    if (first.echoNumber > 1) {
      label += ` (Écho ${first.echoNumber})`;
    }

    resultSeries.push({
      seriesKey,
      seriesInstanceUID: first.seriesInstanceUID,
      seriesNumber: first.seriesNumber,
      description: label,
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

  // Trie les séries par numéro de série croissant (SeriesNumber 0020,0011) comme dans tout PACS,
  // en mettant les séries de plus de 2 coupes avant les scouts/localizers d'une seule coupe.
  resultSeries.sort((a, b) => {
    const aIsScout = a.slices.length <= 2 ? 1 : 0;
    const bIsScout = b.slices.length <= 2 ? 1 : 0;
    if (aIsScout !== bIsScout) return aIsScout - bIsScout;
    if (a.seriesNumber !== b.seriesNumber) return a.seriesNumber - b.seriesNumber;
    return b.slices.length - a.slices.length;
  });

  return resultSeries;
}
