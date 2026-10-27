import { zipSync, strToU8 } from 'fflate';
import { AnnotationItem, PedagogicalManifest, SeriesManifest } from '../types/manifest';
import { applyWindowLut8Bit, CT_DOUBLE_PACK_WINDOWS } from './tpackBuilder';
import { LoadedTPackArchive, loadTPackFromBuffer } from './tpackLoader';

/**
 * Génère une matrice de coupe synthétique en Unités Hounsfield (HU) pour un fantôme TDM thoraco-abdominal
 * avec structures osseuses fines (vertèbre, côtes, fracture focale) et tissus mous (foie, aorte, nodule de 24.0 mm).
 */
export function generatePhantomSliceHU(
  width: number,
  height: number,
  sliceIndex: number,
  totalSlices: number,
  includeBurnedInPhiBanner: boolean = false
): Float32Array {
  const hu = new Float32Array(width * height);
  hu.fill(-1000); // Air environnant

  const cx = width * 0.5;
  const cy = height * 0.52;
  const rxBody = width * 0.41;
  const ryBody = height * 0.31;

  // Progression longitudinale normalisée [-1, +1]
  const zNorm = (sliceIndex / Math.max(1, totalSlices - 1)) * 2 - 1;

  // Paramètres du nodule hépatique cible (présent autour de la coupe médiane, rayon = 24 px -> diamètre 48 px = 24.0 mm à 0.5 mm/px)
  const midSlice = Math.floor(totalSlices * 0.5);
  const distFromMid = Math.abs(sliceIndex - midSlice);
  const lesionMaxRadiusPx = 24; // 48 px de diamètre * 0.5 mm = 24.0 mm exacts sur la coupe centrale
  const lesionActive = distFromMid <= 5;
  const lesionRadiusSlice = lesionActive
    ? lesionMaxRadiusPx * Math.sqrt(Math.max(0, 1 - Math.pow(distFromMid / 5.5, 2)))
    : 0;
  const lesionCx = cx - width * 0.14;
  const lesionCy = cy - height * 0.04;

  // Centre vertébral
  const vertCx = cx;
  const vertCy = cy + height * 0.16;

  // Centre Aorte & VCI
  const aortaCx = cx + width * 0.035;
  const aortaCy = cy + height * 0.055;
  const ivcCx = cx - width * 0.045;
  const ivcCy = cy + height * 0.065;

  for (let y = 0; y < height; y++) {
    const dyBody = (y - cy) / ryBody;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const dxBody = (x - cx) / rxBody;
      const rBodySq = dxBody * dxBody + dyBody * dyBody;

      // Table du scanner sous le patient
      if (y > cy + ryBody * 1.02 && y < cy + ryBody * 1.08 && Math.abs(x - cx) < rxBody * 0.75) {
        hu[idx] = -250;
        continue;
      }

      if (rBodySq > 1.0) continue;

      // Bruit quantique réaliste déterministe léger
      const pseudoNoise = ((Math.sin(x * 12.9898 + y * 78.233 + sliceIndex * 3.17) * 43758.5453) % 1) * 8 - 4;

      // Graisse sous-cutanée périphérique (-95 HU)
      if (rBodySq > 0.86) {
        hu[idx] = -95 + pseudoNoise;
        continue;
      }

      // Anneau musculaire pariétal (+52 HU)
      if (rBodySq > 0.77) {
        hu[idx] = 52 + pseudoNoise;
      } else {
        // Cavité péritonéale graisseuse (-75 HU)
        hu[idx] = -75 + pseudoNoise;
      }

      // Parenchyme hépatique (quadrant antéro-droit radiologique = gauche de l'image)
      const dxLiver = (x - (cx - width * 0.14)) / (width * 0.21);
      const dyLiver = (y - (cy - height * 0.03 + zNorm * 6)) / (height * 0.17);
      if (dxLiver * dxLiver + dyLiver * dyLiver < 1.0) {
        hu[idx] = 64 + pseudoNoise;

        // Vaisseaux portes intra-hépatiques (+125 HU)
        const v1 = Math.hypot(x - (cx - width * 0.11), y - (cy + height * 0.01 + zNorm * 4));
        if (v1 < width * 0.018) {
          hu[idx] = 130 + pseudoNoise;
        }
      }

      // Lésion focale hépatique hypervasculaire (cible pédagogique pour la règle mm : diamètre 24.0 mm)
      if (lesionActive && lesionRadiusSlice > 1) {
        const dLesion = Math.hypot(x - lesionCx, y - lesionCy);
        if (dLesion <= lesionRadiusSlice) {
          // Couronne hypervasculaire (+138 HU) et centre hypodense (+28 HU) visible en fenêtre Parties Molles
          if (dLesion > lesionRadiusSlice * 0.62) {
            hu[idx] = 138 + pseudoNoise * 0.5;
          } else {
            hu[idx] = 28 + pseudoNoise * 0.5;
          }
        }
      }

      // Rate (quadrant postéro-gauche radiologique = droite de l'image)
      const dxSpleen = (x - (cx + width * 0.23)) / (width * 0.11);
      const dySpleen = (y - (cy + height * 0.04 - zNorm * 5)) / (height * 0.12);
      if (dxSpleen * dxSpleen + dySpleen * dySpleen < 1.0) {
        hu[idx] = 50 + pseudoNoise;
      }

      // Reins gauche et droit
      const dKidneyR = Math.hypot((x - (cx - width * 0.12)) / 1.0, (y - (cy + height * 0.11)) / 1.25);
      const dKidneyL = Math.hypot((x - (cx + width * 0.13)) / 1.0, (y - (cy + height * 0.11)) / 1.25);
      const kidneyRad = width * 0.055 * (1 - 0.25 * zNorm * zNorm);
      if (dKidneyR < kidneyRad || dKidneyL < kidneyRad) {
        const dK = Math.min(dKidneyR, dKidneyL);
        hu[idx] = dK > kidneyRad * 0.55 ? 145 + pseudoNoise : 35 + pseudoNoise;
      }

      // Aorte abdominale rehaussée (+195 HU) avec plaque calcifiée pariétale (+780 HU)
      const dAorta = Math.hypot(x - aortaCx, y - aortaCy);
      const aortaRad = width * 0.028;
      if (dAorta < aortaRad) {
        hu[idx] = 195 + pseudoNoise;
        if (dAorta > aortaRad * 0.72 && x > aortaCx && y < aortaCy) {
          hu[idx] = 790 + pseudoNoise; // Calcification intimale
        }
      }

      // Veine Cave Inférieure (+115 HU)
      const dIvc = Math.hypot((x - ivcCx) * 0.85, (y - ivcCy) * 1.15);
      if (dIvc < width * 0.027) {
        hu[idx] = 115 + pseudoNoise;
      }

      // Corps vertébral et arc postérieur (structures osseuses haute densité +260 à +1100 HU)
      const dVertBody = Math.hypot((x - vertCx) / 1.15, y - (vertCy - height * 0.02));
      const vertRad = width * 0.052;
      if (dVertBody < vertRad) {
        if (dVertBody > vertRad * 0.78) {
          // Corticale osseuse dense
          hu[idx] = 980 + pseudoNoise * 2;
        } else {
          // Os spongieux trabéculaire (visible uniquement en fenêtre Os WL 400 / WW 1800)
          const trabeculae = Math.sin(x * 0.8) * Math.cos(y * 0.8) * 65;
          hu[idx] = 275 + trabeculae + pseudoNoise;
        }
      }

      // Canal rachidien et épineuse
      const dCanal = Math.hypot(x - vertCx, y - (vertCy + height * 0.038));
      if (dCanal < width * 0.026) {
        hu[idx] = 18 + pseudoNoise; // LCR
      } else if (
        dCanal < width * 0.044 &&
        y > vertCy + height * 0.01
      ) {
        hu[idx] = 910 + pseudoNoise * 2; // Lames et pédicules
      }

      // Processus épineux postérieur
      if (
        Math.abs(x - vertCx) < width * 0.012 &&
        y >= vertCy + height * 0.065 &&
        y <= vertCy + height * 0.115
      ) {
        hu[idx] = 960 + pseudoNoise * 2;
      }

      // Côtes latérales dans la paroi avec une ostéocondensation / trait de refend cortical sur la coupe médiane
      for (const side of [-1, 1]) {
        const ribAngle = 0.45 + ((sliceIndex % 6) * 0.03);
        const ribX = cx + side * rxBody * 0.81 * Math.cos(ribAngle);
        const ribY = cy + ryBody * 0.78 * Math.sin(ribAngle) - height * 0.05;
        const dRib = Math.hypot(x - ribX, y - ribY);
        if (dRib < width * 0.022) {
          if (side === -1 && distFromMid <= 2 && Math.abs(x - ribX) < 2.2) {
            // Trait de fracture corticale hypo-atténuant (-20 HU) entouré de cal osseux (+1150 HU)
            hu[idx] = 40;
          } else {
            hu[idx] = dRib > width * 0.013 ? 990 : 340;
          }
        }
      }
    }
  }

  // Option : incrustation d'un cartouche Burned-in PHI en haut de l'image pour tester l'outil de masquage
  if (includeBurnedInPhiBanner) {
    const bannerH = Math.round(height * 0.11);
    const bannerW = Math.round(width * 0.62);
    for (let y = 6; y < 6 + bannerH; y++) {
      for (let x = 8; x < 8 + bannerW; x++) {
        const idx = y * width + x;
        // Fond gris sombre et barres de texte blanc simulées (+1200 HU)
        const isTextBar =
          (y >= 12 && y <= 18 && x >= 16 && x <= bannerW - 20 && x % 9 !== 0) ||
          (y >= 24 && y <= 29 && x >= 16 && x <= bannerW * 0.7 && x % 7 !== 0);
        hu[idx] = isTextBar ? 1200 : -400;
      }
    }
  }

  return hu;
}

/**
 * Encode rapidement une matrice HU en octets WebP sur le thread courant pour le cas de démo initial
 */
async function encodeDemoMatrixToWebP(
  pixels: Float32Array,
  width: number,
  height: number,
  wl: number,
  ww: number
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Contexte Canvas 2D indisponible');

  const imgData = ctx.createImageData(width, height);
  applyWindowLut8Bit(pixels, width, height, wl, ww, imgData);
  ctx.putImageData(imgData, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Échec toBlob WebP'))),
      'image/webp',
      0.85
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Construit en mémoire au démarrage un vrai cas pédagogique .tpack de démonstration :
 * - Série 1 : TDM Thoraco-Abdominal injecté (24 coupes, pixelSpacing [0.5, 0.5], double fenêtrage 'bone' + 'soft')
 * - Série 2 : IRM Pondération T2 Axiale (16 coupes, pixelSpacing [0.5, 0.5], fenêtrage 'default')
 * - Annotations pédagogiques fléchées et circulaires pré-intégrées
 */
export async function generateDemoTPackArchive(): Promise<LoadedTPackArchive> {
  const width = 384;
  const height = 384;
  const ctSliceCount = 24;
  const mrSliceCount = 16;
  const midSlice = Math.floor(ctSliceCount * 0.5); // coupe 12

  const zipFiles: Record<string, Uint8Array> = {};
  const ctSlicesManifest: SeriesManifest['slices'] = [];

  for (let i = 0; i < ctSliceCount; i++) {
    const hu = generatePhantomSliceHU(width, height, i, ctSliceCount, false);
    const padded = String(i).padStart(3, '0');

    // Encodage des 2 fenêtres TDM : bone (400/1800) et soft (50/350)
    for (const win of CT_DOUBLE_PACK_WINDOWS) {
      const webpBytes = await encodeDemoMatrixToWebP(
        hu,
        width,
        height,
        win.windowCenter,
        win.windowWidth
      );
      zipFiles[`series/s1_tdm_abdo/${win.key}/${padded}.webp`] = webpBytes;
    }

    const annotations: AnnotationItem[] = [];
    if (Math.abs(i - midSlice) <= 2) {
      annotations.push(
        {
          id: `ann_lesion_${i}`,
          type: 'arrow',
          // Pointe vers la lésion hépatique (x = 0.36, y = 0.48)
          points: [
            [0.21, 0.33],
            [0.34, 0.46],
          ],
          label: 'Nodule hypervasculaire (24.0 mm)',
        },
        {
          id: `ann_circle_${i}`,
          type: 'circle',
          points: [
            [0.36, 0.48],
            [0.422, 0.48],
          ],
          label: 'Cible Règle : 24.0 mm',
        },
        {
          id: `ann_fracture_${i}`,
          type: 'arrow',
          points: [
            [0.12, 0.68],
            [0.195, 0.605],
          ],
          label: 'Refend cortical costal (Fenêtre Os [1])',
        }
      );
    } else if (i === 5 || i === 18) {
      annotations.push({
        id: `ann_aorta_${i}`,
        type: 'arrow',
        points: [
          [0.64, 0.46],
          [0.545, 0.565],
        ],
        label: 'Aorte + calcification intimale',
      });
    }

    ctSlicesManifest.push({
      index: i,
      zPosition: Number((-34.5 + i * 3.0).toFixed(2)),
      ...(annotations.length > 0 ? { annotations } : {}),
    });
  }

  // Série 2 : IRM T2 Axiale simulée (hypersignal T2 du LCR et du nodule)
  const mrSlicesManifest: SeriesManifest['slices'] = [];
  for (let i = 0; i < mrSliceCount; i++) {
    const hu = generatePhantomSliceHU(width, height, Math.round((i * ctSliceCount) / mrSliceCount), ctSliceCount, false);
    const mrSignal = new Float32Array(width * height);
    for (let p = 0; p < hu.length; p++) {
      const v = hu[p];
      if (v < -500) mrSignal[p] = 5; // Air = hyposignal
      else if (v > 250) mrSignal[p] = 25; // Corticale osseuse = vide de signal en T2
      else if (v >= 10 && v <= 42) mrSignal[p] = 235; // LCR & centre nécrotique = franc hypersignal T2
      else if (v > 120) mrSignal[p] = 180; // Couronne hyper-intense
      else if (v < 0) mrSignal[p] = 135; // Graisse intermédiaire en T2 FSE
      else mrSignal[p] = 85; // Parenchyme hépatique/musculaire
    }

    const padded = String(i).padStart(3, '0');
    const webpBytes = await encodeDemoMatrixToWebP(mrSignal, width, height, 125, 230);
    zipFiles[`series/s2_irm_t2/default/${padded}.webp`] = webpBytes;

    const mrMid = Math.floor(mrSliceCount * 0.5);
    const mrAnn: AnnotationItem[] =
      Math.abs(i - mrMid) <= 1
        ? [
            {
              id: `mr_ann_${i}`,
              type: 'arrow',
              points: [
                [0.22, 0.34],
                [0.34, 0.46],
              ],
              label: 'Hypersignal T2 central franc',
            },
          ]
        : [];

    mrSlicesManifest.push({
      index: i,
      zPosition: Number((-30.0 + i * 4.0).toFixed(2)),
      ...(mrAnn.length > 0 ? { annotations: mrAnn } : {}),
    });
  }

  const manifest: PedagogicalManifest = {
    formatVersion: '1.0',
    caseId: 'DEMO-TPACK-2026-01',
    title: 'Fantôme Clinique Thoraco-Abdominal (Double Fenêtrage TDM + IRM T2)',
    modality: 'CT',
    anatomicalRegion: 'Thorax / Abdomen Supérieur',
    clinicalHistory:
      'Cas de démonstration généré en RAM : explorez le nodule hépatique hypervasculaire (diamètre exact 24.0 mm sur la coupe 13/24 en fenêtre Parties Molles [2]) et le trait de fracture costale gauche (visible en fenêtre Os [1]).',
    series: [
      {
        id: 's1_tdm_abdo',
        description: 'TDM Axial Injecté — Double Pack (Os + Parties Molles)',
        modality: 'CT',
        width,
        height,
        sliceCount: ctSliceCount,
        pixelSpacing: [0.5, 0.5],
        effectiveSliceThickness: 3.0,
        availableWindows: [
          {
            key: 'soft',
            label: 'Parties Molles (WL 50 / WW 350)',
            folderPath: 'series/s1_tdm_abdo/soft',
          },
          {
            key: 'bone',
            label: 'Os (WL 400 / WW 1800)',
            folderPath: 'series/s1_tdm_abdo/bone',
          },
        ],
        slices: ctSlicesManifest,
      },
      {
        id: 's2_irm_t2',
        description: 'IRM Axiale T2 FSE — Caractérisation Tissulaire',
        modality: 'MR',
        width,
        height,
        sliceCount: mrSliceCount,
        pixelSpacing: [0.5, 0.5],
        effectiveSliceThickness: 4.0,
        availableWindows: [
          {
            key: 'default',
            label: 'Pondération T2 (Standard)',
            folderPath: 'series/s2_irm_t2/default',
          },
        ],
        slices: mrSlicesManifest,
      },
    ],
  };

  zipFiles['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  const archiveBytes = zipSync(zipFiles, { level: 1 });
  return loadTPackFromBuffer(archiveBytes, true);
}

/**
 * Génère en mémoire un lot de vrais fichiers binaires DICOM Part 10 (.dcm) 16 bits signés (PixelRepresentation = 1)
 * avec tags spatiaux ImagePositionPatient / ImageOrientationPatient et un bandeau Burned-in PHI simulé,
 * permettant de tester immédiatement le Studio d'Import & Compression sans quitter l'application.
 */
export function generateSyntheticDicomFiles(sliceCount: number = 32): File[] {
  const width = 256;
  const height = 256;
  const files: File[] = [];

  // Aide à l'écriture d'éléments DICOM Explicit VR Little Endian
  function createDicomTagString(group: number, element: number, vr: string, value: string): Uint8Array {
    const padded = value.length % 2 === 1 ? value + ' ' : value;
    const strBytes = strToU8(padded);
    const out = new Uint8Array(8 + strBytes.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, group, true);
    dv.setUint16(2, element, true);
    out[4] = vr.charCodeAt(0);
    out[5] = vr.charCodeAt(1);
    dv.setUint16(6, strBytes.length, true);
    out.set(strBytes, 8);
    return out;
  }

  function createDicomTagUint16(group: number, element: number, value: number): Uint8Array {
    const out = new Uint8Array(10);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, group, true);
    dv.setUint16(2, element, true);
    out[4] = 'U'.charCodeAt(0);
    out[5] = 'S'.charCodeAt(0);
    dv.setUint16(6, 2, true);
    dv.setUint16(8, value, true);
    return out;
  }

  for (let i = 0; i < sliceCount; i++) {
    const hu = generatePhantomSliceHU(width, height, i, sliceCount, true);
    const zPos = (-40 + i * 2.5).toFixed(2);
    // InstanceNumber volontairement inversé/mélangé pour prouver le tri spatial géométrique (IPP . Normale)
    const scrambledInstance = sliceCount - i;

    const tags: Uint8Array[] = [
      createDicomTagString(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'), // Explicit VR Little Endian
      createDicomTagString(0x0008, 0x0060, 'CS', 'CT'),
      createDicomTagString(0x0008, 0x103e, 'LO', 'TDM_FANTOME_16BIT_PHI'),
      createDicomTagString(0x0018, 0x0050, 'DS', '2.5'),
      createDicomTagString(0x0020, 0x000e, 'UI', '1.2.826.0.1.3680043.2.1125.99.1'),
      createDicomTagString(0x0020, 0x0013, 'IS', String(scrambledInstance)),
      createDicomTagString(0x0020, 0x0032, 'DS', `-128.0\\-128.0\\${zPos}`),
      createDicomTagString(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
      createDicomTagUint16(0x0028, 0x0002, 1), // SamplesPerPixel
      createDicomTagString(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
      createDicomTagUint16(0x0028, 0x0010, height), // Rows
      createDicomTagUint16(0x0028, 0x0011, width), // Columns
      createDicomTagString(0x0028, 0x0030, 'DS', '0.6667\\0.6667'), // PixelSpacing
      createDicomTagUint16(0x0028, 0x0100, 16), // BitsAllocated = 16
      createDicomTagUint16(0x0028, 0x0101, 16), // BitsStored = 16
      createDicomTagUint16(0x0028, 0x0102, 15), // HighBit = 15
      createDicomTagUint16(0x0028, 0x0103, 1), // PixelRepresentation = 1 (complément à 2 Int16)
      createDicomTagString(0x0028, 0x1050, 'DS', '50'), // WindowCenter
      createDicomTagString(0x0028, 0x1051, 'DS', '350'), // WindowWidth
      createDicomTagString(0x0028, 0x1052, 'DS', '0'), // RescaleIntercept
      createDicomTagString(0x0028, 0x1053, 'DS', '1'), // RescaleSlope
    ];

    const pixelByteLength = width * height * 2;
    const pixelHeader = new Uint8Array(12);
    const phDv = new DataView(pixelHeader.buffer);
    phDv.setUint16(0, 0x7fe0, true);
    phDv.setUint16(2, 0x0010, true);
    pixelHeader[4] = 'O'.charCodeAt(0);
    pixelHeader[5] = 'W'.charCodeAt(0);
    phDv.setUint16(6, 0, true);
    phDv.setUint32(8, pixelByteLength, true);

    const tagsSize = tags.reduce((acc, t) => acc + t.byteLength, 0);
    const totalSize = 132 + tagsSize + 12 + pixelByteLength;
    const fullBuffer = new ArrayBuffer(totalSize);
    const fullBytes = new Uint8Array(fullBuffer);

    // 128 octets de préambule + 'DICM'
    fullBytes[128] = 'D'.charCodeAt(0);
    fullBytes[129] = 'I'.charCodeAt(0);
    fullBytes[130] = 'C'.charCodeAt(0);
    fullBytes[131] = 'M'.charCodeAt(0);

    let offset = 132;
    for (const t of tags) {
      fullBytes.set(t, offset);
      offset += t.byteLength;
    }

    fullBytes.set(pixelHeader, offset);
    offset += 12;

    const int16View = new Int16Array(fullBuffer, offset, width * height);
    for (let p = 0; p < hu.length; p++) {
      int16View[p] = Math.round(hu[p]);
    }

    const file = new File(
      [fullBuffer],
      `IM_${String(scrambledInstance).padStart(3, '0')}_Z${zPos}.dcm`,
      { type: 'application/dicom' }
    );
    files.push(file);
  }

  return files;
}
