import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  BookOpen,
  Play,
  Trash2,
  Upload,
  Download,
  Code2,
  Database,
  Globe,
  Check,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import {
  StoredPedagogicalCase,
  listCasesFromIndexedDB,
  deleteCaseFromIndexedDB,
  saveCaseToIndexedDB,
  fetchPublicCatalogCases,
} from '../core/caseLibraryDb';
import { LoadedTPackArchive, loadTPackFromBuffer } from '../core/tpackLoader';
import { generateDemoTPackArchive } from '../core/demoCaseGenerator';

interface CaseLibraryViewProps {
  onOpenArchive: (archive: LoadedTPackArchive) => void;
  refreshTrigger?: number;
}

export const CaseLibraryView: React.FC<CaseLibraryViewProps> = ({
  onOpenArchive,
  refreshTrigger = 0,
}) => {
  const [localCases, setLocalCases] = useState<StoredPedagogicalCase[]>([]);
  const [publicCases, setPublicCases] = useState<StoredPedagogicalCase[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshAll = useCallback(async () => {
    const [loc, pub] = await Promise.all([
      listCasesFromIndexedDB(),
      fetchPublicCatalogCases(),
    ]);
    setLocalCases(loc);
    setPublicCases(pub);
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll, refreshTrigger]);

  const handleImportTpackFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const buffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        const loaded = await loadTPackFromBuffer(uint8, true);
        const item: StoredPedagogicalCase = {
          id: loaded.manifest.caseId || `CAS-${Date.now()}`,
          title: loaded.manifest.title || file.name.replace(/\.tpack$/i, ''),
          modality: loaded.manifest.modality,
          anatomicalRegion: loaded.manifest.anatomicalRegion || 'Général',
          clinicalHistory: loaded.manifest.clinicalHistory || '',
          createdAt: new Date().toISOString(),
          byteSize: uint8.byteLength,
          source: 'indexeddb',
          tpackBytes: uint8,
          manifest: loaded.manifest,
        };
        await saveCaseToIndexedDB(item);
      } catch {
        // Ignorer les fichiers invalides
      }
    }
    await refreshAll();
  };

  const handleOpenCase = async (c: StoredPedagogicalCase) => {
    setLoadingId(c.id);
    try {
      if (c.tpackBytes) {
        const loaded = await loadTPackFromBuffer(c.tpackBytes, true);
        onOpenArchive(loaded);
      } else if (c.tpackUrl) {
        const res = await fetch(c.tpackUrl);
        const buf = await res.arrayBuffer();
        const loaded = await loadTPackFromBuffer(buf, true);
        onOpenArchive(loaded);
      } else {
        const demo = await generateDemoTPackArchive();
        onOpenArchive(demo);
      }
    } finally {
      setLoadingId(null);
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

  const handleCopyEmbedCode = (c: StoredPedagogicalCase) => {
    const baseViewerUrl = 'https://mrthomaslef.github.io/dicomviewer/';
    const caseParam = c.tpackUrl
      ? `&caseUrl=${encodeURIComponent(c.tpackUrl)}`
      : `&caseUrl=${encodeURIComponent(`./cases/${c.id.toLowerCase()}.tpack`)}`;
    const snippet = `<iframe src="${baseViewerUrl}?embed=1${caseParam}" width="100%" height="640" style="border:0;border-radius:12px;" allow="fullscreen" loading="lazy"></iframe>`;
    navigator.clipboard?.writeText(snippet);
    setCopiedId(c.id);
    setTimeout(() => setCopiedId(null), 2200);
  };

  const handleDeleteLocal = async (id: string) => {
    await deleteCaseFromIndexedDB(id);
    await refreshAll();
  };

  const allCases = [
    ...localCases,
    ...publicCases.filter((p) => !localCases.some((l) => l.id === p.id)),
  ];

  return (
    <div className="h-full w-full overflow-y-auto bg-[#090D16] p-4 sm:p-6 text-slate-100">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* En-tête de la Bibliothèque Hybride */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 sm:p-5 rounded-2xl bg-[#0B101B] border border-slate-800">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-cyan-400 text-xs font-bold uppercase tracking-wider">
              <BookOpen className="w-4 h-4" />
              <span>Bibliothèque Hybride .tpack (IndexedDB + GitHub Pages)</span>
            </div>
            <h1 className="text-base sm:text-lg font-bold text-white">
              Stockage de Cas Pédagogiques &amp; Lecteur Partagé
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Importez ou enregistrez vos examens <code className="text-cyan-300">.tpack</code> depuis le Studio.
              Chaque cas peut être ouvert à 60 fps ici ou intégré sur le portail dédié de Cas Cliniques via le mode{' '}
              <code className="text-emerald-300">?embed=1</code>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".tpack,.zip"
              className="hidden"
              onChange={(e) => e.target.files && handleImportTpackFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              Importer un fichier .tpack
            </button>
            <a
              href="https://mrthomaslef.github.io/tpack-cases/"
              target="_blank"
              rel="noreferrer"
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center gap-1.5 transition"
            >
              <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
              Site de Cas Cliniques
            </a>
          </div>
        </div>

        {/* Grille des Cas Pédagogiques */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {allCases.map((c) => (
            <div
              key={`${c.source}_${c.id}`}
              className="rounded-2xl bg-[#0B101B] border border-slate-800 hover:border-cyan-500/40 p-4 flex flex-col justify-between gap-4 transition shadow-lg"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-xs">
                      {c.modality}
                    </span>
                    <span className="text-xs text-slate-400 font-mono">{c.id}</span>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold flex items-center gap-1 ${
                      c.source === 'indexeddb'
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                    }`}
                  >
                    {c.source === 'indexeddb' ? (
                      <>
                        <Database className="w-3 h-3" /> Stocké dans IndexedDB
                      </>
                    ) : (
                      <>
                        <Globe className="w-3 h-3" /> Catalogue Public
                      </>
                    )}
                  </span>
                </div>

                <h3 className="text-sm font-semibold text-white">{c.title}</h3>
                <div className="text-xs text-cyan-300/90">
                  Région : {c.anatomicalRegion} • {(c.byteSize / 1024).toFixed(0)} Ko
                </div>
                {c.clinicalHistory && (
                  <p className="text-xs text-slate-400 line-clamp-2">{c.clinicalHistory}</p>
                )}
              </div>

              <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={loadingId === c.id}
                  onClick={() => handleOpenCase(c)}
                  className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs flex items-center gap-1.5 transition cursor-pointer"
                >
                  {loadingId === c.id ? (
                    <Sparkles className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  )}
                  Ouvrir dans le Lecteur
                </button>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCopyEmbedCode(c)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-slate-300 flex items-center gap-1 transition cursor-pointer"
                    title="Copier le code <iframe> pour intégrer ce cas avec le lecteur auto-actualisé"
                  >
                    {copiedId === c.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-300">Copié</span>
                      </>
                    ) : (
                      <>
                        <Code2 className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Iframe</span>
                      </>
                    )}
                  </button>

                  {c.tpackBytes && (
                    <button
                      type="button"
                      onClick={() => handleDownloadCase(c)}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-cyan-300 transition cursor-pointer"
                      title="Télécharger le fichier .tpack pour le déposer dans public/cases/"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {c.source === 'indexeddb' && (
                    <button
                      type="button"
                      onClick={() => handleDeleteLocal(c.id)}
                      className="p-1.5 rounded-lg bg-slate-900 hover:bg-red-950/60 border border-slate-800 hover:border-red-500/40 text-slate-400 hover:text-red-300 transition cursor-pointer"
                      title="Supprimer de IndexedDB"
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
    </div>
  );
};
