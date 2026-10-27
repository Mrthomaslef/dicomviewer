import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Eye,
  Cpu,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { LoadedTPackArchive, disposeLoadedTPack } from './core/tpackLoader';
import { generateDemoTPackArchive } from './core/demoCaseGenerator';
import { TPackViewer } from './components/TPackViewer';
import { CompressionStudio } from './components/CompressionStudio';

type AppMode = 'viewer' | 'studio';

export const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('viewer');
  const [loadedArchive, setLoadedArchive] = useState<LoadedTPackArchive | null>(null);
  const [isGeneratingDemo, setIsGeneratingDemo] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadDemoCase = useCallback(async () => {
    setIsGeneratingDemo(true);
    setErrorMsg(null);
    try {
      const demoArchive = await generateDemoTPackArchive();
      setLoadedArchive((prev) => {
        if (prev) disposeLoadedTPack(prev);
        return demoArchive;
      });
      setMode('viewer');
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Erreur lors de la génération du fantôme .tpack en RAM.'
      );
    } finally {
      setIsGeneratingDemo(false);
    }
  }, []);

  useEffect(() => {
    loadDemoCase();
  }, [loadDemoCase]);

  const handleLoadNewArchive = useCallback((newArchive: LoadedTPackArchive) => {
    setLoadedArchive((prev) => {
      if (prev && prev !== newArchive) {
        disposeLoadedTPack(prev);
      }
      return newArchive;
    });
    setMode('viewer');
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#090D16] text-slate-100 overflow-hidden select-none">
      {/* BARRE DE NAVIGATION PRINCIPALE (Console PACS Dark Mode #090D16) */}
      <header className="h-12 shrink-0 bg-[#090D16] border-b border-slate-800/90 px-3 sm:px-5 flex items-center justify-between gap-2 z-30">
        {/* Identité Visuelle */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center text-cyan-400 shrink-0">
            <Activity className="w-4 h-4" />
          </div>
          <div className="truncate">
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-tight text-white">
                TPack<span className="text-cyan-400">.pacs</span>
              </span>
              <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-medium text-emerald-300">
                <ShieldCheck className="w-3 h-3" />
                Zéro-Serveur • WebP 8-bit
              </span>
            </div>
          </div>
        </div>

        {/* Sélecteur des 2 Modes Principaux : Lecteur Pédagogique vs Studio de Compression */}
        <div className="flex items-center bg-slate-900/90 p-1 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setMode('viewer')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              mode === 'viewer'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Lecteur .tpack</span>
          </button>

          <button
            type="button"
            onClick={() => setMode('studio')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              mode === 'studio'
                ? 'bg-cyan-500 text-slate-950 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Studio DICOM → .tpack</span>
          </button>
        </div>

        {/* Bouton de rechargement rapide du Fantôme de Démo */}
        <div className="hidden sm:flex items-center gap-2">
          <button
            type="button"
            onClick={loadDemoCase}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 hover:text-cyan-300 flex items-center gap-1.5 transition cursor-pointer"
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
        ) : (
          <CompressionStudio onOpenGeneratedTPack={handleLoadNewArchive} />
        )}
      </main>
    </div>
  );
};

export default App;
