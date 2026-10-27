import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Eye,
  EyeOff,
  SunMedium,
  Crosshair,
  PanelRightClose,
  GraduationCap,
} from 'lucide-react';
import { LoadedTPackArchive, loadTPackFromFile } from '../core/tpackLoader';
import { AnnotationItem } from '../types/manifest';

interface TPackViewerProps {
  archive: LoadedTPackArchive;
  onLoadNewArchive: (newArchive: LoadedTPackArchive) => void;
}

interface MeasurementLine {
  id: string;
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

  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [contrast, setContrast] = useState<number>(1.0);
  const [brightness, setBrightness] = useState<number>(1.0);

  const [rulerActive, setRulerActive] = useState<boolean>(false);
  const [windowToolActive, setWindowToolActive] = useState<boolean>(false);
  const [showAnnotations, setShowAnnotations] = useState<boolean>(false);
  const [isPedagogicalPanelOpen, setIsPedagogicalPanelOpen] = useState<boolean>(false);
  const [showDiagnosis, setShowDiagnosis] = useState<boolean>(false);

  // Recense toutes les coupes annotées du cas pour accès rapide en 1 clic
  const annotatedSlicesList = useMemo(() => {
    const list: Array<{ seriesId: string; seriesDesc: string; sliceIndex: number; label: string }> = [];
    for (const s of archive.manifest.series) {
      for (const sl of s.slices) {
        if (sl.annotations && sl.annotations.length > 0) {
          for (const ann of sl.annotations) {
            list.push({
              seriesId: s.id,
              seriesDesc: s.description,
              sliceIndex: sl.index,
              label: ann.label || 'Annotation clé',
            });
          }
        }
      }
    }
    return list;
  }, [archive]);

  const effectiveKeySliceIndex = useMemo(() => {
    if (typeof archive.manifest.keySliceIndex === 'number') {
      return archive.manifest.keySliceIndex;
    }
    if (annotatedSlicesList.length > 0) {
      return annotatedSlicesList[0].sliceIndex;
    }
    const firstCount = archive.manifest.series[0]?.sliceCount || 1;
    return Math.floor(firstCount / 2);
  }, [archive, annotatedSlicesList]);

  const effectiveKeySeriesId = useMemo(() => {
    if (annotatedSlicesList.length > 0) {
      return annotatedSlicesList[0].seriesId;
    }
    return archive.manifest.series[0]?.id || '';
  }, [archive, annotatedSlicesList]);

  const [measurementsBySlice, setMeasurementsBySlice] = useState<
    Record<string, MeasurementLine[]>
  >({});
  const [activeDragHandle, setActiveDragHandle] = useState<{
    measureId: string;
    endpoint: 'p1' | 'p2';
  } | null>(null);
  const [creatingMeasureId, setCreatingMeasureId] = useState<string | null>(null);

  const pressedKeysRef = useRef<Set<string>>(new Set());
  const [activeKeyMode, setActiveKeyMode] = useState<'none' | 'w' | 'space' | 'z'>('none');

  const wheelDeltaAccumulatorRef = useRef<number>(0);
  const touchScrollAccumulatorRef = useRef<number>(0);
  const lastVibratedSliceRef = useRef<number>(-10);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrubTrackRef = useRef<HTMLDivElement | null>(null);
  const tpackInputRef = useRef<HTMLInputElement | null>(null);

  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastPinchDistRef = useRef<number | null>(null);
  const lastPinchMidRef = useRef<{ x: number; y: number } | null>(null);
  const lastDragPosRef = useRef<{ x: number; y: number } | null>(null);
  const isScrubbingRef = useRef<boolean>(false);
  const hasWindowDraggedRef = useRef<boolean>(false);

  useEffect(() => {
    const firstSeries = archive.manifest.series[0];
    if (firstSeries) {
      setActiveSeriesId(firstSeries.id);
      setActiveWindowKey(firstSeries.availableWindows[0]?.key || 'default');
      setSliceIndex(0);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setContrast(1);
      setBrightness(1);
      setMeasurementsBySlice({});
      setShowDiagnosis(false);
      setShowAnnotations(false);
      setIsPedagogicalPanelOpen(false);
    }
  }, [archive]);

  const handleJumpToKeySlice = useCallback(
    (revealAnnotations: boolean = true) => {
      const targetSeriesId = effectiveKeySeriesId || activeSeriesId;
      if (targetSeriesId && archive.seriesMap[targetSeriesId]) {
        setActiveSeriesId(targetSeriesId);
        const targetManifest = archive.seriesMap[targetSeriesId].manifest;
        if (
          archive.manifest.keyWindowKey &&
          targetManifest.availableWindows.some((w) => w.key === archive.manifest.keyWindowKey)
        ) {
          setActiveWindowKey(archive.manifest.keyWindowKey);
        }
        const safeSlice = Math.max(
          0,
          Math.min(targetManifest.sliceCount - 1, effectiveKeySliceIndex)
        );
        setSliceIndex(safeSlice);
      }
      if (revealAnnotations) {
        setShowAnnotations(true);
      }
    },
    [archive, effectiveKeySeriesId, effectiveKeySliceIndex, activeSeriesId]
  );

  // Pont API postMessage bidirectionnel
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
      setSliceIndex(0);
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
      } else if (key === 'f') {
        setWindowToolActive((prev) => {
          const next = !prev;
          if (next) setRulerActive(false);
          return next;
        });
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

  const getCanvasTransform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !seriesManifest) {
      return { scale: 1, offsetX: 0, offsetY: 0 };
    }
    const cw = canvas.width;
    const ch = canvas.height;
    const iw = seriesManifest.width;
    const ih = seriesManifest.height;

    const baseScale = Math.min(cw / iw, ch / ih) * 0.94;
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
    ctx.clearRect(0, 0, cw, ch);

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
      ctx.fillStyle = '#000000';
      ctx.fillRect(
        offsetX,
        offsetY,
        seriesManifest.width * scale,
        seriesManifest.height * scale
      );
      ctx.drawImage(
        bitmap,
        offsetX,
        offsetY,
        seriesManifest.width * scale,
        seriesManifest.height * scale
      );
      ctx.restore();
    }

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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const ro = new ResizeObserver(() => {
      setPan((p) => ({ ...p }));
    });
    ro.observe(viewport);
    return () => ro.disconnect();
  }, []);

  // Gestion native { passive: false } du Trackpad sur Ordinateur
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
      e.preventDefault();
      e.stopPropagation();

      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = Math.exp(-e.deltaY * 0.012);
        applyCursorCenteredZoom(zoomFactor, e.clientX, e.clientY);
        return;
      }

      const THRESHOLD_PX = 15;
      wheelDeltaAccumulatorRef.current += e.deltaY;

      if (Math.abs(wheelDeltaAccumulatorRef.current) >= THRESHOLD_PX) {
        const steps = Math.trunc(wheelDeltaAccumulatorRef.current / THRESHOLD_PX);
        const clampedStep = Math.sign(steps) * Math.min(2, Math.abs(steps));
        wheelDeltaAccumulatorRef.current -= steps * THRESHOLD_PX;
        changeSlice(sliceIndex + clampedStep, false);
      }
    };

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

    const preventGlobalPagePinch = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    };

    const preventTouchScroll = (e: TouchEvent) => {
      e.preventDefault();
    };

    viewport.addEventListener('wheel', handleNativeWheel, { passive: false });
    viewport.addEventListener('touchmove', preventTouchScroll, { passive: false });
    viewport.addEventListener('gesturestart', handleGestureStart, { passive: false });
    viewport.addEventListener('gesturechange', handleGestureChange, { passive: false });
    viewport.addEventListener('gestureend', handleGestureEnd, { passive: false });
    window.addEventListener('wheel', preventGlobalPagePinch, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', handleNativeWheel);
      viewport.removeEventListener('touchmove', preventTouchScroll);
      viewport.removeEventListener('gesturestart', handleGestureStart);
      viewport.removeEventListener('gesturechange', handleGestureChange);
      viewport.removeEventListener('gestureend', handleGestureEnd);
      window.removeEventListener('wheel', preventGlobalPagePinch);
    };
  }, [sliceIndex, changeSlice]);

  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isScrubbingRef.current) return;
    // Empêche le défilement automatique du navigateur lors du clic molette (bouton du milieu = 1)
    if (e.button === 1) {
      e.preventDefault();
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Certaines implémentations mobiles n'acceptent pas setPointerCapture sur touch
    }
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hasWindowDraggedRef.current = false;

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

    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };

      if (lastPinchMidRef.current) {
        const dMidX = mid.x - lastPinchMidRef.current.x;
        const dMidY = mid.y - lastPinchMidRef.current.y;
        setPan((p) => ({
          x: p.x + dMidX * dpr,
          y: p.y + dMidY * dpr,
        }));
      }

      if (lastPinchDistRef.current && lastPinchDistRef.current > 8) {
        const ratio = dist / lastPinchDistRef.current;
        setZoom((z) => Math.max(0.4, Math.min(8, z * ratio)));
      }

      lastPinchDistRef.current = dist;
      lastPinchMidRef.current = mid;
      return;
    }

    const prevPos = lastDragPosRef.current;
    if (!prevPos) return;
    const dx = e.clientX - prevPos.x;
    const dy = e.clientY - prevPos.y;
    lastDragPosRef.current = { x: e.clientX, y: e.clientY };

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

    // Fenêtrage interactif (Contraste horizontal / Luminosité verticale) :
    // - Soit en maintenant le clic molette ((e.buttons & 4) !== 0)
    // - Soit lorsque le bouton "Fenêtrage" (windowToolActive) est activé (clic-glisser souris ou pan 1 doigt sur téléphone)
    // - Soit en maintenant la touche W
    if (
      activeKeyMode === 'w' ||
      (e.buttons & 4) !== 0 ||
      windowToolActive
    ) {
      if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
        hasWindowDraggedRef.current = true;
      }
      setContrast((c) => Math.max(0.3, Math.min(3.0, c + dx * 0.006)));
      setBrightness((b) => Math.max(0.3, Math.min(2.5, b - dy * 0.006)));
      return;
    }

    if (activeKeyMode === 'z') {
      setZoom((z) => Math.max(0.4, Math.min(8, z * (1 - dy * 0.008))));
      return;
    }

    // Sur ordinateur (souris) : clic gauche maintenu (ou clic droit / Espace) = Pan (déplacement de l'image)
    if (
      activeKeyMode === 'space' ||
      (e.buttons & 2) !== 0 ||
      (!rulerActive && !windowToolActive && e.pointerType === 'mouse' && (e.buttons & 1) !== 0)
    ) {
      setPan((p) => ({
        x: p.x + dx * dpr,
        y: p.y + dy * dpr,
      }));
      return;
    }

    // Sur tactile (téléphone / tablette) : 1 doigt fait défiler les coupes
    if (!rulerActive && !windowToolActive && e.pointerType === 'touch') {
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
      const remaining = Array.from(activePointersRef.current.values())[0];
      lastDragPosRef.current = { x: remaining.x, y: remaining.y };
      touchScrollAccumulatorRef.current = 0;
    } else if (activePointersRef.current.size === 0) {
      lastDragPosRef.current = null;
      touchScrollAccumulatorRef.current = 0;
      if (windowToolActive && hasWindowDraggedRef.current) {
        setWindowToolActive(false);
        hasWindowDraggedRef.current = false;
      }
    }
    setActiveDragHandle(null);
    setCreatingMeasureId(null);
  };

  const handleViewportPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      lastPinchDistRef.current = null;
      lastPinchMidRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      lastDragPosRef.current = null;
      touchScrollAccumulatorRef.current = 0;
    }
    setActiveDragHandle(null);
    setCreatingMeasureId(null);
  };

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

  const progressRatio =
    seriesManifest && seriesManifest.sliceCount > 1
      ? sliceIndex / (seriesManifest.sliceCount - 1)
      : 0;

  return (
    <div
      className="relative w-full h-full flex flex-col bg-black text-slate-100 select-none overflow-hidden"
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

      {/* CONTENEUR PRINCIPAL : ZONE D'IMAGE + VOLET PÉDAGOGIQUE PLIABLE À DROITE */}
      <div className="relative flex-1 min-h-0 w-full flex bg-black overflow-hidden">
        {/* ZONE D'IMAGE CENTRALE PLEIN ÉCRAN */}
        <div
          ref={viewportRef}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={handleViewportPointerUp}
          onPointerCancel={handleViewportPointerCancel}
          style={{
            touchAction: 'none',
            overscrollBehavior: 'none',
            WebkitUserSelect: 'none',
          }}
          className={`relative flex-1 min-w-0 min-h-0 h-full bg-black overflow-hidden touch-none ${
            rulerActive
              ? 'cursor-crosshair'
              : activeKeyMode === 'space'
              ? 'cursor-grabbing'
              : windowToolActive || activeKeyMode === 'w'
              ? 'cursor-move'
              : activeKeyMode === 'z'
              ? 'cursor-zoom-in'
              : 'cursor-grab active:cursor-grabbing'
          }`}
        >
          <canvas
            ref={canvasRef}
            style={
              contrast !== 1.0 || brightness !== 1.0
                ? {
                    filter: `brightness(${Math.round(brightness * 100)}%) contrast(${Math.round(
                      contrast * 100
                    )}%)`,
                    WebkitFilter: `brightness(${Math.round(
                      brightness * 100
                    )}%) contrast(${Math.round(contrast * 100)}%)`,
                  }
                : undefined
            }
            className="w-full h-full block"
          />

          {/* HUD Ultra-Compact en haut à gauche */}
          {seriesManifest && (
            <div className="absolute top-2.5 left-2.5 pointer-events-none flex items-center gap-2 bg-slate-950/75 backdrop-blur border border-slate-800/80 rounded-lg px-2.5 py-1 text-xs font-mono shadow">
              <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold text-[10px]">
                {seriesManifest.modality}
              </span>
              <span className="text-white font-semibold">
                {sliceIndex + 1} / {seriesManifest.sliceCount}
              </span>
              {zoom !== 1 && (
                <span className="text-[11px] text-amber-300">{zoom.toFixed(1)}×</span>
              )}
              {(contrast !== 1 || brightness !== 1 || windowToolActive) && (
                <span className="text-[10px] text-cyan-300">
                  C:{Math.round(contrast * 100)}% L:{Math.round(brightness * 100)}%
                </span>
              )}
            </div>
          )}

          {/* SCRUB BAR LATÉRALE DROITE (Plus fine et compacte sur téléphone) */}
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
            className="w-4 sm:w-8 h-[50%] sm:h-[68%] absolute right-1 sm:right-1.5 top-1/2 -translate-y-1/2 z-20 rounded-full bg-slate-950/65 sm:bg-slate-950/80 backdrop-blur border border-slate-800/80 hover:border-cyan-500/50 shadow-xl flex flex-col items-center justify-between py-1.5 sm:py-2.5 cursor-ns-resize select-none"
          >
            <div className="text-[8px] sm:text-[10px] font-mono font-bold text-cyan-300 leading-none">
              {sliceIndex + 1}
            </div>

            <div className="relative flex-1 w-1 sm:w-1.5 my-1 sm:my-2 bg-slate-800/90 rounded-full">
              <div
                style={{ height: `${progressRatio * 100}%` }}
                className="w-full bg-cyan-400 rounded-full transition-none"
              />
              <div
                style={{ top: `${progressRatio * 100}%` }}
                className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2 sm:w-5 sm:h-3 rounded-full bg-cyan-300 border border-slate-950 shadow"
              />
            </div>

            <div className="text-[8px] sm:text-[10px] font-mono text-slate-500 leading-none">
              {seriesManifest?.sliceCount || 1}
            </div>
          </div>
        </div>

        {/* VOLET PÉDAGOGIQUE PLIABLE À DROITE (Clinique, Coupe Clé, Annotations & Diagnostic masqué/révélé) */}
        {isPedagogicalPanelOpen && (
          <aside className="w-64 sm:w-72 h-full bg-[#0B101B]/95 backdrop-blur-md border-l border-slate-800 p-3.5 overflow-y-auto flex flex-col gap-3 z-30 absolute right-0 top-0 bottom-0 md:static shrink-0 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <GraduationCap className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-xs font-bold text-white truncate">
                  {archive.manifest.title || 'Cas Pédagogique'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsPedagogicalPanelOpen(false)}
                className="p-1 rounded text-slate-400 hover:text-white cursor-pointer"
                title="Replier le volet pédagogique"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>

            {archive.manifest.anatomicalRegion && (
              <div className="flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-[10px]">
                  {archive.manifest.modality}
                </span>
                <span className="text-xs text-slate-300 truncate">
                  {archive.manifest.anatomicalRegion}
                </span>
              </div>
            )}

            {/* Contexte Clinique */}
            <div className="space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Contexte Clinique
              </div>
              <p className="text-xs text-slate-200 leading-snug bg-slate-900/70 p-2.5 rounded-lg border border-slate-800/80">
                {archive.manifest.clinicalHistory || 'Aucun renseignement clinique spécifié dans ce .tpack.'}
              </p>
            </div>

            {/* Révélation de la Réponse, Coupe Clé & Annotations (masqués par défaut) */}
            <div className="space-y-2.5 pt-2 border-t border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  const next = !showDiagnosis;
                  setShowDiagnosis(next);
                  setShowAnnotations(next);
                  if (next) {
                    handleJumpToKeySlice(true);
                  }
                }}
                className="w-full py-2 px-2.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                {showDiagnosis ? (
                  <>
                    <EyeOff className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Masquer réponse &amp; annotations</span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Révéler réponse &amp; annotations</span>
                  </>
                )}
              </button>

              {showDiagnosis && (
                <div className="space-y-2.5">
                  <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-xs text-emerald-100 leading-snug whitespace-pre-line">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">
                      Diagnostic &amp; Réponse
                    </div>
                    {archive.manifest.diagnosis ||
                      'Aucun diagnostic textuel enregistré dans ce fichier .tpack.'}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleJumpToKeySlice(true)}
                    className="w-full py-1.5 px-2.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Aller à la Coupe Clé (#{effectiveKeySliceIndex + 1})</span>
                  </button>

                  {annotatedSlicesList.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Annotations ({annotatedSlicesList.length})
                      </div>
                      {annotatedSlicesList.map((ann, idx) => (
                        <button
                          key={`${ann.seriesId}_${ann.sliceIndex}_${idx}`}
                          type="button"
                          onClick={() => {
                            setActiveSeriesId(ann.seriesId);
                            setSliceIndex(ann.sliceIndex);
                            setShowAnnotations(true);
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 flex items-center justify-between gap-1 cursor-pointer"
                        >
                          <span className="truncate">{ann.label}</span>
                          <span className="text-[10px] font-mono text-cyan-400 shrink-0">
                            #{ann.sliceIndex + 1}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* BARRE DE CHOIX DES SÉQUENCES (AU-DESSUS DE LA BARRE D'OUTILS) */}
      {seriesList.length > 0 && (
        <div className="w-full bg-[#090D16] border-t border-slate-800/80 px-2.5 py-1.5 flex items-center gap-1.5 z-20 shrink-0 overflow-x-auto">
          {seriesList.map((s) => {
            const isActive = activeSeriesId === s.id;
            const cleanSeqName =
              s.description.replace(/^S?\d+\s*[—\-:_]\s*/i, '').trim() || s.description;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => handleSelectSeries(s.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer shrink-0 ${
                  isActive
                    ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-sm'
                    : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white hover:border-slate-700'
                }`}
                title={`${cleanSeqName} (${s.sliceCount} coupes)`}
              >
                {cleanSeqName}
              </button>
            );
          })}
        </div>
      )}

      {/* BARRE D'OUTILS INFÉRIEURE */}
      <div
        style={{
          paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))',
        }}
        className="w-full bg-[#0B101B] border-t border-slate-800/90 px-2.5 pt-2 flex items-center justify-between gap-2 z-20 shrink-0 overflow-x-auto"
      >
        <div className="flex items-center gap-2 min-w-0">
          {/* Switch Fenêtres (Os / Mou) s'il y a plusieurs fenêtres pré-calculées */}
          {seriesManifest && seriesManifest.availableWindows.length > 1 && (
            <div className="flex items-center bg-slate-900 p-0.5 rounded-lg border border-slate-800 shrink-0">
              {seriesManifest.availableWindows.map((win) => {
                const isActive = activeWindowKey === win.key;
                const shortLabel =
                  win.key === 'bone'
                    ? 'Os'
                    : win.key === 'soft'
                    ? 'Mou'
                    : win.label.split(' ')[0];
                return (
                  <button
                    key={win.key}
                    type="button"
                    onClick={() => setActiveWindowKey(win.key)}
                    className={`px-2.5 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                      isActive
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {shortLabel}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Outils regroupés à droite : Fenêtrage (Soleil), Fenêtre de base (Soleil + A), Annotations, Info Clinique (Logo seul) */}
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {/* Bouton Outil Fenêtrage (Soleil seul) */}
          <button
            type="button"
            onClick={() =>
              setWindowToolActive((prev) => {
                const next = !prev;
                if (next) setRulerActive(false);
                return next;
              })
            }
            className={`w-10 h-10 rounded-xl flex items-center justify-center border transition cursor-pointer shrink-0 ${
              windowToolActive
                ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200 shadow-lg shadow-cyan-500/15'
                : 'bg-slate-900 border-slate-800 text-cyan-400 hover:bg-slate-800 hover:text-cyan-300'
            }`}
            title="Activer le Fenêtrage (ou clic molette maintenu sur l'image)"
            aria-label="Fenêtrage"
          >
            <SunMedium className="w-5 h-5" />
          </button>

          {/* Bouton Remettre la Fenêtre de base (Soleil + A) */}
          <button
            type="button"
            onClick={() => {
              setContrast(1.0);
              setBrightness(1.0);
              setWindowToolActive(false);
            }}
            className={`h-10 px-2.5 rounded-xl flex items-center justify-center gap-0.5 border transition cursor-pointer shrink-0 ${
              contrast === 1 && brightness === 1
                ? 'bg-slate-900 border-slate-800 text-slate-400 hover:bg-slate-800 hover:text-cyan-300'
                : 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/25'
            }`}
            title="Remettre le fenêtrage de base (Auto)"
            aria-label="Fenêtrage de base Auto"
          >
            <SunMedium className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-extrabold font-mono leading-none">A</span>
          </button>

          <button
            type="button"
            onClick={() => setIsPedagogicalPanelOpen((prev) => !prev)}
            className={`w-10 h-10 rounded-xl border flex items-center justify-center transition cursor-pointer shrink-0 ${
              isPedagogicalPanelOpen
                ? 'bg-emerald-500/25 border-emerald-400 text-emerald-200 shadow-lg shadow-emerald-500/15'
                : 'bg-slate-900 border-slate-700 text-emerald-400 hover:bg-slate-800 hover:border-emerald-500/50 hover:text-emerald-300'
            }`}
            title="Afficher / Masquer l'information clinique et le diagnostic"
            aria-label="Info Clinique"
          >
            <GraduationCap className="w-5 h-5" />
          </button>
        </div>
      </div>
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
