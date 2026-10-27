import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity,
  Eye,
  Cpu,
  Sparkles,
  ShieldCheck,
  BookOpen,
} from 'lucide-react';
import {
  LoadedTPackArchive,
  disposeLoadedTPack,
  loadTPackFromBuffer,
} from './core/tpackLoader';
import { generateDemoTPackArchive } from './core/demoCaseGenerator';
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
  const [isGeneratingDemo, setIsGeneratingDemo] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState<number>(0);

  const handleLoadNewArchive = useCallback((newArchive: LoadedTPackArchive) => {
    setLoadedArchive((prev) => {
      if (prev && prev !== newArchive) {
        disposeLoadedTPack(prev);
      }
      return newArchive;
    });
    setMode('viewer');
  }, []);

  const loadDemoCase = useCallback(async () => {
    setIsGeneratingDemo(true);
    setErrorMsg(null);
    try {
      const demoArchive = await generateDemoTPackArchive();
      handleLoadNewArchive(demoArchive);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Erreur lors de la génération du fantôme .tpack en RAM.'
      );
    } finally {
      setIsGeneratingDemo(false);
    }
  }, [handleLoadNewArchive]);

  // Initialisation : charge ?caseUrl=... si fourni, sinon le fantôme de démo
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (initialCaseUrl) {
        setIsGeneratingDemo(true);
        try {
          const res = await fetch(initialCaseUrl);
          if (!res.ok) throw new Error(`Impossible de charger ${initialCaseUrl}`);
          const buf = await res.arrayBuffer();
          const loaded = await loadTPackFromBuffer(buf, true);
          if (!cancelled) {
            handleLoadNewArchive(loaded);
          }
          return;
        } catch {
          // Fallback sur le cas de démo si l'URL externe échoue
        } finally {
          if (!cancelled) setIsGeneratingDemo(false);
        }
      }
      if (!cancelled) {
        await loadDemoCase();
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [initialCaseUrl, loadDemoCase, handleLoadNewArchive]);

  // Pont API postMessage pour le Mode Embed (permet au site de Cas Cliniques d'envoyer un buffer .tpack ou une URL)
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      try {
        if (data.type === 'TPACK_LOAD_BUFFER' && data.buffer) {
          setIsGeneratingDemo(true);
          const loaded = await loadTPackFromBuffer(data.buffer, true);
          handleLoadNewArchive(loaded);
          setIsGeneratingDemo(false);
        } else if (data.type === 'TPACK_LOAD_URL' && typeof data.url === 'string') {
          setIsGeneratingDemo(true);
          const res = await fetch(data.url);
          const buf = await res.arrayBuffer();
          const loaded = await loadTPackFromBuffer(buf, true);
          handleLoadNewArchive(loaded);
          setIsGeneratingDemo(false);
        } else if (data.type === 'TPACK_LOAD_DEMO') {
          await loadDemoCase();
        }
      } catch (err) {
        setIsGeneratingDemo(false);
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
  }, [handleLoadNewArchive, loadDemoCase]);

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

  // Mode Embed plein écran (?embed=1) : uniquement le lecteur .tpack (utilisé par le site de Cas Pédagogiques)
  if (isEmbedMode) {
    return (
      <div className="h-[100dvh] w-screen bg-[#090D16] text-slate-100 overflow-hidden select-none">
        {isGeneratingDemo || !loadedArchive ? (
          <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-[#090D16] p-6 text-center">
            <div className="w-10 h-10 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 animate-pulse">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="text-xs font-semibold text-slate-200">
              Chargement du lecteur <code className="text-cyan-400">.tpack</code> 60 fps...
            </div>
          </div>
        ) : (
          <TPackViewer
            archive={loadedArchive}
            onLoadNewArchive={handleLoadNewArchive}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-screen flex flex-col bg-[#090D16] text-slate-100 overflow-hidden select-none">
      {/* BARRE DE NAVIGATION PRINCIPALE (Console PACS Dark Mode #090D16) */}
      <header className="h-11 sm:h-12 shrink-0 bg-[#090D16] border-b border-slate-800/90 px-2.5 sm:px-5 flex items-center justify-between gap-2 z-30">
        {/* Identité Visuelle */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center text-cyan-400 shrink-0">
            <Activity className="w-4 h-4" />
          </div>
          <div className="truncate">
            <div className="flex items-center gap-2">
              <span className="font-bold text-xs sm:text-sm tracking-tight text-white">
                TPack<span className="text-cyan-400">.pacs</span>
              </span>
              <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-medium text-emerald-300">
                <ShieldCheck className="w-3 h-3" />
                Zéro-Serveur • WebP 8-bit
              </span>
            </div>
          </div>
        </div>

        {/* Sélecteur des 3 Modes : Lecteur / Bibliothèque / Studio DICOM */}
        <div className="flex items-center bg-slate-900/90 p-0.5 sm:p-1 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setMode('viewer')}
            className={`px-2 sm:px-3 py-1 rounded-lg text-[11px] sm:text-xs font-semibold flex items-center gap-1 sm:gap-1.5 transition cursor-pointer ${
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
            className={`px-2 sm:px-3 py-1 rounded-lg text-[11px] sm:text-xs font-semibold flex items-center gap-1 sm:gap-1.5 transition cursor-pointer ${
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
            className={`px-2 sm:px-3 py-1 rounded-lg text-[11px] sm:text-xs font-semibold flex items-center gap-1 sm:gap-1.5 transition cursor-pointer ${
              mode === 'studio'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Studio</span>
          </button>
        </div>

        {/* Bouton de rechargement rapide du Fantôme de Démo */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={loadDemoCase}
            className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 hover:text-cyan-300 flex items-center gap-1.5 transition cursor-pointer"
            title="Recharger le fantôme médical procédural en mémoire vive"
          >
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden lg:inline">Cas Démo RAM</span>
          </button>
        </div>
      </header>

      {/* CORPS DE L'APPLICATION */}
      <main className="flex-1 w-full relative overflow-hidden">
        {errorMsg && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-red-950/90 border border-red-500/50 text-xs text-red-200 shadow-xl">
            {errorMsg}
          </div>
        )}

        {mode === 'viewer' ? (
          isGeneratingDemo || !loadedArchive ? (
            <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-[#090D16] p-6 text-center">
              <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 animate-pulse">
                <Sparkles className="w-6 h-6" />
              </div>
              <div className="text-sm font-semibold text-slate-200">
                Synthèse en RAM du Fantôme Médical <code className="text-cyan-400">.tpack</code>...
              </div>
              <div className="text-xs text-slate-400 max-w-sm">
                Génération des coupes TDM Double-Fenêtre (Os / Parties Molles), IRM T2, calibration{' '}
                <code>0.5 mm/px</code> et décodage en <code>ImageBitmap</code> 60 fps.
              </div>
            </div>
          ) : (
            <TPackViewer
              archive={loadedArchive}
              onLoadNewArchive={handleLoadNewArchive}
            />
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
