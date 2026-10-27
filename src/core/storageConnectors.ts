import { loadTPackFromBuffer } from './tpackLoader';
import { saveCaseToIndexedDB, StoredPedagogicalCase } from './caseLibraryDb';

const HANDLE_DB_NAME = 'tpack_pacs_folder_handles_db';
const HANDLE_STORE = 'handles';
const DRIVE_CONFIG_KEY = 'tpack_google_drive_config_v1';

export interface GoogleDriveConfig {
  folderUrlOrId: string;
  apiKey: string;
  appsScriptUrl?: string;
  oauthClientId?: string;
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
      const cleanBase = f.name.replace(/\.(tpack|zip)$/i, '');
      const nameParts = (loaded.manifest.caseId || cleanBase).split('-');
      const inferredRegion =
        nameParts.length >= 4 && ['CT', 'MR', 'RX'].includes(nameParts[0].toUpperCase())
          ? nameParts[1].replace(/_/g, ' ')
          : '';
      const item: StoredPedagogicalCase = {
        id: loaded.manifest.caseId || cleanBase || `CAS-${Date.now()}`,
        title: loaded.manifest.title || cleanBase,
        modality: loaded.manifest.modality,
        anatomicalRegion: loaded.manifest.anatomicalRegion || inferredRegion,
        clinicalHistory: loaded.manifest.clinicalHistory || '',
        diagnosis: loaded.manifest.diagnosis || '',
        keySliceIndex: loaded.manifest.keySliceIndex,
        keyWindowKey: loaded.manifest.keyWindowKey,
        createdAt: new Date().toISOString(),
        byteSize: uint8.byteLength,
        source: 'indexeddb',
        origin: 'local',
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
    if (!raw) return { folderUrlOrId: '', apiKey: '', appsScriptUrl: '', oauthClientId: '' };
    const parsed = JSON.parse(raw);
    return {
      folderUrlOrId: parsed.folderUrlOrId || '',
      apiKey: parsed.apiKey || '',
      appsScriptUrl: parsed.appsScriptUrl || '',
      oauthClientId: parsed.oauthClientId || '',
    };
  } catch {
    return { folderUrlOrId: '', apiKey: '', appsScriptUrl: '', oauthClientId: '' };
  }
}

export function saveGoogleDriveConfig(config: Partial<GoogleDriveConfig>): void {
  try {
    const current = loadSavedGoogleDriveConfig();
    const merged: GoogleDriveConfig = {
      folderUrlOrId: config.folderUrlOrId !== undefined ? config.folderUrlOrId : current.folderUrlOrId,
      apiKey: config.apiKey !== undefined ? config.apiKey : current.apiKey,
      appsScriptUrl: config.appsScriptUrl !== undefined ? config.appsScriptUrl : current.appsScriptUrl,
      oauthClientId: config.oauthClientId !== undefined ? config.oauthClientId : current.oauthClientId,
    };
    localStorage.setItem(DRIVE_CONFIG_KEY, JSON.stringify(merged));
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
      const cleanBase = entry.name.replace(/\.(tpack|zip)$/i, '');
      const nameParts = (loaded.manifest.caseId || cleanBase).split('-');
      const inferredRegion =
        nameParts.length >= 4 && ['CT', 'MR', 'RX'].includes(nameParts[0].toUpperCase())
          ? nameParts[1].replace(/_/g, ' ')
          : '';
      const item: StoredPedagogicalCase = {
        id: loaded.manifest.caseId || cleanBase,
        title: loaded.manifest.title || cleanBase,
        modality: loaded.manifest.modality,
        anatomicalRegion: loaded.manifest.anatomicalRegion || inferredRegion,
        clinicalHistory: loaded.manifest.clinicalHistory || '',
        diagnosis: loaded.manifest.diagnosis || '',
        keySliceIndex: loaded.manifest.keySliceIndex,
        keyWindowKey: loaded.manifest.keyWindowKey,
        createdAt: new Date().toISOString(),
        byteSize: uint8.byteLength,
        source: 'indexeddb',
        origin: 'drive',
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

/**
 * Demande explicitement à l'utilisateur de choisir le répertoire (repo) / emplacement local
 * où enregistrer le fichier .tpack via l'API File System Access (showSaveFilePicker ou showDirectoryPicker),
 * avec repli sur le téléchargement navigateur si l'OS/navigateur ne supporte pas le sélecteur natif.
 */
export async function saveTPackToLocalRepo(
  archiveBytes: Uint8Array,
  suggestedFileName: string
): Promise<{ savedLocation: string; cancelled: boolean }> {
  const cleanName = suggestedFileName.toLowerCase().endsWith('.tpack')
    ? suggestedFileName
    : `${suggestedFileName}.tpack`;

  const byteSlice = archiveBytes.buffer.slice(
    archiveBytes.byteOffset,
    archiveBytes.byteOffset + archiveBytes.byteLength
  ) as ArrayBuffer;

  // 1. Priorité au sélecteur de fichier natif (Finder / Explorer "Enregistrer sous...") permettant de choisir le dossier et le nom
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      // @ts-expect-error showSaveFilePicker est standard dans Chromium (Chrome, Edge, Brave, Opera)
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: cleanName,
        types: [
          {
            description: 'Archive Imagerie Médicale TPack (.tpack)',
            accept: {
              'application/octet-stream': ['.tpack'],
            },
          },
        ],
      });
      const writable = await fileHandle.createWritable();
      await writable.write(byteSlice);
      await writable.close();
      return { savedLocation: fileHandle.name || cleanName, cancelled: false };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { savedLocation: '', cancelled: true };
      }
      // Si autre erreur, continue vers showDirectoryPicker
    }
  }

  // 2. Alternative : sélecteur de répertoire natif (showDirectoryPicker en écriture)
  if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
    try {
      // @ts-expect-error showDirectoryPicker
      const dirHandle = (await window.showDirectoryPicker({
        mode: 'readwrite',
      })) as FileSystemDirectoryHandle;
      await saveDirectoryHandle(dirHandle);
      const fileHandle = await dirHandle.getFileHandle(cleanName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(byteSlice);
      await writable.close();
      return { savedLocation: `${dirHandle.name}/${cleanName}`, cancelled: false };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { savedLocation: '', cancelled: true };
      }
    }
  }

  // 3. Fallback pour Safari / Firefox / Mobile : téléchargement standard
  const blob = new Blob([byteSlice], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = cleanName;
  a.click();
  URL.revokeObjectURL(url);
  return { savedLocation: cleanName, cancelled: false };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

let cachedOAuthToken: { token: string; expiresAt: number } | null = null;

async function getGoogleOAuthToken(clientId: string): Promise<string> {
  if (cachedOAuthToken && Date.now() < cachedOAuthToken.expiresAt) {
    return cachedOAuthToken.token;
  }

  if (typeof window === 'undefined') {
    throw new Error('Environnement navigateur requis pour OAuth2.');
  }

  // Charge dynamiquement Google Identity Services (gsi/client) si non chargé
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  if (!win.google?.accounts?.oauth2) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Impossible de charger Google Identity Services')));
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Impossible de charger Google Identity Services'));
      document.head.appendChild(script);
    });
  }

  return await new Promise<string>((resolve, reject) => {
    const tokenClient = win.google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error || 'Authentification Google Drive annulée.'));
          return;
        }
        const ttlMs = ((resp.expires_in || 3500) - 60) * 1000;
        cachedOAuthToken = {
          token: resp.access_token,
          expiresAt: Date.now() + ttlMs,
        };
        resolve(resp.access_token);
      },
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

/**
 * Envoie directement un fichier .tpack dans le dossier Google Drive de l'utilisateur :
 * - Soit via le pont Google Apps Script (sans OAuth ni console Cloud, permanent en 1 clic)
 * - Soit via Google Drive API v3 Multipart Upload (OAuth2 Client ID)
 */
export async function uploadTPackToGoogleDrive(
  archiveBytes: Uint8Array,
  fileName: string,
  options: {
    folderUrlOrId: string;
    appsScriptUrl?: string;
    oauthClientId?: string;
  }
): Promise<{ fileName: string; folderUrl: string }> {
  const cleanName = fileName.toLowerCase().endsWith('.tpack') ? fileName : `${fileName}.tpack`;
  const folderId = extractGoogleDriveId(options.folderUrlOrId || '');
  const appsScriptUrl = (options.appsScriptUrl || '').trim();
  const oauthClientId = (options.oauthClientId || '').trim();

  saveGoogleDriveConfig({
    folderUrlOrId: options.folderUrlOrId,
    appsScriptUrl,
    oauthClientId,
  });

  const folderUrl = folderId
    ? `https://drive.google.com/drive/folders/${folderId}`
    : 'https://drive.google.com/drive/my-drive';

  // Méthode 1 : Pont Google Apps Script (zéro configuration OAuth, envoi direct en POST text/plain CORS-safe)
  if (appsScriptUrl) {
    const payload = JSON.stringify({
      fileName: cleanName,
      folderId: folderId || '',
      mimeType: 'application/octet-stream',
      base64Data: uint8ToBase64(archiveBytes),
    });

    const res = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: payload,
    });

    if (!res.ok) {
      throw new Error(`Erreur lors de l'envoi au script Google Drive (${res.status}).`);
    }

    return { fileName: cleanName, folderUrl };
  }

  // Méthode 2 : API Google Drive v3 officielle via OAuth 2.0 Client ID
  if (oauthClientId) {
    const accessToken = await getGoogleOAuthToken(oauthClientId);
    const metadata: { name: string; mimeType: string; parents?: string[] } = {
      name: cleanName,
      mimeType: 'application/octet-stream',
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    const boundary = 'tpack_multipart_boundary_' + Date.now();
    const metaPart =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const closePart = `\r\n--${boundary}--`;

    const encoder = new TextEncoder();
    const metaBytes = encoder.encode(metaPart);
    const closeBytes = encoder.encode(closePart);

    const bodyBuffer = new Uint8Array(
      metaBytes.byteLength + archiveBytes.byteLength + closeBytes.byteLength
    );
    bodyBuffer.set(metaBytes, 0);
    bodyBuffer.set(archiveBytes, metaBytes.byteLength);
    bodyBuffer.set(closeBytes, metaBytes.byteLength + archiveBytes.byteLength);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: bodyBuffer,
      }
    );

    if (!uploadRes.ok) {
      throw new Error(
        `Échec de l'envoi sur Google Drive API (${uploadRes.status}). Vérifiez le Client ID et les droits du dossier.`
      );
    }

    return { fileName: cleanName, folderUrl };
  }

  throw new Error('CONFIG_REQUIRED');
}

export const GOOGLE_DRIVE_UPLOAD_APPS_SCRIPT_SNIPPET = `function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var bytes = Utilities.base64Decode(data.base64Data);
  var blob = Utilities.newBlob(bytes, data.mimeType || 'application/octet-stream', data.fileName);
  var folder = data.folderId ? DriveApp.getFolderById(data.folderId) : DriveApp.getRootFolder();
  var file = folder.createFile(blob);
  return ContentService.createTextOutput(JSON.stringify({ ok: true, id: file.getId(), name: file.getName() }))
    .setMimeType(ContentService.MimeType.JSON);
}`;
