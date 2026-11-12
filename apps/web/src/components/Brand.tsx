import { useRef, type MouseEvent, type ReactNode } from "react";
import { config } from "../config.ts";
import { href } from "../router.ts";

export function Logo({ size = 36 }: { size?: number }) {
  return <img className="logo" src="/logo-mark.png" width={size} height={size} alt="" />;
}

export function Brand() {
  return (
    <a className="brand" href={href("/")} aria-label="NEARFirewall home">
      <Logo />
      <span className="brand-text">
        <strong>NEARFirewall</strong>
        <span>{config.network}</span>
      </span>
    </a>
  );
}

/** Card with a soft glow that follows the pointer. */
export function SpotCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div ref={ref} className={`spot ${className}`} onMouseMove={move}>
      {children}
    </div>
  );
}
