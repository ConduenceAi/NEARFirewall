import { useEffect, useState } from "react";

/** Hash routes: "/", "/docs", "/docs/<section>", "/app/<panel>". Works on any static host. */
export function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash.startsWith("/") ? hash : "/";
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

export const href = (path: string) => `#${path}`;
