import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { checkDir, pickDirectory } from "../lib/fs";
import { scanSource, onScanProgress, type ScanProgress } from "../lib/scan";
import {
  filterByManifest,
  filterVideosByManifest,
  renamedTargets,
  onHashProgress,
  onVideoHashProgress,
  type HashProgress,
} from "../lib/manifest";
import {
  copyAccepted,
  copyVideos,
  onCopyProgress,
  type CopyJob,
  type VideoJob,
  type CopyProgress,
  type CopyReport,
} from "../lib/copy";
import { allowMediaDir } from "../lib/media";
import type { DirStatus, FolderRole } from "../types/fs";
import type { Photo } from "../types/photo";
import type { Video } from "../types/video";
import type { Decision, DecisionKind } from "../types/review";

const SETTINGS_FILE = "settings.json";
const KEY_SOURCE = "sourceDir";
const KEY_DEST = "destDir";

/** Per-destination review progress, so quitting mid-review is safe and rejected
 * photos never come back. Keyed by destination path. */
const SESSIONS_FILE = "sessions.json";
type StoredDecision = { kind: DecisionKind; includeArw: boolean; newName: string };
interface SessionRecord {
  reviewed: Record<string, StoredDecision>;
  /** Video decisions, keyed by MP4 hash. Same skip-list/resume rules as photos. */
  videosReviewed?: Record<string, StoredDecision>;
  /** Accumulated rename target names for autocomplete (survives across copies). */
  names?: string[];
}

/** The source folder is OK when it exists, is a directory, and is readable. */
export function isSourceValid(s: DirStatus | null): boolean {
  return !!s && s.exists && s.isDir && s.readable;
}

/** The destination folder is OK when it exists, is a directory, and is writable. */
export function isDestValid(s: DirStatus | null): boolean {
  return !!s && s.exists && s.isDir && s.writable;
}

/** Application phase. */
export type Phase = "setup" | "scanning" | "scanned" | "review" | "summary";

/** Sub-mode within the review phase. */
export type ReviewMode = "single" | "select" | "compare";

/** Which media the review screen is showing. */
export type MediaTab = "photos" | "videos";

/** Max photos side by side in compare (current + 3 more). */
export const COMPARE_MAX = 4;

interface AppState {
  sourceDir: string | null;
  destDir: string | null;
  sourceStatus: DirStatus | null;
  destStatus: DirStatus | null;
  /** Validation in progress on startup (loading remembered paths). */
  loading: boolean;
  /** Open the dialog and pick a folder for the given role. */
  selectFolder: (role: FolderRole) => Promise<void>;
  /** Both folders selected and valid. */
  canProceed: boolean;

  // --- scan (Stage 2) + manifest filtering (Stage 3) ---
  phase: Phase;
  photos: Photo[];
  /** Video clips found on the source (standalone MP4s). */
  videos: Video[];
  scanProgress: ScanProgress | null;
  scanError: string | null;
  /** Which sub-stage of "scanning" is active: file scan, JPG hashing, or MP4 hashing. */
  scanStage: "scan" | "hash" | "vhash" | null;
  hashProgress: HashProgress | null;
  /** How many photos were skipped because their JPG hash was already in the manifest. */
  filteredOut: number;
  /** How many videos were skipped as already-copied/rejected. */
  filteredOutVideos: number;
  /** Run a scan of the source folder. */
  startScan: () => Promise<void>;
  /** Go back to the folder selection screen. */
  resetToSetup: () => void;

  // --- review (Stage 4) ---
  /** Index of the photo currently under review. */
  reviewIndex: number;
  /** Per-photo decisions, aligned to `photos` by index (undefined = not yet decided). */
  decisions: (Decision | undefined)[];
  /** Rename autocomplete pool for the current destination (sorted, deduped). */
  nameSuggestions: string[];
  /** Enter the review view starting at the first photo. */
  startReview: () => void;
  /** Record a decision for the current photo and advance to the next. */
  decideCurrent: (kind: DecisionKind, opts: { includeArw: boolean; newName: string }) => void;
  /** Record a decision for a specific photo without advancing (compare mode). */
  decideAt: (
    index: number,
    kind: DecisionKind,
    opts: { includeArw: boolean; newName: string },
  ) => void;
  /** Step back to the previous photo (to change a decision). */
  reviewPrev: () => void;
  /** Jump to a specific photo index (from the filmstrip). */
  goToReview: (index: number) => void;
  /** Return from review to the scan-result screen. */
  backToResult: () => void;

  // --- video review (parallel "Videos" tab) ---
  /** Which media tab is active in the review phase. */
  mediaTab: MediaTab;
  /** Switch between the Photos and Videos tabs. */
  setMediaTab: (tab: MediaTab) => void;
  /** Index of the clip currently under review. */
  videoIndex: number;
  /** Per-clip decisions, aligned to `videos` by index. */
  videoDecisions: (Decision | undefined)[];
  /** Record a decision for the current clip and advance. */
  decideVideoCurrent: (kind: DecisionKind, opts: { newName: string }) => void;
  /** Step back to the previous clip. */
  videoPrev: () => void;
  /** Jump to a specific clip index. */
  goToVideo: (index: number) => void;

  // --- compare sub-mode ---
  /** Single photo, selecting frames to compare, or the compare grid. */
  reviewMode: ReviewMode;
  /** Photo indices chosen for comparison (includes the anchor). */
  compareSet: number[];
  /** Begin picking frames to compare (seeds with the current photo). */
  startCompareSelect: () => void;
  /** Add/remove a frame from the compare selection (capped at COMPARE_MAX). */
  toggleComparePick: (index: number) => void;
  /** Open the compare grid for the current selection. */
  openCompare: () => void;
  /** Leave selection/compare without advancing. */
  cancelCompare: () => void;
  /** Close the compare grid and advance to the next undecided frame. */
  finishCompare: () => void;

  // --- copy (Stage 5) ---
  copyStage: "idle" | "copying" | "done";
  copyProgress: CopyProgress | null;
  copyReport: CopyReport | null;
  /** Result of the video copy pass (null if no videos were accepted). */
  videoReport: CopyReport | null;
  /** Copy all accepted photos and videos to the destination folder. */
  runCopy: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Store | null>(null);
  const [sessions, setSessions] = useState<Store | null>(null);
  /** Reviewed hashes for the destination being worked on (accept/reject). */
  const [reviewed, setReviewed] = useState<Record<string, StoredDecision>>({});
  /** Reviewed video hashes for the destination (accept/reject). */
  const [videoReviewed, setVideoReviewed] = useState<Record<string, StoredDecision>>({});
  /** Rename autocomplete pool (manifest history + this destination's sessions). */
  const [nameSuggestions, setNameSuggestions] = useState<string[]>([]);
  const [sourceDir, setSourceDir] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<DirStatus | null>(null);
  const [destStatus, setDestStatus] = useState<DirStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [phase, setPhase] = useState<Phase>("setup");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanStage, setScanStage] = useState<"scan" | "hash" | "vhash" | null>(null);
  const [hashProgress, setHashProgress] = useState<HashProgress | null>(null);
  const [filteredOut, setFilteredOut] = useState(0);
  const [filteredOutVideos, setFilteredOutVideos] = useState(0);

  const [reviewIndex, setReviewIndex] = useState(0);
  const [decisions, setDecisions] = useState<(Decision | undefined)[]>([]);
  const [reviewMode, setReviewMode] = useState<ReviewMode>("single");
  const [compareSet, setCompareSet] = useState<number[]>([]);

  const [mediaTab, setMediaTab] = useState<MediaTab>("photos");
  const [videoIndex, setVideoIndex] = useState(0);
  const [videoDecisions, setVideoDecisions] = useState<(Decision | undefined)[]>([]);

  const [copyStage, setCopyStage] = useState<"idle" | "copying" | "done">("idle");
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [copyReport, setCopyReport] = useState<CopyReport | null>(null);
  const [videoReport, setVideoReport] = useState<CopyReport | null>(null);

  // Startup: load remembered paths and re-validate them (they may be gone).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await load(SETTINGS_FILE, { autoSave: true });
        const sess = await load(SESSIONS_FILE, { autoSave: true });
        if (cancelled) return;
        setStore(s);
        setSessions(sess);

        const savedSource = (await s.get<string>(KEY_SOURCE)) ?? null;
        const savedDest = (await s.get<string>(KEY_DEST)) ?? null;

        if (savedSource) {
          setSourceDir(savedSource);
          setSourceStatus(await checkDir(savedSource));
        }
        if (savedDest) {
          setDestDir(savedDest);
          setDestStatus(await checkDir(savedDest));
        }
      } catch (err) {
        console.error("Failed to load remembered paths:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function selectFolder(role: FolderRole) {
    const title =
      role === "source"
        ? "Choose source card / folder"
        : "Choose destination folder";
    const picked = await pickDirectory(title);
    if (!picked) return; // cancelled

    const status = await checkDir(picked);
    if (role === "source") {
      setSourceDir(picked);
      setSourceStatus(status);
      await store?.set(KEY_SOURCE, picked);
    } else {
      setDestDir(picked);
      setDestStatus(status);
      await store?.set(KEY_DEST, picked);
    }
  }

  /** Persist a destination's whole session record (skip-list + resume + names). */
  async function persistSession(
    dest: string,
    map: Record<string, StoredDecision>,
    videosMap: Record<string, StoredDecision>,
    names: string[],
  ) {
    try {
      await sessions?.set(dest, {
        reviewed: map,
        videosReviewed: videosMap,
        names,
      } satisfies SessionRecord);
    } catch (err) {
      console.error("Failed to persist review progress:", err);
    }
  }

  async function startScan() {
    if (!sourceDir || !destDir) return;
    setPhase("scanning");
    setScanError(null);
    setScanProgress(null);
    setHashProgress(null);
    setFilteredOut(0);
    setFilteredOutVideos(0);
    setPhotos([]);
    setVideos([]);

    // Step 1: recursive scan and pairing (photos + video clips).
    setScanStage("scan");
    const unlistenScan = await onScanProgress(setScanProgress);
    let found: Photo[];
    let foundVideos: Video[];
    try {
      const result = await scanSource(sourceDir);
      found = result.photos;
      foundVideos = result.videos;
    } catch (err) {
      setScanError(String(err));
      setPhase("setup");
      unlistenScan();
      return;
    } finally {
      unlistenScan();
    }

    // Allow the asset protocol to stream video files from the source folder.
    if (foundVideos.length > 0) {
      try {
        await allowMediaDir(sourceDir);
      } catch (err) {
        console.error("Failed to grant media access:", err);
      }
    }

    // Step 2: hash JPGs and filter out already-copied ones per the manifest.
    setScanStage("hash");
    const jpgPaths = found
      .map((p) => p.jpgPath)
      .filter((x): x is string => !!x);

    try {
      const byPath = new Map<string, { hash: string; alreadyCopied: boolean }>();
      if (jpgPaths.length > 0) {
        const unlistenHash = await onHashProgress(setHashProgress);
        try {
          const results = await filterByManifest(destDir, jpgPaths);
          for (const r of results) {
            byPath.set(r.path, { hash: r.hash, alreadyCopied: r.alreadyCopied });
          }
        } finally {
          unlistenHash();
        }
      }

      // Load this destination's review history: already-copied (manifest) and
      // previously-rejected photos are hidden; accepted-but-not-yet-copied ones
      // stay and get their decision restored later (resume).
      const record = await sessions?.get<SessionRecord>(destDir);
      const rev = record?.reviewed ?? {};
      setReviewed(rev);
      const vrev = record?.videosReviewed ?? {};
      setVideoReviewed(vrev);

      // Rename autocomplete pool: manifest history (past copies) + names saved in
      // this destination's session record. Merged, deduplicated, sorted.
      const manifestNames = await renamedTargets(destDir).catch(() => []);
      const pool = Array.from(
        new Set([...(record?.names ?? []), ...manifestNames]),
      ).sort((a, b) => a.localeCompare(b));
      setNameSuggestions(pool);

      // Photos without a JPG (ARW only) stay — they can't be deduped by hash.
      const remaining: Photo[] = [];
      for (const p of found) {
        if (!p.jpgPath) {
          remaining.push(p);
          continue;
        }
        const r = byPath.get(p.jpgPath);
        if (r?.alreadyCopied) continue; // skip — already copied
        if (r?.hash && rev[r.hash]?.kind === "reject") continue; // permanently rejected
        remaining.push({ ...p, jpgHash: r?.hash });
      }

      setFilteredOut(found.length - remaining.length);
      setPhotos(remaining);

      // Videos: hash and dedup against the manifest, same as photos.
      const remainingVideos: Video[] = [];
      if (foundVideos.length > 0) {
        setScanStage("vhash");
        setHashProgress(null);
        const vByPath = new Map<string, { hash: string; alreadyCopied: boolean }>();
        const unlistenV = await onVideoHashProgress(setHashProgress);
        try {
          const vres = await filterVideosByManifest(
            destDir,
            foundVideos.map((v) => v.path),
          );
          for (const r of vres) {
            vByPath.set(r.path, { hash: r.hash, alreadyCopied: r.alreadyCopied });
          }
        } finally {
          unlistenV();
        }
        for (const v of foundVideos) {
          const r = vByPath.get(v.path);
          if (r?.alreadyCopied) continue; // already copied
          if (r?.hash && vrev[r.hash]?.kind === "reject") continue; // rejected before
          remainingVideos.push({ ...v, hash: r?.hash });
        }
      }
      setFilteredOutVideos(foundVideos.length - remainingVideos.length);
      setVideos(remainingVideos);

      setPhase("scanned");
    } catch (err) {
      setScanError(String(err));
      setPhase("setup");
    } finally {
      setScanStage(null);
    }
  }

  function resetToSetup() {
    setPhase("setup");
    setScanProgress(null);
    setHashProgress(null);
    setScanStage(null);
    setScanError(null);
  }

  function startReview() {
    // Restore accepted-but-not-copied decisions from a prior session, and start
    // at the first photo still undecided (resume where you left off).
    const seeded: (Decision | undefined)[] = photos.map((p) => {
      const r = p.jpgHash ? reviewed[p.jpgHash] : undefined;
      return r?.kind === "accept"
        ? { kind: "accept", includeArw: r.includeArw, newName: r.newName }
        : undefined;
    });
    const firstUndecided = seeded.findIndex((d) => d === undefined);
    setDecisions(seeded);
    setReviewIndex(firstUndecided === -1 ? photos.length : firstUndecided);
    setReviewMode("single");
    setCompareSet([]);

    // Seed video decisions the same way and resume at the first undecided clip.
    const seededV: (Decision | undefined)[] = videos.map((v) => {
      const r = v.hash ? videoReviewed[v.hash] : undefined;
      return r?.kind === "accept"
        ? { kind: "accept", includeArw: false, newName: r.newName }
        : r?.kind === "reject"
          ? { kind: "reject", includeArw: false, newName: r.newName }
          : undefined;
    });
    const firstUndecidedV = seededV.findIndex((d) => d === undefined);
    setVideoDecisions(seededV);
    setVideoIndex(firstUndecidedV === -1 ? videos.length : firstUndecidedV);
    setMediaTab(photos.length > 0 ? "photos" : "videos");

    setCopyStage("idle");
    setCopyProgress(null);
    setCopyReport(null);
    setVideoReport(null);
    setPhase("review");
  }

  async function runCopy() {
    if (!destDir) return;
    const jobs: CopyJob[] = [];
    photos.forEach((p, i) => {
      const d = decisions[i];
      if (d?.kind !== "accept") return;
      jobs.push({
        baseName: p.baseName,
        jpgPath: p.jpgPath,
        arwPath: p.arwPath,
        jpgHash: p.jpgHash,
        includeArw: d.includeArw,
        newName: d.newName || undefined,
      });
    });

    const videoJobs: VideoJob[] = [];
    videos.forEach((v, i) => {
      const d = videoDecisions[i];
      if (d?.kind !== "accept") return;
      videoJobs.push({
        baseName: v.baseName,
        path: v.path,
        hash: v.hash,
        newName: d.newName || undefined,
      });
    });

    setCopyStage("copying");
    setCopyProgress(null);
    setCopyReport(null);
    setVideoReport(null);
    const unlisten = await onCopyProgress(setCopyProgress);
    try {
      if (jobs.length > 0) {
        const report = await copyAccepted(destDir, jobs);
        setCopyReport(report);
      } else {
        setCopyReport({ copied: 0, filesCopied: 0, errors: [] });
      }
      if (videoJobs.length > 0) {
        const vreport = await copyVideos(destDir, videoJobs);
        setVideoReport(vreport);
      }

      // Copied media now lives in the manifest, so drop pending accepts from the
      // session record. Rejects stay — they're the permanent skip-list. Prune both
      // maps and persist them together.
      const nextReviewed: Record<string, StoredDecision> = {};
      for (const [h, v] of Object.entries(reviewed)) {
        if (v.kind === "reject") nextReviewed[h] = v;
      }
      const nextVideoReviewed: Record<string, StoredDecision> = {};
      for (const [h, v] of Object.entries(videoReviewed)) {
        if (v.kind === "reject") nextVideoReviewed[h] = v;
      }
      setReviewed(nextReviewed);
      setVideoReviewed(nextVideoReviewed);
      void persistSession(destDir, nextReviewed, nextVideoReviewed, nameSuggestions);
    } catch (err) {
      setCopyReport({ copied: 0, filesCopied: 0, errors: [String(err)] });
    } finally {
      unlisten();
      setCopyStage("done");
      setPhase("summary");
    }
  }

  function decideAt(
    index: number,
    kind: DecisionKind,
    opts: { includeArw: boolean; newName: string },
  ) {
    const newName = opts.newName.trim();
    setDecisions((prev) => {
      const next = prev.slice();
      next[index] = { kind, includeArw: opts.includeArw, newName };
      return next;
    });

    // Remember a new rename target for autocomplete (accept + non-empty name).
    let names = nameSuggestions;
    if (kind === "accept" && newName && !nameSuggestions.includes(newName)) {
      names = [...nameSuggestions, newName].sort((a, b) => a.localeCompare(b));
      setNameSuggestions(names);
    }

    // Persist immediately, keyed by JPG hash, so a crash or early quit can't lose
    // the decision. Rejects become a permanent skip-list; accepts are resumable
    // until the copy moves them into the manifest.
    const photo = photos[index];
    if (photo?.jpgHash && destDir) {
      const nextReviewed = {
        ...reviewed,
        [photo.jpgHash]: { kind, includeArw: opts.includeArw, newName },
      };
      setReviewed(nextReviewed);
      void persistSession(destDir, nextReviewed, videoReviewed, names);
    }
  }

  function decideCurrent(
    kind: DecisionKind,
    opts: { includeArw: boolean; newName: string },
  ) {
    decideAt(reviewIndex, kind, opts);
    // Advance (clamped at the end — the end state shows the review summary).
    setReviewIndex((i) => Math.min(i + 1, photos.length));
  }

  // --- video review ---
  function decideVideoCurrent(kind: DecisionKind, opts: { newName: string }) {
    const index = videoIndex;
    const newName = opts.newName.trim();
    setVideoDecisions((prev) => {
      const next = prev.slice();
      next[index] = { kind, includeArw: false, newName };
      return next;
    });

    // A new rename target joins the shared autocomplete pool.
    let names = nameSuggestions;
    if (kind === "accept" && newName && !nameSuggestions.includes(newName)) {
      names = [...nameSuggestions, newName].sort((a, b) => a.localeCompare(b));
      setNameSuggestions(names);
    }

    // Persist immediately, keyed by MP4 hash (skip-list + resume).
    const clip = videos[index];
    if (clip?.hash && destDir) {
      const nextVideoReviewed = {
        ...videoReviewed,
        [clip.hash]: { kind, includeArw: false, newName },
      };
      setVideoReviewed(nextVideoReviewed);
      void persistSession(destDir, reviewed, nextVideoReviewed, names);
    }

    setVideoIndex((i) => Math.min(i + 1, videos.length));
  }

  function videoPrev() {
    setVideoIndex((i) => Math.max(0, i - 1));
  }

  function goToVideo(index: number) {
    setVideoIndex(Math.max(0, Math.min(index, videos.length)));
  }

  // --- compare sub-mode ---
  function startCompareSelect() {
    setCompareSet([reviewIndex]);
    setReviewMode("select");
  }

  function toggleComparePick(index: number) {
    setCompareSet((prev) => {
      if (prev.includes(index)) return prev.filter((i) => i !== index);
      if (prev.length >= COMPARE_MAX) return prev; // capped
      return [...prev, index];
    });
  }

  function openCompare() {
    if (compareSet.length >= 2) setReviewMode("compare");
  }

  function cancelCompare() {
    setReviewMode("single");
    setCompareSet([]);
  }

  function finishCompare() {
    setReviewMode("single");
    // Advance past the frames just compared to the next undecided one.
    const from = compareSet.length ? Math.max(...compareSet) + 1 : reviewIndex;
    let idx = from;
    while (idx < photos.length && decisions[idx]) idx++;
    setCompareSet([]);
    setReviewIndex(Math.min(idx, photos.length));
  }

  function reviewPrev() {
    setReviewIndex((i) => Math.max(0, i - 1));
  }

  function goToReview(index: number) {
    setReviewIndex(Math.max(0, Math.min(index, photos.length)));
  }

  function backToResult() {
    setPhase("scanned");
  }

  const canProceed = isSourceValid(sourceStatus) && isDestValid(destStatus);

  const value: AppState = {
    sourceDir,
    destDir,
    sourceStatus,
    destStatus,
    loading,
    selectFolder,
    canProceed,
    phase,
    photos,
    videos,
    scanProgress,
    scanError,
    scanStage,
    hashProgress,
    filteredOut,
    filteredOutVideos,
    startScan,
    resetToSetup,
    reviewIndex,
    decisions,
    nameSuggestions,
    startReview,
    decideCurrent,
    decideAt,
    reviewPrev,
    goToReview,
    backToResult,
    mediaTab,
    setMediaTab,
    videoIndex,
    videoDecisions,
    decideVideoCurrent,
    videoPrev,
    goToVideo,
    reviewMode,
    compareSet,
    startCompareSelect,
    toggleComparePick,
    openCompare,
    cancelCompare,
    finishCompare,
    copyStage,
    copyProgress,
    copyReport,
    videoReport,
    runCopy,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used within <AppProvider>");
  return ctx;
}
