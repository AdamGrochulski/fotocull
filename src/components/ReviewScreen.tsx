import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useAppState, COMPARE_MAX } from "../state/appStore";
import { sanitizeName } from "../lib/names";
import {
  assetUrl,
  exposureLabel,
  getPreview,
  requestPreviews,
  usePreview,
  usePreviewError,
  type PreviewInfo,
} from "../lib/previews";
import { previewFrames, thumbFrames } from "../lib/frames";
import { PhotoViewer, type PhotoViewerHandle } from "./PhotoViewer";
import { GridView } from "./GridView";
import type { MediaMeta, Photo } from "../types/photo";
import "./ReviewScreen.css";

/** Photos ahead of / behind the current one that get previews generated and
 * decoded in advance, so moving through them is a redraw, not a load. */
const PREFETCH_AHEAD = 6;
const PREFETCH_BEHIND = 3;

/** Zoom lock survives leaving and re-entering the single view. */
let zoomLockPref = false;

/**
 * Keep the photo at `index` and its neighbours ready: previews generated (the
 * current one first, on its own, so it never waits for the rest) and decoded
 * into the frame cache.
 */
function useNeighbourPrefetch(photos: Photo[], index: number) {
  useEffect(() => {
    let cancelled = false;
    const req = (p?: Photo) =>
      p?.hash && p.jpgPath ? [{ hash: p.hash, path: p.jpgPath }] : [];
    const ahead: Photo[] = [];
    for (let d = 1; d <= PREFETCH_AHEAD; d++) if (photos[index + d]) ahead.push(photos[index + d]);
    for (let d = 1; d <= PREFETCH_BEHIND; d++) if (photos[index - d]) ahead.push(photos[index - d]);

    const decode = (list: Photo[]) => {
      if (cancelled) return;
      const infos = list.map((p) => getPreview(p.hash)).filter((i): i is PreviewInfo => !!i);
      thumbFrames.prefetch(infos.map((i) => assetUrl(i.thumb)));
      previewFrames.prefetch(infos.map((i) => assetUrl(i.preview)));
    };
    void (async () => {
      await requestPreviews(req(photos[index]));
      decode([photos[index]]);
      await requestPreviews(ahead.flatMap(req));
      decode(ahead);
    })();
    return () => {
      cancelled = true;
    };
  }, [photos, index]);
}

/** Keys that decide or move between photos: ignored while auto-repeating. */
export const DECISION_KEYS = new Set([
  "ArrowRight", "ArrowLeft", " ", "a", "A", "x", "X", "Delete",
  "Backspace", "u", "U", "[", "]", "Enter",
]);

/** After a mouse click on Accept/Reject the button keeps focus, and the next
 * Enter or Space would press it again on the following photo. Drop it. */
export function releaseButtonFocus() {
  const el = document.activeElement;
  if (el instanceof HTMLButtonElement) el.blur();
}

export function ReviewScreen() {
  const { photos, reviewIndex, reviewMode } = useAppState();

  // The compare grid takes over the whole review area.
  if (reviewMode === "compare") {
    return <CompareView />;
  }
  if (reviewMode === "grid" && photos.length > 0) {
    return <GridView />;
  }

  // Past the last photo → review is complete.
  if (reviewIndex >= photos.length) {
    return <ReviewComplete />;
  }

  return <ReviewCard photo={photos[reviewIndex]} />;
}

function ReviewCard({ photo }: { photo: Photo }) {
  const {
    photos,
    reviewIndex,
    decisions,
    nameSuggestions,
    decideCurrent,
    reviewPrev,
    backToResult,
    reviewMode,
    compareSet,
    startCompareSelect,
    openCompare,
    cancelCompare,
    showGrid,
  } = useAppState();
  const selecting = reviewMode === "select";

  const existing = decisions[reviewIndex];
  const hasArw = !!photo.arwPath;
  const hasJpg = !!photo.jpgPath;

  const [includeArw, setIncludeArw] = useState(existing?.includeArw ?? false);
  const [newName, setNewName] = useState(existing?.newName ?? "");
  const [zoomLock, setZoomLock] = useState(zoomLockPref);
  const preview = usePreview(photo.hash);
  const previewError = usePreviewError(photo.hash);
  useNeighbourPrefetch(photos, reviewIndex);

  function toggleZoomLock() {
    setZoomLock((v) => (zoomLockPref = !v));
  }

  // Sync inputs when the photo changes (also when stepping back to an edited one).
  useEffect(() => {
    setIncludeArw(existing?.includeArw ?? false);
    setNewName(existing?.newName ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewIndex]);

  const viewerRef = useRef<PhotoViewerHandle>(null);

  function accept() {
    releaseButtonFocus();
    decideCurrent("accept", { includeArw, newName });
  }
  function reject() {
    releaseButtonFocus();
    decideCurrent("reject", { includeArw, newName });
  }

  // Latest handlers kept in refs so the window listener (mounted once) never
  // goes stale as includeArw / newName / mode change.
  const actions = useRef({
    accept,
    reject,
    toggleArw: () => {},
    compare: () => {},
    escape: () => {},
    toggleLock: () => {},
    grid: () => {},
  });
  actions.current = {
    accept,
    reject,
    toggleArw: () => hasArw && setIncludeArw((v) => !v),
    compare: () => (selecting ? openCompare() : startCompareSelect()),
    escape: () => selecting && cancelCompare(),
    toggleLock: toggleZoomLock,
    grid: () => !selecting && showGrid(),
  };

  // Global shortcuts. Photo controls (P/F/1/±) drive the PhotoViewer imperatively.
  // Suspended while a text field is focused — the rename input handles its own keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const v = viewerRef.current;
      // A held key auto-repeats; for decisions that would sweep through a
      // dozen photos in a second, so only the first press counts.
      if (e.repeat && DECISION_KEYS.has(e.key)) {
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case "ArrowRight":
        case " ": // Space
        case "a":
        case "A":
          e.preventDefault();
          actions.current.accept();
          break;
        case "ArrowLeft":
        case "x":
        case "X":
        case "Delete":
          e.preventDefault();
          actions.current.reject();
          break;
        case "Backspace":
        case "u":
        case "U":
          e.preventDefault();
          reviewPrev();
          break;
        case "r":
        case "R":
          e.preventDefault();
          actions.current.toggleArw();
          break;
        case "c":
        case "C":
          e.preventDefault();
          actions.current.compare();
          break;
        case "Escape":
          e.preventDefault();
          actions.current.escape();
          break;
        case "p":
        case "P":
          e.preventDefault();
          v?.togglePeaking();
          break;
        case "f":
        case "F":
          e.preventDefault();
          v?.fit();
          break;
        case "l":
        case "L":
          e.preventDefault();
          if (!e.repeat) actions.current.toggleLock();
          break;
        case "g":
        case "G":
          e.preventDefault();
          if (!e.repeat) actions.current.grid();
          break;
        case "1":
          e.preventDefault();
          v?.actual();
          break;
        case "+":
        case "=":
          e.preventDefault();
          v?.zoomIn();
          break;
        case "-":
        case "_":
          e.preventDefault();
          v?.zoomOut();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  return (
    <div className="review">
      <header className="review-top">
        <button className="fc-btn" onClick={backToResult}>
          ← Results
        </button>
        <div className="review-counter">
          <span className="review-counter__now">{reviewIndex + 1}</span>
          <span className="review-counter__sep">/</span>
          <span>{photos.length}</span>
        </div>
        <span className="review-top__right">
          <button
            className="fc-btn"
            onClick={showGrid}
            disabled={selecting}
            title="All photos in a grid, bursts stacked (G)"
          >
            ▦ Grid
          </button>
          <button
            className="fc-btn"
            onClick={startCompareSelect}
            disabled={selecting}
            title="Compare this frame with nearby ones (C)"
          >
            ⊞ Compare
          </button>
          <button
            className="fc-btn"
            onClick={reviewPrev}
            disabled={reviewIndex === 0}
            title="Previous (Backspace)"
          >
            Undo
          </button>
        </span>
      </header>

      <div className="review-progress">
        <i style={{ width: `${(reviewIndex / photos.length) * 100}%` }} />
      </div>

      {hasJpg ? (
        previewError ? (
          <div className="review-stage">
            <div className="review-noimg">Could not load JPG preview.</div>
          </div>
        ) : (
          <PhotoViewer
            ref={viewerRef}
            previewSrc={preview && assetUrl(preview.preview)}
            thumbSrc={preview && assetUrl(preview.thumb)}
            originalSrc={photo.jpgPath && assetUrl(photo.jpgPath)}
            width={preview?.width}
            height={preview?.height}
            orientation={photo.meta?.orientation}
            label={photo.baseName}
            lockView={zoomLock}
            onToggleLock={toggleZoomLock}
          />
        )
      ) : (
        <div className="review-stage">
          <div className="review-noimg">
            ARW only — no JPG preview.
            <br />
            Accepting will copy the RAW file.
          </div>
        </div>
      )}

      {selecting && (
        <div className="review-selectbar">
          <span className="review-selectbar__hint">
            Pick up to {COMPARE_MAX} frames to compare — click thumbnails below.
          </span>
          <span className="review-selectbar__count">
            {compareSet.length}/{COMPARE_MAX}
          </span>
          <button className="fc-btn" onClick={cancelCompare}>
            Cancel
          </button>
          <button
            className="fc-btn fc-btn--primary"
            onClick={openCompare}
            disabled={compareSet.length < 2}
            title={compareSet.length < 2 ? "Pick at least 2 frames" : "Open compare"}
          >
            Compare {compareSet.length} →
          </button>
        </div>
      )}

      <Filmstrip />

      <div className="review-info">
        <span className="review-name">{photo.baseName}</span>
        <ExifReadout exif={photo.meta} />
        <span className="review-meta__right">
          <QualityReadout preview={preview} hasJpg={hasJpg} />
          <span className="review-chips">
            <span className={`fc-chip ${hasJpg ? "" : "is-off"}`}>JPG</span>
            <span className={`fc-chip ${hasArw ? "fc-chip--raw" : "is-off"}`}>ARW</span>
          </span>
        </span>
      </div>

      <div className="review-bar">
        <label
          className={`review-toggle ${hasArw ? "" : "is-disabled"}`}
          title={hasArw ? "Copy the RAW file too (R)" : "This photo has no ARW"}
        >
          <input
            type="checkbox"
            checked={hasArw ? includeArw : false}
            disabled={!hasArw}
            onChange={(e) => setIncludeArw(e.currentTarget.checked)}
          />
          <span>+ ARW</span>
        </label>

        <RenameField
          value={newName}
          onChange={setNewName}
          suggestions={nameSuggestions}
          onAccept={accept}
          placeholder={`Rename… (default: ${photo.baseName})`}
        />

        {!selecting && (
          <>
            <button className="fc-btn fc-btn--reject review-btn" onClick={reject} title="Reject (← or X)">
              ← Reject
            </button>
            <button className="fc-btn fc-btn--primary review-btn" onClick={accept} title="Accept (→, A or Space)">
              Accept →
            </button>
          </>
        )}
      </div>

      <KeyLegend
        primary={[
          [["←", "X"], "reject"],
          [["→", "A"], "accept"],
          [["U"], "undo"],
          [["G"], "grid"],
          [["1"], "100%"],
        ]}
        more={[
          [["Space"], "accept"],
          [["Backspace"], "undo"],
          [["R"], "ARW"],
          [["C"], "compare"],
          [["P"], "peaking"],
          [["F"], "fit"],
          [["L"], "lock zoom"],
          [["+", "−"], "zoom"],
        ]}
      />
    </div>
  );
}

type KeyHint = [string[], string];

/** Whether the full shortcut list is open (survives photo changes). */
let showAllKeysPref = false;

/**
 * One quiet line of the main shortcuts; `?` (or the toggle) reveals the rest.
 * Keeps the photo as large as possible on small screens.
 */
export function KeyLegend({ primary, more }: { primary: KeyHint[]; more: KeyHint[] }) {
  const [all, setAll] = useState(showAllKeysPref);
  const toggle = () => setAll((v) => (showAllKeysPref = !v));
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "?" && !e.repeat) toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const hint = ([keys, label]: KeyHint) => (
    <span key={label + keys.join()}>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 && "/"}
          <kbd>{k}</kbd>
        </span>
      ))}{" "}
      {label}
    </span>
  );
  return (
    <div className="review-keys">
      {primary.map(hint)}
      {all && more.map(hint)}
      <button className="review-keys__more" onClick={toggle} title="All shortcuts (?)">
        {all ? "less" : "? more"}
      </button>
    </div>
  );
}

function ReviewComplete() {
  const {
    photos,
    videos,
    destDir,
    decisions,
    videoDecisions,
    reviewPrev,
    copyStage,
    copyProgress,
    runCopy,
    showGrid,
  } = useAppState();

  const accepted = decisions.filter((d) => d?.kind === "accept").length;
  const rejected = decisions.filter((d) => d?.kind === "reject").length;
  const withArw = decisions.filter((d) => d?.kind === "accept" && d.includeArw).length;
  const renamed = decisions.filter((d) => d?.kind === "accept" && d.newName).length;
  const videosAccepted = videoDecisions.filter((d) => d?.kind === "accept").length;
  const totalAccepted = accepted + videosAccepted;
  const hasVideos = videos.length > 0;

  return (
    <div className="review review--done">
      <h2>Review complete</h2>
      <p className="review-done-sub">Reviewed all {photos.length} photo(s).</p>

      <div className="scan-stats">
        <Stat label="Accepted" value={accepted} />
        <Stat label="Rejected" value={rejected} />
        <Stat label="With ARW" value={withArw} />
        <Stat label="Renamed" value={renamed} />
      </div>

      {copyStage === "idle" && (
        <>
          <p className="review-note">
            Accepted photos will be copied to <code>{destDir}</code> and recorded in
            the manifest. The source is never touched.
          </p>
          <div className="review-done-actions">
            <button className="fc-btn" onClick={reviewPrev}>
              ← Back to last photo
            </button>
            <button className="fc-btn" onClick={showGrid} disabled={photos.length === 0}>
              ▦ Look over in grid
            </button>
            <button
              className="fc-btn fc-btn--primary"
              onClick={runCopy}
              title={totalAccepted === 0 ? "Nothing to copy — finish the session" : "Copy accepted"}
            >
              {totalAccepted === 0 ? "Finish →" : `Copy ${totalAccepted} accepted →`}
            </button>
          </div>
          {hasVideos && videosAccepted > 0 && (
            <p className="review-note">
              Includes {videosAccepted} accepted video(s) from the Videos tab.
            </p>
          )}
        </>
      )}

      {copyStage === "copying" && (
        <div className="review-copying">
          <div className="scan-spinner" aria-hidden />
          <span>
            Copying {copyProgress?.done ?? 0} / {copyProgress?.total ?? totalAccepted}…
          </span>
        </div>
      )}
    </div>
  );
}

/** Compact exposure readout from the preview's clipping stats. Sharpness is
 * judged by eye via focus peaking, so no blur label here. */
function QualityReadout({ preview, hasJpg }: { preview?: PreviewInfo; hasJpg: boolean }) {
  if (!hasJpg) return null;
  if (!preview) {
    return <span className="review-quality review-quality--wait">analyzing…</span>;
  }
  const label = exposureLabel(preview);
  const tone = label === "ok" ? "good" : "warn";
  return (
    <span className="review-quality">
      <span
        className={`review-metric review-metric--${tone}`}
        title={`Clipped highlights ${preview.overPct.toFixed(1)}% · shadows ${preview.underPct.toFixed(1)}%`}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * Rename input with IDE-style autocomplete over previously used names.
 * ↑/↓ move the highlight, Tab or Enter accepts the highlighted suggestion, a
 * second Enter (dropdown closed) accepts the photo. Escape closes the list, then
 * blurs. Suggestions are prefix matches of what's typed.
 */
export function RenameField({
  value,
  onChange,
  suggestions,
  onAccept,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  onAccept: () => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return suggestions
      .filter((s) => s.toLowerCase().startsWith(q) && s.toLowerCase() !== q)
      .slice(0, 6);
  }, [value, suggestions]);

  const showList = open && matches.length > 0;
  // Characters a file name can't hold are replaced on save; say so up front.
  const typed = value.trim();
  const savedAs = sanitizeName(value);
  const showSavedAs = !!typed && savedAs !== typed;

  function choose(name: string) {
    onChange(name);
    setOpen(false);
    setHighlight(-1);
    inputRef.current?.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (showList) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlight((h) => (h + 1) % matches.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          setHighlight((h) => (h <= 0 ? matches.length - 1 : h - 1));
          return;
        case "Tab":
          if (highlight >= 0) {
            e.preventDefault();
            choose(matches[highlight]);
          }
          return;
        case "Enter":
          if (highlight >= 0) {
            e.preventDefault();
            choose(matches[highlight]);
            return;
          }
          break; // no highlight → fall through to accept the photo
        case "Escape":
          e.preventDefault();
          setOpen(false);
          setHighlight(-1);
          return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
      onAccept();
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
    }
  }

  return (
    <div className="review-rename">
      <input
        ref={inputRef}
        className="fc-input review-rename__input"
        type="text"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.currentTarget.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showSavedAs && (
        <span className="review-rename__hint" aria-live="polite">
          {savedAs ? `saved as “${savedAs}”` : "no usable name, original kept"}
        </span>
      )}
      {showList && (
        <ul className="review-suggest" role="listbox">
          {matches.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === highlight}
              className={`review-suggest__item ${i === highlight ? "is-active" : ""}`}
              // Mouse-down (not click) so it fires before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(name);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How many frames each side of the current one the filmstrip shows. */
const STRIP_RADIUS = 3;

/** Filmstrip of nearby frames (previous and next). In single mode, click any to
 * jump to it without a decision (scrub a burst). In select mode, click to pick
 * frames for comparison. In select mode the window widens so more frames of a
 * burst are reachable. */
function Filmstrip() {
  const { photos, reviewIndex, reviewMode, compareSet, goToReview, toggleComparePick } =
    useAppState();
  const selecting = reviewMode === "select";

  // Current frame in the middle, three each side.
  const start = Math.max(0, reviewIndex - STRIP_RADIUS);
  const end = Math.min(photos.length - 1, reviewIndex + STRIP_RADIUS);
  const items: number[] = [];
  for (let i = start; i <= end; i++) {
    if (photos[i]?.jpgPath) items.push(i);
  }
  if (items.length <= 1) return null;

  return (
    <div
      className={`review-strip ${selecting ? "is-selecting" : ""}`}
      role="list"
      aria-label="Nearby frames"
    >
      {items.map((i) => (
        <Thumb
          key={i}
          index={i}
          current={i === reviewIndex}
          picked={selecting && compareSet.includes(i)}
          onPick={() =>
            selecting ? toggleComparePick(i) : i !== reviewIndex && goToReview(i)
          }
        />
      ))}
    </div>
  );
}

function Thumb({
  index,
  current,
  picked,
  onPick,
}: {
  index: number;
  current: boolean;
  picked: boolean;
  onPick: () => void;
}) {
  const { photos, decisions } = useAppState();
  const photo = photos[index];
  const preview = usePreview(photo?.hash);
  const url = preview ? assetUrl(preview.thumb) : null;
  const btnRef = useRef<HTMLButtonElement>(null);

  // Keep the current frame scrolled into view as the window slides.
  useEffect(() => {
    if (current) btnRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [current]);

  const d = decisions[index];
  const tone =
    d?.kind === "accept" ? "is-accept" : d?.kind === "reject" ? "is-reject" : "";

  return (
    <button
      ref={btnRef}
      className={`review-thumb ${tone} ${current ? "is-current" : ""} ${
        picked ? "is-picked" : ""
      }`}
      role="listitem"
      aria-pressed={picked}
      onClick={onPick}
      title={`#${index + 1} ${photo?.baseName ?? ""}`}
    >
      {url ? (
        <img src={url} alt={photo?.baseName ?? ""} draggable={false} />
      ) : (
        <span className="review-thumb__ph" />
      )}
      <span className="review-thumb__no">{index + 1}</span>
      {picked && <span className="review-thumb__pick">✓</span>}
    </button>
  );
}

/** Shooting parameters strip: aperture · shutter · ISO · focal length · lens. */
function ExifReadout({ exif }: { exif?: MediaMeta | null }) {
  if (!exif) return null;
  const items: string[] = [];
  if (exif.aperture) items.push(exif.aperture);
  if (exif.shutter) items.push(exif.shutter);
  if (exif.iso) items.push(`ISO ${exif.iso}`);
  if (exif.focalLength) items.push(exif.focalLength);
  if (items.length === 0 && !exif.lens) return null;

  return (
    <div className="review-exif">
      {items.map((t, i) => (
        <span key={i} className="review-exif__item">
          {t}
        </span>
      ))}
      {exif.lens && (
        <span className="review-exif__lens" title={exif.lens}>
          {exif.lens}
        </span>
      )}
    </div>
  );
}

/** Side-by-side compare grid. Each cell is a full mini-inspector (zoom/pan/
 * peaking) with its own ARW toggle, rename and accept/reject. Decisions apply to
 * that specific frame and don't advance the main review. */
/** Synced zoom in compare survives reopening it. */
let compareSyncPref = true;

function CompareView() {
  const { compareSet, cancelCompare, finishCompare } = useAppState();
  const indices = [...compareSet].sort((a, b) => a - b);
  const [sync, setSync] = useState(compareSyncPref);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelCompare();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelCompare]);

  return (
    <div className="review compare">
      <header className="compare-top">
        <button className="fc-btn" onClick={cancelCompare} title="Back (Esc)">
          ← Back
        </button>
        <span className="compare-title">Comparing {indices.length} frames, decide each</span>
        <label className="review-toggle" title="Zoom and pan all frames together">
          <input
            type="checkbox"
            checked={sync}
            onChange={(e) => setSync((compareSyncPref = e.currentTarget.checked))}
          />
          <span>Sync zoom</span>
        </label>
        <button className="fc-btn fc-btn--primary" onClick={finishCompare}>
          Done →
        </button>
      </header>

      <div className="compare-grid" data-count={indices.length}>
        {indices.map((i) => (
          <CompareCell key={i} index={i} sync={sync} />
        ))}
      </div>
    </div>
  );
}

function CompareCell({ index, sync }: { index: number; sync: boolean }) {
  const { photos, decisions, nameSuggestions, decideAt } = useAppState();
  const photo = photos[index];
  const hasArw = !!photo?.arwPath;
  const hasJpg = !!photo?.jpgPath;
  const existing = decisions[index];

  const [includeArw, setIncludeArw] = useState(existing?.includeArw ?? false);
  const [newName, setNewName] = useState(existing?.newName ?? "");
  const preview = usePreview(photo?.hash);
  const previewError = usePreviewError(photo?.hash);
  const viewerRef = useRef<PhotoViewerHandle>(null);

  useEffect(() => {
    if (photo?.hash && photo.jpgPath) {
      void requestPreviews([{ hash: photo.hash, path: photo.jpgPath }]);
    }
  }, [photo?.hash, photo?.jpgPath]);

  const decision = decisions[index];
  function accept() {
    releaseButtonFocus();
    decideAt(index, "accept", { includeArw, newName });
  }
  function reject() {
    releaseButtonFocus();
    decideAt(index, "reject", { includeArw, newName });
  }

  return (
    <div className={`compare-cell ${decision ? `is-${decision.kind}` : ""}`}>
      <div className="compare-cell__stage">
        {hasJpg ? (
          previewError ? (
            <div className="review-noimg">Could not load JPG.</div>
          ) : (
            <PhotoViewer
              ref={viewerRef}
              previewSrc={preview && assetUrl(preview.preview)}
              thumbSrc={preview && assetUrl(preview.thumb)}
              originalSrc={photo.jpgPath && assetUrl(photo.jpgPath)}
              width={preview?.width}
              height={preview?.height}
              orientation={photo.meta?.orientation}
              label={photo.baseName}
              syncGroup={sync ? "compare" : undefined}
            />
          )
        ) : (
          <div className="review-noimg">ARW only — no JPG preview.</div>
        )}
      </div>

      <div className="compare-cell__bar">
        <span className="compare-cell__name">
          #{index + 1} {photo?.baseName}
          {decision && (
            <em className={`compare-badge is-${decision.kind}`}>
              {decision.kind === "accept" ? "Accepted" : "Rejected"}
            </em>
          )}
        </span>
        <ExifReadout exif={photo.meta} />
      </div>

      <div className="compare-cell__controls">
        <label className={`review-toggle ${hasArw ? "" : "is-disabled"}`}>
          <input
            type="checkbox"
            checked={hasArw ? includeArw : false}
            disabled={!hasArw}
            onChange={(e) => setIncludeArw(e.currentTarget.checked)}
          />
          <span>ARW</span>
        </label>
        <RenameField
          value={newName}
          onChange={setNewName}
          suggestions={nameSuggestions}
          onAccept={accept}
          placeholder={`Rename… (${photo?.baseName ?? ""})`}
        />
      </div>

      <div className="compare-cell__actions">
        <button className="fc-btn fc-btn--reject" onClick={reject}>
          Reject
        </button>
        <button className="fc-btn fc-btn--primary" onClick={accept}>
          Accept
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="scan-stat">
      <div className="scan-stat__value">{value}</div>
      <div className="scan-stat__label">{label}</div>
    </div>
  );
}
