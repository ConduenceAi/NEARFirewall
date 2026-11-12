import { ArrowRight } from "lucide-react";
import { Brand } from "./Brand.tsx";
import { ThemeToggle } from "../theme.tsx";
import { href } from "../router.ts";

export function Topbar({ current }: { current: "home" | "docs" }) {
  return (
    <header className="topbar">
      <div className="header-inner">
        <Brand />
        <nav className="site-nav" aria-label="Main">
          <a href={href("/")} aria-current={current === "home" ? "page" : undefined}>Overview</a>
          <a href={href("/docs")} aria-current={current === "docs" ? "page" : undefined}>Docs</a>
        </nav>
        <div className="top-actions">
          <ThemeToggle />
          <a className="btn header-launch" href={href("/app/agents")}>Launch app <ArrowRight size={15} /></a>
        </div>
      </div>
    </header>
  );
}
