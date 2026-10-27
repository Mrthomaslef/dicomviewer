import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Activity,
  Eye,
  Cpu,
  ShieldCheck,
  BookOpen,
  FolderUp,
} from 'lucide-react';
import {
  LoadedTPackArchive,
  disposeLoadedTPack,
  loadTPackFromBuffer,
  loadTPackFromFile,
} from './core/tpackLoader';
import { listCasesFromIndexedDB } from './core/caseLibraryDb';
import { TPackViewer } from './components/TPackViewer';
import { CompressionStudio } from './components/CompressionStudio';
import { CaseLibraryView } from './components/CaseLibraryView';

type AppMode = 'viewer' | 'library' | 'studio';

export const App: React.FC = () => {
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const isEmbedMode = urlParams.get('embed') === '1' || urlParams.get('embed') === 'true';
  const initialCaseUrl = urlParams.get('caseUrl');

  const [mode, setMode] = useState<AppMode>('viewer');
  const [loadedArchive, setLoadedArchive] = useState<LoadedTPackArchive | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleLoadNewArchive = useCallback((newArchive: LoadedTPackArchive) => {
    setErrorMsg(null);
    setLoadedArchive((prev) => {
      if (prev && prev !== newArchive) {
        disposeLoadedTPack(prev);
      }
      return newArchive;
    });
    setMode('viewer');
  }, []);

  // Initialisation : charge ?caseUrl=... si fourni, ou le dernier cas stocké en local (hors mode embed)
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (initialCaseUrl) {
        setIsLoading(true);
        try {
          const res = await fetch(initialCaseUrl);
          if (!res.ok) throw new Error(`Impossible de charger ${initialCaseUrl}`);
          const buf = await res.arrayBuffer();
          const loaded = await loadTPackFromBuffer(buf, true);
          if (!cancelled) {
            handleLoadNewArchive(loaded);
          }
        } catch (err) {
          if (!cancelled) {
            setErrorMsg(err instanceof Error ? err.message : 'Erreur de chargement du fichier .tpack');
          }
        } finally {
          if (!cancelled) setIsLoading(false);
        }
        return;
      }

      // En mode normal (non-embed), charge automatiquement le dernier .tpack enregistré dans IndexedDB s'il existe
      if (!isEmbedMode) {
        const stored = await listCasesFromIndexedDB();
        if (!cancelled && stored.length > 0 && stored[0].tpackBytes) {
          try {
            setIsLoading(true);
            const loaded = await loadTPackFromBuffer(stored[0].tpackBytes, true);
            if (!cancelled) {
              handleLoadNewArchive(loaded);
            }
          } catch {
            // Ignorer si corrompu
          } finally {
            if (!cancelled) setIsLoading(false);
          }
        }
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [initialCaseUrl, isEmbedMode, handleLoadNewArchive]);

  // Pont API postMessage pour le Mode Embed (reçoit le buffer .tpack ou l'URL depuis le site TPack.cases)
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      try {
        const applyCaseMeta = (loaded: LoadedTPackArchive, meta: Record<string, unknown> | undefined) => {
          if (!meta || typeof meta !== 'object') return;
          if (!loaded.manifest.title && typeof meta.title === 'string') {
            loaded.manifest.title = meta.title;
          }
          if (!loaded.manifest.clinicalHistory && typeof meta.clinicalHistory === 'string') {
            loaded.manifest.clinicalHistory = meta.clinicalHistory;
          }
          if (!loaded.manifest.diagnosis && typeof meta.diagnosis === 'string') {
            loaded.manifest.diagnosis = meta.diagnosis;
          }
          if (!loaded.manifest.anatomicalRegion && typeof meta.anatomicalRegion === 'string') {
            loaded.manifest.anatomicalRegion = meta.anatomicalRegion;
          }
          if (typeof loaded.manifest.keySliceIndex !== 'number' && typeof meta.keySliceIndex === 'number') {
            loaded.manifest.keySliceIndex = meta.keySliceIndex;
          }
        };

        if (data.type === 'TPACK_LOAD_BUFFER' && data.buffer) {
          setIsLoading(true);
          const loaded = await loadTPackFromBuffer(data.buffer, true);
          applyCaseMeta(loaded, data.caseMeta);
          handleLoadNewArchive(loaded);
          setIsLoading(false);
        } else if (data.type === 'TPACK_LOAD_URL' && typeof data.url === 'string') {
          setIsLoading(true);
          const res = await fetch(data.url);
          if (!res.ok) throw new Error(`Fichier introuvable : ${data.url}`);
          const buf = await res.arrayBuffer();
          const loaded = await loadTPackFromBuffer(buf, true);
          applyCaseMeta(loaded, data.caseMeta);
          handleLoadNewArchive(loaded);
          setIsLoading(false);
        }
      } catch (err) {
        setIsLoading(false);
        setErrorMsg(
          err instanceof Error ? err.message : 'Erreur chargement .tpack via postMessage'
        );
      }
    };

    window.addEventListener('message', handleMessage);
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'TPACK_EMBED_READY' }, '*');
    }
    return () => window.removeEventListener('message', handleMessage);
  }, [handleLoadNewArchive]);

  // Empêche le navigateur sur ordinateur de zoomer sur la page entière lors d'un pincement au trackpad
  useEffect(() => {
    const preventPageWheelZoom = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    };
    const preventSafariGesturePageZoom = (e: Event) => {
      e.preventDefault();
    };
    window.addEventListener('wheel', preventPageWheelZoom, { passive: false });
    window.addEventListener('gesturestart', preventSafariGesturePageZoom, { passive: false });
    window.addEventListener('gesturechange', preventSafariGesturePageZoom, { passive: false });
    window.addEventListener('gestureend', preventSafariGesturePageZoom, { passive: false });
    return () => {
      window.removeEventListener('wheel', preventPageWheelZoom);
      window.removeEventListener('gesturestart', preventSafariGesturePageZoom);
      window.removeEventListener('gesturechange', preventSafariGesturePageZoom);
      window.removeEventListener('gestureend', preventSafariGesturePageZoom);
    };
  }, []);

  // Mode Embed plein écran (?embed=1)
  if (isEmbedMode) {
    return (
      <div
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)',
          paddingRight: 'env(safe-area-inset-right, 0px)',
        }}
        className="h-[100dvh] w-screen bg-[#090D16] text-slate-100 overflow-hidden select-none box-border"
      >
        {loadedArchive ? (
          <TPackViewer
            archive={loadedArchive}
            onLoadNewArchive={handleLoadNewArchive}
          />
        ) : (
          <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-[#090D16] p-6 text-center">
            <div className="text-xs text-slate-400">
              {isLoading ? 'Décodage du fichier .tpack en cours...' : 'En attente d’un fichier .tpack...'}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
      className="h-[100dvh] w-screen flex flex-col bg-[#090D16] text-slate-100 overflow-hidden select-none box-border"
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file && file.name.toLowerCase().endsWith('.tpack')) {
          const loaded = await loadTPackFromFile(file);
          handleLoadNewArchive(loaded);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".tpack,.zip"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) {
            const loaded = await loadTPackFromFile(file);
            handleLoadNewArchive(loaded);
          }
        }}
      />

      {/* BARRE DE NAVIGATION PRINCIPALE */}
      <header className="h-11 shrink-0 bg-[#090D16] border-b border-slate-800/90 px-3 flex items-center justify-between gap-2 z-30">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center text-cyan-400 shrink-0">
            <Activity className="w-4 h-4" />
          </div>
          <span className="font-bold text-xs sm:text-sm tracking-tight text-white truncate">
            TPack<span className="text-cyan-400">.pacs</span>
          </span>
          <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-medium text-emerald-300">
            <ShieldCheck className="w-3 h-3" />
            Zéro-Serveur
          </span>
        </div>

        {/* Sélecteur des 3 Modes : Lecteur / Bibliothèque / Studio DICOM */}
        <div className="flex items-center bg-slate-900/90 p-0.5 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setMode('viewer')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              mode === 'viewer'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Lecteur</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('library')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              mode === 'library'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Bibliothèque</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('studio')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              mode === 'studio'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Studio</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 hover:text-cyan-300 flex items-center gap-1.5 transition cursor-pointer"
        >
          <FolderUp className="w-3.5 h-3.5 text-cyan-400" />
          <span className="hidden sm:inline">Ouvrir .tpack</span>
        </button>
      </header>

      {/* CORPS DE L'APPLICATION */}
      <main className="flex-1 w-full relative overflow-hidden">
        {errorMsg && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-red-950/90 border border-red-500/50 text-xs text-red-200 shadow-xl">
            {errorMsg}
          </div>
        )}

        {mode === 'viewer' ? (
          loadedArchive ? (
            <TPackViewer
              archive={loadedArchive}
              onLoadNewArchive={handleLoadNewArchive}
            />
          ) : (
            <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-[#090D16] p-6 text-center">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs flex items-center gap-2 shadow-lg transition cursor-pointer"
              >
                <FolderUp className="w-4 h-4" />
                Ouvrir un fichier .tpack
              </button>
              <p className="text-xs text-slate-400">
                Ou glissez-déposez un fichier <code className="text-cyan-300">.tpack</code> sur l’écran.
              </p>
            </div>
          )
        ) : mode === 'library' ? (
          <CaseLibraryView
            onOpenArchive={handleLoadNewArchive}
            refreshTrigger={libraryRefreshKey}
          />
        ) : (
          <CompressionStudio
            onOpenGeneratedTPack={handleLoadNewArchive}
            onCaseSavedToLibrary={() => setLibraryRefreshKey((k) => k + 1)}
          />
        )}
      </main>
    </div>
  );
};

export default App;
