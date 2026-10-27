import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Upload,
  FolderOpen,
  Scissors,
  ShieldAlert,
  MousePointer,
  ArrowUpRight,
  Circle as CircleIcon,
  Download,
  Play,
  Layers,
  Trash2,
  Sparkles,
  CheckCircle2,
  Sliders,
  Info,
  FileArchive,
} from 'lucide-react';
import {
  AnnotationItem,
  BurnedInMaskRect,
} from '../types/manifest';
import {
  parseDicomFiles,
  ParsedDicomSeries,
} from '../core/dicomReader';
import {
  applyWindowLut8Bit,
  buildTPackArchive,
  computeTargetGeometry,
  estimateTPackSizeBytes,
  StudioSeriesBuildOptions,
} from '../core/tpackBuilder';
import { generateSyntheticDicomFiles } from '../core/demoCaseGenerator';
import { LoadedTPackArchive, loadTPackFromBuffer } from '../core/tpackLoader';

interface CompressionStudioProps {
  onOpenGeneratedTPack: (archive: LoadedTPackArchive) => void;
}

type StudioCanvasTool = 'none' | 'mask' | 'arrow' | 'circle';

export const CompressionStudio: React.FC<CompressionStudioProps> = ({
  onOpenGeneratedTPack,
}) => {
  const [parsedSeriesList, setParsedSeriesList] = useState<ParsedDicomSeries[]>([]);
  const [activeSeriesIdx, setActiveSeriesIdx] = useState<number>(0);
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [parseProgress, setParseProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });

  // Métadonnées du cas clinique
  const [caseId, setCaseId] = useState<string>('CAS-PEDAGO-01');
  const [caseTitle, setCaseTitle] = useState<string>('Cas Clinique Radiologique');
  const [anatomicalRegion, setAnatomicalRegion] = useState<string>('Thorax / Abdomen');
  const [clinicalHistory, setClinicalHistory] = useState<string>(
    'Examen anonymisé et compressé via TPack Studio (encodage WebP 8 bits pré-fenêtré).'
  );

  // Options de compression par série
  const [seriesOptionsMap, setSeriesOptionsMap] = useState<Record<string, StudioSeriesBuildOptions>>({});

  // Coupe actuellement prévisualisée dans la série active (indice dans la série originale)
  const [previewSliceIdx, setPreviewSliceIdx] = useState<number>(0);
  // Fenêtre de prévisualisation dans le studio ('soft' | 'bone' | 'custom')
  const [studioPreviewWindow, setStudioPreviewWindow] = useState<'soft' | 'bone' | 'custom'>('soft');

  // Outil de dessin actif sur le Canvas du Studio
  const [activeTool, setActiveTool] = useState<StudioCanvasTool>('none');
  const [pendingLabel, setPendingLabel] = useState<string>('Lésion clé');
  const [dragStartNorm, setDragStartNorm] = useState<[number, number] | null>(null);
  const [dragCurrentNorm, setDragCurrentNorm] = useState<[number, number] | null>(null);
  const [studioZoom, setStudioZoom] = useState<number>(1);

  // État d'export .tpack
  const [isBuilding, setIsBuilding] = useState<boolean>(false);
  const [buildProgress, setBuildProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });
  const [lastBuiltBytes, setLastBuiltBytes] = useState<Uint8Array | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const studioViewportRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const studioTouchLastYRef = useRef<number | null>(null);
  const studioTouchAccRef = useRef<number>(0);

  const activeSeries: ParsedDicomSeries | undefined = parsedSeriesList[activeSeriesIdx];
  const activeOptions: StudioSeriesBuildOptions | undefined = activeSeries
    ? seriesOptionsMap[activeSeries.seriesInstanceUID]
    : undefined;

  const initSeriesOptions = useCallback((seriesList: ParsedDicomSeries[]) => {
    const map: Record<string, StudioSeriesBuildOptions> = {};
    seriesList.forEach((s, idx) => {
      const cleanId = `s${idx + 1}_${s.modality.toLowerCase()}_${s.description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 18) || 'serie'}`;

      map[s.seriesInstanceUID] = {
        series: s,
        seriesId: cleanId,
        description: s.description,
        startIndex: 0,
        endIndex: Math.max(0, s.slices.length - 1),
        step: 1,
        capMatrix512: true,
        doublePackCt: s.modality === 'CT',
        customWindowCenter: s.defaultWindowCenter,
        customWindowWidth: s.defaultWindowWidth,
        masks: [],
        annotationsByOriginalSlice: {},
      };
    });
    setSeriesOptionsMap(map);
    setActiveSeriesIdx(0);
    if (seriesList.length > 0) {
      setPreviewSliceIdx(Math.floor(seriesList[0].slices.length / 2));
      setStudioPreviewWindow(seriesList[0].modality === 'CT' ? 'soft' : 'custom');
    }
    setLastBuiltBytes(null);
  }, []);

  const handleFilesSelected = async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(
      (f) => !f.name.startsWith('.') && f.size > 132
    );
    if (fileArray.length === 0) return;

    setIsParsing(true);
    setParseProgress({ current: 0, total: fileArray.length });

    try {
      const series = await parseDicomFiles(fileArray, (cur, tot) => {
        setParseProgress({ current: cur, total: tot });
      });
      if (series.length > 0) {
        setParsedSeriesList(series);
        initSeriesOptions(series);
      }
    } finally {
      setIsParsing(false);
    }
  };

  const handleLoadSyntheticDicomFolder = async () => {
    setIsParsing(true);
    const synthFiles = generateSyntheticDicomFiles(32);
    setParseProgress({ current: 0, total: synthFiles.length });
    try {
      const series = await parseDicomFiles(synthFiles, (cur, tot) => {
        setParseProgress({ current: cur, total: tot });
      });
      if (series.length > 0) {
        setParsedSeriesList(series);
        initSeriesOptions(series);
        setCaseTitle('TDM Fantôme 16-bit (avec Bandeau PHI à anonymiser)');
      }
    } finally {
      setIsParsing(false);
    }
  };

  const updateActiveOption = (
    updater: (prev: StudioSeriesBuildOptions) => StudioSeriesBuildOptions
  ) => {
    if (!activeSeries) return;
    const uid = activeSeries.seriesInstanceUID;
    setSeriesOptionsMap((prev) => {
      const current = prev[uid];
      if (!current) return prev;
      return {
        ...prev,
        [uid]: updater(current),
      };
    });
    setLastBuiltBytes(null);
  };

  // Calcul en temps réel de l'estimation de taille et du gain de compression
  const sizeEstimation = useMemo(() => {
    const opts = Object.values(seriesOptionsMap);
    if (opts.length === 0) {
      return {
        rawTotalBytes: 0,
        estimatedTpackBytes: 0,
        reductionPercentage: 96.5,
        retainedSliceCount: 0,
        totalEncodedFrames: 0,
      };
    }
    return estimateTPackSizeBytes(opts);
  }, [seriesOptionsMap]);

  // Géométrie recalculée de la série active
  const targetGeometry = useMemo(() => {
    if (!activeSeries || !activeOptions) return null;
    return computeTargetGeometry(
      activeSeries.width,
      activeSeries.height,
      activeSeries.pixelSpacing,
      activeOptions.capMatrix512
    );
  }, [activeSeries, activeOptions]);

  // Rendu de la coupe active dans le Canvas de prévisualisation du Studio
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSeries || !activeOptions) return;

    const safeIdx = Math.max(0, Math.min(previewSliceIdx, activeSeries.slices.length - 1));
    const slice = activeSeries.slices[safeIdx];
    if (!slice) return;

    const { width, height } = activeSeries;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let wl = activeOptions.customWindowCenter;
    let ww = activeOptions.customWindowWidth;
    if (activeSeries.modality === 'CT' && activeOptions.doublePackCt) {
      if (studioPreviewWindow === 'bone') {
        wl = 400;
        ww = 1800;
      } else if (studioPreviewWindow === 'soft') {
        wl = 50;
        ww = 350;
      }
    }

    const imgData = ctx.createImageData(width, height);
    applyWindowLut8Bit(slice.physicalPixels, width, height, wl, ww, imgData);
    ctx.putImageData(imgData, 0, 0);

    // 1. Dessin des rectangles noirs d'anonymisation (Burned-in PHI)
    for (const mask of activeOptions.masks) {
      const rx = mask.x * width;
      const ry = mask.y * height;
      const rw = mask.width * width;
      const rh = mask.height * height;

      ctx.fillStyle = '#000000';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }

    // 2. Dessin des annotations pédagogiques de la coupe courante
    const annotations = activeOptions.annotationsByOriginalSlice[safeIdx] || [];
    for (const ann of annotations) {
      drawStudioAnnotation(ctx, ann, width, height);
    }

    // 3. Dessin de la forme en cours de tracé à la souris
    if (dragStartNorm && dragCurrentNorm && activeTool !== 'none') {
      const [x1, y1] = dragStartNorm;
      const [x2, y2] = dragCurrentNorm;
      if (activeTool === 'mask') {
        const rx = Math.min(x1, x2) * width;
        const ry = Math.min(y1, y2) * height;
        const rw = Math.abs(x2 - x1) * width;
        const rh = Math.abs(y2 - y1) * height;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#EF4444';
        ctx.lineWidth = 2;
        ctx.strokeRect(rx, ry, rw, rh);
      } else if (activeTool === 'arrow') {
        drawStudioAnnotation(
          ctx,
          {
            id: 'preview',
            type: 'arrow',
            points: [dragStartNorm, dragCurrentNorm],
            label: pendingLabel,
          },
          width,
          height
        );
      } else if (activeTool === 'circle') {
        drawStudioAnnotation(
          ctx,
          {
            id: 'preview',
            type: 'circle',
            points: [dragStartNorm, dragCurrentNorm],
            label: pendingLabel,
          },
          width,
          height
        );
      }
    }
  }, [
    activeSeries,
    activeOptions,
    previewSliceIdx,
    studioPreviewWindow,
    dragStartNorm,
    dragCurrentNorm,
    activeTool,
    pendingLabel,
  ]);

  function drawStudioAnnotation(
    ctx: CanvasRenderingContext2D,
    ann: AnnotationItem,
    width: number,
    height: number
  ) {
    if (ann.points.length < 2) return;
    const [p1, p2] = ann.points;
    const x1 = p1[0] * width;
    const y1 = p1[1] * height;
    const x2 = p2[0] * width;
    const y2 = p2[1] * height;

    ctx.save();
    ctx.strokeStyle = '#22D3EE';
    ctx.fillStyle = '#22D3EE';
    ctx.lineWidth = 2.2;

    if (ann.type === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = 10;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - headLen * Math.cos(angle - Math.PI / 6),
        y2 - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        x2 - headLen * Math.cos(angle + Math.PI / 6),
        y2 - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    } else if (ann.type === 'circle') {
      const r = Math.hypot(x2 - x1, y2 - y1);
      ctx.beginPath();
      ctx.arc(x1, y1, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (ann.label) {
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const textWidth = ctx.measureText(ann.label).width;
      const lx = Math.max(6, Math.min(width - textWidth - 14, x1 - textWidth / 2));
      const ly = Math.max(18, y1 - 10);
      ctx.fillStyle = 'rgba(9, 13, 22, 0.88)';
      ctx.fillRect(lx - 4, ly - 12, textWidth + 8, 16);
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lx - 4, ly - 12, textWidth + 8, 16);
      ctx.fillStyle = '#67E8F9';
      ctx.fillText(ann.label, lx, ly);
    }
    ctx.restore();
  }

  const getNormalizedCanvasCoords = (
    e: React.PointerEvent<HTMLCanvasElement>
  ): [number, number] => {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return [Number(nx.toFixed(4)), Number(ny.toFixed(4))];
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (activeTool === 'none') {
      studioTouchLastYRef.current = e.clientY;
      studioTouchAccRef.current = 0;
      return;
    }
    const coords = getNormalizedCanvasCoords(e);
    setDragStartNorm(coords);
    setDragCurrentNorm(coords);
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'none') {
      if (studioTouchLastYRef.current !== null && activeSeries) {
        const dy = e.clientY - studioTouchLastYRef.current;
        studioTouchLastYRef.current = e.clientY;
        studioTouchAccRef.current += dy;
        const STEP_PX = 12;
        if (Math.abs(studioTouchAccRef.current) >= STEP_PX) {
          const delta = Math.trunc(studioTouchAccRef.current / STEP_PX);
          studioTouchAccRef.current -= delta * STEP_PX;
          setPreviewSliceIdx((prev) =>
            Math.max(0, Math.min(activeSeries.slices.length - 1, prev + delta))
          );
        }
      }
      return;
    }
    if (!dragStartNorm) return;
    setDragCurrentNorm(getNormalizedCanvasCoords(e));
  };

  const handleCanvasPointerUp = () => {
    studioTouchLastYRef.current = null;
    studioTouchAccRef.current = 0;
    if (!dragStartNorm || !dragCurrentNorm || !activeOptions) {
      setDragStartNorm(null);
      setDragCurrentNorm(null);
      return;
    }

    const [x1, y1] = dragStartNorm;
    const [x2, y2] = dragCurrentNorm;
    const dist = Math.hypot(x2 - x1, y2 - y1);

    if (dist > 0.015) {
      if (activeTool === 'mask') {
        const newMask: BurnedInMaskRect = {
          id: `mask_${Date.now()}`,
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        };
        updateActiveOption((prev) => ({
          ...prev,
          masks: [...prev.masks, newMask],
        }));
      } else if (activeTool === 'arrow' || activeTool === 'circle') {
        const newAnn: AnnotationItem = {
          id: `ann_${Date.now()}`,
          type: activeTool,
          points: [
            [x1, y1],
            [x2, y2],
          ],
          label: pendingLabel.trim() || undefined,
        };
        updateActiveOption((prev) => {
          const existing = prev.annotationsByOriginalSlice[previewSliceIdx] || [];
          return {
            ...prev,
            annotationsByOriginalSlice: {
              ...prev.annotationsByOriginalSlice,
              [previewSliceIdx]: [...existing, newAnn],
            },
          };
        });
      }
    }

    setDragStartNorm(null);
    setDragCurrentNorm(null);
  };

  const handleBuildAndAction = async (mode: 'download' | 'open_viewer') => {
    const seriesOptions = Object.values(seriesOptionsMap);
    if (seriesOptions.length === 0) return;

    setIsBuilding(true);
    setBuildProgress({ current: 0, total: sizeEstimation.totalEncodedFrames });

    try {
      const archiveBytes = await buildTPackArchive(
        {
          caseId: caseId.trim() || 'CAS-01',
          title: caseTitle.trim() || 'Cas Clinique Pédagogique',
          modality: seriesOptions[0].series.modality,
          anatomicalRegion: anatomicalRegion.trim() || undefined,
          clinicalHistory: clinicalHistory.trim() || undefined,
          seriesOptions,
        },
        (cur, tot) => {
          setBuildProgress({ current: cur, total: tot });
        }
      );

      setLastBuiltBytes(archiveBytes);

      if (mode === 'download') {
        const blob = new Blob([archiveBytes.buffer.slice(archiveBytes.byteOffset, archiveBytes.byteOffset + archiveBytes.byteLength) as ArrayBuffer], {
          type: 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeFileName =
          (caseId || 'cas-clinique').toLowerCase().replace(/[^a-z0-9-_]+/g, '-') + '.tpack';
        a.href = url;
        a.download = safeFileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const loaded = await loadTPackFromBuffer(archiveBytes, true);
        onOpenGeneratedTPack(loaded);
      }
    } finally {
      setIsBuilding(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Ko';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(2)} Mo`;
    return `${(bytes / 1024).toFixed(0)} Ko`;
  };

  const currentSliceObj =
    activeSeries && activeSeries.slices[previewSliceIdx]
      ? activeSeries.slices[previewSliceIdx]
      : null;

  const isSliceInRetainedSet = useMemo(() => {
    if (!activeOptions) return true;
    if (previewSliceIdx < activeOptions.startIndex || previewSliceIdx > activeOptions.endIndex) {
      return false;
    }
    return (previewSliceIdx - activeOptions.startIndex) % activeOptions.step === 0;
  }, [activeOptions, previewSliceIdx]);

  // Pincement Trackpad dans le Studio : zoom sur l'image prévisualisée, jamais sur la page entière
  useEffect(() => {
    const vp = studioViewportRef.current;
    if (!vp) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.012);
        setStudioZoom((z) => Math.max(0.5, Math.min(6, z * factor)));
        return;
      }
      if (!activeSeries) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      setPreviewSliceIdx((prev) =>
        Math.max(0, Math.min(activeSeries.slices.length - 1, prev + dir))
      );
    };
    vp.addEventListener('wheel', handleWheel, { passive: false });
    return () => vp.removeEventListener('wheel', handleWheel);
  }, [activeSeries]);

  return (
    <div className="h-full w-full flex flex-col lg:flex-row bg-[#090D16] text-slate-100 overflow-y-auto lg:overflow-hidden">
      {/* Inputs cachés pour import de fichiers ou de dossier complet */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".dcm,application/dicom,*/*"
        className="hidden"
        onChange={(e) => e.target.files && handleFilesSelected(e.target.files)}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory est supporté par tous les navigateurs modernes
        webkitdirectory="true"
        className="hidden"
        onChange={(e) => e.target.files && handleFilesSelected(e.target.files)}
      />

      {/* COLONNE GAUCHE : Import DICOM, Tri Spatial & Paramètres longitudinaux/matriciels */}
      <div className="w-full lg:w-96 border-b lg:border-b-0 lg:border-r border-slate-800/80 bg-[#0B101B] p-4 flex flex-col gap-4 lg:overflow-y-auto shrink-0">
        {/* Zone Drag & Drop DICOM */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files) {
              handleFilesSelected(e.dataTransfer.files);
            }
          }}
          className="border-2 border-dashed border-cyan-500/40 hover:border-cyan-400/80 rounded-xl p-4 bg-slate-900/60 transition-colors flex flex-col items-center text-center gap-2.5"
        >
          <div className="w-10 h-10 rounded-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <Upload className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-100">
              Glissez-déposez vos fichiers <code className="text-cyan-300">.dcm</code>
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              Lecture binaire 100% locale (Zéro-Serveur) & Tri spatial vectoriel
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 w-full mt-1">
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="flex-1 min-w-[120px] py-1.5 px-3 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 text-xs font-medium flex items-center justify-center gap-1.5 transition"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Dossier DICOM
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 min-w-[120px] py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5 transition"
            >
              <Upload className="w-3.5 h-3.5" />
              Fichiers .dcm
            </button>
          </div>
          <button
            type="button"
            onClick={handleLoadSyntheticDicomFolder}
            className="w-full py-1.5 px-3 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-medium flex items-center justify-center gap-1.5 transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Générer 32 coupes DICOM 16-bit de test (avec PHI)
          </button>
        </div>

        {isParsing && (
          <div className="p-3 rounded-lg bg-cyan-950/40 border border-cyan-500/30 text-xs text-cyan-200">
            <div className="flex justify-between mb-1">
              <span>Analyse & Tri géométrique (IPP × IOP)...</span>
              <span>
                {parseProgress.current} / {parseProgress.total}
              </span>
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-400 transition-all"
                style={{
                  width: `${Math.round(
                    (parseProgress.current / Math.max(1, parseProgress.total)) * 100
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Métadonnées du Manifest Pédagogique */}
        <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
            <Info className="w-3.5 h-3.5" />
            <span>Métadonnées Pédagogiques (Whitelist)</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-slate-400 block mb-0.5">Identifiant Cas</label>
              <input
                type="text"
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-400 block mb-0.5">Région Anatomique</label>
              <input
                type="text"
                value={anatomicalRegion}
                onChange={(e) => setAnatomicalRegion(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-slate-400 block mb-0.5">Titre du Cas</label>
            <input
              type="text"
              value={caseTitle}
              onChange={(e) => setCaseTitle(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[11px] text-slate-400 block mb-0.5">Contexte Clinique</label>
            <textarea
              rows={2}
              value={clinicalHistory}
              onChange={(e) => setClinicalHistory(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none resize-none"
            />
          </div>
        </div>

        {/* Réglages de Coupe (Crop Z, Décimation, Redimensionnement 512px) */}
        {activeSeries && activeOptions && targetGeometry && (
          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
                <Scissors className="w-3.5 h-3.5" />
                <span>Optimisation Longitudinale & Matrice</span>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-mono">
                {activeSeries.modality}
              </span>
            </div>

            {parsedSeriesList.length > 1 && (
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Série Active</label>
                <select
                  value={activeSeriesIdx}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setActiveSeriesIdx(idx);
                    setPreviewSliceIdx(0);
                  }}
                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 text-xs text-slate-100"
                >
                  {parsedSeriesList.map((s, i) => (
                    <option key={s.seriesInstanceUID} value={i}>
                      {s.description} ({s.slices.length} coupes)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Plage de coupes Start / End */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-slate-400 flex justify-between mb-1">
                  <span>Coupe début</span>
                  <span className="text-cyan-300 font-mono">#{activeOptions.startIndex + 1}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, activeSeries.slices.length - 1)}
                  value={activeOptions.startIndex}
                  onChange={(e) => {
                    const val = Math.min(Number(e.target.value), activeOptions.endIndex);
                    updateActiveOption((prev) => ({ ...prev, startIndex: val }));
                    setPreviewSliceIdx(val);
                  }}
                  className="w-full accent-cyan-400"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-400 flex justify-between mb-1">
                  <span>Coupe fin</span>
                  <span className="text-cyan-300 font-mono">#{activeOptions.endIndex + 1}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, activeSeries.slices.length - 1)}
                  value={activeOptions.endIndex}
                  onChange={(e) => {
                    const val = Math.max(Number(e.target.value), activeOptions.startIndex);
                    updateActiveOption((prev) => ({ ...prev, endIndex: val }));
                    setPreviewSliceIdx(val);
                  }}
                  className="w-full accent-cyan-400"
                />
              </div>
            </div>

            {/* Pas de décimation (step = 1, 2, 3, 4) */}
            <div>
              <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                <span>Pas de décimation longitudinale</span>
                <span className="text-emerald-300 font-mono">
                  Épaisseur eff. : {(activeSeries.sliceThickness * activeOptions.step).toFixed(2)} mm
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {([1, 2, 3, 4] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => updateActiveOption((prev) => ({ ...prev, step: st }))}
                    className={`py-1.5 rounded text-xs font-semibold border transition ${
                      activeOptions.step === st
                        ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    1/{st}
                  </button>
                ))}
              </div>
            </div>

            {/* Redimensionnement matriciel 512px max & recalcul exact du PixelSpacing */}
            <div className="pt-1 border-t border-slate-800/80">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-slate-200">Plafonner la matrice à 512×512 px</span>
                <input
                  type="checkbox"
                  checked={activeOptions.capMatrix512}
                  onChange={(e) =>
                    updateActiveOption((prev) => ({ ...prev, capMatrix512: e.target.checked }))
                  }
                  className="accent-cyan-400 w-4 h-4"
                />
              </label>
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400 font-mono bg-slate-950/90 px-2.5 py-1.5 rounded border border-slate-800/80">
                <span>
                  Matrice : {activeSeries.width}×{activeSeries.height} → {targetGeometry.width}×
                  {targetGeometry.height}
                </span>
                <span className="text-cyan-300">
                  Δxy: [{targetGeometry.pixelSpacing[0]}, {targetGeometry.pixelSpacing[1]}] mm
                </span>
              </div>
            </div>

            {/* Stratégie Multi-Fenêtres (Double Pack TDM vs Fenêtre personnalisée) */}
            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
                <Sliders className="w-3.5 h-3.5" />
                <span>Fenêtrage LUT 8 bits</span>
              </div>

              {activeSeries.modality === 'CT' && (
                <label className="flex items-center justify-between p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold text-cyan-200">
                      Mode « Double Pack TDM »
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Génère Os (400/1800) + Parties Molles (50/350)
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={activeOptions.doublePackCt}
                    onChange={(e) =>
                      updateActiveOption((prev) => ({
                        ...prev,
                        doublePackCt: e.target.checked,
                      }))
                    }
                    className="accent-cyan-400 w-4 h-4"
                  />
                </label>
              )}

              {(!activeOptions.doublePackCt || activeSeries.modality !== 'CT') && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-slate-400 flex justify-between">
                      <span>WL (Centre)</span>
                      <span className="font-mono text-cyan-300">
                        {activeOptions.customWindowCenter}
                      </span>
                    </label>
                    <input
                      type="range"
                      min={-1000}
                      max={2000}
                      value={activeOptions.customWindowCenter}
                      onChange={(e) =>
                        updateActiveOption((prev) => ({
                          ...prev,
                          customWindowCenter: Number(e.target.value),
                        }))
                      }
                      className="w-full accent-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-400 flex justify-between">
                      <span>WW (Largeur)</span>
                      <span className="font-mono text-cyan-300">
                        {activeOptions.customWindowWidth}
                      </span>
                    </label>
                    <input
                      type="range"
                      min={1}
                      max={4000}
                      value={activeOptions.customWindowWidth}
                      onChange={(e) =>
                        updateActiveOption((prev) => ({
                          ...prev,
                          customWindowWidth: Number(e.target.value),
                        }))
                      }
                      className="w-full accent-cyan-400"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ZONE CENTRALE : Prévisualisation Canvas interactive, Anonymisation Burned-in PHI & Annotations */}
      <div className="flex-1 flex flex-col bg-[#090D16] min-h-[420px] relative overflow-hidden">
        {!activeSeries || !activeOptions ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-cyan-400 mb-4 shadow-lg">
              <Layers className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-semibold text-slate-100">
              Studio d&apos;Import &amp; Compression DICOM → <code className="text-cyan-400">.tpack</code>
            </h2>
            <p className="text-sm text-slate-400 max-w-md mt-1">
              Glissez un dossier de fichiers <code className="text-slate-200">.dcm</code> à gauche ou
              générez un lot de 32 coupes DICOM 16 bits signées pour tester le tri géométrique, le
              masquage Burned-in PHI et l&apos;encodage WebP 8 bits.
            </p>
            <button
              type="button"
              onClick={handleLoadSyntheticDicomFolder}
              className="mt-5 px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              Charger le lot DICOM 16-bit de démonstration (32 coupes .dcm)
            </button>
          </div>
        ) : (
          <>
            {/* Barre d'outils supérieure du Studio (Outils Masquage PHI & Annotations) */}
            <div className="border-b border-slate-800/80 bg-[#0B101B]/90 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => setActiveTool('none')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
                    activeTool === 'none'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <MousePointer className="w-3.5 h-3.5" />
                  Navigation
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool('mask')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
                    activeTool === 'mask'
                      ? 'bg-red-500/20 border-red-400 text-red-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                  title="Tracer un rectangle noir détruisant définitivement les pixels d'identité patient (Burned-in PHI)"
                >
                  <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                  Masque Noir PHI ({activeOptions.masks.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool('arrow')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
                    activeTool === 'arrow'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5 text-cyan-400" />
                  Annoter Flèche
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTool('circle')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
                    activeTool === 'circle'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <CircleIcon className="w-3.5 h-3.5 text-cyan-400" />
                  Annoter Cercle
                </button>

                {(activeTool === 'arrow' || activeTool === 'circle') && (
                  <input
                    type="text"
                    value={pendingLabel}
                    onChange={(e) => setPendingLabel(e.target.value)}
                    placeholder="Texte de l'annotation..."
                    className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-700 text-xs text-cyan-200 focus:border-cyan-400 focus:outline-none w-44"
                  />
                )}
              </div>

              {/* Bascule de prévisualisation Os / Mou dans le Studio */}
              <div className="flex items-center gap-1.5">
                {activeSeries.modality === 'CT' && activeOptions.doublePackCt && (
                  <div className="flex bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                    <button
                      type="button"
                      onClick={() => setStudioPreviewWindow('soft')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                        studioPreviewWindow === 'soft'
                          ? 'bg-cyan-500 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Parties Molles
                    </button>
                    <button
                      type="button"
                      onClick={() => setStudioPreviewWindow('bone')}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                        studioPreviewWindow === 'bone'
                          ? 'bg-cyan-500 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Os
                    </button>
                  </div>
                )}

                {(activeOptions.masks.length > 0 ||
                  (activeOptions.annotationsByOriginalSlice[previewSliceIdx]?.length ?? 0) > 0) && (
                  <button
                    type="button"
                    onClick={() =>
                      updateActiveOption((prev) => ({
                        ...prev,
                        masks: [],
                        annotationsByOriginalSlice: {
                          ...prev.annotationsByOriginalSlice,
                          [previewSliceIdx]: [],
                        },
                      }))
                    }
                    className="p-1.5 rounded-lg bg-slate-900 hover:bg-red-950/60 border border-slate-800 hover:border-red-500/40 text-slate-400 hover:text-red-300 transition"
                    title="Effacer les masques et annotations de cette coupe"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Canvas de prévisualisation de la coupe DICOM */}
            <div
              ref={studioViewportRef}
              className="flex-1 flex items-center justify-center p-4 relative select-none overflow-hidden"
            >
              <div
                style={{
                  transform: `scale(${studioZoom})`,
                  transformOrigin: 'center center',
                }}
                className="relative flex items-center justify-center max-h-full max-w-full transition-transform duration-75"
              >
                <canvas
                  ref={canvasRef}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={handleCanvasPointerUp}
                  className={`max-h-[54vh] sm:max-h-[62vh] max-w-full object-contain rounded-lg border shadow-2xl touch-none ${
                    activeTool !== 'none' ? 'cursor-crosshair border-cyan-500/60' : 'cursor-ns-resize border-slate-800'
                  }`}
                />
                {!isSliceInRetainedSet && (
                  <div className="absolute top-3 right-3 px-2.5 py-1 rounded bg-amber-500/90 text-slate-950 font-semibold text-[11px] shadow">
                    Coupe exclue (Crop Z / Décimation 1/{activeOptions.step})
                  </div>
                )}
              </div>

              {/* Overlay HUD infos géométriques de la coupe */}
              {currentSliceObj && (
                <div className="absolute top-3 left-4 pointer-events-none text-[11px] font-mono space-y-0.5 bg-slate-950/80 border border-slate-800/80 px-3 py-2 rounded-lg">
                  <div className="text-cyan-300 font-semibold">
                    Coupe Triée #{previewSliceIdx + 1} / {activeSeries.slices.length}
                  </div>
                  <div className="text-slate-400">
                    Z-Proj (IPP·N): <span className="text-slate-200">{currentSliceObj.zProjection.toFixed(2)} mm</span>
                  </div>
                  <div className="text-slate-400">
                    InstanceNumber (0020,0013): <span className="text-slate-200">#{currentSliceObj.instanceNumber}</span>
                  </div>
                  <div className="text-slate-400">
                    Calibration HU: <span className="text-emerald-300">[{Math.round(currentSliceObj.minVal)} .. {Math.round(currentSliceObj.maxVal)}]</span>
                  </div>
                </div>
              )}
            </div>

            {/* Scrubber horizontal de prévisualisation dans le Studio */}
            <div className="border-t border-slate-800/80 bg-[#0B101B] px-4 py-3 flex items-center gap-3">
              <span className="text-xs font-mono text-slate-400 shrink-0">
                Coupe {previewSliceIdx + 1}/{activeSeries.slices.length}
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0, activeSeries.slices.length - 1)}
                value={previewSliceIdx}
                onChange={(e) => setPreviewSliceIdx(Number(e.target.value))}
                className="flex-1 accent-cyan-400"
              />
              <span className="text-[11px] text-slate-400 hidden sm:inline">
                Molette ou curseur pour inspecter le tri spatial
              </span>
            </div>
          </>
        )}
      </div>

      {/* COLONNE DROITE : Bilan de Compression en direct & Export .tpack */}
      <div className="w-full lg:w-80 border-t lg:border-t-0 lg:border-l border-slate-800/80 bg-[#0B101B] p-4 flex flex-col justify-between gap-4 shrink-0">
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
            <FileArchive className="w-4 h-4" />
            <span>Bilan de Compression .tpack</span>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3">
            <div className="flex justify-between items-baseline">
              <span className="text-xs text-slate-400">Poids DICOM brut</span>
              <span className="text-sm font-mono text-slate-300">
                {formatBytes(sizeEstimation.rawTotalBytes)}
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-xs text-slate-400">Poids .tpack estimé</span>
              <span className="text-lg font-bold font-mono text-cyan-300">
                {lastBuiltBytes
                  ? formatBytes(lastBuiltBytes.byteLength)
                  : formatBytes(sizeEstimation.estimatedTpackBytes)}
              </span>
            </div>

            <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
              <span className="text-xs text-slate-400">Gain d&apos;espace</span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-bold font-mono">
                -{sizeEstimation.reductionPercentage.toFixed(1)} %
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 text-[11px] text-slate-400">
              <div className="bg-slate-950 p-2 rounded border border-slate-800/80">
                <div>Coupes retenues</div>
                <div className="text-slate-100 font-mono font-semibold text-sm mt-0.5">
                  {sizeEstimation.retainedSliceCount}
                </div>
              </div>
              <div className="bg-slate-950 p-2 rounded border border-slate-800/80">
                <div>Images WebP (q=0.85)</div>
                <div className="text-slate-100 font-mono font-semibold text-sm mt-0.5">
                  {sizeEstimation.totalEncodedFrames}
                </div>
              </div>
            </div>
          </div>

          {/* Rappel des garanties de sécurité & qualité */}
          <div className="p-3.5 rounded-xl bg-slate-900/50 border border-slate-800/80 space-y-2 text-xs text-slate-300">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                <strong>Zéro fuite PHI :</strong> seuls les pixels 8 bits WebP et la whitelist{' '}
                <code>manifest.json</code> sont écrits dans l&apos;archive.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                <strong>Calibration millimétrique :</strong> recalcul automatique du{' '}
                <code>pixelSpacing</code> après redimensionnement.
              </span>
            </div>
          </div>
        </div>

        {/* Boutons d'action Export & Ouverture directe dans le Viewer */}
        <div className="space-y-2.5">
          {isBuilding && (
            <div className="p-3 rounded-lg bg-cyan-950/50 border border-cyan-500/40 text-xs text-cyan-200">
              <div className="flex justify-between mb-1">
                <span>Encodage WebP OffscreenCanvas...</span>
                <span>
                  {buildProgress.current} / {buildProgress.total}
                </span>
              </div>
              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-400 transition-all"
                  style={{
                    width: `${Math.round(
                      (buildProgress.current / Math.max(1, buildProgress.total)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}

          <button
            type="button"
            disabled={!activeSeries || isBuilding}
            onClick={() => handleBuildAndAction('open_viewer')}
            className="w-full py-2.5 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20 transition cursor-pointer"
          >
            <Play className="w-4 h-4 fill-current" />
            Compiler &amp; Ouvrir dans le Lecteur 60 fps
          </button>

          <button
            type="button"
            disabled={!activeSeries || isBuilding}
            onClick={() => handleBuildAndAction('download')}
            className="w-full py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <Download className="w-4 h-4" />
            Télécharger l&apos;archive .tpack
          </button>
        </div>
      </div>
    </div>
  );
};
