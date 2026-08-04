import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { checkDir, pickDirectory } from "../lib/fs";
import type { DirStatus, FolderRole } from "../types/fs";

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
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Store | null>(null);
  const [sourceDir, setSourceDir] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<DirStatus | null>(null);
  const [destStatus, setDestStatus] = useState<DirStatus | null>(null);
  const [loading, setLoading] = useState(true);

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

  const canProceed = isSourceValid(sourceStatus) && isDestValid(destStatus);

  const value: AppState = {
    sourceDir,
    destDir,
    sourceStatus,
    destStatus,
    loading,
    selectFolder,
    canProceed,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState musi być użyte wewnątrz <AppProvider>");
  return ctx;
}
