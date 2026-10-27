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

export type AnatomicalPlane = 'AXIAL' | 'CORONAL' | 'SAGITTAL';

export interface ParsedDicomSeries {
  seriesKey: string;
  seriesInstanceUID: string;
  seriesNumber: number;
  description: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  anatomicalPlane: AnatomicalPlane;
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
    .map((s) => parseFloat(s.trim().replace(',', '.')))
    .filter((n) => !Number.isNaN(n));
}

/**
 * Recherche récursive d'un tag texte dans le DataSet racine ou dans les séquences
 * fonctionnelles Enhanced DICOM (SharedFunctionalGroupsSequence 5200,9229 / PerFrame 5200,9230).
 */
function findDicomString(dataSet: dicomParser.DataSet, tag: string, maxDepth: number = 3): string | undefined {
  const direct = dataSet.string(tag);
  if (direct !== undefined && direct.trim() !== '') {
    return direct;
  }
  if (maxDepth <= 0 || !dataSet.elements) return undefined;

  // Priorité aux séquences fonctionnelles standard Enhanced CT/MR
  const prioritySeqTags = ['x52009229', 'x52009230', 'x00209113', 'x00209116', 'x00289110', 'x00289132'];
  for (const seqTag of prioritySeqTags) {
    const el = dataSet.elements[seqTag];
    if (el && el.items) {
      for (const item of el.items) {
        if (item.dataSet) {
          const found = findDicomString(item.dataSet, tag, maxDepth - 1);
          if (found !== undefined) return found;
        }
      }
    }
  }
  return undefined;
}

function normalizeModality(raw: string | undefined): "MR" | "CT" | "CR" | "DX" | "XA" | "US" {
  const m = (raw || 'CT').trim().toUpperCase();
  if (m === 'MR' || m === 'CT' || m === 'CR' || m === 'DX' || m === 'XA' || m === 'US') {
    return m;
  }
  return 'CT';
}

/**
 * Calcule le vecteur normal unitaire N = R x C à partir de ImageOrientationPatient (0020,0037)
 */
function computeUnitNormal(
  iop?: [number, number, number, number, number, number]
): [number, number, number] | undefined {
  if (!iop) return undefined;
  const [rx, ry, rz, cx, cy, cz] = iop;
  const nx = ry * cz - rz * cy;
  const ny = rz * cx - rx * cz;
  const nz = rx * cy - ry * cx;
  const norm = Math.hypot(nx, ny, nz);
  if (norm < 1e-5) return undefined;
  return [nx / norm, ny / norm, nz / norm];
}

/**
 * Détermine le plan anatomique dominant (AXIAL, CORONAL ou SAGITTAL) à partir de IOP (0020,0037).
 * Contrairement à un arrondi décimal fragile, ce classement par plan anatomique évite de fragmenter
 * les séries Coronales et Sagittales obliques, courbes ou radiaires.
 */
export function getPlaneFromIOP(
  iop?: [number, number, number, number, number, number]
): AnatomicalPlane | 'UNKNOWN' {
  const n = computeUnitNormal(iop);
  if (!n) return 'UNKNOWN';
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return 'AXIAL';
  if (ay >= ax && ay >= az) return 'CORONAL';
  return 'SAGITTAL';
}

/**
 * Calcule le centre géométrique 3D de la coupe dans le repère patient (LPS, mm).
 * Plus stable que le coin supérieur gauche (IPP) lorsque le cadrage/FOV varie entre coupes.
 */
function computeSliceCenter3D(slice: ParsedDicomSlice): [number, number, number] | undefined {
  const ipp = slice.imagePositionPatient;
  if (!ipp) return undefined;
  const iop = slice.imageOrientationPatient;
  if (!iop) return ipp;
  const [rx, ry, rz, cx, cy, cz] = iop;
  const halfWidthMm = (slice.columns * slice.pixelSpacing[1]) * 0.5;
  const halfHeightMm = (slice.rows * slice.pixelSpacing[0]) * 0.5;
  return [
    ipp[0] + rx * halfWidthMm + cx * halfHeightMm,
    ipp[1] + ry * halfWidthMm + cy * halfHeightMm,
    ipp[2] + rz * halfWidthMm + cz * halfHeightMm,
  ];
}

/**
 * Calcule la coordonnée projetée initiale d'une coupe isolée (avant consolidation 3D de la série)
 */
export function computeSpatialProjection(
  ipp?: [number, number, number],
  iop?: [number, number, number, number, number, number],
  sliceLocation?: number,
  fallbackInstanceNumber: number = 0
): number {
  const n = computeUnitNormal(iop);
  if (ipp && n) {
    return ipp[0] * n[0] + ipp[1] * n[1] + ipp[2] * n[2];
  }
  if (sliceLocation !== undefined && !Number.isNaN(sliceLocation)) return sliceLocation;
  if (ipp) return ipp[2];
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

    const psRaw = parseNumberList(
      findDicomString(dataSet, 'x00280030') || findDicomString(dataSet, 'x00181164')
    );
    const pixelSpacing: [number, number] =
      psRaw.length >= 2 && psRaw[0] > 0 && psRaw[1] > 0
        ? [psRaw[0], psRaw[1]]
        : [1.0, 1.0];

    const sliceThicknessStr = findDicomString(dataSet, 'x00180050');
    const sliceThickness = sliceThicknessStr ? parseFloat(sliceThicknessStr.replace(',', '.')) || 1.0 : 1.0;

    const sliceLocationStr = findDicomString(dataSet, 'x00201041');
    const parsedSliceLoc = sliceLocationStr ? parseFloat(sliceLocationStr.replace(',', '.')) : undefined;
    const sliceLocation =
      parsedSliceLoc !== undefined && !Number.isNaN(parsedSliceLoc) ? parsedSliceLoc : undefined;

    const ippNums = parseNumberList(findDicomString(dataSet, 'x00200032'));
    const imagePositionPatient: [number, number, number] | undefined =
      ippNums.length >= 3 ? [ippNums[0], ippNums[1], ippNums[2]] : undefined;

    const iopNums = parseNumberList(findDicomString(dataSet, 'x00200037'));
    const imageOrientationPatient: [number, number, number, number, number, number] | undefined =
      iopNums.length >= 6
        ? [iopNums[0], iopNums[1], iopNums[2], iopNums[3], iopNums[4], iopNums[5]]
        : undefined;

    const hasSpatialTags = Boolean(
      imagePositionPatient || (sliceLocation !== undefined && !Number.isNaN(sliceLocation))
    );
    const zProjection = computeSpatialProjection(
      imagePositionPatient,
      imageOrientationPatient,
      sliceLocation,
      instanceNumber
    );

    const wcList = parseNumberList(findDicomString(dataSet, 'x00281050'));
    const wwList = parseNumberList(findDicomString(dataSet, 'x00281051'));
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
 * Consolide l'axe d'empilement 3D (Stacking Axis) sur l'ensemble d'une série (Axiale, Coronale, Sagittale ou Oblique).
 *
 * Pourquoi est-ce indispensable pour les séries Coronales et Sagittales ?
 * 1. En Axial, l'orientation IOP est souvent [1,0,0,0,1,0] (entiers exacts) et seule la coordonnée Z (IPP[2]) varie.
 * 2. En Coronal (variation selon Y = IPP[1]) et Sagittal (variation selon X = IPP[0]) :
 *    - Les cosinus directeurs IOP (0020,0037) sont souvent obliques (nombres flottants arrondis par coupe) ou absents.
 *    - Projeter chaque coupe individuellement sur sa propre normale N_i introduit une erreur de bras de levier
 *      P_i . (N_i - N_j) proportionnelle à l'éloignement de l'isocentre (ex: Z = -1200 mm en TDM), ce qui mélange les coupes !
 *    - Si IOP est absent ou forcé à [1,0,0,0,1,0], projeter sur Z renvoie une constante ou du bruit flottant sur Coronal/Sagittal.
 * 3. Cette fonction calcule l'axe principal réel de déplacement 3D des centres de coupes (par analyse de covariance 3D / PCA)
 *    et projette toutes les coupes de la série sur UN SEUL vecteur unitaire constant U orienté anatomiquement (LPS) :
 *    - AXIAL : +Z (Inférieur -> Supérieur)
 *    - CORONAL : +Y (Antérieur -> Postérieur)
 *    - SAGITTAL : +X (Droite -> Gauche)
 */
export function recomputeSeriesSpatialCoordinates(slices: ParsedDicomSlice[]): {
  plane: AnatomicalPlane;
  linearity: number;
  hasValid3DStack: boolean;
  normalRotationSpan: number;
} {
  if (slices.length === 0) {
    return { plane: 'AXIAL', linearity: 1, hasValid3DStack: false, normalRotationSpan: 0 };
  }

  // Mesure la dispersion angulaire des normales IOP au sein de la série (pour détecter les séries radiaires / courbes)
  const normals: [number, number, number][] = [];
  for (const s of slices) {
    const n = computeUnitNormal(s.imageOrientationPatient);
    if (n) normals.push(n);
  }

  let normalRotationSpan = 0;
  if (normals.length >= 2) {
    const refN = normals[0];
    for (let i = 1; i < normals.length; i++) {
      const d = Math.hypot(
        normals[i][0] - refN[0],
        normals[i][1] - refN[1],
        normals[i][2] - refN[2]
      );
      if (d > normalRotationSpan) normalRotationSpan = d;
    }
  }

  // Extraction des centres 3D (ou IPP) de chaque coupe
  const centers: ([number, number, number] | undefined)[] = slices.map((s) => computeSliceCenter3D(s));
  const validCenters = centers.filter((c): c is [number, number, number] => c !== undefined);

  if (validCenters.length >= 2) {
    const n = validCenters.length;
    let meanX = 0;
    let meanY = 0;
    let meanZ = 0;
    for (const c of validCenters) {
      meanX += c[0];
      meanY += c[1];
      meanZ += c[2];
    }
    meanX /= n;
    meanY /= n;
    meanZ /= n;

    // Matrice de covariance 3x3 des positions centrées (X - meanX, Y - meanY, Z - meanZ)
    let cxx = 0, cxy = 0, cxz = 0;
    let cyy = 0, cyz = 0, czz = 0;
    for (const c of validCenters) {
      const dx = c[0] - meanX;
      const dy = c[1] - meanY;
      const dz = c[2] - meanZ;
      cxx += dx * dx;
      cxy += dx * dy;
      cxz += dx * dz;
      cyy += dy * dy;
      cyz += dy * dz;
      czz += dz * dz;
    }
    cxx /= n;
    cxy /= n;
    cxz /= n;
    cyy /= n;
    cyz /= n;
    czz /= n;

    const totalVariance = cxx + cyy + czz;

    // Si les coupes se déplacent réellement dans l'espace 3D (écart-type > 0.05 mm)
    if (totalVariance > 0.0025) {
      // Vecteur initial sur l'axe présentant la plus grande variance (X=Sagittal, Y=Coronal, Z=Axial)
      let vx = cxx >= cyy && cxx >= czz ? 1 : 0;
      let vy = cyy > cxx && cyy >= czz ? 1 : 0;
      let vz = vx === 0 && vy === 0 ? 1 : 0;

      // 20 itérations de la méthode de la puissance pour extraire le vecteur propre dominant exact D
      for (let iter = 0; iter < 20; iter++) {
        const nx = cxx * vx + cxy * vy + cxz * vz;
        const ny = cxy * vx + cyy * vy + cyz * vz;
        const nz = cxz * vx + cyz * vy + czz * vz;
        const norm = Math.hypot(nx, ny, nz);
        if (norm < 1e-9) break;
        vx = nx / norm;
        vy = ny / norm;
        vz = nz / norm;
      }

      const lambdaMax =
        vx * (cxx * vx + cxy * vy + cxz * vz) +
        vy * (cxy * vx + cyy * vy + cyz * vz) +
        vz * (cxz * vx + cyz * vy + czz * vz);
      const linearity = Math.min(1, Math.max(0, lambdaMax / totalVariance));

      // Vérifie si la normale médiane IOP est alignée avec le déplacement 3D réel
      const midSlice = slices[Math.floor(slices.length / 2)];
      const medNormal = computeUnitNormal(midSlice.imageOrientationPatient);
      if (medNormal && normalRotationSpan < 0.08) {
        const dot = Math.abs(medNormal[0] * vx + medNormal[1] * vy + medNormal[2] * vz);
        if (dot >= 0.85) {
          vx = medNormal[0];
          vy = medNormal[1];
          vz = medNormal[2];
        }
      }

      // Détermination du plan anatomique dominant de l'axe d'empilement 3D
      const ax = Math.abs(vx);
      const ay = Math.abs(vy);
      const az = Math.abs(vz);
      let plane: AnatomicalPlane = 'AXIAL';
      if (az >= ax && az >= ay) {
        plane = 'AXIAL';
        // Orientation canonique LPS : +Z (Inférieur -> Supérieur)
        if (vz < 0) {
          vx = -vx;
          vy = -vy;
          vz = -vz;
        }
      } else if (ay >= ax && ay >= az) {
        plane = 'CORONAL';
        // Orientation canonique LPS : +Y (Antérieur -> Postérieur)
        if (vy < 0) {
          vx = -vx;
          vy = -vy;
          vz = -vz;
        }
      } else {
        plane = 'SAGITTAL';
        // Orientation canonique LPS : +X (Droite -> Gauche)
        if (vx < 0) {
          vx = -vx;
          vy = -vy;
          vz = -vz;
        }
      }

      // Projette TOUTES les coupes de la série sur ce vecteur unitaire unique (vx, vy, vz)
      const meanProj = meanX * vx + meanY * vy + meanZ * vz;
      for (let i = 0; i < slices.length; i++) {
        const c = centers[i];
        if (c) {
          slices[i].zProjection =
            (c[0] - meanX) * vx + (c[1] - meanY) * vy + (c[2] - meanZ) * vz + meanProj;
          slices[i].hasSpatialTags = true;
        }
      }

      return {
        plane,
        linearity,
        hasValid3DStack: true,
        normalRotationSpan,
      };
    }
  }

  // Fallback si IPP est absent ou constant : utilise SliceLocation (0020,1041) s'il varie
  const validLocs = slices
    .map((s) => s.sliceLocation)
    .filter((loc): loc is number => loc !== undefined && !Number.isNaN(loc));
  const uniqueLocs = new Set(validLocs.map((l) => Math.round(l * 100)));

  const iopPlane = getPlaneFromIOP(slices[0].imageOrientationPatient);
  const fallbackPlane: AnatomicalPlane = iopPlane === 'UNKNOWN' ? 'AXIAL' : iopPlane;

  if (uniqueLocs.size >= Math.floor(slices.length * 0.8) && slices.length >= 2) {
    for (const s of slices) {
      if (s.sliceLocation !== undefined && !Number.isNaN(s.sliceLocation)) {
        s.zProjection = s.sliceLocation;
        s.hasSpatialTags = true;
      }
    }
    return {
      plane: fallbackPlane,
      linearity: 1,
      hasValid3DStack: true,
      normalRotationSpan,
    };
  }

  return {
    plane: fallbackPlane,
    linearity: 0,
    hasValid3DStack: false,
    normalRotationSpan,
  };
}

/**
 * Trie les coupes d'une série (Axiale, Coronale, Sagittale ou Oblique) selon le mode choisi :
 * - 'pacs_auto' :
 *   1. Consolide l'axe d'empilement 3D réel de la série (Z pour Axial, Y pour Coronal, X pour Sagittal, ou vecteur propre 3D).
 *   2. Si la série est radiaire / courbe (rotation des normales ou non-linéarité 3D) et possède des InstanceNumber,
 *      conserve l'ordre séquentiel exact d'InstanceNumber (1..N).
 *   3. Pour une pile volumique 3D (Axiale, Coronale, Sagittale), détermine le sens de lecture :
 *      - Si InstanceNumber est cohérent avec la progression spatiale (corrélation monotone >= 60%), conserve le sens exact du PACS.
 *      - Si InstanceNumber est absent ou mélangé, applique le sens de lecture radiologique standard :
 *        * AXIAL : Tête -> Pieds (+Z -> -Z)
 *        * CORONAL : Antérieur -> Postérieur (-Y -> +Y)
 *        * SAGITTAL : Droite -> Gauche (-X -> +X)
 * - 'instance_asc' : Tri strict par InstanceNumber (0020,0013) croissant (1, 2, 3...)
 * - 'spatial_asc' : Tri spatial 3D croissant (-Z->+Z / Ant->Post / Droite->Gauche)
 * - 'spatial_desc' : Tri spatial 3D décroissant (+Z->-Z / Post->Ant / Gauche->Droite)
 * - 'filename_asc' : Tri par chemin/nom de fichier naturel
 */
export function sortSeriesSlices(
  slices: ParsedDicomSlice[],
  mode: DicomSortMode = 'pacs_auto'
): ParsedDicomSlice[] {
  const copy = [...slices];
  if (copy.length <= 1) return copy;

  // Consolide toujours les coordonnées spatiales 3D sur l'axe réel de la série (X, Y, Z ou Oblique)
  const { plane, linearity, hasValid3DStack, normalRotationSpan } =
    recomputeSeriesSpatialCoordinates(copy);

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
  const uniqueInstances = new Set(copy.map((s) => s.instanceNumber));
  const hasMostlyUniqueInstances = uniqueInstances.size >= Math.ceil(copy.length * 0.85);

  // Cas particulier des séries Coronales/Sagittales radiaires, courbes ou multi-angles (ex: rachis, épaule, genou, hanche)
  // où le plan de coupe tourne (normalRotationSpan > 0.15 rad ≈ 8.5° ou linearity < 0.85) :
  // L'ordre séquentiel InstanceNumber (0020,0013) de la console est la seule vérité géométrique.
  if (
    hasMostlyUniqueInstances &&
    (!hasValid3DStack || linearity < 0.85 || normalRotationSpan > 0.15)
  ) {
    return copy.sort((a, b) => {
      if (a.instanceNumber !== b.instanceNumber) return a.instanceNumber - b.instanceNumber;
      return naturalCollator.compare(a.relativePath, b.relativePath);
    });
  }

  // Pile volumique 3D linéaire (Axiale selon Z, Coronale selon Y, Sagittale selon X ou Oblique)
  const roundedPositions = new Set(copy.map((s) => Math.round(s.zProjection * 50)));
  const hasDistinctSpatialPositions =
    hasValid3DStack && roundedPositions.size >= Math.floor(copy.length * 0.85);

  if (hasDistinctSpatialPositions) {
    // Sens de lecture anatomique PACS par défaut selon le plan (si InstanceNumber est absent ou non corrélé) :
    // - AXIAL (+Z = Supérieur) : lecture standard Tête -> Pieds (+Z -> -Z => directionSign = -1)
    // - CORONAL (+Y = Postérieur) : lecture standard Antérieur -> Postérieur (-Y -> +Y => directionSign = +1)
    // - SAGITTAL (+X = Gauche) : lecture standard Droite -> Gauche (-X -> +X => directionSign = +1)
    let directionSign = plane === 'AXIAL' ? -1 : 1;

    if (hasMostlyUniqueInstances) {
      const byInstance = [...copy].sort((a, b) => a.instanceNumber - b.instanceNumber);
      let posSteps = 0;
      let negSteps = 0;
      for (let i = 1; i < byInstance.length; i++) {
        const diff = byInstance[i].zProjection - byInstance[i - 1].zProjection;
        if (diff > 1e-3) posSteps++;
        else if (diff < -1e-3) negSteps++;
      }
      const totalSteps = posSteps + negSteps;
      if (totalSteps > 0) {
        const coherence = Math.abs(posSteps - negSteps) / totalSteps;
        // Si InstanceNumber progresse de façon cohérente le long de l'axe 3D, on respecte son sens
        if (coherence >= 0.6) {
          directionSign = negSteps > posSteps ? -1 : 1;
        }
      }
    }

    return copy.sort((a, b) => {
      const dz = (a.zProjection - b.zProjection) * directionSign;
      if (Math.abs(dz) > 1e-4) return dz;
      if (a.instanceNumber !== b.instanceNumber) return a.instanceNumber - b.instanceNumber;
      return naturalCollator.compare(a.relativePath, b.relativePath);
    });
  }

  // Fallback sur InstanceNumber si les coordonnées spatiales sont absentes ou identiques
  if (uniqueInstances.size > 1) {
    return copy.sort((a, b) => {
      if (a.instanceNumber !== b.instanceNumber) return a.instanceNumber - b.instanceNumber;
      return naturalCollator.compare(a.relativePath, b.relativePath);
    });
  }

  return copy.sort((a, b) => naturalCollator.compare(a.relativePath, b.relativePath));
}

/**
 * Lit un ensemble de fichiers DICOM, les organise par série (et sous-série de plan anatomique / écho)
 * comme sur une console PACS et applique le tri anatomique 3D (Axial, Coronal, Sagittal).
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
  // Sépare par SeriesInstanceUID + dimensions + plan anatomique (AXIAL / CORONAL / SAGITTAL) + EchoNumber.
  // L'utilisation du plan anatomique (et non d'un arrondi décimal des cosinus) garde intactes les séries
  // Coronales et Sagittales obliques ou courbes tout en séparant les localizers 3-plans.
  const seriesMap = new Map<string, ParsedDicomSlice[]>();
  for (const s of slices) {
    const planeSig = getPlaneFromIOP(s.imageOrientationPatient);
    const key = `${s.seriesInstanceUID}_${s.columns}x${s.rows}_${planeSig}_echo${s.echoNumber}`;
    const list = seriesMap.get(key) || [];
    list.push(s);
    seriesMap.set(key, list);
  }

  // Vérifie si au sein d'un groupe il y a plusieurs phases exactement aux mêmes coordonnées 3D (X, Y, Z)
  const finalGroups = new Map<string, ParsedDicomSlice[]>();
  for (const [key, groupSlices] of seriesMap.entries()) {
    if (groupSlices.length > 4) {
      const acqSet = new Set(groupSlices.map((s) => s.acquisitionNumber));
      const pos3dSet = new Set(
        groupSlices.map((s) =>
          s.imagePositionPatient
            ? `${Math.round(s.imagePositionPatient[0])}_${Math.round(s.imagePositionPatient[1])}_${Math.round(s.imagePositionPatient[2])}`
            : String(s.instanceNumber)
        )
      );
      if (acqSet.size > 1 && pos3dSet.size * 1.5 < groupSlices.length) {
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
    const { plane } = recomputeSeriesSpatialCoordinates(groupSlices);
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

    // Conserve uniquement le nom de la séquence (ex: "CORO T1 DRB") sans préfixe de numéro de série
    let label = first.seriesDescription
      .replace(/^S?\d+\s*[—\-:_]\s*/i, '')
      .trim();
    if (!label) {
      label = first.seriesDescription.trim() || `Séquence ${first.seriesNumber}`;
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
      anatomicalPlane: plane,
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
