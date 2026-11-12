import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "./wallet.tsx";
import { ThemeProvider } from "./theme.tsx";
import { usePath } from "./router.ts";
import { Landing } from "./pages/Landing.tsx";
import { Docs } from "./pages/Docs.tsx";
import { AppShell, type Panel } from "./pages/AppShell.tsx";
import "./styles.css";

const PANELS: Panel[] = ["map", "agents", "payments", "activity"];

function App() {
  const path = usePath();
  const [, area, rest] = path.split("/");

  if (area === "docs") return <Docs section={rest} />;
  if (area === "app") return <AppShell panel={PANELS.includes(rest as Panel) ? (rest as Panel) : "map"} />;
  return <Landing />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <WalletProvider>
        <App />
      </WalletProvider>
    </ThemeProvider>
  </StrictMode>,
);
