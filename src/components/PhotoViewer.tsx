import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { frameSize, originalFrames, previewFrames, thumbFrames, type Frame } from "../lib/frames";
import "./PhotoViewer.css";

interface PhotoViewerProps {
  /** Cached ~2560 px preview: what the viewer normally draws. */
  previewSrc?: string;
  /** Cached thumbnail, drawn as an instant placeholder until the preview is in. */
  thumbSrc?: string;
  /** Original JPG, decoded only when zooming past the preview's detail. */
  originalSrc?: string;
  /** Upright size of the original: the viewer's coordinate space. */
  width?: number;
  height?: number;
  /** EXIF orientation of the original (for webviews that ignore it). */
  orientation?: number | null;
  /** Base name (for labels). */
  label: string;
  /** Keep zoom and position when the photo changes (to compare a burst). */
  lockView?: boolean;
  /** Shows a lock toggle in the toolbar when given. */
  onToggleLock?: () => void;
}

/** Imperative controls, driven by the review screen's keyboard shortcuts. */
export interface PhotoViewerHandle {
  fit: () => void;
  actual: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  togglePeaking: () => void;
}

const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;
/** Cap the focus-peaking analysis resolution (longest side) for speed. */
const PEAK_MAX_SIDE = 1600;
/** Sobel gradient magnitude above which a pixel counts as a focused edge. */
const PEAK_THRESHOLD = 52;
/** Load the original once the screen shows more detail than the preview has. */
const ORIGINAL_NEEDED_AT = 1.05;
/** Dwelling on a photo this long pre-decodes its original for a quick zoom. */
const ORIGINAL_DWELL_MS = 900;
/** Only show the spinner if the photo takes longer than this to appear. */
const SPINNER_DELAY_MS = 180;

/** How far the image may be panned past a frame edge, as a fraction of viewport. */
const OVERSCROLL = 0.12;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** View shared across photos while the zoom is locked: scale + centre point. */
const locked = { scale: 0, cx: 0.5, cy: 0.5 };

/**
 * Canvas 2D photo inspector: fit / 100% / cursor-anchored wheel zoom / drag pan.
 *
 * It stays mounted while the photo changes: the next photo's decoded preview
 * usually sits in the frame cache already, so switching is a redraw. Until it
 * arrives the thumbnail is drawn scaled up, so the right photo is on screen at
 * once, never the previous one. The original is decoded only for deep zoom.
 *
 * "inspect = photo first": the image sits on a neutral near-black ground with no
 * colour cast, so exposure and white balance can be judged honestly. Focus peaking
 * paints green only where edges are sharp, and is an opt-in overlay (default OFF).
 */
export const PhotoViewer = forwardRef<PhotoViewerHandle, PhotoViewerProps>(
  function PhotoViewer(
    {
      previewSrc,
      thumbSrc,
      originalSrc,
      width,
      height,
      orientation,
      label,
      lockView,
      onToggleLock,
    },
    ref,
  ) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // What is drawn: the best frame available for the current photo.
  const frames = useRef<{ thumb?: Frame; preview?: Frame; original?: Frame }>({});
  // Coordinate space = upright original size, so frames of any resolution
  // swap in without moving the view.
  const dims = useRef({ w: 0, h: 0 });

  // View transform, in CSS pixels: screen = offset + imagePx * scale.
  const view = useRef({ scale: 1, offsetX: 0, offsetY: 0, fit: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const [ready, setReady] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false);
  const [error, setError] = useState(false);
  const [peaking, setPeaking] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  // Peaking is read inside draw() via a ref so draw() stays identity-stable.
  const peakingRef = useRef(false);
  const lockRef = useRef(!!lockView);
  lockRef.current = !!lockView;
  const originalSrcRef = useRef(originalSrc);
  originalSrcRef.current = originalSrc;

  // --- drawing -------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const { w, h } = dims.current;
    const f = frames.current;
    const { scale, offsetX, offsetY } = view.current;
    // The original only once it's needed for detail; the thumb as a stand-in.
    const deep = scale * dpr > previewDensity() * ORIGINAL_NEEDED_AT;
    const frame = (deep && f.original) || f.preview || f.original || f.thumb;
    if (!frame || !w || !h) return;

    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
    // Pixel-exact when magnifying the original, smooth otherwise.
    ctx.imageSmoothingEnabled = frame !== f.original || scale < 1;
    ctx.imageSmoothingQuality = "high";
    drawUpright(ctx, frame, w, h, orientation);

    if (peakingRef.current && overlayRef.current) {
      // Overlay is analysed at a capped resolution; stretch it over the image rect.
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(overlayRef.current, 0, 0, w, h);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orientation]);

  /** Preview pixels per original pixel (1 when there's no preview yet). */
  function previewDensity() {
    const p = frames.current.preview;
    if (!p || !dims.current.w) return 1;
    const { w, h } = frameSize(p);
    return Math.max(w, h) / Math.max(dims.current.w, dims.current.h);
  }

  const applyView = useCallback(
    (next: Partial<typeof view.current>) => {
      const merged = { ...view.current, ...next };
      // Pan clamp, per axis: if the scaled image fits within the canvas on that
      // axis it locks centred; if it's larger you can pan its edges to the frame
      // border, plus a small overscroll for comfort — never enough to lose it.
      const canvas = canvasRef.current;
      const { w, h } = dims.current;
      if (canvas && w && h) {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const iw = w * merged.scale;
        const ih = h * merged.scale;
        if (iw <= cw) {
          merged.offsetX = (cw - iw) / 2;
        } else {
          const slack = cw * OVERSCROLL;
          merged.offsetX = clamp(merged.offsetX, cw - iw - slack, slack);
        }
        if (ih <= ch) {
          merged.offsetY = (ch - ih) / 2;
        } else {
          const slack = ch * OVERSCROLL;
          merged.offsetY = clamp(merged.offsetY, ch - ih - slack, slack);
        }
        // Remember where we are, so a locked view carries to the next photo.
        locked.scale = merged.scale;
        locked.cx = (cw / 2 - merged.offsetX) / iw;
        locked.cy = (ch / 2 - merged.offsetY) / ih;
      }
      view.current = merged;
      setZoomPct(Math.round(view.current.scale * 100));
      if (
        view.current.scale * (window.devicePixelRatio || 1) >
        previewDensity() * ORIGINAL_NEEDED_AT
      ) {
        loadOriginal();
      }
      draw();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draw],
  );

  const fitScale = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h } = dims.current;
    if (!canvas || !w || !h) return 1;
    return Math.min(canvas.clientWidth / w, canvas.clientHeight / h);
  }, []);

  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h } = dims.current;
    if (!canvas || !w || !h) return;
    const fit = fitScale();
    applyView({
      scale: fit,
      fit,
      offsetX: (canvas.clientWidth - w * fit) / 2,
      offsetY: (canvas.clientHeight - h * fit) / 2,
    });
  }, [applyView, fitScale]);

  /** Restore the shared locked view (same scale, same relative centre). */
  const applyLocked = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h } = dims.current;
    if (!canvas || !w || !h || !locked.scale) return fitToView();
    const fit = fitScale();
    const scale = locked.scale;
    applyView({
      fit,
      scale,
      offsetX: canvas.clientWidth / 2 - locked.cx * w * scale,
      offsetY: canvas.clientHeight / 2 - locked.cy * h * scale,
    });
  }, [applyView, fitScale, fitToView]);

  const zoomAround = useCallback(
    (mx: number, my: number, factor: number) => {
      const { scale, offsetX, offsetY, fit } = view.current;
      const min = Math.min(fit, 1);
      const target = Math.max(min, Math.min(MAX_SCALE, scale * factor));
      if (target === scale) return;
      const ix = (mx - offsetX) / scale;
      const iy = (my - offsetY) / scale;
      applyView({
        scale: target,
        offsetX: mx - ix * target,
        offsetY: my - iy * target,
      });
    },
    [applyView],
  );

  const zoomCentered = useCallback(
    (factorOrScale: number, absolute = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      if (absolute) {
        const { scale } = view.current;
        zoomAround(cx, cy, factorOrScale / scale);
      } else {
        zoomAround(cx, cy, factorOrScale);
      }
    },
    [zoomAround],
  );

  // --- original (deep zoom) ------------------------------------------------
  const loadingOriginal = useRef<string | null>(null);
  function loadOriginal() {
    const src = originalSrcRef.current;
    if (!src || frames.current.original || loadingOriginal.current === src) return;
    loadingOriginal.current = src;
    originalFrames
      .load(src)
      .then((frame) => {
        if (originalSrcRef.current !== src) return;
        frames.current.original = frame;
        draw();
      })
      .catch(() => {
        /* stay on the preview */
      });
  }

  // --- photo change ----------------------------------------------------------
  // Runs when the photo (its preview) changes. Whatever is already decoded is
  // drawn in this same frame; the rest streams in.
  useEffect(() => {
    let cancelled = false;
    setError(false);
    setPeaking(false);
    peakingRef.current = false;
    overlayRef.current = null;
    loadingOriginal.current = null;

    const w = width ?? 0;
    const h = height ?? 0;
    const sameSize = dims.current.w === w && dims.current.h === h;
    dims.current = { w, h };
    frames.current = {
      thumb: thumbSrc ? thumbFrames.peek(thumbSrc) : undefined,
      preview: previewSrc ? previewFrames.peek(previewSrc) : undefined,
      original: originalSrc ? originalFrames.peek(originalSrc) : undefined,
    };

    const placeView = () => {
      if (lockRef.current && sameSize) applyLocked();
      else fitToView();
    };
    const hasSomething = () => !!(frames.current.preview || frames.current.thumb);
    if (w && h) placeView();
    setReady(hasSomething());
    setShowSpinner(false);
    const spinnerTimer = window.setTimeout(() => {
      if (!cancelled && !hasSomething()) setShowSpinner(true);
    }, SPINNER_DELAY_MS);

    if (thumbSrc && !frames.current.thumb) {
      thumbFrames
        .load(thumbSrc)
        .then((f) => {
          if (cancelled) return;
          frames.current.thumb = f;
          setReady(true);
          setShowSpinner(false);
          draw();
        })
        .catch(() => {});
    }
    if (previewSrc && !frames.current.preview) {
      previewFrames
        .load(previewSrc)
        .then((f) => {
          if (cancelled) return;
          frames.current.preview = f;
          setReady(true);
          setShowSpinner(false);
          draw();
        })
        .catch(() => !cancelled && setError(true));
    }

    // Dwelling on a photo: pre-decode its original so zooming in is instant.
    const dwell = window.setTimeout(() => !cancelled && loadOriginal(), ORIGINAL_DWELL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(spinnerTimer);
      window.clearTimeout(dwell);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSrc, thumbSrc, originalSrc, width, height]);

  // React to container resize (window resize, fullscreen toggle). If the view is
  // still at Fit, re-fit to the new size; if the user has zoomed in, keep their
  // scale but re-clamp the pan so nothing drifts out of bounds.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!dims.current.w) return;
      const { scale, fit } = view.current;
      if (Math.abs(scale - fit) < 1e-3) fitToView();
      else applyView({ fit: fitScale() });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitToView, applyView, fitScale]);

  // --- focus peaking (built lazily on toggle, from the preview) --------------
  const buildPeaking = useCallback(() => {
    const src = frames.current.preview ?? frames.current.thumb;
    const { w: iw, h: ih } = dims.current;
    if (!src || !iw || !ih) return false;
    const s = Math.min(1, PEAK_MAX_SIDE / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * s));
    const h = Math.max(1, Math.round(ih * s));

    const sample = document.createElement("canvas");
    sample.width = w;
    sample.height = h;
    const sctx = sample.getContext("2d", { willReadFrequently: true });
    if (!sctx) return false;
    sctx.scale(w / iw, h / ih);
    drawUpright(sctx, src, iw, ih, orientation);
    const data = sctx.getImageData(0, 0, w, h).data;

    // Luma buffer.
    const luma = new Float32Array(w * h);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }

    const out = new ImageData(w, h);
    const od = out.data;
    // Sobel gradient magnitude → green where sharp.
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx =
          -luma[i - w - 1] - 2 * luma[i - 1] - luma[i + w - 1] +
          luma[i - w + 1] + 2 * luma[i + 1] + luma[i + w + 1];
        const gy =
          -luma[i - w - 1] - 2 * luma[i - w] - luma[i - w + 1] +
          luma[i + w - 1] + 2 * luma[i + w] + luma[i + w + 1];
        const mag = Math.hypot(gx, gy);
        if (mag >= PEAK_THRESHOLD) {
          const p = i * 4;
          od[p] = 61; // --fc-green 3ddc84
          od[p + 1] = 220;
          od[p + 2] = 132;
          od[p + 3] = Math.min(255, 140 + (mag - PEAK_THRESHOLD));
        }
      }
    }

    const overlay = document.createElement("canvas");
    overlay.width = w;
    overlay.height = h;
    overlay.getContext("2d")!.putImageData(out, 0, 0);
    overlayRef.current = overlay;
    return true;
  }, [orientation]);

  const togglePeaking = useCallback(() => {
    const next = !peakingRef.current;
    if (next && !overlayRef.current && !buildPeaking()) return;
    peakingRef.current = next;
    setPeaking(next);
    draw();
  }, [buildPeaking, draw]);

  // Expose zoom/fit/peaking so the review screen's keyboard shortcuts can drive
  // the viewer without the toolbar.
  useImperativeHandle(
    ref,
    () => ({
      fit: fitToView,
      actual: () => zoomCentered(1, true),
      zoomIn: () => zoomCentered(ZOOM_STEP),
      zoomOut: () => zoomCentered(1 / ZOOM_STEP),
      togglePeaking,
    }),
    [fitToView, zoomCentered, togglePeaking],
  );

  // --- pointer interaction -------------------------------------------------
  function onWheel(e: React.WheelEvent) {
    if (!ready) return;
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    zoomAround(mx, my, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }
  function onPointerDown(e: React.PointerEvent) {
    if (!ready) return;
    drag.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    applyView({
      offsetX: view.current.offsetX + dx,
      offsetY: view.current.offsetY + dy,
    });
  }
  function onPointerUp(e: React.PointerEvent) {
    drag.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }
  function onDoubleClick(e: React.MouseEvent) {
    if (!ready) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Toggle between fit and 100%.
    if (view.current.scale > view.current.fit * 1.05) fitToView();
    else zoomAround(mx, my, 1 / view.current.scale);
  }

  return (
    <div className="pv" ref={containerRef}>
      {error ? (
        <div className="pv-msg">Could not load JPG preview.</div>
      ) : !ready && showSpinner ? (
        <div className="pv-msg">
          <div className="scan-spinner" aria-hidden />
        </div>
      ) : null}

      <canvas
        ref={canvasRef}
        className="pv-canvas"
        style={{ visibility: ready && !error ? "visible" : "hidden", cursor: drag.current ? "grabbing" : "grab" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onDoubleClick={onDoubleClick}
        aria-label={`Inspect ${label}`}
      />

      {ready && !error && (
        <div className="pv-toolbar" role="toolbar">
          <button className="pv-tool" onClick={() => zoomCentered(1 / ZOOM_STEP)} title="Zoom out">
            −
          </button>
          <span className="pv-zoom">{zoomPct}%</span>
          <button className="pv-tool" onClick={() => zoomCentered(ZOOM_STEP)} title="Zoom in">
            +
          </button>
          <span className="pv-sep" />
          <button className="pv-tool" onClick={fitToView} title="Fit to view">
            Fit
          </button>
          <button className="pv-tool" onClick={() => zoomCentered(1, true)} title="Actual pixels">
            100%
          </button>
          <span className="pv-sep" />
          <button
            className={`pv-tool pv-peak ${peaking ? "is-on" : ""}`}
            onClick={togglePeaking}
            title="Focus peaking — highlight sharp edges (off by default)"
            aria-pressed={peaking}
          >
            ◉ Peaking
          </button>
          {onToggleLock && (
            <button
              className={`pv-tool pv-lock ${lockView ? "is-on" : ""}`}
              onClick={onToggleLock}
              title="Keep zoom and position when moving to the next photo (L)"
              aria-pressed={!!lockView}
            >
              Lock
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Draw `frame` upright into the `w` x `h` box. Previews are stored upright; an
 * original is too in webviews that honour EXIF orientation. If a frame's
 * aspect doesn't match the box (EXIF ignored), rotate it here.
 */
function drawUpright(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  w: number,
  h: number,
  orientation?: number | null,
) {
  const { w: fw, h: fh } = frameSize(frame);
  const boxPortrait = h > w;
  const framePortrait = fh > fw;
  if (boxPortrait === framePortrait || (orientation !== 6 && orientation !== 8)) {
    ctx.drawImage(frame, 0, 0, w, h);
    return;
  }
  ctx.save();
  if (orientation === 6) {
    // Stored rotated 90° counter-clockwise: turn it clockwise.
    ctx.translate(w, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, h);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(frame, 0, 0, h, w);
  ctx.restore();
}
