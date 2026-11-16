// The contrast report (spec section 5, "Check"; TSK-49): every role pair the engine measured, per
// mode combination (colour mode x density), failing pairs first, each with the engine's fix applied
// in one click. Nothing here measures or solves anything: the pairs, ratios and fixes are
// `validate`'s (a failing ContrastMeasurement carries the fix its diagnostic has), and applying one
// is the engine's `applyFix`, the edit `by-tokens fix` makes. Gamut warnings are listed with theirs.
import { type ContrastMeasurement, type Diagnostic, type Fix, type ModeContext, allContexts, applyFix, fixAll, isApplicable, overStack } from "@byterygon/design-tokens";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert/alert";
import { Badge } from "@/components/badge/badge";
import { Button } from "@/components/button/button";
import { Switch } from "@/components/switch/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { type CSSProperties, type ReactNode, useState } from "react";
import type { Derived } from "../engine.ts";
import type { View } from "../state/persist.ts";
import type { ThemeDoc } from "../state/theme-edit.ts";

const cssVar = (path: string) => `var(--by-${path.replace(/\./g, "-")})`;
const comboKey = (context: ModeContext) => Object.values(context).join(" · ");

/** True when a measurement holds in `combo`: every mode it was measured in is the combo's. */
const inCombo = (m: ContrastMeasurement, combo: ModeContext) => Object.entries(m.mode).every(([axis, mode]) => combo[axis] === mode);

/** The pair painted as the user sees it: the stack under it, its background, its foreground. */
function Sample({ m, combo, gradientAt }: { m: ContrastMeasurement; combo: ModeContext; gradientAt: (path: string) => boolean }) {
  const layers = [...overStack(m), m.bg];
  const paint = (path: string): CSSProperties => (gradientAt(path) ? { backgroundImage: cssVar(path), backgroundColor: cssVar("color.bg.canvas") } : { background: cssVar(path) });
  const inner =
    m.kind === "text" ? (
      <span className="px-inline-sm font-sans text-body-1-strong" style={{ color: cssVar(m.fg) }}>
        Aa
      </span>
    ) : (
      <span className="block size-icon-md rounded-sm border-2" style={{ borderColor: cssVar(m.fg) }} />
    );
  const nested = layers.reduceRight<ReactNode>(
    (child, path) => (
      <span className="flex size-full items-center justify-center" style={paint(path)}>
        {child}
      </span>
    ),
    inner,
  );
  return (
    <span aria-hidden="true" {...Object.fromEntries(Object.entries(combo).map(([axis, mode]) => [`data-${axis}`, mode]))} className="flex h-control-lg w-16 shrink-0 overflow-hidden rounded-md border border-border-subtle">
      {nested}
    </span>
  );
}

function FixActions({ fix, onApply }: { fix: Fix; onApply: (fix: Pick<Fix, "overrides" | "seeds">, summary: string) => void }) {
  return (
    <div className="flex flex-col gap-stack-xs">
      <div className="flex flex-wrap items-start gap-inline-sm">
        <span className="min-w-0 flex-1 text-caption-1 text-fg">{fix.summary}</span>
        {isApplicable(fix) && (
          <Button size="small" appearance="primary" onClick={() => onApply(fix, fix.summary)}>
            Apply fix
          </Button>
        )}
      </div>
      {(fix.alternatives ?? []).map((alternative) => (
        <div key={alternative.summary} className="flex flex-wrap items-start gap-inline-sm">
          <span className="min-w-0 flex-1 text-caption-1 text-fg-muted">Or: {alternative.summary}</span>
          {alternative.overrides && (
            <Button size="small" appearance="secondary" onClick={() => onApply(alternative, alternative.summary)}>
              Apply
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

interface Group {
  readonly fg: string;
  readonly mode: ModeContext;
  /** Worst first. */
  readonly pairs: readonly ContrastMeasurement[];
  readonly failing: number;
  /** The engine solves a fix per role and mode, against every background: one per group. */
  readonly fix?: Fix;
}

/** Measurements grouped by foreground role and mode; failing groups first, worst first. */
function groupByRole(measurements: readonly ContrastMeasurement[]): Group[] {
  const score = (m: ContrastMeasurement) => (m.pass ? 1 : 0) * 100 + m.ratio / m.required;
  const map = new Map<string, ContrastMeasurement[]>();
  for (const m of measurements) {
    const key = `${m.fg} ${JSON.stringify(m.mode)}`;
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  return [...map.values()]
    .map((pairs) => {
      const sorted = [...pairs].sort((a, b) => score(a) - score(b));
      const fix = sorted.find((m) => m.fix)?.fix;
      return { fg: sorted[0]!.fg, mode: sorted[0]!.mode, pairs: sorted, failing: sorted.filter((m) => !m.pass).length, ...(fix ? { fix } : {}) };
    })
    .sort((a, b) => score(a.pairs[0]!) - score(b.pairs[0]!));
}

const SHOWN = 4;

function RoleGroup({ group, combo, gradientAt, onSelect, onApply }: { group: Group; combo: ModeContext; gradientAt: (path: string) => boolean; onSelect: (path: string) => void; onApply: (fix: Pick<Fix, "overrides" | "seeds">, summary: string) => void }) {
  const [all, setAll] = useState(false);
  const worst = group.pairs[0]!;
  const shown = all ? group.pairs : group.pairs.slice(0, SHOWN);
  return (
    <li aria-label={group.fg} className="flex flex-col gap-stack-sm rounded-md border border-border-muted bg-surface p-inset-md">
      <span className="flex flex-wrap items-center gap-inline-xs">
        <Button appearance="subtle" size="small" className="font-mono" onClick={() => onSelect(group.fg)}>
          {group.fg}
        </Button>
        <Badge appearance="outline">{worst.kind === "text" ? "text" : "UI"}</Badge>
        <span className="text-caption-1 text-fg-muted">
          {group.failing > 0 ? `fails on ${group.failing} of ${group.pairs.length} ${group.pairs.length === 1 ? "background" : "backgrounds"}` : `passes on ${group.pairs.length} ${group.pairs.length === 1 ? "background" : "backgrounds"}`}
          {Object.keys(group.mode).length > 0 ? ` (${Object.values(group.mode).join(", ")})` : " (every mode)"}
        </span>
      </span>
      {group.fix && <FixActions fix={group.fix} onApply={onApply} />}
      <ul aria-label={`${group.fg} pairs`} className="flex flex-col gap-stack-xs">
        {shown.map((m, index) => (
          <li key={`${m.bg} ${JSON.stringify(m.over)} ${index}`} className="flex flex-wrap items-center gap-inline-sm">
            <Sample m={m} combo={combo} gradientAt={gradientAt} />
            <Badge variant={m.pass ? "success" : "danger"}>
              {m.ratio.toFixed(2)} / {m.required}
            </Badge>
            <span className="text-caption-1 text-fg-muted">on</span>
            <Button appearance="subtle" size="small" className="font-mono" onClick={() => onSelect(m.bg)}>
              {m.bg}
            </Button>
            {m.over !== undefined && <span className="font-mono text-caption-1 text-fg-muted">over {(typeof m.over === "string" ? [m.over] : [...m.over].reverse()).join(" over ")}</span>}
            <span className="text-caption-1 text-fg-muted">APCA Lc {Math.abs(m.apca).toFixed(1)}</span>
          </li>
        ))}
      </ul>
      {group.pairs.length > SHOWN && (
        <Button size="small" appearance="transparent" className="self-start" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${group.pairs.length}`}
        </Button>
      )}
    </li>
  );
}

export interface ContrastReportProps {
  readonly theme: ThemeDoc;
  readonly derived: Derived;
  readonly view: View;
  readonly onChange: (theme: ThemeDoc) => void;
  readonly onSelect: (path: string) => void;
}

export function ContrastReport({ theme, derived, view, onChange, onSelect }: ContrastReportProps) {
  const combos = allContexts(derived.set);
  const failingIn = (c: ModeContext) => derived.contrast.filter((m) => !m.pass && inCombo(m, c));
  // The view's own combination, unless it has no failure and another has.
  const viewCombo = combos.find((c) => c["theme"] === view.mode && c["density"] === view.density) ?? combos[0]!;
  const current = failingIn(viewCombo).length > 0 ? viewCombo : (combos.find((c) => failingIn(c).length > 0) ?? viewCombo);
  const [chosen, setChosen] = useState<string>();
  const combo = combos.find((c) => comboKey(c) === chosen) ?? current;
  const [showPassing, setShowPassing] = useState(false);
  const [done, setDone] = useState<{ text: string; before: ThemeDoc }>();

  const gradientAt = (path: string) => derived.set.tokens.get(path)?.type === "gradient";
  // A group holds all of the role's pairs (the fix holds on every one); groups that pass are hidden unless asked.
  const groups = groupByRole(derived.contrast.filter((m) => inCombo(m, combo))).filter((group) => showPassing || group.failing > 0);
  const failing = derived.contrast.filter((m) => !m.pass);
  const gamut = derived.diagnostics.filter((d) => d.rule === "gamut");

  const apply = (next: ThemeDoc, text: string) => {
    setDone({ text, before: theme });
    onChange(next);
  };
  const applyOne = (fix: Pick<Fix, "overrides" | "seeds">, summary: string) => apply(applyFix(theme, fix, derived.set), `Applied: ${summary}`);

  return (
    <div className="flex flex-col gap-stack-lg">
      <div className="flex flex-wrap items-center gap-inline-md">
        <p className="text-body-1 text-fg">
          {derived.contrast.length} pairs measured in {combos.length} mode combinations (WCAG 2.2 {derived.set.contrast.level}: text {derived.set.contrast.text}:1, UI {derived.set.contrast.ui}:1).{" "}
          {failing.length === 0 ? "Every pair passes." : `${failing.length} ${failing.length === 1 ? "measurement fails" : "measurements fail"}.`}
        </p>
        {failing.length > 0 && (
          <Button
            size="small"
            appearance="primary"
            className="ms-auto"
            onClick={() => {
              const result = fixAll(theme);
              const left = result.diagnostics.filter((d) => d.severity === "error").length;
              apply(result.theme, `Applied ${result.applied.length} ${result.applied.length === 1 ? "fix" : "fixes"}${left > 0 ? `; ${left} ${left === 1 ? "problem has" : "problems have"} no automatic fix` : ""}.`);
            }}
          >
            Fix all
          </Button>
        )}
      </div>

      {done && (
        <Alert intent="success" onDismiss={() => setDone(undefined)}>
          <AlertDescription>
            <span className="flex flex-wrap items-center gap-inline-sm" aria-live="polite">
              <span className="min-w-0 flex-1">{done.text}</span>
              <Button
                size="small"
                appearance="secondary"
                onClick={() => {
                  onChange(done.before);
                  setDone(undefined);
                }}
              >
                Undo
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-inline-md">
        <ToggleGroup aria-label="Mode combination" size="small" value={[comboKey(combo)]} onValueChange={(next: unknown[]) => next[0] !== undefined && setChosen(String(next[0]))}>
          {combos.map((c) => {
            const count = failingIn(c).length;
            return (
              <ToggleGroupItem key={comboKey(c)} value={comboKey(c)}>
                {comboKey(c)}
                {count > 0 && (
                  <Badge variant="danger" appearance="solid" size="sm" className="ms-inline-xs">
                    {count}
                  </Badge>
                )}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <label className="flex items-center gap-inline-sm text-body-1 text-fg">
          <Switch checked={showPassing} onCheckedChange={setShowPassing} />
          Show passing pairs
        </label>
      </div>

      {groups.length === 0 ? (
        <p className="text-body-1 text-fg-muted">No pair fails in {comboKey(combo)}.</p>
      ) : (
        <ul aria-label={`Contrast pairs, ${comboKey(combo)}`} className="flex flex-col gap-stack-sm">
          {groups.map((group) => (
            <RoleGroup key={`${group.fg} ${JSON.stringify(group.mode)}`} group={group} combo={combo} gradientAt={gradientAt} onSelect={onSelect} onApply={applyOne} />
          ))}
        </ul>
      )}

      {gamut.length > 0 && (
        <section aria-label="Gamut warnings" className="flex flex-col gap-stack-sm">
          <h3 className="text-subtitle-2 text-fg">Colours sRGB cannot show</h3>
          <p className="text-caption-1 text-fg-muted">The engine lowered these chromas to fit sRGB, keeping hue and lightness. Lower the seed to match, or keep the reduced colour: both pass every rule.</p>
          {gamut.map((d: Diagnostic, index) => (
            <Alert key={`${d.token} ${index}`} intent="warning">
              <AlertTitle>{d.token}</AlertTitle>
              <AlertDescription>
                <span className="flex flex-col gap-stack-xs">
                  <span>{d.message}</span>
                  {d.fix && <FixActions fix={d.fix} onApply={applyOne} />}
                </span>
              </AlertDescription>
            </Alert>
          ))}
        </section>
      )}
    </div>
  );
}
