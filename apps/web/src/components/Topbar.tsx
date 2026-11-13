import { Brand } from "./Brand.tsx";
import { WalletEntry } from "./WalletEntry.tsx";
import { ThemeToggle } from "../theme.tsx";

export function Topbar() {
  return (
    <header className="topbar">
      <div className="header-inner">
        <Brand />
        <div className="top-actions">
          <ThemeToggle />
          <WalletEntry placement="header" />
        </div>
      </div>
    </header>
  );
}
