import { AppProvider, useAppState } from "./state/appStore";
import { StartScreen } from "./components/StartScreen";
import { ScanScreen } from "./components/ScanScreen";
import { ReviewScreen } from "./components/ReviewScreen";
import "./App.css";

function Router() {
  const { phase } = useAppState();
  if (phase === "setup") return <StartScreen />;
  if (phase === "review") return <ReviewScreen />;
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
