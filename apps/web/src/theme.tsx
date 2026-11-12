import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";
const KEY = "nearfirewall-theme";

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Storage can be blocked; fall through.
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const ThemeContext = createContext<{ theme: Theme; toggle(): void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Ignore.
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const ctx = useContext(ThemeContext);
  if (!ctx) return null;
  const label = ctx.theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button className="icon-btn" onClick={ctx.toggle} aria-label={label} title={label}>
      {ctx.theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
