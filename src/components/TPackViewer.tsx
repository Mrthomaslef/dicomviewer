import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Ruler,
  Eye,
  EyeOff,
  RotateCcw,
  Layers,
  Info,
  FolderUp,
  SunMedium,
  Keyboard,
  Move,
  ZoomIn,
  Trash2,
  X,
  Download,
} from 'lucide-react';
import { LoadedTPackArchive, loadTPackFromFile } from '../core/tpackLoader';
import { AnnotationItem } from '../types/manifest';

interface TPackViewerProps {
  archive: LoadedTPackArchive;
  onLoadNewArchive: (newArchive: LoadedTPackArchive) => void;
}

interface MeasurementLine {
  id: string;
  // Coordonnées dans le référentiel de l'image source (0..width, 0..height)
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const TPackViewer: React.FC<TPackViewerProps> = ({
  archive,
  onLoadNewArchive,
}) => {
  const seriesList = archive.manifest.series;
  const [activeSeriesId, setActiveSeriesId] = useState<string>(
    seriesList[0]?.id || ''
  );

  const activeSeriesData =
    archive.seriesMap[activeSeriesId] ||
    archive.seriesMap[seriesList[0]?.id || ''];
  const seriesManifest = activeSeriesData?.manifest;

  const [activeWindowKey, setActiveWindowKey] = useState<string>(
    seriesManifest?.availableWindows[0]?.key || 'default'
  );
  const [sliceIndex, setSliceIndex] = useState<number>(0);

  // Transformation de vue (Zoom, Pan, Contraste/Luminosité post-LUT)
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [contrast, setContrast] = useState<number>(1.0);
  const [brightness, setBrightness] = useState<number>(1.0);

  // Outils Pédagogiques
  const [rulerActive, setRulerActive] = useState<boolean>(false);
  const [showAnnotations, setShowAnnotations] = useState<boolean>(true);
  const [showCaseInfo, setShowCaseInfo] = useState<boolean>(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false);

  // Mesures en millimètres par coupe : clé `${seriesId}_${sliceIndex}`
  const [measurementsBySlice, setMeasurementsBySlice] = useState<
    Record<string, MeasurementLine[]>
  >({});
  const [activeDragHandle, setActiveDragHandle] = useState<{
    measureId: string;
    endpoint: 'p1' | 'p2';
  } | null>(null);
  const [creatingMeasureId, setCreatingMeasureId] = useState<string | null>(null);

  // État des touches maintenues main gauche (W, Espace, Z) sur ordinateur
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const [activeKeyMode, setActiveKeyMode] = useState<'none' | 'w' | 'space' | 'z'>('none');

  // Accumulateurs pour le défilement Trackpad et le Scroll tactile à 1 doigt
  const wheelDeltaAccumulatorRef = useRef<number>(0);
  const touchScrollAccumulatorRef = useRef<number>(0);
  const lastVibratedSliceRef = useRef<number>(-10);

  // Références DOM
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrubTrackRef = useRef<HTMLDivElement | null>(null);
  const tpackInputRef = useRef<HTMLInputElement | null>(null);

  // Gestion multi-touch :
  // - 1 doigt : défilement des coupes (scroll vertical) ou tracé de la règle si active
  // - 2 doigts : déplacement de l'image (Pan) + zoom par pincement (Pinch-to-Zoom)
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastPinchDistRef = useRef<number | null>(null);
  const lastPinchMidRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPosRef = useRef<{ x: number; y: number } | null>(null);
  const isScrubbingRef = useRef<boolean>(false);

  // Synchronisation lors d'un changement d'archive
  useEffect(() => {
    const firstSeries = archive.manifest.series[0];
    if (firstSeries) {
      setActiveSeriesId(firstSeries.id);
      setActiveWindowKey(firstSeries.availableWindows[0]?.key || 'default');
      setSliceIndex(Math.floor(firstSeries.sliceCount / 2));
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setContrast(1);
      setBrightness(1);
      setMeasurementsBySlice({});
    }
  }, [archive]);

  // Pont API postMessage bidirectionnel : permet au site de Cas Pédagogiques (parent iframe)
  // de piloter le lecteur (aller à une coupe clé, changer de fenêtre Os/Mou, afficher les annotations)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'TPACK_GOTO') {
        if (typeof data.seriesId === 'string' && archive.seriesMap[data.seriesId]) {
          setActiveSeriesId(data.seriesId);
        }
        if (typeof data.windowKey === 'string') {
          setActiveWindowKey(data.windowKey);
        }
        if (typeof data.sliceIndex === 'number') {
          setSliceIndex(
            Math.max(0, Math.min((seriesManifest?.sliceCount || 1) - 1, data.sliceIndex))
          );
        }
        if (typeof data.showAnnotations === 'boolean') {
          setShowAnnotations(data.showAnnotations);
        }
      } else if (data.type === 'TPACK_RESET_VIEW') {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setContrast(1);
        setBrightness(1);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [archive, seriesManifest]);

  // Émet l'état courant vers la fenêtre parente si le lecteur est intégré en mode iframe
  useEffect(() => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        {
          type: 'TPACK_VIEWER_STATE',
          caseId: archive.manifest.caseId,
          seriesId: activeSeriesId,
          windowKey: activeWindowKey,
          sliceIndex,
          sliceCount: seriesManifest?.sliceCount || 0,
        },
        '*'
      );
    }
  }, [archive.manifest.caseId, activeSeriesId, activeWindowKey, sliceIndex, seriesManifest]);

  const handleSelectSeries = useCallback(
    (newSeriesId: string) => {
      const target = archive.seriesMap[newSeriesId]?.manifest;
      if (!target) return;
      setActiveSeriesId(newSeriesId);
      setActiveWindowKey(target.availableWindows[0]?.key || 'default');
      setSliceIndex(Math.floor(target.sliceCount / 2));
      setZoom(1);
      setPan({ x: 0, y: 0 });
    },
    [archive]
  );

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setContrast(1.0);
    setBrightness(1.0);
  }, []);

  // Changement de coupe sécurisé avec retour haptique léger sur mobile
  const changeSlice = useCallback(
    (nextIndex: number, triggerHaptics: boolean = false) => {
      if (!seriesManifest) return;
      const clamped = Math.max(0, Math.min(seriesManifest.sliceCount - 1, nextIndex));
      setSliceIndex((prev) => {
        if (prev !== clamped && triggerHaptics) {
          if (
            clamped % 5 === 0 &&
            Math.abs(clamped - lastVibratedSliceRef.current) >= 5
          ) {
            lastVibratedSliceRef.current = clamped;
            if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
              navigator.vibrate(5);
            }
          }
        }
        return clamped;
      });
    },
    [seriesManifest]
  );

  // Raccourcis Clavier Main Gauche (W, Espace, Z, M, A, 1, 2, 3, R, Flèches)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      pressedKeysRef.current.add(key);

      if (key === 'w') {
        setActiveKeyMode('w');
      } else if (e.code === 'Space') {
        e.preventDefault();
        pressedKeysRef.current.add('space');
        setActiveKeyMode('space');
      } else if (key === 'z') {
        setActiveKeyMode('z');
      } else if (key === 'm') {
        setRulerActive((prev) => !prev);
      } else if (key === 'a') {
        setShowAnnotations((prev) => !prev);
      } else if (key === 'r') {
        resetView();
      } else if (key === '1' || key === '2' || key === '3') {
        if (!seriesManifest) return;
        const wins = seriesManifest.availableWindows;
        if (key === '1') {
          const boneWin = wins.find((w) => w.key === 'bone') || wins[0];
          if (boneWin) setActiveWindowKey(boneWin.key);
        } else if (key === '2') {
          const softWin = wins.find((w) => w.key === 'soft') || wins[1] || wins[0];
          if (softWin) setActiveWindowKey(softWin.key);
        } else if (key === '3' && wins[2]) {
          setActiveWindowKey(wins[2].key);
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        changeSlice(sliceIndex + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        changeSlice(sliceIndex - 1);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      pressedKeysRef.current.delete(key);
      if (e.code === 'Space') {
        pressedKeysRef.current.delete('space');
      }
      if (pressedKeysRef.current.has('w')) setActiveKeyMode('w');
      else if (pressedKeysRef.current.has('space')) setActiveKeyMode('space');
      else if (pressedKeysRef.current.has('z')) setActiveKeyMode('z');
      else setActiveKeyMode('none');
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [seriesManifest, sliceIndex, changeSlice, resetView]);

  // Formule Euclidienne Physique exacte en millimètres :
  // distanceMm = Math.sqrt(Math.pow((x2 - x1) * pixelSpacing[1], 2) + Math.pow((y2 - y1) * pixelSpacing[0], 2))
  const computeDistanceMm = useCallback(
    (x1: number, y1: number, x2: number, y2: number): number => {
      const spacing = seriesManifest?.pixelSpacing || [1, 1];
      return Math.sqrt(
        Math.pow((x2 - x1) * spacing[1], 2) + Math.pow((y2 - y1) * spacing[0], 2)
      );
    },
    [seriesManifest]
  );

  const currentSliceKey = `${activeSeriesId}_${sliceIndex}`;
  const currentMeasurements = useMemo(
    () => measurementsBySlice[currentSliceKey] || [],
    [measurementsBySlice, currentSliceKey]
  );

  // Calcul de la transformation géométrique d'affichage (Image -> Canvas écran)
  const getCanvasTransform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !seriesManifest) {
      return { scale: 1, offsetX: 0, offsetY: 0 };
    }
    const cw = canvas.width;
    const ch = canvas.height;
    const iw = seriesManifest.width;
    const ih = seriesManifest.height;

    const baseScale = Math.min(cw / iw, ch / ih) * 0.92;
    const finalScale = baseScale * zoom;
    const offsetX = (cw - iw * finalScale) / 2 + pan.x;
    const offsetY = (ch - ih * finalScale) / 2 + pan.y;

    return { scale: finalScale, offsetX, offsetY };
  }, [seriesManifest, zoom, pan]);

  const screenToImageCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas || !seriesManifest) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const sx = (clientX - rect.left) * (canvas.width / rect.width);
      const sy = (clientY - rect.top) * (canvas.height / rect.height);
      const { scale, offsetX, offsetY } = getCanvasTransform();
      const ix = Math.max(0, Math.min(seriesManifest.width, (sx - offsetX) / scale));
      const iy = Math.max(0, Math.min(seriesManifest.height, (sy - offsetY) / scale));
      return { x: ix, y: iy };
    },
    [seriesManifest, getCanvasTransform]
  );

  // Rendu 60 fps sur le Canvas 2D avec ImageBitmap
  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || !activeSeriesData || !seriesManifest) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = viewport.getBoundingClientRect();
    const cw = Math.max(1, Math.floor(rect.width * dpr));
    const ch = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.fillStyle = '#090D16';
    ctx.fillRect(0, 0, cw, ch);

    const frames =
      activeSeriesData.framesByWindow[activeWindowKey] ||
      Object.values(activeSeriesData.framesByWindow)[0] ||
      [];
    const bitmap = frames[sliceIndex];

    const { scale, offsetX, offsetY } = getCanvasTransform();

    if (bitmap) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (contrast !== 1.0 || brightness !== 1.0) {
        ctx.filter = `brightness(${Math.round(brightness * 100)}%) contrast(${Math.round(
          contrast * 100
        )}%)`;
      }
      ctx.drawImage(
        bitmap,
        offsetX,
        offsetY,
        seriesManifest.width * scale,
        seriesManifest.height * scale
      );
      ctx.restore();
    }

    // Affichage des annotations pédagogiques de la coupe courante
    const sliceObj = seriesManifest.slices[sliceIndex];
    if (showAnnotations && sliceObj?.annotations && sliceObj.annotations.length > 0) {
      for (const ann of sliceObj.annotations) {
        drawViewerAnnotation(
          ctx,
          ann,
          seriesManifest.width,
          seriesManifest.height,
          scale,
          offsetX,
          offsetY,
          dpr
        );
      }
    }

    // Affichage des segments de l'outil Règle graduée en millimètres
    if (currentMeasurements.length > 0) {
      for (const m of currentMeasurements) {
        drawMeasurementLine(ctx, m, scale, offsetX, offsetY, dpr, computeDistanceMm);
      }
    }

    ctx.restore();
  }, [
    activeSeriesData,
    seriesManifest,
    activeWindowKey,
    sliceIndex,
    zoom,
    pan,
    contrast,
    brightness,
    showAnnotations,
    currentMeasurements,
    getCanvasTransform,
    computeDistanceMm,
  ]);

  // Redimensionnement réactif du viewport
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const ro = new ResizeObserver(() => {
      setPan((p) => ({ ...p }));
    });
    ro.observe(viewport);
    return () => ro.disconnect();
  }, []);

  // Gestion native { passive: false } du Trackpad sur Ordinateur :
  // - Pincement Trackpad (wheel avec ctrlKey=true ou WebKit gesturechange) => Zoom sur l'image visionnée centré sur le curseur, bloque le zoom de la page entière
  // - Glissement Trackpad à 2 doigts (wheel sans ctrlKey) => Défilement précis des coupes (seuil = 15px)
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const applyCursorCenteredZoom = (
      zoomRatio: number,
      clientX: number,
      clientY: number
    ) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // Coordonnées du curseur par rapport au centre du canvas (en pixels physiques canvas)
      const cursorOffsetX = (clientX - (rect.left + rect.width / 2)) * dpr;
      const cursorOffsetY = (clientY - (rect.top + rect.height / 2)) * dpr;

      setZoom((prevZoom) => {
        const nextZoom = Math.max(0.4, Math.min(10, prevZoom * zoomRatio));
        const effectiveRatio = nextZoom / prevZoom;
        setPan((prevPan) => ({
          x: cursorOffsetX - (cursorOffsetX - prevPan.x) * effectiveRatio,
          y: cursorOffsetY - (cursorOffsetY - prevPan.y) * effectiveRatio,
        }));
        return nextZoom;
      });
    };

    const handleNativeWheel = (e: WheelEvent) => {
      // Bloque impérativement le zoom natif du navigateur sur toute la page
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey || e.metaKey) {
        // Pincement Trackpad sur MacBook / PC (ctrlKey est automatiquement true lors d'un pinch trackpad)
        const zoomFactor = Math.exp(-e.deltaY * 0.012);
        applyCursorCenteredZoom(zoomFactor, e.clientX, e.clientY);
        return;
      }

      // Défilement normal au Trackpad / Molette -> changement de coupe
      const THRESHOLD_PX = 15;
      wheelDeltaAccumulatorRef.current += e.deltaY;

      if (Math.abs(wheelDeltaAccumulatorRef.current) >= THRESHOLD_PX) {
        const steps = Math.trunc(wheelDeltaAccumulatorRef.current / THRESHOLD_PX);
        const clampedStep = Math.sign(steps) * Math.min(2, Math.abs(steps));
        wheelDeltaAccumulatorRef.current -= steps * THRESHOLD_PX;
        changeSlice(sliceIndex + clampedStep, false);
      }
    };

    // Support spécifique Safari macOS (WebKit GestureEvents) pour bloquer le zoom page et zoomer l'image
    let lastSafariGestureScale = 1;
    const handleGestureStart = (e: Event) => {
      e.preventDefault();
      const ge = e as unknown as { scale?: number };
      lastSafariGestureScale = ge.scale || 1;
    };

    const handleGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as unknown as { scale?: number; clientX?: number; clientY?: number };
      const currentScale = ge.scale || 1;
      if (lastSafariGestureScale > 0) {
        const ratio = currentScale / lastSafariGestureScale;
        const rect = viewport.getBoundingClientRect();
        const cx = ge.clientX ?? rect.left + rect.width / 2;
        const cy = ge.clientY ?? rect.top + rect.height / 2;
        applyCursorCenteredZoom(ratio, cx, cy);
      }
      lastSafariGestureScale = currentScale;
    };

    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
      lastSafariGestureScale = 1;
    };

    // Bloque également le pincement accidentel sur le reste de la fenêtre (barre d'outils, header)
    const preventGlobalPagePinch = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    };

    viewport.addEventListener('wheel', handleNativeWheel, { passive: false });
    viewport.addEventListener('gesturestart', handleGestureStart, { passive: false });
    viewport.addEventListener('gesturechange', handleGestureChange, { passive: false });
    viewport.addEventListener('gestureend', handleGestureEnd, { passive: false });
    window.addEventListener('wheel', preventGlobalPagePinch, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', handleNativeWheel);
      viewport.removeEventListener('gesturestart', handleGestureStart);
      viewport.removeEventListener('gesturechange', handleGestureChange);
      viewport.removeEventListener('gestureend', handleGestureEnd);
      window.removeEventListener('wheel', preventGlobalPagePinch);
    };
  }, [sliceIndex, changeSlice]);

  // Gestion Pointeur :
  // - 1 doigt / clic gauche : scroll vertical à travers les coupes (ou règle en mm si active)
  // - 2 doigts : déplacement (Pan) du point milieu + zoom par pincement (Pinch-to-Zoom)
  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isScrubbingRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Passage à 2 doigts : interrompt tout tracé de règle éventuel et initialise Pan 2 doigts + Pinch Zoom
    if (activePointersRef.current.size === 2) {
      if (creatingMeasureId) {
        const cancelId = creatingMeasureId;
        setMeasurementsBySlice((prev) => ({
          ...prev,
          [currentSliceKey]: (prev[currentSliceKey] || []).filter((m) => m.id !== cancelId),
        }));
        setCreatingMeasureId(null);
      }
      setActiveDragHandle(null);

      const pts = Array.from(activePointersRef.current.values());
      lastPinchDistRef.current = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      lastPinchMidRef.current = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
      return;
    }

    lastDragPosRef.current = { x: e.clientX, y: e.clientY };
    touchScrollAccumulatorRef.current = 0;

    // Si l'outil Règle est actif (et qu'un seul doigt / pointeur est posé)
    if (
      rulerActive &&
      activeKeyMode === 'none' &&
      e.button === 0 &&
      activePointersRef.current.size === 1
    ) {
      const imgPt = screenToImageCoords(e.clientX, e.clientY);
      const { scale } = getCanvasTransform();
      const hitRadiusImg = 18 / Math.max(0.2, scale);

      for (const m of currentMeasurements) {
        if (Math.hypot(imgPt.x - m.x1, imgPt.y - m.y1) <= hitRadiusImg) {
          setActiveDragHandle({ measureId: m.id, endpoint: 'p1' });
          return;
        }
        if (Math.hypot(imgPt.x - m.x2, imgPt.y - m.y2) <= hitRadiusImg) {
          setActiveDragHandle({ measureId: m.id, endpoint: 'p2' });
          return;
        }
      }

      const newId = `m_${Date.now()}`;
      const newMeasure: MeasurementLine = {
        id: newId,
        x1: imgPt.x,
        y1: imgPt.y,
        x2: imgPt.x,
        y2: imgPt.y,
      };
      setMeasurementsBySlice((prev) => ({
        ...prev,
        [currentSliceKey]: [...(prev[currentSliceKey] || []), newMeasure],
      }));
      setCreatingMeasureId(newId);
    }
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activePointersRef.current.has(e.pointerId)) return;
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const dpr = window.devicePixelRatio || 1;

    // 1. GESTE À 2 DOIGTS : Déplacement (Pan à 2 doigts) + Zoom en pinçant (Pinch-to-Zoom)
    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };

      // Déplacement à 2 doigts (suivi du point milieu)
      if (lastPinchMidRef.current) {
        const dMidX = mid.x - lastPinchMidRef.current.x;
        const dMidY = mid.y - lastPinchMidRef.current.y;
        setPan((p) => ({
          x: p.x + dMidX * dpr,
          y: p.y + dMidY * dpr,
        }));
      }

      // Zoom par pincement (Pinch-to-Zoom)
      if (lastPinchDistRef.current && lastPinchDistRef.current > 8) {
        const ratio = dist / lastPinchDistRef.current;
        setZoom((z) => Math.max(0.4, Math.min(8, z * ratio)));
      }

      lastPinchDistRef.current = dist;
      lastPinchMidRef.current = mid;
      return;
    }

    // 2. GESTE À 1 DOIGT / SOURIS
    const prevPos = lastDragPosRef.current;
    if (!prevPos) return;
    const dx = e.clientX - prevPos.x;
    const dy = e.clientY - prevPos.y;
    lastDragPosRef.current = { x: e.clientX, y: e.clientY };

    // 2a. Ajustement ou tracé d'une mesure en millimètres
    if (activeDragHandle) {
      const imgPt = screenToImageCoords(e.clientX, e.clientY);
      setMeasurementsBySlice((prev) => ({
        ...prev,
        [currentSliceKey]: (prev[currentSliceKey] || []).map((m) =>
          m.id === activeDragHandle.measureId
            ? activeDragHandle.endpoint === 'p1'
              ? { ...m, x1: imgPt.x, y1: imgPt.y }
              : { ...m, x2: imgPt.x, y2: imgPt.y }
            : m
        ),
      }));
      return;
    }

    if (creatingMeasureId) {
      const imgPt = screenToImageCoords(e.clientX, e.clientY);
      setMeasurementsBySlice((prev) => ({
        ...prev,
        [currentSliceKey]: (prev[currentSliceKey] || []).map((m) =>
          m.id === creatingMeasureId ? { ...m, x2: imgPt.x, y2: imgPt.y } : m
        ),
      }));
      return;
    }

    // 2b. Raccourcis Clavier Main Gauche sur ordinateur (W = Contraste, Z = Zoom, Espace / Clic milieu = Pan)
    if (activeKeyMode === 'w') {
      setContrast((c) => Math.max(0.3, Math.min(3.0, c + dx * 0.005)));
      setBrightness((b) => Math.max(0.3, Math.min(2.5, b - dy * 0.005)));
      return;
    }

    if (activeKeyMode === 'z') {
      setZoom((z) => Math.max(0.4, Math.min(8, z * (1 - dy * 0.008))));
      return;
    }

    if (activeKeyMode === 'space' || e.buttons === 4) {
      setPan((p) => ({
        x: p.x + dx * dpr,
        y: p.y + dy * dpr,
      }));
      return;
    }

    // 2c. Défilement des coupes en scrollant à 1 doigt sur l'image (ou glisser vertical à la souris)
    if (!rulerActive && (e.pointerType === 'touch' || e.buttons === 1)) {
      const SLICE_SCROLL_STEP_PX = 11;
      touchScrollAccumulatorRef.current += dy;
      if (Math.abs(touchScrollAccumulatorRef.current) >= SLICE_SCROLL_STEP_PX) {
        const deltaSlices = Math.trunc(
          touchScrollAccumulatorRef.current / SLICE_SCROLL_STEP_PX
        );
        touchScrollAccumulatorRef.current -= deltaSlices * SLICE_SCROLL_STEP_PX;
        changeSlice(sliceIndex + deltaSlices, true);
      }
    }
  };

  const handleViewportPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      lastPinchDistRef.current = null;
      lastPinchMidRef.current = null;
    }
    if (activePointersRef.current.size === 1) {
      // Ré-ancrer le doigt restant pour éviter un saut de position après avoir relâché le 2e doigt
      const remaining = Array.from(activePointersRef.current.values())[0];
      lastDragPosRef.current = { x: remaining.x, y: remaining.y };
      touchScrollAccumulatorRef.current = 0;
    } else if (activePointersRef.current.size === 0) {
      lastDragPosRef.current = null;
      touchScrollAccumulatorRef.current = 0;
    }
    setActiveDragHandle(null);
    setCreatingMeasureId(null);
  };

  // Gestion de la Scrub Bar Latérale Droite (accès rapide à toute la pile)
  const updateSliceFromScrubY = (clientY: number) => {
    const track = scrubTrackRef.current;
    if (!track || !seriesManifest) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    const targetSlice = Math.round(ratio * (seriesManifest.sliceCount - 1));
    changeSlice(targetSlice, true);
  };

  const handleScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    isScrubbingRef.current = true;
    updateSliceFromScrubY(e.clientY);
  };

  const handleScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbingRef.current) return;
    e.stopPropagation();
    updateSliceFromScrubY(e.clientY);
  };

  const handleScrubPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    isScrubbingRef.current = false;
  };

  const handleCycleWindow = () => {
    if (!seriesManifest || seriesManifest.availableWindows.length <= 1) return;
    const wins = seriesManifest.availableWindows;
    const currentIdx = wins.findIndex((w) => w.key === activeWindowKey);
    const nextWin = wins[(currentIdx + 1) % wins.length];
    if (nextWin) {
      setActiveWindowKey(nextWin.key);
    }
  };

  const handleDownloadCurrentArchive = () => {
    if (!archive.rawBytes) return;
    const blob = new Blob(
      [
        archive.rawBytes.buffer.slice(
          archive.rawBytes.byteOffset,
          archive.rawBytes.byteOffset + archive.rawBytes.byteLength
        ) as ArrayBuffer,
      ],
      {
        type: 'application/octet-stream',
      }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${archive.manifest.caseId.toLowerCase()}.tpack`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentSliceObj = seriesManifest?.slices[sliceIndex];
  const progressRatio =
    seriesManifest && seriesManifest.sliceCount > 1
      ? sliceIndex / (seriesManifest.sliceCount - 1)
      : 0;

  return (
    <div
      className="relative w-full h-full flex flex-col bg-[#090D16] text-slate-100 select-none overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) {
          const loaded = await loadTPackFromFile(file);
          onLoadNewArchive(loaded);
        }
      }}
    >
      <input
        ref={tpackInputRef}
        type="file"
        accept=".tpack,.zip,application/zip,application/octet-stream"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) {
            const loaded = await loadTPackFromFile(file);
            onLoadNewArchive(loaded);
          }
        }}
      />

      {/* ZONE D'IMAGE CENTRALE (1 doigt = Scroll coupes, 2 doigts / Pinch Trackpad = Pan + Pinch Zoom sur l'image) */}
      <div
        ref={viewportRef}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        className={`relative flex-1 w-full overflow-hidden touch-none ${
          rulerActive
            ? 'cursor-crosshair'
            : activeKeyMode === 'space'
            ? 'cursor-grabbing'
            : activeKeyMode === 'w'
            ? 'cursor-ns-resize'
            : activeKeyMode === 'z'
            ? 'cursor-zoom-in'
            : 'cursor-ns-resize'
        }`}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />

        {/* HUD Radiologique Supérieur Gauche — Compact sur Mobile */}
        {seriesManifest && (
          <div className="absolute top-2.5 left-2.5 pointer-events-none flex flex-col gap-0.5 bg-slate-950/75 backdrop-blur-md border border-slate-800/80 rounded-xl px-2.5 py-1.5 sm:px-3 sm:py-2 text-[11px] sm:text-xs font-mono shadow-lg max-w-[62vw] sm:max-w-[70vw]">
            <div className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold text-[10px]">
                {seriesManifest.modality}
              </span>
              <span className="font-sans font-semibold text-slate-100 truncate text-xs">
                {archive.manifest.title}
              </span>
            </div>
            <div className="hidden sm:block text-[11px] text-slate-400 truncate">
              {seriesManifest.description} • {seriesManifest.width}×{seriesManifest.height}px
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] sm:text-[11px] text-cyan-300">
              <span>
                Coupe{' '}
                <strong className="text-white">
                  {sliceIndex + 1}/{seriesManifest.sliceCount}
                </strong>
              </span>
              <span>Z:{currentSliceObj?.zPosition.toFixed(1) ?? '0.0'}mm</span>
              <span className="hidden xs:inline">
                Δxy:{seriesManifest.pixelSpacing[1]}mm
              </span>
            </div>
            {(zoom !== 1 || pan.x !== 0 || pan.y !== 0 || contrast !== 1 || brightness !== 1) && (
              <div className="text-[10px] text-amber-300">
                Zoom {zoom.toFixed(1)}×
                {(contrast !== 1 || brightness !== 1) &&
                  ` | C:${Math.round(contrast * 100)}% L:${Math.round(brightness * 100)}%`}
              </div>
            )}
          </div>
        )}

        {/* Boutons d'actions rapides en haut à droite */}
        <div className="absolute top-2.5 right-12 sm:right-14 flex items-center gap-1 sm:gap-1.5 z-10">
          {currentMeasurements.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setMeasurementsBySlice((prev) => ({
                  ...prev,
                  [currentSliceKey]: [],
                }))
              }
              className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg bg-red-950/85 hover:bg-red-900/80 border border-red-500/40 text-red-200 text-xs font-medium flex items-center gap-1 shadow transition cursor-pointer"
              title="Effacer les mesures de cette coupe"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Effacer</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => tpackInputRef.current?.click()}
            className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg bg-slate-900/85 hover:bg-slate-800 border border-slate-700/80 text-slate-200 text-xs font-medium flex items-center gap-1.5 shadow transition cursor-pointer"
            title="Ouvrir un fichier .tpack local"
          >
            <FolderUp className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Ouvrir .tpack</span>
          </button>

          {archive.rawBytes && (
            <button
              type="button"
              onClick={handleDownloadCurrentArchive}
              className="p-1.5 rounded-lg bg-slate-900/85 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-cyan-300 shadow transition cursor-pointer"
              title={`Télécharger ce cas (${(archive.archiveByteSize / 1024).toFixed(0)} Ko)`}
            >
              <Download className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={resetView}
            className="p-1.5 rounded-lg bg-slate-900/85 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white shadow transition cursor-pointer"
            title="Réinitialiser Zoom / Pan / Contraste (Touche R)"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => setShowShortcutsModal(true)}
            className="p-1.5 rounded-lg bg-slate-900/85 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-cyan-300 shadow transition cursor-pointer"
            title="Aide Gestes Tactiles & Raccourcis"
          >
            <Keyboard className="w-4 h-4" />
          </button>
        </div>

        {/* Bandeau d'indication des gestes tactiles (discret en bas de l'image sur mobile) */}
        <div className="sm:hidden absolute bottom-2 left-2.5 right-12 pointer-events-none flex items-center justify-center">
          <div className="px-2.5 py-1 rounded-full bg-slate-950/75 backdrop-blur border border-slate-800/80 text-[10px] text-slate-300 flex items-center gap-2 shadow">
            <span>
              <strong className="text-cyan-300">1 doigt :</strong> {rulerActive ? 'Tracer règle mm' : 'Défiler coupes'}
            </span>
            <span className="text-slate-600">•</span>
            <span>
              <strong className="text-cyan-300">2 doigts :</strong> Déplacer &amp; Pincer Zoom
            </span>
          </div>
        </div>

        {/* SCRUB BAR LATÉRALE DROITE (largeur 36px sur mobile / 40px desktop, hauteur 68% de l'écran) */}
        <div
          ref={scrubTrackRef}
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
          onPointerUp={handleScrubPointerUp}
          onPointerCancel={handleScrubPointerUp}
          style={{
            touchAction: 'none',
            overscrollBehavior: 'none',
          }}
          className="w-9 sm:w-10 h-[66%] sm:h-[70%] absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 z-20 rounded-2xl bg-slate-950/85 backdrop-blur-md border border-slate-800/90 hover:border-cyan-500/50 shadow-2xl flex flex-col items-center justify-between py-2.5 cursor-ns-resize select-none"
          title="Scrub Bar Rapide : glissez pour parcourir toute la pile"
        >
          <div className="text-[10px] font-mono font-bold text-cyan-300 leading-none">
            {sliceIndex + 1}
          </div>

          <div className="relative flex-1 w-1.5 sm:w-2 my-2 bg-slate-800/90 rounded-full">
            {seriesManifest &&
              Array.from({ length: Math.min(20, Math.floor(seriesManifest.sliceCount / 2)) }).map(
                (_, idx, arr) => (
                  <div
                    key={idx}
                    style={{ top: `${(idx / Math.max(1, arr.length - 1)) * 100}%` }}
                    className="absolute -left-1.5 w-4 sm:w-5 h-[1px] bg-slate-700/60 pointer-events-none"
                  />
                )
              )}

            <div
              style={{ height: `${progressRatio * 100}%` }}
              className="w-full bg-gradient-to-b from-cyan-500/40 to-cyan-400 rounded-full transition-none"
            />

            <div
              style={{ top: `${progressRatio * 100}%` }}
              className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 sm:w-7 h-3.5 sm:h-4 rounded-full bg-cyan-400 border-2 border-slate-950 shadow-lg shadow-cyan-400/40 flex items-center justify-center"
            >
              <div className="w-2 h-0.5 bg-slate-950 rounded-full" />
            </div>
          </div>

          <div className="text-[10px] font-mono text-slate-400 leading-none">
            {seriesManifest?.sliceCount || 1}
          </div>
        </div>

        {/* Tiroir / Carte flottante d'informations du Cas Clinique */}
        {showCaseInfo && (
          <div className="absolute bottom-10 sm:bottom-4 left-2.5 right-12 md:right-auto md:w-96 z-30 rounded-2xl bg-slate-950/95 backdrop-blur-md border border-cyan-500/40 p-3.5 sm:p-4 shadow-2xl space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-cyan-400">
                <Info className="w-4 h-4" />
                <span>Dossier Pédagogique ({archive.manifest.caseId})</span>
              </div>
              <button
                type="button"
                onClick={() => setShowCaseInfo(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <h3 className="text-xs sm:text-sm font-semibold text-white">
              {archive.manifest.title}
            </h3>
            {archive.manifest.anatomicalRegion && (
              <div className="text-xs text-cyan-300">
                Région : {archive.manifest.anatomicalRegion}
              </div>
            )}
            {archive.manifest.clinicalHistory && (
              <p className="text-xs text-slate-300 leading-relaxed">
                {archive.manifest.clinicalHistory}
              </p>
            )}
            <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-400 font-mono">
              <span>Poids archive : {(archive.archiveByteSize / 1024).toFixed(0)} Ko</span>
              <span>Format .tpack v{archive.manifest.formatVersion}</span>
            </div>
          </div>
        )}
      </div>

      {/* BOTTOM BAR ERGONOMIQUE — Adaptée Mobile (2 lignes compactes sur téléphone, 1 ligne sur desktop) */}
      <div className="w-full bg-[#0B101B] border-t border-slate-800/90 px-2.5 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 z-20 shrink-0">
        {/* Ligne 1 sur Mobile : Sélecteur de Série + Bascule Rapide Fenêtres (Os / Mou) */}
        <div className="flex items-center justify-between sm:justify-start gap-1.5 w-full sm:w-auto">
          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1.5 flex-1 sm:flex-initial min-w-0">
            <Layers className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <select
              value={activeSeriesId}
              onChange={(e) => handleSelectSeries(e.target.value)}
              className="bg-transparent text-xs font-medium text-slate-100 focus:outline-none w-full sm:max-w-[220px] truncate"
            >
              {seriesList.map((s) => (
                <option key={s.id} value={s.id} className="bg-slate-950 text-slate-100">
                  {s.description} ({s.sliceCount} c.)
                </option>
              ))}
            </select>
          </div>

          {seriesManifest && seriesManifest.availableWindows.length > 1 ? (
            <div className="flex items-center bg-slate-900 p-0.5 rounded-xl border border-slate-800 shrink-0">
              {seriesManifest.availableWindows.map((win, idx) => {
                const isActive = activeWindowKey === win.key;
                const shortLabel =
                  win.key === 'bone'
                    ? 'Os'
                    : win.key === 'soft'
                    ? 'Mou'
                    : `${win.label.split(' ')[0]} [${idx + 1}]`;
                return (
                  <button
                    key={win.key}
                    type="button"
                    onClick={() => setActiveWindowKey(win.key)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition cursor-pointer ${
                      isActive
                        ? 'bg-cyan-500 text-slate-950 shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {shortLabel}
                  </button>
                );
              })}
            </div>
          ) : (
            <button
              type="button"
              onClick={handleCycleWindow}
              className="px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 flex items-center gap-1 shrink-0"
            >
              <SunMedium className="w-3.5 h-3.5 text-cyan-400" />
              <span className="truncate max-w-[100px]">
                {seriesManifest?.availableWindows[0]?.label || 'Standard'}
              </span>
            </button>
          )}
        </div>

        {/* Ligne 2 sur Mobile : Outils Pédagogiques (Règle mm, Annotations, Infos Cas, Reset) */}
        <div className="grid grid-cols-3 sm:flex items-center gap-1.5 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => setRulerActive((prev) => !prev)}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border transition cursor-pointer ${
              rulerActive
                ? 'bg-amber-500/20 border-amber-400 text-amber-200 shadow-sm'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white'
            }`}
          >
            <Ruler className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>Règle mm</span>
            <kbd className="hidden md:inline-block text-[10px] px-1 bg-slate-950/80 rounded text-slate-400">
              M
            </kbd>
          </button>

          <button
            type="button"
            onClick={() => setShowAnnotations((prev) => !prev)}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border transition cursor-pointer ${
              showAnnotations
                ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-sm'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {showAnnotations ? (
              <Eye className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            ) : (
              <EyeOff className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            )}
            <span>Annot.</span>
            <kbd className="hidden md:inline-block text-[10px] px-1 bg-slate-950/80 rounded text-slate-400">
              A
            </kbd>
          </button>

          <button
            type="button"
            onClick={() => setShowCaseInfo((prev) => !prev)}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border transition cursor-pointer ${
              showCaseInfo
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white'
            }`}
          >
            <Info className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Infos Cas</span>
          </button>
        </div>
      </div>

      {/* Modal Gestes Tactiles Mobile & Raccourcis Clavier */}
      {showShortcutsModal && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowShortcutsModal(false)}
        >
          <div
            className="bg-[#0B101B] border border-slate-800 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-sm font-bold text-cyan-400">
                <Keyboard className="w-4 h-4" />
                <span>Gestes Tactiles Mobile &amp; Raccourcis</span>
              </div>
              <button
                type="button"
                onClick={() => setShowShortcutsModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs">
              <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                Sur Mobile &amp; Tablette
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                <span className="text-slate-300">Défiler les coupes</span>
                <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-cyan-300">
                  Glisser 1 doigt (ou Scrub Bar)
                </span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                <span className="text-slate-300">Déplacer l&apos;image (Pan)</span>
                <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-cyan-300">
                  Glisser avec 2 doigts
                </span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                <span className="text-slate-300">Zoomer / Dézoomer</span>
                <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-cyan-300">
                  Pincer à 2 doigts
                </span>
              </div>

              <div className="text-[11px] font-bold uppercase tracking-wider text-cyan-400 pt-2">
                Sur Ordinateur (Trackpad &amp; Clavier)
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                <span className="text-slate-300 flex items-center gap-1.5">
                  <SunMedium className="w-3.5 h-3.5 text-cyan-400" /> Contraste / Luminosité
                </span>
                <kbd className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-cyan-300">
                  Maintenir W + Glisser
                </kbd>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                <span className="text-slate-300 flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-cyan-400" /> Déplacer l&apos;image (Pan)
                </span>
                <kbd className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-cyan-300">
                  Maintenir Espace + Glisser
                </kbd>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-800/60">
                <span className="text-slate-300 flex items-center gap-1.5">
                  <ZoomIn className="w-3.5 h-3.5 text-cyan-400" /> Zoom fluide centré
                </span>
                <kbd className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-cyan-300">
                  Maintenir Z + Glisser
                </kbd>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-300">Règle mm / Annotations / Fenêtres / Reset</span>
                <kbd className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-amber-300">
                  M / A / 1-2 / R
                </kbd>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function drawViewerAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: AnnotationItem,
  imgWidth: number,
  imgHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  dpr: number
) {
  if (ann.points.length === 0) return;

  const toScreen = (pt: [number, number]): [number, number] => [
    offsetX + pt[0] * imgWidth * scale,
    offsetY + pt[1] * imgHeight * scale,
  ];

  ctx.save();
  ctx.strokeStyle = '#22D3EE';
  ctx.fillStyle = '#22D3EE';
  ctx.lineWidth = 2.2 * dpr;

  const [x1, y1] = toScreen(ann.points[0]);

  if (ann.type === 'arrow' && ann.points.length >= 2) {
    const [x2, y2] = toScreen(ann.points[1]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = 11 * dpr;
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
  } else if (ann.type === 'circle' && ann.points.length >= 2) {
    const [x2, y2] = toScreen(ann.points[1]);
    const radius = Math.hypot(x2 - x1, y2 - y1);
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.arc(x1, y1, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (ann.label) {
    ctx.font = `600 ${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`;
    const metrics = ctx.measureText(ann.label);
    const padX = 6 * dpr;
    const boxH = 19 * dpr;
    const boxW = metrics.width + padX * 2;
    const bx = Math.max(4 * dpr, Math.min(ctx.canvas.width - boxW - 4 * dpr, x1 - boxW / 2));
    const by = Math.max(4 * dpr, y1 - boxH - 6 * dpr);

    ctx.fillStyle = 'rgba(9, 13, 22, 0.9)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.7)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeRect(bx, by, boxW, boxH);

    ctx.fillStyle = '#67E8F9';
    ctx.textBaseline = 'middle';
    ctx.fillText(ann.label, bx + padX, by + boxH / 2);
  }

  ctx.restore();
}

function drawMeasurementLine(
  ctx: CanvasRenderingContext2D,
  m: MeasurementLine,
  scale: number,
  offsetX: number,
  offsetY: number,
  dpr: number,
  computeDistanceMm: (x1: number, y1: number, x2: number, y2: number) => number
) {
  const sx1 = offsetX + m.x1 * scale;
  const sy1 = offsetY + m.y1 * scale;
  const sx2 = offsetX + m.x2 * scale;
  const sy2 = offsetY + m.y2 * scale;

  const distMm = computeDistanceMm(m.x1, m.y1, m.x2, m.y2);

  ctx.save();
  ctx.strokeStyle = '#FBBF24';
  ctx.fillStyle = '#FBBF24';
  ctx.lineWidth = 2.2 * dpr;

  ctx.beginPath();
  ctx.moveTo(sx1, sy1);
  ctx.lineTo(sx2, sy2);
  ctx.stroke();

  const handleRadius = 6 * dpr;
  for (const [px, py] of [
    [sx1, sy1],
    [sx2, sy2],
  ]) {
    ctx.beginPath();
    ctx.arc(px, py, handleRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9, 13, 22, 0.85)';
    ctx.fill();
    ctx.stroke();
  }

  const midX = (sx1 + sx2) / 2;
  const midY = (sy1 + sy2) / 2;
  const label = `${distMm.toFixed(1)} mm`;

  ctx.font = `700 ${Math.round(12 * dpr)}px JetBrains Mono, monospace`;
  const textW = ctx.measureText(label).width;
  const padX = 6 * dpr;
  const boxW = textW + padX * 2;
  const boxH = 20 * dpr;
  const bx = midX - boxW / 2;
  const by = midY - boxH - 8 * dpr;

  ctx.fillStyle = 'rgba(9, 13, 22, 0.92)';
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.strokeStyle = '#FBBF24';
  ctx.lineWidth = 1.2 * dpr;
  ctx.strokeRect(bx, by, boxW, boxH);

  ctx.fillStyle = '#FDE68A';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + padX, by + boxH / 2);

  ctx.restore();
}
