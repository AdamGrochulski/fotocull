import { useEffect, useRef, useState } from "react";
import { useAppState } from "../state/appStore";
import { videoSrc } from "../lib/media";
import { openFolder } from "../lib/fs";
import { RenameField } from "./ReviewScreen";
import type { Video } from "../types/video";
import "./VideoReviewScreen.css";

/** Video tab: a Tinder-style pass over standalone MP4 clips. Same accept/reject/
 * rename/skip-list model as photos, but the preview is an HTML5 <video> — no
 * zoom, peaking or EXIF (those are photo tools). */
export function VideoReviewScreen() {
  const { videos, videoIndex } = useAppState();

  if (videoIndex >= videos.length) {
    return <VideoReviewComplete />;
  }
  return <VideoCard clip={videos[videoIndex]} />;
}

function VideoCard({ clip }: { clip: Video }) {
  const {
    videos,
    videoIndex,
    videoDecisions,
    nameSuggestions,
    decideVideoCurrent,
    videoPrev,
    goToVideo,
    backToResult,
  } = useAppState();

  const existing = videoDecisions[videoIndex];
  const [newName, setNewName] = useState(existing?.newName ?? "");

  // Sync the rename field when the clip changes (e.g. stepping back).
  useEffect(() => {
    setNewName(existing?.newName ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoIndex]);

  function accept() {
    decideVideoCurrent("accept", { newName });
  }
  function reject() {
    decideVideoCurrent("reject", { newName });
  }

  // Latest handlers in a ref so the once-mounted key listener never goes stale.
  const actions = useRef({ accept, reject, prev: () => {}, next: () => {} });
  actions.current = {
    accept,
    reject,
    prev: videoPrev,
    next: () => goToVideo(videoIndex + 1),
  };

  // Keyboard: A/Enter accept, X/Delete reject, U/Backspace undo, [ ] navigate.
  // Space and arrows are left to the focused <video> for play / scrub.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      switch (e.key) {
        case "a":
        case "A":
          e.preventDefault();
          actions.current.accept();
          break;
        case "x":
        case "X":
        case "Delete":
          e.preventDefault();
          actions.current.reject();
          break;
        case "u":
        case "U":
        case "Backspace":
          e.preventDefault();
          actions.current.prev();
          break;
        case "[":
          e.preventDefault();
          actions.current.prev();
          break;
        case "]":
          e.preventDefault();
          actions.current.next();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="review vreview">
      <header className="review-top">
        <button className="fc-btn" onClick={backToResult}>
          ← Results
        </button>
        <div className="review-counter">
          <span className="review-counter__now">{videoIndex + 1}</span>
          <span className="review-counter__sep">/</span>
          <span>{videos.length}</span>
        </div>
        <span className="review-top__right">
          <button
            className="fc-btn"
            onClick={() => goToVideo(videoIndex + 1)}
            disabled={videoIndex >= videos.length - 1}
            title="Next without deciding (])"
          >
            Skip →
          </button>
          <button
            className="fc-btn"
            onClick={videoPrev}
            disabled={videoIndex === 0}
            title="Previous (Backspace)"
          >
            Undo
          </button>
        </span>
      </header>

      <div className="review-progress">
        <i style={{ width: `${(videoIndex / videos.length) * 100}%` }} />
      </div>

      <div className="vreview-stage">
        {/* key forces a fresh element per clip so the player resets cleanly. */}
        <video
          key={clip.path}
          className="vreview-player"
          src={videoSrc(clip.path)}
          controls
          preload="metadata"
        />
      </div>

      <div className="review-meta">
        <span className="review-name">{clip.baseName}</span>
        <span className="review-meta__right">
          <span className="fc-chip fc-chip--raw">MP4</span>
        </span>
      </div>

      <div className="review-controls">
        <RenameField
          value={newName}
          onChange={setNewName}
          suggestions={nameSuggestions}
          onAccept={accept}
          placeholder={`Rename… (default: ${clip.baseName})`}
        />
      </div>

      <div className="review-actions">
        <button className="fc-btn fc-btn--reject review-btn" onClick={reject}>
          Reject
        </button>
        <button className="fc-btn fc-btn--primary review-btn" onClick={accept}>
          Accept
        </button>
      </div>

      <div className="review-keys" aria-hidden>
        <span><kbd>A</kbd> accept</span>
        <span><kbd>X</kbd>/<kbd>Del</kbd> reject</span>
        <span><kbd>Backspace</kbd>/<kbd>U</kbd> undo</span>
        <span><kbd>]</kbd> skip</span>
        <span><kbd>Space</kbd> play/pause</span>
      </div>
    </div>
  );
}

function VideoReviewComplete() {
  const {
    videos,
    videoDecisions,
    decisions,
    destDir,
    videoPrev,
    copyStage,
    copyProgress,
    copyReport,
    videoReport,
    runCopy,
  } = useAppState();

  const accepted = videoDecisions.filter((d) => d?.kind === "accept").length;
  const rejected = videoDecisions.filter((d) => d?.kind === "reject").length;
  const renamed = videoDecisions.filter((d) => d?.kind === "accept" && d.newName).length;
  const photosAccepted = decisions.filter((d) => d?.kind === "accept").length;
  const totalAccepted = accepted + photosAccepted;

  return (
    <div className="review review--done">
      <h2>Videos reviewed</h2>
      <p className="review-done-sub">Reviewed all {videos.length} clip(s).</p>

      <div className="scan-stats">
        <Stat label="Accepted" value={accepted} />
        <Stat label="Rejected" value={rejected} />
        <Stat label="Renamed" value={renamed} />
        <Stat label="Photos kept" value={photosAccepted} />
      </div>

      {copyStage === "idle" && (
        <>
          <p className="review-note">
            Accepted clips go to <code>video/</code> in <code>{destDir}</code> and
            are recorded in the manifest. Copying also handles any accepted photos.
            The source is never touched.
          </p>
          <div className="review-done-actions">
            <button className="fc-btn" onClick={videoPrev}>
              ← Back to last clip
            </button>
            <button
              className="fc-btn fc-btn--primary"
              onClick={runCopy}
              title={totalAccepted === 0 ? "Nothing to copy — finish the session" : "Copy accepted"}
            >
              {totalAccepted === 0 ? "Finish →" : `Copy ${totalAccepted} accepted →`}
            </button>
          </div>
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

      {copyStage === "done" && (
        <div className="review-done-actions">
          <p className="review-note">
            Copied {(copyReport?.copied ?? 0) + (videoReport?.copied ?? 0)} item(s).
          </p>
          <button
            className="fc-btn"
            onClick={() => destDir && openFolder(destDir)}
            disabled={!destDir}
          >
            Open folder
          </button>
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
