import { useAppState } from "../state/appStore";
import { baseName } from "../lib/paths";
import type { Photo } from "../types/photo";
import "./ScanScreen.css";

/** Rodzaj pary — do statystyk i etykiet. */
function pairKind(p: Photo): "pair" | "jpgOnly" | "arwOnly" {
  if (p.jpgPath && p.arwPath) return "pair";
  if (p.jpgPath) return "jpgOnly";
  return "arwOnly";
}

/** Ekran skanu (Etap 2): postęp + wynik parowania. Przeglądanie dojdzie w Etapie 4. */
export function ScanScreen() {
  const {
    phase,
    photos,
    scanProgress,
    scanStage,
    hashProgress,
    filteredOut,
    resetToSetup,
  } = useAppState();

  if (phase === "scanning") {
    return (
      <div className="scan-screen">
        <h2>{scanStage === "hash" ? "Sprawdzanie manifestu…" : "Skanowanie nośnika…"}</h2>
        <div className="scan-progress">
          {scanStage === "hash" ? (
            <div>
              Hashowanie JPG: {hashProgress?.hashed ?? 0} / {hashProgress?.total ?? 0}
            </div>
          ) : (
            <>
              <div>Przeskanowano plików: {scanProgress?.filesScanned ?? 0}</div>
              <div>Znaleziono zdjęć: {scanProgress?.imagesFound ?? 0}</div>
            </>
          )}
        </div>
        <div className="scan-spinner" aria-hidden />
      </div>
    );
  }

  // phase === "scanned"
  const pairs = photos.filter((p) => pairKind(p) === "pair").length;
  const jpgOnly = photos.filter((p) => pairKind(p) === "jpgOnly").length;
  const arwOnly = photos.filter((p) => pairKind(p) === "arwOnly").length;

  return (
    <div className="scan-screen">
      <header className="scan-header">
        <h2>Wynik skanu</h2>
        <button className="scan-back" onClick={resetToSetup}>
          ← Zmień foldery
        </button>
      </header>

      {filteredOut > 0 && (
        <div className="scan-filtered">
          Pominięto {filteredOut} zdjęć — już wcześniej skopiowane (dopasowane po
          hashu JPG w manifeście).
        </div>
      )}

      <div className="scan-stats">
        <Stat label="Zdjęć razem" value={photos.length} />
        <Stat label="Pary JPG+ARW" value={pairs} />
        <Stat label="Tylko JPG" value={jpgOnly} />
        <Stat label="Tylko ARW" value={arwOnly} />
      </div>

      {photos.length === 0 ? (
        <p className="scan-empty">Brak plików JPG/ARW w wybranym folderze.</p>
      ) : (
        <div className="scan-list">
          <table>
            <thead>
              <tr>
                <th>Nazwa</th>
                <th>JPG</th>
                <th>ARW</th>
                <th>Folder</th>
              </tr>
            </thead>
            <tbody>
              {photos.map((p) => (
                <tr key={p.baseName + p.sourceDir}>
                  <td>{p.baseName}</td>
                  <td>{p.jpgPath ? "✓" : "—"}</td>
                  <td>{p.arwPath ? "✓" : "—"}</td>
                  <td className="scan-list__dir" title={p.sourceDir}>
                    {baseName(p.sourceDir)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
