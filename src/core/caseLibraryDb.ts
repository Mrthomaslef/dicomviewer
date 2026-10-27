import { PedagogicalManifest } from '../types/manifest';

export interface StoredPedagogicalCase {
  id: string;
  title: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  anatomicalRegion: string;
  clinicalHistory: string;
  diagnosis?: string;
  question?: string;
  choices?: string[];
  correctChoiceIndex?: number;
  explanation?: string;
  keySliceIndex?: number;
  keyWindowKey?: string;
  createdAt: string;
  byteSize: number;
  source: 'indexeddb' | 'public_catalog' | 'demo';
  tpackUrl?: string;
  tpackBytes?: Uint8Array;
  manifest?: PedagogicalManifest;
}

const DB_NAME = 'tpack_pedagogical_library_v1';
const STORE_NAME = 'cases';

function openLibraryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCaseToIndexedDB(item: StoredPedagogicalCase): Promise<void> {
  const db = await openLibraryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(item);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function listCasesFromIndexedDB(): Promise<StoredPedagogicalCase[]> {
  try {
    const db = await openLibraryDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        const list = (req.result as StoredPedagogicalCase[]) || [];
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        resolve(list);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return [];
  }
}

export async function deleteCaseFromIndexedDB(id: string): Promise<void> {
  const db = await openLibraryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function fetchPublicCatalogCases(): Promise<StoredPedagogicalCase[]> {
  try {
    const res = await fetch('./cases/catalog.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data as StoredPedagogicalCase[];
  } catch {
    return [];
  }
}
