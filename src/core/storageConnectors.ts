import { loadTPackFromBuffer } from './tpackLoader';
import { saveCaseToIndexedDB, StoredPedagogicalCase } from './caseLibraryDb';

const HANDLE_DB_NAME = 'tpack_pacs_folder_handles_db';
const HANDLE_STORE = 'handles';
const DRIVE_CONFIG_KEY = 'tpack_google_drive_config_v1';

export interface GoogleDriveConfig {
  folderUrlOrId: string;
  apiKey: string;
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, 'default_tpack_dir');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore
  }
}

export async function getSavedDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get('default_tpack_dir');
      req.onsuccess = () => {
        db.close();
        resolve((req.result as FileSystemDirectoryHandle) || null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  } catch {
    return null;
  }
}

async function scanDirectoryRecursively(
  dirHandle: FileSystemDirectoryHandle,
  maxDepth: number = 3
): Promise<File[]> {
  const files: File[] = [];
  if (maxDepth < 0) return files;

  // @ts-expect-error values() est standard sur FileSystemDirectoryHandle
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      const name: string = entry.name || '';
      if (name.toLowerCase().endsWith('.tpack') && !name.startsWith('._')) {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        files.push(file);
      }
    } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
      const subFiles = await scanDirectoryRecursively(
        entry as FileSystemDirectoryHandle,
        maxDepth - 1
      );
      files.push(...subFiles);
    }
  }
  return files;
}

export function supportsFileSystemAccessApi(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function connectAndScanLocalDirectory(
  existingHandle?: FileSystemDirectoryHandle | null,
  onProgress?: (current: number, total: number) => void
): Promise<{ folderName: string; cases: StoredPedagogicalCase[] }> {
  let dirHandle = existingHandle;

  if (!dirHandle) {
    // @ts-expect-error showDirectoryPicker
    dirHandle = (await window.showDirectoryPicker({
      mode: 'read',
    })) as FileSystemDirectoryHandle;
  } else {
    // @ts-expect-error queryPermission
    const perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      // @ts-expect-error requestPermission
      const reqPerm = await dirHandle.requestPermission({ mode: 'read' });
      if (reqPerm !== 'granted') {
        throw new Error('Permission refusée.');
      }
    }
  }

  if (!dirHandle) {
    throw new Error('Aucun dossier sélectionné.');
  }

  await saveDirectoryHandle(dirHandle);

  const tpackFiles = await scanDirectoryRecursively(dirHandle, 3);
  const loadedCases: StoredPedagogicalCase[] = [];

  for (let i = 0; i < tpackFiles.length; i++) {
    const f = tpackFiles[i];
    if (onProgress) onProgress(i + 1, tpackFiles.length);
    try {
      const buf = await f.arrayBuffer();
      const uint8 = new Uint8Array(buf);
      const loaded = await loadTPackFromBuffer(uint8, true);
      const item: StoredPedagogicalCase = {
        id: loaded.manifest.caseId || f.name.replace(/\.tpack$/i, '') || `CAS-${Date.now()}`,
        title: loaded.manifest.title || f.name.replace(/\.tpack$/i, ''),
        modality: loaded.manifest.modality,
        anatomicalRegion: loaded.manifest.anatomicalRegion || '',
        clinicalHistory: loaded.manifest.clinicalHistory || '',
        diagnosis: loaded.manifest.diagnosis || '',
        keySliceIndex: loaded.manifest.keySliceIndex,
        keyWindowKey: loaded.manifest.keyWindowKey,
        createdAt: new Date().toISOString(),
        byteSize: uint8.byteLength,
        source: 'indexeddb',
        tpackBytes: uint8,
        manifest: loaded.manifest,
      };
      await saveCaseToIndexedDB(item);
      loadedCases.push(item);
    } catch {
      // Ignorer
    }
  }

  return {
    folderName: dirHandle.name,
    cases: loadedCases,
  };
}

export function extractGoogleDriveId(input: string): string {
  const trimmed = input.trim();
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];
  return trimmed;
}

export function loadSavedGoogleDriveConfig(): GoogleDriveConfig {
  try {
    const raw = localStorage.getItem(DRIVE_CONFIG_KEY);
    if (!raw) return { folderUrlOrId: '', apiKey: '' };
    const parsed = JSON.parse(raw);
    return {
      folderUrlOrId: parsed.folderUrlOrId || '',
      apiKey: parsed.apiKey || '',
    };
  } catch {
    return { folderUrlOrId: '', apiKey: '' };
  }
}

export function saveGoogleDriveConfig(config: GoogleDriveConfig): void {
  try {
    localStorage.setItem(DRIVE_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Ignore
  }
}

interface DriveFileEntry {
  id: string;
  name: string;
  size?: string;
}

export async function syncFromGoogleDrive(
  folderUrlOrId: string,
  apiKey: string,
  onProgress?: (current: number, total: number, fileName: string) => void
): Promise<StoredPedagogicalCase[]> {
  const driveId = extractGoogleDriveId(folderUrlOrId);
  const cleanKey = apiKey.trim();

  if (!driveId || !cleanKey) {
    throw new Error('Veuillez renseigner le lien du dossier Google Drive et votre clé API.');
  }

  saveGoogleDriveConfig({ folderUrlOrId, apiKey: cleanKey });

  const q = encodeURIComponent(`'${driveId}' in parents and trashed = false`);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=100&fields=files(id,name,size)&key=${encodeURIComponent(
    cleanKey
  )}`;

  const res = await fetch(listUrl);
  if (!res.ok) {
    throw new Error(
      'Impossible de lister ce dossier Google Drive (vérifiez le partage du dossier et la clé API).'
    );
  }

  const data = await res.json();
  const rawFiles: DriveFileEntry[] = Array.isArray(data.files) ? data.files : [];
  const filesToFetch = rawFiles.filter(
    (f) => f.name.toLowerCase().endsWith('.tpack') || f.name.toLowerCase().endsWith('.zip')
  );

  if (filesToFetch.length === 0) {
    throw new Error('Aucun fichier .tpack trouvé dans ce dossier Google Drive.');
  }

  const imported: StoredPedagogicalCase[] = [];

  for (let i = 0; i < filesToFetch.length; i++) {
    const entry = filesToFetch[i];
    if (onProgress) onProgress(i + 1, filesToFetch.length, entry.name);

    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      entry.id
    )}?alt=media&key=${encodeURIComponent(cleanKey)}`;

    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) continue;

    const buf = await fileRes.arrayBuffer();
    const uint8 = new Uint8Array(buf);
    try {
      const loaded = await loadTPackFromBuffer(uint8, true);
      const item: StoredPedagogicalCase = {
        id: loaded.manifest.caseId || entry.name.replace(/\.tpack$/i, ''),
        title: loaded.manifest.title || entry.name.replace(/\.tpack$/i, ''),
        modality: loaded.manifest.modality,
        anatomicalRegion: loaded.manifest.anatomicalRegion || '',
        clinicalHistory: loaded.manifest.clinicalHistory || '',
        diagnosis: loaded.manifest.diagnosis || '',
        keySliceIndex: loaded.manifest.keySliceIndex,
        keyWindowKey: loaded.manifest.keyWindowKey,
        createdAt: new Date().toISOString(),
        byteSize: uint8.byteLength,
        source: 'indexeddb',
        tpackBytes: uint8,
        manifest: loaded.manifest,
      };
      await saveCaseToIndexedDB(item);
      imported.push(item);
    } catch {
      // Ignore
    }
  }

  return imported;
}
