import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppState, COMPARE_MAX } from "../state/appStore";
import { burstGroups } from "../lib/bursts";
import { assetUrl, requestPreviews, usePreview } from "../lib/previews";
import { VERY_SLOW_SHUTTER_S, shutterLabel } from "../lib/report";
import type { Decision } from "../types/review";
import type { Photo } from "../types/photo";
import "./GridView.css";

type Filter = "all" | "undecided" | "accepted" | "rejected";

/** One cell: a photo, or the visible head of a collapsed burst. */
interface Item {
  index: number;
  /** All frames of the collapsed burst this cell stands for (head first). */
  stack?: number[];
  /** Part of a burst (expanded or stacking off). */
  inBurst: boolean;
}

const GAP = 10;
/** Room around the canvas so focus rings and the scrollbar never clip tiles. */
const PAD = { left: 4, right: 14, y: 4 };
const TARGET_TILE = 200;
/** Thumbnail box height relative to tile width (3:2 and 2:3 frames both fit). */
const IMAGE_RATIO = 0.72;
const CAPTION = 24;
/** Rows rendered above and below the viewport. */
const OVERSCAN = 2;

/** Persist view options while the review screen remounts. */
const prefs: { filter: Filter; stack: boolean } = { filter: "all", stack: true };

/**
 * Grid of every photo, for an overview and bulk decisions. Bursts (frames shot
 * within 2 s of each other) collapse into one stacked cell. Select with click,
 * Shift and Ctrl like a file manager, then A / X to decide, C to compare.
 * Only the rows on screen are rendered, so thousands of photos scroll smoothly.
 */
export function GridView() {
  const {
    photos,
    decisions,
    reviewIndex,
    backToResult,
    showSingle,
    decideMany,
    compareIndices,
    copyStage,
    copyProgress,
    runCopy,
    videoDecisions,
  } = useAppState();

  const [filter, setFilter] = useState<Filter>(prefs.filter);
  const [stack, setStack] = useState(prefs.stack);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [focus, setFocus] = useState(() => Math.min(reviewIndex, photos.length - 1));
  const [selected, setSelected] = useState<Set<number>>(() => new Set([focus]));
  const anchor = useRef(focus);
  prefs.filter = filter;
  prefs.stack = stack;

  const groups = useMemo(() => burstGroups(photos), [photos]);
  const items = useMemo(
    () => buildItems(groups, decisions, filter, stack, expanded),
    [groups, decisions, filter, stack, expanded],
  );
  const position = useMemo(() => {
    const m = new Map<number, number>();
    items.forEach((it, pos) => m.set(it.index, pos));
    return m;
  }, [items]);

  // Keep the focus on a visible cell when filters or stacks change.
  useEffect(() => {
    if (items.length && !position.has(focus)) {
      const next = items.find((it) => it.index >= focus) ?? items[items.length - 1];
      setFocus(next.index);
    }
  }, [items, position, focus]);

  // --- layout / virtualisation ---------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setBox({ w: el.clientWidth - PAD.left - PAD.right, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(2, Math.floor((box.w + GAP) / (TARGET_TILE + GAP)));
  const tileW = box.w > 0 ? (box.w - GAP * (cols - 1)) / cols : TARGET_TILE;
  const imageH = Math.round(tileW * IMAGE_RATIO);
  const rowH = imageH + CAPTION + GAP;
  const rows = Math.ceil(items.length / cols);
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + box.h) / rowH) + OVERSCAN);
  const visible = items.slice(firstRow * cols, (lastRow + 1) * cols);

  // Previews for what's on screen jump the background queue.
  useEffect(() => {
    const reqs = visible.flatMap(({ index }) => {
      const p = photos[index];
      return p?.hash && p.jpgPath ? [{ hash: p.hash, path: p.jpgPath }] : [];
    });
    const t = window.setTimeout(() => void requestPreviews(reqs), 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRow, lastRow, items, photos]);

  // Keyboard moves keep the focused cell in view.
  const scrollToFocus = useRef(false);
  useEffect(() => {
    if (!scrollToFocus.current) return;
    scrollToFocus.current = false;
    const el = scrollRef.current;
    const pos = position.get(focus);
    if (!el || pos === undefined) return;
    const top = Math.floor(pos / cols) * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + rowH - el.clientHeight;
    }
  }, [focus, position, cols, rowH]);

  // Start with the photo the single view was on in sight.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const pos = position.get(focus);
    if (el && pos !== undefined && box.h > 0) {
      el.scrollTop = Math.max(0, Math.floor(pos / cols) * rowH - box.h / 3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.h > 0]);

  // --- selection --------------------------------------------------------------
  /** Photo indices the selection stands for (a collapsed stack = all its frames). */
  function targets(sel: Set<number> = selected): number[] {
    const out = new Set<number>();
    for (const it of items) {
      if (!sel.has(it.index)) continue;
      for (const i of it.stack ?? [it.index]) out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  }

  function select(index: number, mode: "only" | "toggle" | "range") {
    setFocus(index);
    if (mode === "only") {
      anchor.current = index;
      setSelected(new Set([index]));
    } else if (mode === "toggle") {
      anchor.current = index;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    } else {
      const a = position.get(anchor.current) ?? position.get(index) ?? 0;
      const b = position.get(index) ?? a;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(items.slice(lo, hi + 1).map((it) => it.index)));
    }
  }

  function toggleStack(head: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });
  }

  function compareSelection() {
    const sel = targets();
    if (sel.length >= 2) compareIndices(sel.slice(0, COMPARE_MAX));
  }

  // --- keyboard ---------------------------------------------------------------
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    const pos = position.get(focus) ?? 0;
    const move = (delta: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, pos + delta))];
      if (!next) return;
      e.preventDefault();
      scrollToFocus.current = true;
      select(next.index, e.shiftKey ? "range" : "only");
    };
    // Movement may auto-repeat; verdicts may not (a held key would sweep).
    switch (e.key) {
      case "ArrowRight":
        return move(1);
      case "ArrowLeft":
        return move(-1);
      case "ArrowDown":
        return move(cols);
      case "ArrowUp":
        return move(-cols);
      case "PageDown":
        return move(cols * Math.max(1, Math.floor(box.h / rowH)));
      case "PageUp":
        return move(-cols * Math.max(1, Math.floor(box.h / rowH)));
      case "Home":
        return move(-pos);
      case "End":
        return move(items.length);
    }
    if (e.repeat) return;
    switch (e.key) {
      case "a":
      case "A":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setSelected(new Set(items.map((it) => it.index)));
          return;
        }
        e.preventDefault();
        decideMany(targets(), "accept");
        return;
      case "x":
      case "X":
      case "Delete":
        e.preventDefault();
        decideMany(targets(), "reject");
        return;
      case "0":
      case "Backspace":
        e.preventDefault();
        decideMany(targets(), null);
        return;
      case "c":
      case "C": {
        e.preventDefault();
        const head = items[pos];
        if (selected.size <= 1 && head?.stack) compareIndices(head.stack.slice(0, COMPARE_MAX));
        else compareSelection();
        return;
      }
      case "s":
      case "S": {
        const head = items[pos];
        const group = groups.find((g) => g.includes(head?.index ?? -1));
        if (group && group.length > 1) {
          e.preventDefault();
          toggleStack(group[0]);
        }
        return;
      }
      case "Enter":
      case " ":
      case "g":
      case "G":
      case "Escape":
        e.preventDefault();
        showSingle(focus);
        return;
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- header numbers ---------------------------------------------------------
  const accepted = decisions.filter((d) => d?.kind === "accept").length;
  const rejected = decisions.filter((d) => d?.kind === "reject").length;
  const left = photos.length - accepted - rejected;
  const videosAccepted = videoDecisions.filter((d) => d?.kind === "accept").length;
  const toCopy = accepted + videosAccepted;
  const selCount = targets().length;

  return (
    <div className="grid-view">
      <header className="grid-top">
        <button className="fc-btn" onClick={backToResult}>
          ← Results
        </button>
        <div className="grid-tally" aria-live="polite">
          <span className="is-accept">{accepted} kept</span>
          <span className="is-reject">{rejected} rejected</span>
          <span>{left} left</span>
        </div>
        <div className="grid-filters" role="group" aria-label="Show">
          {(["all", "undecided", "accepted", "rejected"] as Filter[]).map((f) => (
            <button
              key={f}
              className={`grid-filter ${filter === f ? "is-active" : ""}`}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="review-toggle grid-stack-toggle" title="Group frames shot within 2 s (S on one burst)">
          <input type="checkbox" checked={stack} onChange={(e) => setStack(e.currentTarget.checked)} />
          <span>Stack bursts</span>
        </label>
        <span className="grid-top__right">
          <button className="fc-btn" onClick={() => showSingle(focus)} title="Single photo (G / Enter)">
            Single view
          </button>
          {copyStage === "copying" ? (
            <span className="grid-copying">
              Copying {copyProgress?.done ?? 0} / {copyProgress?.total ?? toCopy}…
            </span>
          ) : (
            <button
              className="fc-btn fc-btn--primary"
              onClick={runCopy}
              disabled={toCopy === 0}
              title={toCopy === 0 ? "Accept photos first" : "Copy accepted photos now; undecided ones stay for later"}
            >
              Copy {toCopy} →
            </button>
          )}
        </span>
      </header>

      <div
        className="grid-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {items.length === 0 ? (
          <p className="grid-empty">No photos match this filter.</p>
        ) : (
          <div
            className="grid-canvas"
            style={{
              height: rows * rowH - GAP + 2 * PAD.y,
              marginLeft: PAD.left,
              width: Math.max(0, box.w),
            }}
          >
            {visible.map((it, k) => {
              const pos = firstRow * cols + k;
              return (
                <GridTile
                  key={it.index}
                  item={it}
                  photo={photos[it.index]}
                  decision={decisions[it.index]}
                  stackDecisions={it.stack?.map((i) => decisions[i])}
                  focused={it.index === focus}
                  selected={selected.has(it.index)}
                  left={(pos % cols) * (tileW + GAP)}
                  top={PAD.y + Math.floor(pos / cols) * rowH}
                  width={tileW}
                  imageH={imageH}
                  onPick={(e) =>
                    select(it.index, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "only")
                  }
                  onOpen={() => showSingle(it.index)}
                  onToggleStack={() => toggleStack(groups.find((g) => g.includes(it.index))![0])}
                />
              );
            })}
          </div>
        )}
      </div>

      <footer className="grid-keys" aria-hidden>
        <span className="grid-keys__sel">{selCount} selected</span>
        <span><kbd>A</kbd> keep</span>
        <span><kbd>X</kbd> reject</span>
        <span><kbd>0</kbd> clear</span>
        <span><kbd>C</kbd> compare</span>
        <span><kbd>S</kbd> stack</span>
        <span><kbd>Shift</kbd>/<kbd>Ctrl</kbd> + click select</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>G</kbd> single view</span>
      </footer>
    </div>
  );
}

function passes(d: Decision | undefined, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "undecided") return !d;
  if (filter === "accepted") return d?.kind === "accept";
  return d?.kind === "reject";
}

function buildItems(
  groups: number[][],
  decisions: (Decision | undefined)[],
  filter: Filter,
  stack: boolean,
  expanded: Set<number>,
): Item[] {
  const items: Item[] = [];
  for (const g of groups) {
    const members = g.filter((i) => passes(decisions[i], filter));
    if (members.length === 0) continue;
    const burst = g.length > 1;
    if (stack && members.length > 1 && !expanded.has(g[0])) {
      items.push({ index: members[0], stack: members, inBurst: true });
    } else {
      for (const i of members) items.push({ index: i, inBurst: burst });
    }
  }
  return items;
}

interface TileProps {
  item: Item;
  photo: Photo;
  decision?: Decision;
  stackDecisions?: (Decision | undefined)[];
  focused: boolean;
  selected: boolean;
  left: number;
  top: number;
  width: number;
  imageH: number;
  onPick: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onToggleStack: () => void;
}

function GridTile({
  item,
  photo,
  decision,
  stackDecisions,
  focused,
  selected,
  left,
  top,
  width,
  imageH,
  onPick,
  onOpen,
  onToggleStack,
}: TileProps) {
  const preview = usePreview(photo.hash);
  // A stack shows how its frames are decided: all kept, all rejected, mixed.
  const kinds = stackDecisions ? new Set(stackDecisions.map((d) => d?.kind ?? "none")) : null;
  const tone = kinds
    ? kinds.size === 1
      ? [...kinds][0]
      : "mixed"
    : (decision?.kind ?? "none");
  const kept = stackDecisions?.filter((d) => d?.kind === "accept").length ?? 0;

  return (
    <div
      className={`grid-tile is-${tone} ${focused ? "is-focused" : ""} ${selected ? "is-selected" : ""} ${
        item.stack ? "is-stack" : ""
      }`}
      style={{ left, top, width }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on shift-click
      }}
      onClick={onPick}
      onDoubleClick={onOpen}
      role="gridcell"
      aria-selected={selected}
      title={`#${item.index + 1} ${photo.baseName}`}
    >
      <div className="grid-tile__img" style={{ height: imageH }}>
        {preview ? (
          <img src={assetUrl(preview.thumb)} alt={photo.baseName} draggable={false} decoding="async" />
        ) : photo.jpgPath ? (
          <span className="grid-tile__ph" />
        ) : (
          <span className="grid-tile__raw">ARW only</span>
        )}
        {item.stack && (
          <button
            className="grid-tile__stack"
            onClick={(e) => {
              e.stopPropagation();
              onToggleStack();
            }}
            title="Burst: click (or S) to show every frame"
          >
            ▤ {item.stack.length}
          </button>
        )}
        {!item.stack && item.inBurst && <span className="grid-tile__burst" title="Part of a burst" />}
      </div>
      <div className="grid-tile__cap">
        <span className="grid-tile__no">{item.index + 1}</span>
        <span className="grid-tile__name">{photo.baseName}</span>
        {(photo.meta?.exposureS ?? 0) > VERY_SLOW_SHUTTER_S * 1.001 && (
          <span className="grid-tile__slow" title="Slow shutter: check for motion blur">
            {shutterLabel(photo.meta!.exposureS!)}
          </span>
        )}
        <span className="grid-tile__mark">
          {item.stack ? (kept ? `${kept} kept` : "") : decision?.kind === "accept" ? "kept" : decision?.kind === "reject" ? "rejected" : ""}
        </span>
      </div>
    </div>
  );
}
