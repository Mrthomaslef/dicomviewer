import { unzipSync, strFromU8 } from 'fflate';
import { PedagogicalManifest, SeriesManifest } from '../types/manifest';

export interface LoadedSeriesData {
  manifest: SeriesManifest;
  // framesByWindow[windowKey][sliceIndex] = ImageBitmap
  framesByWindow: Record<string, ImageBitmap[]>;
}

export interface LoadedTPackArchive {
  manifest: PedagogicalManifest;
  seriesMap: Record<string, LoadedSeriesData>;
  archiveByteSize: number;
  rawBytes?: Uint8Array;
}

/**
 * Décompresse un fichier ou buffer .tpack en mémoire vive via fflate
 * et décode toutes les coupes WebP en ImageBitmap pour un affichage 60 fps sur Canvas 2D.
 */
export async function loadTPackFromBuffer(
  buffer: ArrayBuffer | Uint8Array,
  keepRawBytes: boolean = false
): Promise<LoadedTPackArchive> {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const unzipped = unzipSync(uint8);

  const manifestEntry = unzipped['manifest.json'];
  if (!manifestEntry) {
    throw new Error('Archive .tpack invalide : fichier manifest.json introuvable.');
  }

  const manifestJson = strFromU8(manifestEntry);
  const manifest = JSON.parse(manifestJson) as PedagogicalManifest;

  if (!manifest.series || !Array.isArray(manifest.series)) {
    throw new Error('Archive .tpack invalide : aucune série trouvée dans manifest.json.');
  }

  const seriesMap: Record<string, LoadedSeriesData> = {};

  for (const series of manifest.series) {
    const framesByWindow: Record<string, ImageBitmap[]> = {};

    for (const win of series.availableWindows) {
      const bitmaps: ImageBitmap[] = new Array(series.sliceCount);
      const folderClean = win.folderPath.replace(/\/+$/, '');

      const decodePromises = series.slices.map(async (sliceObj, idx) => {
        const sIdx = sliceObj.index ?? idx;
        const padded = String(sIdx).padStart(3, '0');
        const candidatePath1 = `${folderClean}/${padded}.webp`;
        const candidatePath2 = `series/${series.id}/${win.key}/${padded}.webp`;

        const fileBytes = unzipped[candidatePath1] || unzipped[candidatePath2];
        if (!fileBytes) {
          throw new Error(`Coupe WebP manquante dans l'archive : ${candidatePath1}`);
        }

        const blob = new Blob([fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength) as ArrayBuffer], {
          type: 'image/webp',
        });
        const bmp = await createImageBitmap(blob);
        bitmaps[idx] = bmp;
      });

      await Promise.all(decodePromises);
      framesByWindow[win.key] = bitmaps;
    }

    seriesMap[series.id] = {
      manifest: series,
      framesByWindow,
    };
  }

  return {
    manifest,
    seriesMap,
    archiveByteSize: uint8.byteLength,
    rawBytes: keepRawBytes ? uint8 : undefined,
  };
}

export async function loadTPackFromFile(file: File): Promise<LoadedTPackArchive> {
  const arrayBuffer = await file.arrayBuffer();
  return loadTPackFromBuffer(arrayBuffer, true);
}

/**
 * Libère proprement la mémoire GPU des ImageBitmap lors du changement d'examen
 */
export function disposeLoadedTPack(archive: LoadedTPackArchive | null): void {
  if (!archive) return;
  for (const sData of Object.values(archive.seriesMap)) {
    for (const bmpList of Object.values(sData.framesByWindow)) {
      for (const bmp of bmpList) {
        if (bmp && typeof bmp.close === 'function') {
          bmp.close();
        }
      }
    }
  }
}
