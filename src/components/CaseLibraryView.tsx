import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Play,
  Trash2,
  Upload,
  Download,
  FolderOpen,
  Cloud,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  StoredPedagogicalCase,
  listCasesFromIndexedDB,
  deleteCaseFromIndexedDB,
  saveCaseToIndexedDB,
  fetchPublicCatalogCases,
} from '../core/caseLibraryDb';
import { LoadedTPackArchive, loadTPackFromBuffer } from '../core/tpackLoader';
import {
  connectAndScanLocalDirectory,
  getSavedDirectoryHandle,
  loadSavedGoogleDriveConfig,
  supportsFileSystemAccessApi,
  syncFromGoogleDrive,
} from '../core/storageConnectors';

interface CaseLibraryViewProps {
  onOpenArchive: (archive: LoadedTPackArchive) => void;
  refreshTrigger?: number;
}

export const CaseLibraryView: React.FC<CaseLibraryViewProps> = ({
  onOpenArchive,
  refreshTrigger = 0,
}) => {
  const [librarySource, setLibrarySource] = useState<'local' | 'drive'>('local');
  const [localCases, setLocalCases] = useState<StoredPedagogicalCase[]>([]);
  const [publicCases, setPublicCases] = useState<StoredPedagogicalCase[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [savedDirHandle, setSavedDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [connectedFolderName, setConnectedFolderName] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [showDriveModal, setShowDriveModal] = useState<boolean>(false);
  const [driveFolderUrl, setDriveFolderUrl] = useState<string>('');
  const [driveApiKey, setDriveApiKey] = useState<string>('');
  const [driveError, setDriveError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderFallbackRef = useRef<HTMLInputElement | null>(null);

  const refreshAll = useCallback(async () => {
    const [loc, pub, handle] = await Promise.all([
      listCasesFromIndexedDB(),
      fetchPublicCatalogCases(),
      getSavedDirectoryHandle(),
    ]);
    setLocalCases(loc);
    setPublicCases(pub);
    if (handle) {
      setSavedDirHandle(handle);
      setConnectedFolderName(handle.name);
    }
  }, []);

  useEffect(() => {
    refreshAll();
    const savedDrive = loadSavedGoogleDriveConfig();
    setDriveFolderUrl(savedDrive.folderUrlOrId);
    setDriveApiKey(savedDrive.apiKey);
  }, [refreshAll, refreshTrigger]);

  const handleImportTpackFiles = async (files: FileList) => {
    const valid = Array.from(files).filter(
      (f) =>
        (f.name.toLowerCase().endsWith('.tpack') || f.name.toLowerCase().endsWith('.zip')) &&
        !f.name.startsWith('._')
    );
    if (valid.length === 0) return;

    setIsSyncing(true);
    try {
      for (let i = 0; i < valid.length; i++) {
        const file = valid[i];
        setSyncStatus(`Import (${i + 1}/${valid.length}) : ${file.name}`);
        try {
          const buffer = await file.arrayBuffer();
          const uint8 = new Uint8Array(buffer);
          const loaded = await loadTPackFromBuffer(uint8, true);
          const item: StoredPedagogicalCase = {
            id: loaded.manifest.caseId || `CAS-${Date.now()}`,
            title: loaded.manifest.title || file.name.replace(/\.tpack$/i, ''),
            modality: loaded.manifest.modality,
            anatomicalRegion: loaded.manifest.anatomicalRegion || '',
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
        } catch {
          // Ignorer
        }
      }
      await refreshAll();
      setLibrarySource('local');
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  const handleConnectLocalFolder = async (useRemembered: boolean = false) => {
    if (!supportsFileSystemAccessApi()) {
      folderFallbackRef.current?.click();
      return;
    }
    setIsSyncing(true);
    setSyncStatus('Lecture du dossier local...');
    try {
      const { folderName } = await connectAndScanLocalDirectory(
        useRemembered ? savedDirHandle : null,
        (cur, tot) => setSyncStatus(`Indexation (${cur}/${tot})...`)
      );
      setConnectedFolderName(folderName);
      await refreshAll();
      setLibrarySource('local');
    } catch {
      // Annulé
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  const handleQuickRefreshDrive = async () => {
    if (!driveFolderUrl.trim() || !driveApiKey.trim()) {
      setShowDriveModal(true);
      return;
    }
    setDriveError(null);
    setIsSyncing(true);
    try {
      await syncFromGoogleDrive(driveFolderUrl, driveApiKey, (cur, tot, name) => {
        setSyncStatus(`Google Drive (${cur}/${tot}) : ${name}`);
      });
      await refreshAll();
      setLibrarySource('drive');
    } catch (err) {
      setDriveError(err instanceof Error ? err.message : 'Erreur Google Drive');
      setShowDriveModal(true);
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  const handleSyncDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    setDriveError(null);
    setIsSyncing(true);
    try {
      await syncFromGoogleDrive(driveFolderUrl, driveApiKey, (cur, tot, name) => {
        setSyncStatus(`Google Drive (${cur}/${tot}) : ${name}`);
      });
      await refreshAll();
      setLibrarySource('drive');
      setShowDriveModal(false);
    } catch (err) {
      setDriveError(err instanceof Error ? err.message : 'Erreur Google Drive');
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  const handleOpenCase = async (c: StoredPedagogicalCase) => {
    if (c.tpackBytes) {
      const loaded = await loadTPackFromBuffer(c.tpackBytes, true);
      onOpenArchive(loaded);
    } else if (c.tpackUrl) {
      const res = await fetch(c.tpackUrl);
      const buf = await res.arrayBuffer();
      const loaded = await loadTPackFromBuffer(buf, true);
      onOpenArchive(loaded);
    }
  };

  const handleDownloadCase = (c: StoredPedagogicalCase) => {
    if (!c.tpackBytes) return;
    const blob = new Blob(
      [
        c.tpackBytes.buffer.slice(
          c.tpackBytes.byteOffset,
          c.tpackBytes.byteOffset + c.tpackBytes.byteLength
        ) as ArrayBuffer,
      ],
      { type: 'application/octet-stream' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${c.id.toLowerCase()}.tpack`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const localLibraryCases = [
    ...localCases.filter((c) => c.origin !== 'drive'),
    ...publicCases.filter((p) => !localCases.some((l) => l.id === p.id)),
  ];
  const driveLibraryCases = localCases.filter((c) => c.origin === 'drive');

  const activeSourceCases =
    librarySource === 'local' ? localLibraryCases : driveLibraryCases;

  const allCases = activeSourceCases.filter((c) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      c.title.toLowerCase().includes(q) ||
      c.anatomicalRegion.toLowerCase().includes(q) ||
      c.clinicalHistory.toLowerCase().includes(q) ||
      (c.diagnosis || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="h-full w-full overflow-y-auto bg-[#090D16] p-4 sm:p-6 text-slate-100">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".tpack,.zip"
        className="hidden"
        onChange={(e) => e.target.files && handleImportTpackFiles(e.target.files)}
      />
      <input
        ref={folderFallbackRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory="true"
        className="hidden"
        onChange={(e) => e.target.files && handleImportTpackFiles(e.target.files)}
      />

      <div className="max-w-4xl mx-auto space-y-4">
        {/* Sélecteur de Source : Bibliothèque Locale vs Google Drive */}
        <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-xl bg-[#0B101B] border border-slate-800">
          <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800/80">
            <button
              type="button"
              onClick={() => setLibrarySource('local')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition cursor-pointer ${
                librarySource === 'local'
                  ? 'bg-cyan-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <FolderOpen className="w-4 h-4 shrink-0" />
              <span>Bibliothèque Locale ({localLibraryCases.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setLibrarySource('drive')}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition cursor-pointer ${
                librarySource === 'drive'
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Cloud className="w-4 h-4 shrink-0" />
              <span>Mon Google Drive ({driveLibraryCases.length})</span>
            </button>
          </div>

          {/* Actions contextuelles selon la bibliothèque choisie */}
          <div className="flex flex-wrap items-center gap-1.5">
            {librarySource === 'local' ? (
              <>
                {savedDirHandle && (
                  <button
                    type="button"
                    onClick={() => handleConnectLocalFolder(true)}
                    disabled={isSyncing}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-cyan-300 flex items-center gap-1 cursor-pointer"
                    title={`Actualiser "${connectedFolderName}"`}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span className="max-w-[100px] truncate">{connectedFolderName}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleConnectLocalFolder(false)}
                  disabled={isSyncing}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Choisir Dossier Local</span>
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Importer .tpack</span>
                </button>
              </>
            ) : (
              <>
                {driveFolderUrl && driveApiKey && (
                  <button
                    type="button"
                    onClick={handleQuickRefreshDrive}
                    disabled={isSyncing}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-emerald-300 flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>Actualiser Drive</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setShowDriveModal(true)}
                  disabled={isSyncing}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <Cloud className="w-3.5 h-3.5" />
                  <span>Configurer Google Drive</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Barre de recherche */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              librarySource === 'local'
                ? 'Rechercher dans votre bibliothèque locale...'
                : 'Rechercher dans votre bibliothèque Google Drive...'
            }
            className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#0B101B] border border-slate-800 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
          />
        </div>

        {syncStatus && (
          <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-xs text-cyan-200 flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
            <span>{syncStatus}</span>
          </div>
        )}

        {/* État vide guidé si aucun cas dans la source sélectionnée */}
        {allCases.length === 0 && (
          <div className="rounded-2xl bg-[#0B101B] border border-slate-800 p-8 text-center space-y-3">
            {librarySource === 'local' ? (
              <>
                <FolderOpen className="w-8 h-8 text-cyan-400 mx-auto opacity-80" />
                <div className="text-sm font-bold text-white">
                  Aucun cas dans votre Bibliothèque Locale
                </div>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Pointez vers un dossier local contenant vos fichiers .tpack ou importez directement un fichier .tpack.
                </p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => handleConnectLocalFolder(false)}
                    className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-cyan-300 cursor-pointer"
                  >
                    Choisir un dossier local
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-xs font-semibold text-slate-950 cursor-pointer"
                  >
                    Importer un .tpack
                  </button>
                </div>
              </>
            ) : (
              <>
                <Cloud className="w-8 h-8 text-emerald-400 mx-auto opacity-80" />
                <div className="text-sm font-bold text-white">
                  Aucun cas synchronisé depuis votre Google Drive
                </div>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Connectez votre dossier Google Drive pour accéder à l&apos;ensemble de votre bibliothèque .tpack dans le Cloud.
                </p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  {driveFolderUrl && driveApiKey && (
                    <button
                      type="button"
                      onClick={handleQuickRefreshDrive}
                      className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-emerald-300 cursor-pointer"
                    >
                      Synchroniser maintenant
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowDriveModal(true)}
                    className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-xs font-semibold text-slate-950 cursor-pointer"
                  >
                    Connecter mon Google Drive
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Grille des Cas */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {allCases.map((c) => (
            <div
              key={`${c.source}_${c.id}`}
              onClick={() => handleOpenCase(c)}
              className="rounded-xl bg-[#0B101B] border border-slate-800 hover:border-cyan-500/40 p-4 flex flex-col justify-between gap-3 transition cursor-pointer group"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-[10px]">
                      {c.modality}
                    </span>
                    {c.anatomicalRegion && (
                      <span className="text-xs text-slate-400">{c.anatomicalRegion}</span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-500 font-mono">
                    {(c.byteSize / 1024).toFixed(0)} Ko
                  </span>
                </div>

                <h3 className="text-sm font-bold text-white group-hover:text-cyan-300 transition">
                  {c.title}
                </h3>
                {c.clinicalHistory && (
                  <p className="text-xs text-slate-400 line-clamp-2">{c.clinicalHistory}</p>
                )}
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1">
                  <Play className="w-3 h-3 fill-current" /> Ouvrir
                </span>

                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {c.tpackBytes && (
                    <button
                      type="button"
                      onClick={() => handleDownloadCase(c)}
                      className="p-1.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-300"
                      title="Télécharger .tpack"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {c.source === 'indexeddb' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteCaseFromIndexedDB(c.id);
                        await refreshAll();
                      }}
                      className="p-1.5 rounded bg-slate-900 hover:bg-red-950/60 text-slate-400 hover:text-red-300"
                      title="Supprimer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Modal Google Drive */}
      {showDriveModal && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowDriveModal(false)}
        >
          <div
            className="bg-[#0B101B] border border-slate-800 rounded-2xl max-w-md w-full p-4 space-y-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                <Cloud className="w-4 h-4" />
                <span>Connecter un Dossier Google Drive</span>
              </div>
              <button
                type="button"
                onClick={() => setShowDriveModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSyncDrive} className="space-y-3 text-xs">
              <div>
                <label className="text-slate-400 block mb-1">
                  Lien ou ID du dossier Google Drive partagé
                </label>
                <input
                  type="text"
                  required
                  value={driveFolderUrl}
                  onChange={(e) => setDriveFolderUrl(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/..."
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Clé API Google Drive</label>
                <input
                  type="password"
                  required
                  value={driveApiKey}
                  onChange={(e) => setDriveApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 font-mono"
                />
              </div>

              {driveError && (
                <div className="p-2 rounded bg-red-950/70 border border-red-500/40 text-red-200 text-[11px]">
                  {driveError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowDriveModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isSyncing}
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-semibold cursor-pointer"
                >
                  Synchroniser
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
