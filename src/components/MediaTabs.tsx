import { useAppState } from "../state/appStore";
import "./MediaTabs.css";

/** Photos | Videos switch, shown at the top of the review phase when the source
 * holds video clips alongside photos. */
export function MediaTabs() {
  const { photos, videos, decisions, videoDecisions, mediaTab, setMediaTab } =
    useAppState();

  const photosLeft = photos.filter((_, i) => !decisions[i]).length;
  const videosLeft = videos.filter((_, i) => !videoDecisions[i]).length;

  return (
    <div className="media-tabs" role="tablist" aria-label="Media type">
      <button
        role="tab"
        aria-selected={mediaTab === "photos"}
        className={`media-tab ${mediaTab === "photos" ? "is-active" : ""}`}
        onClick={() => setMediaTab("photos")}
        disabled={photos.length === 0}
      >
        <span className="media-tab__icon" aria-hidden>🖼️</span>
        Photos
        <span className="media-tab__count">{photos.length}</span>
        {photosLeft > 0 && <span className="media-tab__left">{photosLeft} left</span>}
      </button>
      <button
        role="tab"
        aria-selected={mediaTab === "videos"}
        className={`media-tab ${mediaTab === "videos" ? "is-active" : ""}`}
        onClick={() => setMediaTab("videos")}
        disabled={videos.length === 0}
      >
        <span className="media-tab__icon" aria-hidden>🎬</span>
        Videos
        <span className="media-tab__count">{videos.length}</span>
        {videosLeft > 0 && <span className="media-tab__left">{videosLeft} left</span>}
      </button>
    </div>
  );
}
