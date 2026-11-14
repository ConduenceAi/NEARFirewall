import { useEffect, type ReactNode } from "react";

/** The app is light-only; this just pins the theme attribute the styles key off. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
  }, []);
  return <>{children}</>;
}
