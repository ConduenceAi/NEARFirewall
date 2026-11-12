import { ArrowRight } from "lucide-react";
import { Brand } from "./Brand.tsx";
import { ThemeToggle } from "../theme.tsx";
import { href } from "../router.ts";
import { useWallet } from "../wallet.tsx";

export function Topbar({ current }: { current: "home" | "docs" }) {
  const { accountId } = useWallet();
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
          {accountId ? (
            <a className="btn header-launch header-dashboard" href={href("/app/map")} title={`Signed in as ${accountId}`}>
              <i className="online-dot" aria-hidden="true" /> Dashboard <ArrowRight size={15} />
            </a>
          ) : (
            <a className="btn header-launch" href={href("/app/map")}>Launch app <ArrowRight size={15} /></a>
          )}
        </div>
      </div>
    </header>
  );
}
