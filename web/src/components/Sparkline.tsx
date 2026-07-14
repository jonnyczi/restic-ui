// Hand-rolled SVG sparkline — deliberately no chart dependency. Strokes use
// currentColor so the surrounding text color (and dark mode) styles the line;
// the latest point is emphasized in the primary color.
export default function Sparkline({
  points,
  height = 28,
  ariaLabel,
  className = "text-muted-foreground",
}: {
  points: number[];
  height?: number;
  ariaLabel: string;
  className?: string;
}) {
  if (points.length < 2) {
    return <span className="text-xs text-muted-foreground">not enough data yet</span>;
  }

  const W = 100;
  const H = 100;
  const PAD = 6; // vertical padding, in viewBox units
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const x = (i: number) => (i / (points.length - 1)) * W;
  // Flat series renders as a midline instead of collapsing to an edge.
  const y = (v: number) => (span === 0 ? H / 2 : PAD + (1 - (v - min) / span) * (H - 2 * PAD));
  const coords = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
    >
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Zero-length round-capped stroke = a dot immune to the non-uniform
          viewBox scaling that would squash a <circle> into an ellipse. */}
      <path
        d={`M ${x(points.length - 1)} ${y(points[points.length - 1])} l 0.01 0`}
        stroke="currentColor"
        strokeWidth={6}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        fill="none"
        className="text-primary"
      />
    </svg>
  );
}
