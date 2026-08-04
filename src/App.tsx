import { AppProvider, useAppState } from "./state/appStore";
import { StartScreen } from "./components/StartScreen";
import { ScanScreen } from "./components/ScanScreen";
import "./App.css";

function Router() {
  const { phase } = useAppState();
  return phase === "setup" ? <StartScreen /> : <ScanScreen />;
}

function App() {
  return (
    <AppProvider>
      <Router />
    </AppProvider>
  );
}

export default App;
