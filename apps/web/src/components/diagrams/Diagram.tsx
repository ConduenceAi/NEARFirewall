/**
 * Small SVG building blocks for the docs diagrams. Colours come from the app's
 * theme variables (see `.dg-*` in styles.css), so every figure works in light
 * and dark mode. Each figure has a <title> and <desc> for screen readers.
 */
import { createContext, useContext, useId, type CSSProperties, type ReactNode } from "react";

export type Tone = "owner" | "contract" | "agent" | "recipient" | "neutral";
export type EdgeKind = "call" | "pays" | "deny" | "returns" | "holds" | "parent";
const KINDS: EdgeKind[] = ["call", "pays", "deny", "returns", "holds", "parent"];

const MarkerContext = createContext("dg");

export function Diagram({
  title,
  desc,
  width,
  height,
  caption,
  maxWidth = 560,
  children,
}: {
  title: string;
  desc: string;
  width: number;
  height: number;
  caption?: ReactNode;
  maxWidth?: number;
  children: ReactNode;
}) {
  const id = `dg${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <figure className="diagram" style={{ "--dg-max": `${maxWidth}px` } as CSSProperties}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{desc}</desc>
        <defs>
          {KINDS.map((k) => (
            <marker
              key={k}
              id={`${id}-m-${k}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" className={`dg-marker ${k}`} />
            </marker>
          ))}
        </defs>
        <MarkerContext.Provider value={id}>{children}</MarkerContext.Provider>
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** A labelled box. `label` may be several lines; `sub` is a smaller line below. */
export function Node({
  x,
  y,
  w,
  h,
  label,
  sub,
  tone = "neutral",
  dashed,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string | string[];
  sub?: string;
  tone?: Tone;
  dashed?: boolean;
}) {
  const lines = Array.isArray(label) ? label : [label];
  const total = lines.length + (sub ? 1 : 0);
  const lineHeight = 15;
  const first = y + h / 2 - ((total - 1) * lineHeight) / 2 + 4.5;
  return (
    <g className={`dg-node ${tone}${dashed ? " dashed" : ""}`}>
      <rect x={x} y={y} width={w} height={h} rx={8} />
      {lines.map((line, i) => (
        <text key={i} x={x + w / 2} y={first + i * lineHeight} textAnchor="middle" className="dg-label">
          {line}
        </text>
      ))}
      {sub && (
        <text x={x + w / 2} y={first + lines.length * lineHeight} textAnchor="middle" className="dg-sub">
          {sub}
        </text>
      )}
    </g>
  );
}

/** Left-aligned note with monospace lines, for small data panels. */
export function Note({ x, y, w, lines, tone = "neutral" }: { x: number; y: number; w: number; lines: string[]; tone?: Tone }) {
  const lineHeight = 15;
  const h = lines.length * lineHeight + 14;
  return (
    <g className={`dg-node dg-note ${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx={6} />
      {lines.map((line, i) => (
        <text key={i} x={x + 10} y={y + 18 + i * lineHeight} className={line.startsWith("✕") ? "dg-sub deny" : "dg-sub"}>
          {line}
        </text>
      ))}
    </g>
  );
}

/** An arrow along a polyline. `labelAt` places the label; otherwise it sits mid-way. */
export function Edge({
  points,
  kind,
  label,
  labelAt,
  anchor = "middle",
}: {
  points: [number, number][];
  kind: EdgeKind;
  label?: string;
  labelAt?: [number, number];
  anchor?: "start" | "middle" | "end";
}) {
  const id = useContext(MarkerContext);
  const d = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px},${py}`).join(" ");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const [lx, ly] = labelAt ?? [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2 - 6];
  return (
    <g className={`dg-edge ${kind}`}>
      <path d={d} markerEnd={`url(#${id}-m-${kind})`} />
      {label && (
        <text x={lx} y={ly} textAnchor={anchor} className="dg-edge-label">
          {label}
        </text>
      )}
    </g>
  );
}

/** A vertical lifeline with a header box, for sequence diagrams. */
export function Lane({ x, top, bottom, label, tone = "neutral" }: { x: number; top: number; bottom: number; label: string; tone?: Tone }) {
  const w = 86;
  return (
    <g className="dg-lane">
      <line x1={x} y1={top + 30} x2={x} y2={bottom} />
      <Node x={x - w / 2} y={top} w={w} h={30} label={label} tone={tone} />
    </g>
  );
}

/** A numbered circle that matches a step in the HTML list under the figure. */
export function StepBadge({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g className="dg-step">
      <circle cx={x} cy={y} r={9} />
      <text x={x} y={y + 4} textAnchor="middle">
        {n}
      </text>
    </g>
  );
}
