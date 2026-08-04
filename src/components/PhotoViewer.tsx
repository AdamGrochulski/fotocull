import { useCallback, useEffect, useRef, useState } from "react";
import "./PhotoViewer.css";

interface PhotoViewerProps {
  /** Object URL of the JPG to inspect. */
  src: string;
  /** Base name (for the empty/error label). */
  label: string;
}

const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;
/** Cap the focus-peaking analysis resolution (longest side) for speed. */
const PEAK_MAX_SIDE = 1600;
/** Sobel gradient magnitude above which a pixel counts as a focused edge. */
const PEAK_THRESHOLD = 52;

/** How far the image may be panned past a frame edge, as a fraction of viewport. */
const OVERSCROLL = 0.12;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Canvas 2D photo inspector: fit / 100% / cursor-anchored wheel zoom / drag pan.
 *
 * "inspect = photo first": the image sits on a neutral near-black ground with no
 * colour cast, so exposure and white balance can be judged honestly. Focus peaking
 * paints green only where edges are sharp, and is an opt-in overlay (default OFF) —
 * never on while you're reading the raw photo.
 */
export function PhotoViewer({ src, label }: PhotoViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // View transform, in CSS pixels: screen = offset + imagePx * scale.
  const view = useRef({ scale: 1, offsetX: 0, offsetY: 0, fit: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [peaking, setPeaking] = useState(false);
  const [peakBuilt, setPeakBuilt] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  // Peaking is read inside draw() via a ref so draw() stays identity-stable.
  // (If draw depended on the peaking state, its identity would cascade into
  // fitToView and re-fire the image-load effect, resetting the toggle.)
  const peakingRef = useRef(false);

  // --- drawing -------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }

    const { scale, offsetX, offsetY } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    ctx.imageSmoothingEnabled = scale < 1;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
    ctx.drawImage(img, 0, 0);

    if (peakingRef.current && overlayRef.current) {
      // Overlay is analysed at a capped resolution; stretch it over the image rect.
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(overlayRef.current, 0, 0, img.naturalWidth, img.naturalHeight);
    }
  }, []);

  const applyView = useCallback(
    (next: Partial<typeof view.current>) => {
      const merged = { ...view.current, ...next };
      // Pan clamp, per axis: if the scaled image fits within the canvas on that
      // axis it locks centred; if it's larger you can pan its edges to the frame
      // border, plus a small overscroll for comfort — never enough to lose it.
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (canvas && img) {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        const iw = img.naturalWidth * merged.scale;
        const ih = img.naturalHeight * merged.scale;
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
      }
      view.current = merged;
      setZoomPct(Math.round(view.current.scale * 100));
      draw();
    },
    [draw],
  );

  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const fit = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    applyView({
      scale: fit,
      fit,
      offsetX: (cw - img.naturalWidth * fit) / 2,
      offsetY: (ch - img.naturalHeight * fit) / 2,
    });
  }, [applyView]);

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

  // --- image load ----------------------------------------------------------
  useEffect(() => {
    setReady(false);
    setError(false);
    setPeaking(false);
    peakingRef.current = false;
    setPeakBuilt(false);
    overlayRef.current = null;

    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      setReady(true);
      fitToView();
    };
    img.onerror = () => !cancelled && setError(true);
    img.src = src;

    return () => {
      cancelled = true;
      imgRef.current = null;
    };
  }, [src, fitToView]);

  // Redraw on container resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (imgRef.current) draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // --- focus peaking (built lazily on first toggle) ------------------------
  const buildPeaking = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const s = Math.min(1, PEAK_MAX_SIDE / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * s));
    const h = Math.max(1, Math.round(ih * s));

    const sample = document.createElement("canvas");
    sample.width = w;
    sample.height = h;
    const sctx = sample.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    sctx.drawImage(img, 0, 0, w, h);
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
    setPeakBuilt(true);
  }, []);

  function togglePeaking() {
    const next = !peaking;
    if (next && !peakBuilt) buildPeaking();
    peakingRef.current = next;
    setPeaking(next);
    draw();
  }

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
      ) : !ready ? (
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
        </div>
      )}
    </div>
  );
}
