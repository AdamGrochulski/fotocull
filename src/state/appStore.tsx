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

/** Katalog źródłowy jest OK, gdy istnieje, jest katalogiem i da się odczytać. */
export function isSourceValid(s: DirStatus | null): boolean {
  return !!s && s.exists && s.isDir && s.readable;
}

/** Katalog docelowy jest OK, gdy istnieje, jest katalogiem i da się zapisać. */
export function isDestValid(s: DirStatus | null): boolean {
  return !!s && s.exists && s.isDir && s.writable;
}

/** Faza aplikacji. */
export type Phase = "setup" | "scanning" | "scanned";

interface AppState {
  sourceDir: string | null;
  destDir: string | null;
  sourceStatus: DirStatus | null;
  destStatus: DirStatus | null;
  /** Trwa walidacja przy starcie (wczytywanie zapamiętanych ścieżek). */
  loading: boolean;
  /** Otwórz dialog i wybierz folder dla danej roli. */
  selectFolder: (role: FolderRole) => Promise<void>;
  /** Oba foldery wybrane i poprawne. */
  canProceed: boolean;

  // --- skan (Etap 2) + filtrowanie po manifeście (Etap 3) ---
  phase: Phase;
  photos: Photo[];
  scanProgress: ScanProgress | null;
  scanError: string | null;
  /** Który podetap trwa w fazie "scanning": skan plików czy hashowanie. */
  scanStage: "scan" | "hash" | null;
  hashProgress: HashProgress | null;
  /** Ile zdjęć pominięto, bo hash JPG był już w manifeście. */
  filteredOut: number;
  /** Uruchom skan folderu źródłowego. */
  startScan: () => Promise<void>;
  /** Wróć do ekranu wyboru folderów. */
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

  // Start: wczytaj zapamiętane ścieżki i zwaliduj je ponownie (mogły zniknąć).
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
        console.error("Nie udało się wczytać zapamiętanych ścieżek:", err);
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
        ? "Wybierz kartę / folder źródłowy"
        : "Wybierz folder docelowy";
    const picked = await pickDirectory(title);
    if (!picked) return; // anulowano

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

    // Etap 1: rekursywny skan i parowanie.
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

    // Etap 2: hash JPG i odfiltrowanie już-skopiowanych wg manifestu.
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

      // Zdjęcia bez JPG (tylko ARW) zostają — nie da się ich dedupować po hashu.
      const remaining: Photo[] = [];
      for (const p of found) {
        if (!p.jpgPath) {
          remaining.push(p);
          continue;
        }
        const r = byPath.get(p.jpgPath);
        if (r?.alreadyCopied) continue; // pomiń — już skopiowane
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
  if (!ctx) throw new Error("useAppState musi być użyte wewnątrz <AppProvider>");
  return ctx;
}
