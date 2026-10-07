import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface Series {
  name: string;
  values: number[];
}

const H = 260;

/**
 * Value-over-time for up to a few series on one shared y-axis. Thin 2px lines, recessive grid, a legend and direct
 * labels at the line ends, a crosshair that reads every series at the hovered point, and a table view. Colors are
 * the validated categorical slots (--series-1 to --series-3), in fixed order, never cycled.
 */
export function LineChart(props: { series: Series[]; xLabel: (i: number) => string; format: (v: number) => string; title: string; height?: number }) {
  const { series, xLabel, format } = props;
  const h = props.height ?? H;
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Draw at the container's real width so text stays at its real size on any screen.
  const [W, setW] = useState(720);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = W < 520;
  const PAD = { top: 16, right: narrow ? 12 : 104, bottom: 28, left: 58 };
  const id = useId();
  const n = Math.max(...series.map((s) => s.values.length));

  const { y, ticks, x } = useMemo(() => {
    const all = series.flatMap((s) => s.values);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (!isFinite(lo)) [lo, hi] = [0, 1];
    if (hi - lo < 1e-9) [lo, hi] = [lo * 0.99, hi * 1.01 + 1e-9];
    const step = niceStep((hi - lo) / 4);
    const t0 = Math.floor(lo / step) * step;
    // Ticks from at or below the lowest value to at or above the highest, so no line ever leaves the plot.
    const ticks: number[] = [];
    for (let k = 0; ticks.length === 0 || ticks[ticks.length - 1] < hi - 1e-9; k++) ticks.push(t0 + k * step);
    const [ylo, yhi] = [ticks[0], ticks[ticks.length - 1]];
    const y = (v: number) => PAD.top + (1 - (v - ylo) / (yhi - ylo || 1)) * (h - PAD.top - PAD.bottom);
    const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.left - PAD.right));
    return { y, ticks, x };
  }, [series, n, h, W, PAD.right]);

  if (n === 0) return null;

  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  // End labels: nudge apart if the lines finish close together.
  const ends = series.map((s, k) => ({ k, y: y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;

  return (
    <figure className="chart" aria-labelledby={`${id}-t`} ref={boxRef as never}>
      <div className="chart-head">
        <figcaption id={`${id}-t`}>{props.title}</figcaption>
        <div className="legend">
          {series.map((s, k) => (
            <span key={s.name} className="legend-item">
              <span className={`swatch s${k + 1}`} />
              {s.name}
            </span>
          ))}
          <button className="btn small" onClick={() => setTable((t) => !t)}>
            {table ? "Chart" : "Table"}
          </button>
        </div>
      </div>
      {table ? (
        <div className="table-scroll" style={{ maxHeight: h, overflowY: "auto" }}>
          <table className="holdings">
            <thead>
              <tr>
                <th>Point</th>
                {series.map((s) => (
                  <th key={s.name} className="num">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: n }, (_, i) => (
                <tr key={i}>
                  <td>{xLabel(i)}</td>
                  {series.map((s) => (
                    <td key={s.name} className="num">
                      {s.values[i] === undefined ? "–" : format(s.values[i])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={props.title} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="axis" x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
                  {format(t)}
                </text>
              </g>
            ))}
            <text className="axis" x={PAD.left} y={h - 8}>
              {xLabel(0)}
            </text>
            <text className="axis" x={W - PAD.right} y={h - 8} textAnchor="end">
              {xLabel(n - 1)}
            </text>
            {series.map((s, k) => (
              <path key={s.name} className={`line s${k + 1}`} d={path(s.values)} />
            ))}
            {!narrow && ends.map(({ k, y: ly }) => (
              <text key={k} className="end-label" x={W - PAD.right + 8} y={ly} dominantBaseline="middle">
                {series[k].name}
              </text>
            ))}
            {hover !== null && (
              <g>
                <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={h - PAD.bottom} />
                {series.map((s, k) =>
                  s.values[hover] === undefined ? null : <circle key={s.name} className={`dot s${k + 1}`} cx={x(hover)} cy={y(s.values[hover])} r={4.5} />,
                )}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
              <div className="muted small">{xLabel(hover)}</div>
              {series.map((s, k) => (
                <div key={s.name} className="tooltip-row">
                  <span className={`swatch s${k + 1}`} />
                  <strong>{s.values[hover] === undefined ? "–" : format(s.values[hover])}</strong>
                  <span className="muted">{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export const compactUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", notation: Math.abs(v) >= 100_000 ? "compact" : "standard", maximumFractionDigits: 0 });
