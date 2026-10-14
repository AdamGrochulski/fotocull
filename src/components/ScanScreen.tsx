import { useAppState } from "../state/appStore";
import { baseName } from "../lib/paths";
import type { Photo } from "../types/photo";
import "./ScanScreen.css";

/** Pair kind — for stats and labels. */
function pairKind(p: Photo): "pair" | "jpgOnly" | "arwOnly" {
  if (p.jpgPath && p.arwPath) return "pair";
  if (p.jpgPath) return "jpgOnly";
  return "arwOnly";
}

/** Scan screen (Stage 2): progress + pairing result. Review comes in Stage 4. */
export function ScanScreen() {
  const {
    phase,
    photos,
    videos,
    scanProgress,
    scanStage,
    hashProgress,
    filteredOut,
    filteredOutVideos,
    resetToSetup,
    startReview,
  } = useAppState();

  if (phase === "scanning") {
    const hashing = scanStage === "hash" || scanStage === "vhash";
    return (
      <div className="scan-screen">
        <h2>{hashing ? "Checking manifest…" : "Scanning media…"}</h2>
        <div className="scan-progress">
          {scanStage === "vhash" ? (
            <div>
              Hashing video: {hashProgress?.hashed ?? 0} / {hashProgress?.total ?? 0}
            </div>
          ) : scanStage === "hash" ? (
            <div>
              Hashing JPG: {hashProgress?.hashed ?? 0} / {hashProgress?.total ?? 0}
            </div>
          ) : (
            <>
              <div>Files scanned: {scanProgress?.filesScanned ?? 0}</div>
              <div>Photos found: {scanProgress?.imagesFound ?? 0}</div>
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
        <h2>Scan result</h2>
        <div className="scan-header__actions">
          <button className="fc-btn" onClick={resetToSetup}>
            ← Change folders
          </button>
          {(photos.length > 0 || videos.length > 0) && (
            <button className="fc-btn fc-btn--primary" onClick={startReview}>
              Start review →
            </button>
          )}
        </div>
      </header>

      {(filteredOut > 0 || filteredOutVideos > 0) && (
        <div className="scan-filtered">
          Skipped {filteredOut} photo(s)
          {filteredOutVideos > 0 && ` and ${filteredOutVideos} video(s)`} — already
          handled earlier (copied or rejected), matched by content hash.
        </div>
      )}

      <div className="scan-stats">
        <Stat label="Photos total" value={photos.length} />
        <Stat label="JPG+ARW pairs" value={pairs} />
        <Stat label="JPG only" value={jpgOnly} />
        <Stat label="ARW only" value={arwOnly} />
        <Stat label="Videos (MP4)" value={videos.length} />
      </div>

      {photos.length === 0 && videos.length === 0 ? (
        <p className="scan-empty">
          {filteredOut > 0 || filteredOutVideos > 0
            ? "Nothing new — every item here was already copied or rejected in an earlier session."
            : "No JPG/ARW/MP4 files found in the selected folder."}
        </p>
      ) : (
        <>
          {photos.length > 0 && (
            <div className="scan-list">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>JPG</th>
                    <th>ARW</th>
                    <th>Folder</th>
                  </tr>
                </thead>
                <tbody>
                  {photos.map((p) => (
                    <tr key={p.jpgPath ?? p.arwPath}>
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

          {videos.length > 0 && (
            <div className="scan-list">
              <table>
                <thead>
                  <tr>
                    <th>Video</th>
                    <th>MP4</th>
                    <th>Folder</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr key={v.path}>
                      <td>{v.baseName}</td>
                      <td>✓</td>
                      <td className="scan-list__dir" title={v.sourceDir}>
                        {baseName(v.sourceDir)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
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
