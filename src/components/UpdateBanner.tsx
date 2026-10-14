import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { findUpdate, installUpdate } from "../lib/updates";
import "./UpdateBanner.css";

/** Checked once per app run, so going back to the start screen doesn't re-ask. */
let checked = false;
let found: Update | null = null;

/**
 * Offers a newer version on the start screen only: an update restarts the
 * app, so it's never offered in the middle of reviewing a card.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(found);
  const [dismissed, setDismissed] = useState(false);
  const [progress, setProgress] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (checked) return;
    checked = true;
    void findUpdate().then((u) => {
      found = u;
      setUpdate(u);
    });
  }, []);

  if (!update || dismissed) return null;
  const installing = progress !== undefined && !error;

  async function install() {
    if (!update) return;
    setError(null);
    setProgress(null);
    try {
      await installUpdate(update, setProgress);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="update-banner" role="status">
      <span className="update-banner__text">
        {error ? (
          <>Update failed: {error}</>
        ) : installing ? (
          <>
            Installing fotocull {update.version}
            {typeof progress === "number" && ` (${Math.round(progress * 100)}%)`}…
          </>
        ) : (
          <>
            fotocull <strong>{update.version}</strong> is available (you have{" "}
            {update.currentVersion}).
          </>
        )}
      </span>
      {!installing && (
        <span className="update-banner__actions">
          <button className="fc-btn" onClick={() => setDismissed(true)}>
            Later
          </button>
          <button className="fc-btn fc-btn--primary" onClick={install}>
            {error ? "Try again" : "Update and restart"}
          </button>
        </span>
      )}
    </div>
  );
}
