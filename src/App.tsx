import { AppProvider } from "./state/appStore";
import { StartScreen } from "./components/StartScreen";
import "./App.css";

function App() {
  return (
    <AppProvider>
      <StartScreen />
    </AppProvider>
  );
}

export default App;
