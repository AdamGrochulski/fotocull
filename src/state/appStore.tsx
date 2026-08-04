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
  renamedTargets,
  onHashProgress,
  type HashProgress,
} from "../lib/manifest";
import {
  copyAccepted,
  onCopyProgress,
  type CopyJob,
  type CopyProgress,
  type CopyReport,
} from "../lib/copy";
import type { DirStatus, FolderRole } from "../types/fs";
import type { Photo } from "../types/photo";
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
  scanProgress: ScanProgress | null;
  scanError: string | null;
  /** Which sub-stage of "scanning" is active: file scan or hashing. */
  scanStage: "scan" | "hash" | null;
  hashProgress: HashProgress | null;
  /** How many photos were skipped because their JPG hash was already in the manifest. */
  filteredOut: number;
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
  /** Step back to the previous photo (to change a decision). */
  reviewPrev: () => void;
  /** Return from review to the scan-result screen. */
  backToResult: () => void;

  // --- copy (Stage 5) ---
  copyStage: "idle" | "copying" | "done";
  copyProgress: CopyProgress | null;
  copyReport: CopyReport | null;
  /** Copy all accepted photos to the destination folder. */
  runCopy: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Store | null>(null);
  const [sessions, setSessions] = useState<Store | null>(null);
  /** Reviewed hashes for the destination being worked on (accept/reject). */
  const [reviewed, setReviewed] = useState<Record<string, StoredDecision>>({});
  /** Rename autocomplete pool (manifest history + this destination's sessions). */
  const [nameSuggestions, setNameSuggestions] = useState<string[]>([]);
  const [sourceDir, setSourceDir] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<DirStatus | null>(null);
  const [destStatus, setDestStatus] = useState<DirStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [phase, setPhase] = useState<Phase>("setup");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanStage, setScanStage] = useState<"scan" | "hash" | null>(null);
  const [hashProgress, setHashProgress] = useState<HashProgress | null>(null);
  const [filteredOut, setFilteredOut] = useState(0);

  const [reviewIndex, setReviewIndex] = useState(0);
  const [decisions, setDecisions] = useState<(Decision | undefined)[]>([]);

  const [copyStage, setCopyStage] = useState<"idle" | "copying" | "done">("idle");
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [copyReport, setCopyReport] = useState<CopyReport | null>(null);

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
    names: string[],
  ) {
    try {
      await sessions?.set(dest, { reviewed: map, names } satisfies SessionRecord);
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
    setPhotos([]);

    // Step 1: recursive scan and pairing.
    setScanStage("scan");
    const unlistenScan = await onScanProgress(setScanProgress);
    let found: Photo[];
    try {
      found = await scanSource(sourceDir);
    } catch (err) {
      setScanError(String(err));
      setPhase("setup");
      unlistenScan();
      return;
    } finally {
      unlistenScan();
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
    setCopyStage("idle");
    setCopyProgress(null);
    setCopyReport(null);
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

    setCopyStage("copying");
    setCopyProgress(null);
    setCopyReport(null);
    const unlisten = await onCopyProgress(setCopyProgress);
    try {
      const report = await copyAccepted(destDir, jobs);
      setCopyReport(report);
      // Copied photos now live in the manifest, so drop their pending accepts
      // from the session record. Rejects stay — they're the permanent skip-list.
      setReviewed((prev) => {
        const next: Record<string, StoredDecision> = {};
        for (const [h, v] of Object.entries(prev)) {
          if (v.kind === "reject") next[h] = v;
        }
        void persistSession(destDir, next, nameSuggestions);
        return next;
      });
    } catch (err) {
      setCopyReport({ copied: 0, filesCopied: 0, errors: [String(err)] });
    } finally {
      unlisten();
      setCopyStage("done");
      setPhase("summary");
    }
  }

  function decideCurrent(
    kind: DecisionKind,
    opts: { includeArw: boolean; newName: string },
  ) {
    const newName = opts.newName.trim();
    setDecisions((prev) => {
      const next = prev.slice();
      next[reviewIndex] = { kind, includeArw: opts.includeArw, newName };
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
    const photo = photos[reviewIndex];
    if (photo?.jpgHash && destDir) {
      const nextReviewed = {
        ...reviewed,
        [photo.jpgHash]: { kind, includeArw: opts.includeArw, newName },
      };
      setReviewed(nextReviewed);
      void persistSession(destDir, nextReviewed, names);
    }

    // Advance (clamped at the end — the end state shows the review summary).
    setReviewIndex((i) => Math.min(i + 1, photos.length));
  }

  function reviewPrev() {
    setReviewIndex((i) => Math.max(0, i - 1));
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
    scanProgress,
    scanError,
    scanStage,
    hashProgress,
    filteredOut,
    startScan,
    resetToSetup,
    reviewIndex,
    decisions,
    nameSuggestions,
    startReview,
    decideCurrent,
    reviewPrev,
    backToResult,
    copyStage,
    copyProgress,
    copyReport,
    runCopy,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used within <AppProvider>");
  return ctx;
}
