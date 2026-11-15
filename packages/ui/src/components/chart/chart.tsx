import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";

// Bar, line and area charts drawn as SVG from data, in the colour-blind-safe chart.cat.1..8 roles
// (Base UI has no charts, and the project builds what it lacks itself rather than adding a chart
// library). Series differ by more than colour: lines and areas have their own dash pattern and
// marker shape, bars keep their order in each group and in the legend. The chart is one tab stop:
// arrow keys move a guide across the categories, and a tooltip and a polite live region say the
// values; a visually hidden table holds the data for screen readers (a summary above 1,000 rows).
// Long series are decimated to the plot's width (min and max per pixel), so 100,000 points draw
// as fast as 500. ChartSparkline is a tiny inline line for a table cell or a Stat.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const chartVariants = {} as const;

/** A categorical colour, chart.cat.1..8. */
export type ChartColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ChartSeries {
  /** The data field with this series' numbers. */
  key: string;
  /** The name in the legend, tooltip and table. */
  label: string;
  /** chart.cat colour; by default the series' position (1, 2, …). */
  color?: ChartColor;
}

// Every colour class written out so Tailwind finds them.
const strokeClass: Record<ChartColor, string> = { 1: "stroke-chart-1", 2: "stroke-chart-2", 3: "stroke-chart-3", 4: "stroke-chart-4", 5: "stroke-chart-5", 6: "stroke-chart-6", 7: "stroke-chart-7", 8: "stroke-chart-8" };
const fillClass: Record<ChartColor, string> = { 1: "fill-chart-1", 2: "fill-chart-2", 3: "fill-chart-3", 4: "fill-chart-4", 5: "fill-chart-5", 6: "fill-chart-6", 7: "fill-chart-7", 8: "fill-chart-8" };
const softFillClass: Record<ChartColor, string> = { 1: "fill-chart-1/20", 2: "fill-chart-2/20", 3: "fill-chart-3/20", 4: "fill-chart-4/20", 5: "fill-chart-5/20", 6: "fill-chart-6/20", 7: "fill-chart-7/20", 8: "fill-chart-8/20" };

/** Dash patterns per series position, so lines differ without colour. */
const DASHES = [undefined, "6 3", "2 3", "8 3 2 3", "1 2", "10 4", "4 2 1 2 1 2", "3 6"];
const MARKERS = ["circle", "square", "triangle", "diamond", "circle", "square", "triangle", "diamond"] as const;

const classes = {
  root: "relative flex w-full min-w-0 flex-col gap-stack-sm font-sans text-caption text-fg-muted",
  plot: [
    "relative h-panel-xs min-h-0 w-full rounded-sm outline-none",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  ],
  svg: "absolute inset-0 size-full overflow-visible",
  grid: "stroke-border-muted",
  axis: "stroke-border",
  tick: "fill-fg-muted text-caption tabular-nums",
  guide: "stroke-border-strong",
  marker: "stroke-surface",
  tooltip: "pointer-events-none absolute z-[var(--by-z-tooltip)] flex min-w-panel-xs max-w-panel-sm flex-col gap-stack-xs rounded-md border border-border bg-overlay p-inset-xs text-caption text-fg shadow-overlay",
  tooltipTitle: "text-label text-fg",
  tooltipRow: "flex items-center gap-inline-sm",
  tooltipLabel: "min-w-0 flex-1 truncate text-fg-muted",
  tooltipValue: "tabular-nums text-fg",
  legend: "flex flex-wrap items-center gap-x-inline-lg gap-y-stack-xs text-caption text-fg",
  legendItem: "inline-flex min-w-0 items-center gap-inline-xs",
  legendLabel: "truncate",
  swatch: "h-track w-icon-md shrink-0 overflow-visible",
  empty: "flex h-panel-xs items-center justify-center rounded-sm border border-dashed border-border text-body text-fg-muted",
  hidden: "sr-only",
  sparkline: "inline-block h-control-xs w-panel-xs shrink-0 overflow-visible align-middle",
} as const;

/** Ticks at 1, 2 or 5 × 10^n covering [min, max], about `count` of them. Exported for tests. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    if (min === 0) return [0, 1];
    [min, max] = min > 0 ? [0, min] : [min, 0];
  }
  const raw = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/** Indices to draw for a series of `length` points over `width` px: every point, or the min and max of each pixel column. Exported for tests. */
export function decimate(values: readonly number[], width: number): number[] {
  const n = values.length;
  const columns = Math.max(1, Math.floor(width));
  if (n <= columns * 2) return values.map((_, i) => i);
  const out: number[] = [];
  for (let c = 0; c < columns; c += 1) {
    const from = Math.floor((c * n) / columns);
    const to = Math.max(from + 1, Math.floor(((c + 1) * n) / columns));
    let lo = from;
    let hi = from;
    for (let i = from; i < to; i += 1) {
      if (values[i]! < values[lo]!) lo = i;
      if (values[i]! > values[hi]!) hi = i;
    }
    if (lo === hi) out.push(lo);
    else out.push(Math.min(lo, hi), Math.max(lo, hi));
  }
  return out;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const defaultFormat = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

function Marker({ shape, x, y, className }: { shape: (typeof MARKERS)[number]; x: number; y: number; className: string }) {
  const r = 3.5;
  if (shape === "square") return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} className={className} />;
  if (shape === "triangle") return <path d={`M${x} ${y - r - 1}L${x + r + 1} ${y + r}H${x - r - 1}Z`} className={className} />;
  if (shape === "diamond") return <path d={`M${x} ${y - r - 1}L${x + r + 1} ${y}L${x} ${y + r + 1}L${x - r - 1} ${y}Z`} className={className} />;
  return <circle cx={x} cy={y} r={r} className={className} />;
}

export interface ChartProps {
  /** bar (grouped or stacked), line, or area. */
  type?: "bar" | "line" | "area";
  /** One object per category, with the `x` field and each series' field. */
  data?: readonly Record<string, unknown>[];
  /** The field that names each category (the x axis). */
  x?: string;
  /** The series to draw. */
  series?: readonly ChartSeries[];
  /** Stacks bars or areas instead of grouping or overlapping them. */
  stacked?: boolean;
  /** Formats values on the axis, in the tooltip and the table. */
  valueFormat?: (value: number) => string;
  /** Formats categories. */
  xFormat?: (value: unknown) => string;
  /** Shows the legend (default: more than one series). */
  legend?: boolean;
  /** Horizontal grid lines at the ticks. */
  grid?: boolean;
  /** Marks a category (controlled), as the keyboard and pointer do; null for none. */
  activeIndex?: number | null;
  /** The category marked at first (uncontrolled; previews). */
  defaultActiveIndex?: number | null;
  /** Called when the marked category changes. */
  onActiveIndexChange?: (index: number | null) => void;
  /** The chart's name: what it shows ("Queries per hour, last 24 hours"). Required. */
  "aria-label": string;
  /** Shown when there is no data. */
  emptyText?: ReactNode;
  /** Extra classes on the root (the plot is h-panel-xs; override with [&_[data-slot=chart-plot]]:h-…), merged after the component's own. */
  className?: string;
  /** Reaches the root. */
  ref?: Ref<HTMLDivElement>;
}

/** A bar, line or area chart drawn from data, with axes, legend, tooltip, keyboard reading and a hidden data table. */
export function Chart({
  type = "bar",
  data = [],
  x = "x",
  series = [],
  stacked = false,
  valueFormat = defaultFormat,
  xFormat = (value: unknown) => String(value ?? ""),
  legend,
  grid = true,
  activeIndex: activeProp,
  defaultActiveIndex = null,
  onActiveIndexChange,
  "aria-label": label,
  emptyText = "No data",
  className,
  ref,
}: ChartProps) {
  const id = useId();
  const plot = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 480, height: 240 });
  useEffect(() => {
    const element = plot.current;
    if (!element) return undefined;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width && height) setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [data.length]);

  const [activeState, setActiveState] = useState<number | null>(defaultActiveIndex);
  const active = activeProp === undefined ? activeState : activeProp;
  const setActive = useCallback(
    (index: number | null) => {
      if (activeProp === undefined) setActiveState(index);
      onActiveIndexChange?.(index);
    },
    [activeProp, onActiveIndexChange],
  );

  const colours = series.map((s, i) => s.color ?? (((i % 8) + 1) as ChartColor));
  const columns = useMemo(() => series.map((s) => data.map((row) => num(row[s.key]))), [data, series]);
  const stackedTops = useMemo(() => {
    if (!stacked) return null;
    return data.map((_, i) => {
      let sum = 0;
      return columns.map((col) => (sum += col[i]!));
    });
  }, [stacked, data, columns]);

  const { min, max } = useMemo(() => {
    let lo = 0;
    let hi = 0;
    if (stackedTops) for (const tops of stackedTops) for (const v of tops) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    else for (const col of columns) for (const v of col) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    return { min: lo, max: hi };
  }, [columns, stackedTops]);
  const ticks = useMemo(() => niceTicks(min, max), [min, max]);
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;

  const longestTick = Math.max(...ticks.map((t) => valueFormat(t).length));
  const margin = { top: 8, right: 8, bottom: 24, left: Math.min(96, 12 + longestTick * 7) };
  const plotW = Math.max(1, size.width - margin.left - margin.right);
  const plotH = Math.max(1, size.height - margin.top - margin.bottom);
  const band = plotW / Math.max(1, data.length);
  const xAt = (i: number) => margin.left + (i + 0.5) * band;
  const yAt = (v: number) => margin.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const labelStep = Math.max(1, Math.ceil((data.length * 64) / plotW));

  const announce = active !== null && data[active] ? `${xFormat(data[active]![x])}: ${series.map((s, k) => `${s.label} ${valueFormat(columns[k]![active]!)}`).join(", ")}` : "";

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - rect.left - margin.left) / band);
    setActive(index >= 0 && index < data.length ? index : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!data.length) return;
    const current = active ?? -1;
    const next = event.key === "ArrowRight" ? Math.min(data.length - 1, current + 1) : event.key === "ArrowLeft" ? Math.max(0, current < 0 ? 0 : current - 1) : event.key === "Home" ? 0 : event.key === "End" ? data.length - 1 : event.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };

  const showLegend = legend ?? series.length > 1;
  const empty = data.length === 0 || series.length === 0;

  const marks: ReactNode[] = [];
  if (!empty && type === "bar") {
    const inner = band * 0.72;
    data.forEach((_, i) => {
      if (stacked) {
        let base = 0;
        series.forEach((s, k) => {
          const v = columns[k]![i]!;
          const top = base + v;
          marks.push(<rect key={`${s.key}-${i}`} x={xAt(i) - inner / 2} y={yAt(Math.max(base, top))} width={inner} height={Math.abs(yAt(base) - yAt(top))} className={fillClass[colours[k]!]} />);
          base = top;
        });
      } else {
        const w = inner / series.length;
        series.forEach((s, k) => {
          const v = columns[k]![i]!;
          marks.push(<rect key={`${s.key}-${i}`} x={xAt(i) - inner / 2 + k * w} y={yAt(Math.max(0, v))} width={Math.max(1, w - 1)} height={Math.abs(yAt(0) - yAt(v))} className={fillClass[colours[k]!]} />);
        });
      }
    });
  } else if (!empty) {
    series.forEach((s, k) => {
      const values = stackedTops ? stackedTops.map((tops) => tops[k]!) : columns[k]!;
      const floor = stackedTops && k > 0 ? stackedTops.map((tops) => tops[k - 1]!) : null;
      const keep = decimate(values, plotW);
      const line = keep.map((i, j) => `${j ? "L" : "M"}${xAt(i).toFixed(1)} ${yAt(values[i]!).toFixed(1)}`).join("");
      if (type === "area") {
        const back = floor ? [...keep].reverse().map((i) => `L${xAt(i).toFixed(1)} ${yAt(floor[i]!).toFixed(1)}`).join("") : `L${xAt(keep[keep.length - 1]!).toFixed(1)} ${yAt(0).toFixed(1)}L${xAt(keep[0]!).toFixed(1)} ${yAt(0).toFixed(1)}`;
        marks.push(<path key={`${s.key}-area`} d={`${line}${back}Z`} className={softFillClass[colours[k]!]} />);
      }
      marks.push(<path key={`${s.key}-line`} d={line} fill="none" strokeWidth={2} strokeLinejoin="round" strokeDasharray={DASHES[k % DASHES.length]} className={strokeClass[colours[k]!]} />);
      if (data.length <= 60) keep.forEach((i) => marks.push(<Marker key={`${s.key}-m${i}`} shape={MARKERS[k % MARKERS.length]!} x={xAt(i)} y={yAt(values[i]!)} className={cn(classes.marker, fillClass[colours[k]!])} />));
    });
  }

  const tooltipLeft = active !== null ? Math.min(Math.max(0, xAt(active) + 12), Math.max(0, size.width - 200)) : 0;

  return (
    <div ref={ref} data-slot="chart" data-type={type} className={cn(classes.root, className)}>
      {empty ? (
        <div data-slot="chart-empty" role="img" aria-label={`${label}: no data`} className={classes.empty}>
          {emptyText}
        </div>
      ) : (
        <div
          ref={plot}
          data-slot="chart-plot"
          role="group"
          aria-roledescription="chart"
          aria-label={label}
          aria-describedby={`${id}-table`}
          tabIndex={0}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          className={cn(classes.plot)}
        >
          <svg aria-hidden="true" className={classes.svg} viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none">
            {ticks.map((t) => (
              <g key={t}>
                {grid ? <line x1={margin.left} x2={margin.left + plotW} y1={yAt(t)} y2={yAt(t)} className={classes.grid} /> : null}
                <text x={margin.left - 6} y={yAt(t)} dy="0.32em" textAnchor="end" className={classes.tick}>
                  {valueFormat(t)}
                </text>
              </g>
            ))}
            <line x1={margin.left} x2={margin.left + plotW} y1={yAt(Math.max(yMin, Math.min(0, yMax)))} y2={yAt(Math.max(yMin, Math.min(0, yMax)))} className={classes.axis} />
            {data.map((row, i) =>
              i % labelStep === 0 ? (
                <text key={i} x={xAt(i)} y={margin.top + plotH + 16} textAnchor="middle" className={classes.tick}>
                  {xFormat(row[x])}
                </text>
              ) : null,
            )}
            {active !== null && data[active] ? <line data-slot="chart-guide" x1={xAt(active)} x2={xAt(active)} y1={margin.top} y2={margin.top + plotH} className={classes.guide} /> : null}
            {marks}
          </svg>
          {active !== null && data[active] ? (
            <ChartTooltip style={{ left: tooltipLeft, top: margin.top }} title={xFormat(data[active]![x])}>
              {series.map((s, k) => (
                <div key={s.key} className={classes.tooltipRow}>
                  <LegendSwatch type={type} color={colours[k]!} index={k} />
                  <span className={classes.tooltipLabel}>{s.label}</span>
                  <span className={classes.tooltipValue}>{valueFormat(columns[k]![active]!)}</span>
                </div>
              ))}
            </ChartTooltip>
          ) : null}
        </div>
      )}
      {showLegend && !empty ? (
        <ChartLegend>
          {series.map((s, k) => (
            <li key={s.key} className={classes.legendItem}>
              <LegendSwatch type={type} color={colours[k]!} index={k} />
              <span className={classes.legendLabel}>{s.label}</span>
            </li>
          ))}
        </ChartLegend>
      ) : null}
      <div role="status" aria-live="polite" className={classes.hidden}>
        {announce}
      </div>
      {!empty ? (
        data.length <= 1000 ? (
          <table id={`${id}-table`} className={classes.hidden}>
            <caption>{label}</caption>
            <thead>
              <tr>
                <th scope="col">{x}</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i}>
                  <th scope="row">{xFormat(row[x])}</th>
                  {series.map((s, k) => (
                    <td key={s.key}>{valueFormat(columns[k]![i]!)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p id={`${id}-table`} className={classes.hidden}>
            {`${data.length.toLocaleString()} points. ${series.map((s, k) => `${s.label}: from ${valueFormat(Math.min(...columns[k]!))} to ${valueFormat(Math.max(...columns[k]!))}`).join(". ")}.`}
          </p>
        )
      ) : null}
    </div>
  );
}

function LegendSwatch({ type, color, index }: { type: NonNullable<ChartProps["type"]>; color: ChartColor; index: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 4" className={classes.swatch}>
      {type === "bar" ? (
        <rect x="0" y="-2" width="16" height="8" rx="1" className={fillClass[color]} />
      ) : (
        <line x1="0" x2="16" y1="2" y2="2" strokeWidth="3" strokeDasharray={DASHES[index % DASHES.length]} className={strokeClass[color]} />
      )}
    </svg>
  );
}

export interface ChartLegendProps {
  children?: ReactNode;
  className?: string;
}

/** The legend under the plot, a list of each series' swatch (its colour and dash) and name; Chart renders it. */
export function ChartLegend({ children, className }: ChartLegendProps) {
  return (
    <ul data-slot="chart-legend" aria-label="Legend" className={cn(classes.legend, className)}>
      {children}
    </ul>
  );
}

export interface ChartTooltipProps {
  title?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/** The box beside the guide with the category and each series' value; Chart renders it. */
export function ChartTooltip({ title, children, style, className }: ChartTooltipProps) {
  return (
    <div data-slot="chart-tooltip" aria-hidden="true" style={style} className={cn(classes.tooltip, className)}>
      {title !== undefined ? <div className={classes.tooltipTitle}>{title}</div> : null}
      {children}
    </div>
  );
}

export interface ChartSparklineProps {
  /** The numbers, oldest first. */
  values: readonly number[];
  /** What they are ("Queries per minute"); the summary screen readers hear starts with it. */
  "aria-label": string;
  /** chart.cat colour. */
  color?: ChartColor;
  /** Fills under the line. */
  area?: boolean;
  /** Formats the first, last, lowest and highest values in the summary. */
  valueFormat?: (value: number) => string;
  /** Extra classes (the size: h-control-xs w-panel-xs by default). */
  className?: string;
}

/** A tiny inline line (role="img") for a table cell, a Stat or a card; its label says the range in words. */
export function ChartSparkline({ values, "aria-label": label, color = 1, area = false, valueFormat = defaultFormat, className }: ChartSparklineProps) {
  const w = 100;
  const h = 24;
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 0;
  const keep = decimate(values, 200);
  const xAt = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * w : w / 2);
  const yAt = (v: number) => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
  const line = keep.map((i, j) => `${j ? "L" : "M"}${xAt(i).toFixed(2)} ${yAt(values[i]!).toFixed(2)}`).join("");
  const summary = values.length ? `${label}: from ${valueFormat(values[0]!)} to ${valueFormat(values[values.length - 1]!)}, lowest ${valueFormat(lo)}, highest ${valueFormat(hi)}` : `${label}: no data`;
  return (
    <svg data-slot="chart-sparkline" role="img" aria-label={summary} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn(classes.sparkline, className)}>
      {area && values.length ? <path d={`${line}L${w} ${h}L0 ${h}Z`} className={softFillClass[color]} /> : null}
      {values.length ? <path d={line} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" className={strokeClass[color]} /> : null}
    </svg>
  );
}
