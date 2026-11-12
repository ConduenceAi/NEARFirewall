import { ArrowRight } from "lucide-react";
import { Brand } from "./Brand.tsx";
import { ThemeToggle } from "../theme.tsx";
import { href } from "../router.ts";

export function Topbar({ current }: { current: "home" | "docs" }) {
  return (
    <header className="topbar">
      <Brand />
      <nav aria-label="Main">
        <a href={href("/")} className={current === "home" ? "current" : ""}>
          Overview
        </a>
        <a href={href("/docs")} className={current === "docs" ? "current" : ""}>
          Docs
        </a>
      </nav>
      <div className="top-actions">
        <ThemeToggle />
        <a className="btn primary" href={href("/app/agents")}>
          Launch app <ArrowRight size={16} />
        </a>
      </div>
    </header>
  );
}
