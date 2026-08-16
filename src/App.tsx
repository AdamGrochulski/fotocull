import { AppProvider, useAppState } from "./state/appStore";
import { StartScreen } from "./components/StartScreen";
import { ScanScreen } from "./components/ScanScreen";
import { ReviewScreen } from "./components/ReviewScreen";
import { VideoReviewScreen } from "./components/VideoReviewScreen";
import { MediaTabs } from "./components/MediaTabs";
import { SummaryScreen } from "./components/SummaryScreen";
import "./App.css";

/** Review phase: photos only, or a Photos|Videos shell when clips are present. */
function ReviewRouter() {
  const { videos, mediaTab } = useAppState();
  // No videos → the original photo flow, untouched.
  if (videos.length === 0) return <ReviewScreen />;
  return (
    <div className="media-shell">
      <MediaTabs />
      <div className="media-shell__body">
        {mediaTab === "videos" ? <VideoReviewScreen /> : <ReviewScreen />}
      </div>
    </div>
  );
}

function Router() {
  const { phase } = useAppState();
  if (phase === "setup") return <StartScreen />;
  if (phase === "review") return <ReviewRouter />;
  if (phase === "summary") return <SummaryScreen />;
  return <ScanScreen />;
}

function App() {
  return (
    <AppProvider>
      <Router />
    </AppProvider>
  );
}

export default App;
