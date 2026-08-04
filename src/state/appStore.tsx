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
  onHashProgress,
  type HashProgress,
} from "../lib/manifest";
import type { DirStatus, FolderRole } from "../types/fs";
import type { Photo } from "../types/photo";

const SETTINGS_FILE = "settings.json";
const KEY_SOURCE = "sourceDir";
const KEY_DEST = "destDir";

/** The source folder is OK when it exists, is a directory, and is readable. */
export function isSourceValid(s: DirStatus | null): boolean {
  return !!s && s.exists && s.isDir && s.readable;
}

/** The destination folder is OK when it exists, is a directory, and is writable. */
export function isDestValid(s: DirStatus | null): boolean {
  return !!s && s.exists && s.isDir && s.writable;
}

/** Application phase. */
export type Phase = "setup" | "scanning" | "scanned";

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
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Store | null>(null);
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

  // Startup: load remembered paths and re-validate them (they may be gone).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await load(SETTINGS_FILE, { autoSave: true });
        if (cancelled) return;
        setStore(s);

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

      // Photos without a JPG (ARW only) stay — they can't be deduped by hash.
      const remaining: Photo[] = [];
      for (const p of found) {
        if (!p.jpgPath) {
          remaining.push(p);
          continue;
        }
        const r = byPath.get(p.jpgPath);
        if (r?.alreadyCopied) continue; // skip — already copied
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
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used within <AppProvider>");
  return ctx;
}
