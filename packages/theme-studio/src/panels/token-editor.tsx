// The advanced editor (spec section 5, "Edit"): any semantic, component or primitive token. A
// colour shows its OKLCH values and its contrast against every role it is paired with, as the
// engine measured them; a primitive colour takes an OKLCH literal, a role takes an alias (a role
// never holds a raw colour: the engine rejects it). Reset per token and per group.
import { type Token, type TokenSet, overText } from "@byterygon/design-tokens";
import { Badge } from "@/components/badge/badge";
import { Button } from "@/components/button/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/collapsible/collapsible";
import { Combobox, ComboboxItem } from "@/components/combobox/combobox";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { SearchInput } from "@/components/search-input/search-input";
import { Slider } from "@/components/slider/slider";
import { Switch } from "@/components/switch/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { useMemo, useState } from "react";
import { type Derived, contextsOf, contrastOf, diagnosticsOf, modeLabel, resolvedView } from "../engine.ts";
import { type ThemeDoc, groupOf, overriddenTokens, overrideOf, overrideText, parseOverrideText, resetGroup, setOverride } from "../state/theme-edit.ts";

export interface TokenEditorProps {
  readonly theme: ThemeDoc;
  readonly derived: Derived;
  readonly onChange: (next: ThemeDoc) => void;
  readonly selected: string | undefined;
  readonly onSelect: (path: string | undefined) => void;
}

type TierFilter = "semantic" | "component" | "primitive" | "all";

const cssVar = (path: string) => `var(--by-${path.replace(/\./g, "-")})`;

/** A swatch of a colour token, in the colour mode of its region. */
function Swatch({ path, label }: { path: string; label?: string }) {
  return <span aria-hidden="true" title={label} className="inline-block size-icon-md shrink-0 rounded-sm border border-border" style={{ background: cssVar(path) }} />;
}

function TokenRow({ token, edited, selected, onSelect }: { token: Token; edited: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="flex w-full min-w-0 items-center gap-inline-sm rounded-sm px-inline-sm py-inline-xs text-start text-label text-fg outline-none hover:bg-hover aria-pressed:bg-selected focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring"
    >
      {token.type === "color" && (
        <span className="flex shrink-0 gap-inline-xs">
          <span data-theme="light">
            <Swatch path={token.path} label="light" />
          </span>
          <span data-theme="dark">
            <Swatch path={token.path} label="dark" />
          </span>
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono">{token.path}</span>
      {edited && <Badge variant="accent">edited</Badge>}
    </button>
  );
}

export function TokenList({ theme, derived, onChange, selected, onSelect }: TokenEditorProps) {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<TierFilter>("semantic");
  const [editedOnly, setEditedOnly] = useState(false);
  const edited = useMemo(() => new Set(overriddenTokens(theme)), [theme]);
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = new Map<string, Token[]>();
    for (const token of derived.set.tokens.values()) {
      if (tier !== "all" && token.tier !== tier) continue;
      if (editedOnly && !edited.has(token.path)) continue;
      const haystack = `${token.path} ${token.description}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      const group = groupOf(token.path);
      out.set(group, [...(out.get(group) ?? []), token]);
    }
    return [...out];
  }, [derived.set, query, tier, editedOnly, edited]);
  const count = groups.reduce((sum, [, tokens]) => sum + tokens.length, 0);
  const open = query !== "" || editedOnly || groups.length <= 3;

  return (
    <div className="flex flex-col gap-stack-md">
      <SearchInput aria-label="Search tokens" placeholder="Search tokens (path or description)" value={query} onValueChange={setQuery} />
      <ToggleGroup aria-label="Tier" size="small" value={[tier]} onValueChange={(next: unknown[]) => next[0] !== undefined && setTier(next[0] as TierFilter)}>
        <ToggleGroupItem value="semantic">Semantic</ToggleGroupItem>
        <ToggleGroupItem value="component">Component</ToggleGroupItem>
        <ToggleGroupItem value="primitive">Primitive</ToggleGroupItem>
        <ToggleGroupItem value="all">All</ToggleGroupItem>
      </ToggleGroup>
      <Field>
        <FieldLabel>
          <Switch checked={editedOnly} onCheckedChange={setEditedOnly} />
          Edited only
        </FieldLabel>
      </Field>
      <p className="text-caption text-fg-muted" aria-live="polite">
        {count} {count === 1 ? "token" : "tokens"} in {groups.length} {groups.length === 1 ? "group" : "groups"}
      </p>
      <div className="flex flex-col gap-stack-xs">
        {groups.map(([group, tokens]) => {
          const groupEdited = tokens.some((token) => edited.has(token.path));
          return (
            <Collapsible key={`${group}-${open}`} defaultOpen={open}>
              <div className="flex items-center gap-inline-xs">
                <CollapsibleTrigger className="min-w-0 flex-1">
                  <span className="truncate font-mono">{group}</span>
                  <span className="text-caption text-fg-muted">{tokens.length}</span>
                </CollapsibleTrigger>
                {groupEdited && (
                  <Button appearance="subtle" size="small" onClick={() => onChange(resetGroup(theme, group))} aria-label={`Reset group ${group}`}>
                    Reset group
                  </Button>
                )}
              </div>
              <CollapsiblePanel>
                <div className="flex flex-col">
                  {tokens.map((token) => (
                    <TokenRow key={token.path} token={token} edited={edited.has(token.path)} selected={selected === token.path} onSelect={() => onSelect(token.path)} />
                  ))}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

/** The colour primitives a role may alias in one colour mode, ramp by ramp. */
function colourTargets(set: TokenSet, mode: string | undefined): string[] {
  const out: string[] = [];
  for (const token of set.tokens.values()) {
    if (token.tier !== "primitive" || token.type !== "color") continue;
    const scheme = token.ramp?.scheme;
    if (scheme && mode && scheme !== mode) continue;
    out.push(token.path);
  }
  return out;
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

/** OKLCH sliders for a primitive colour: writes `oklch(L C H)` (with `/ alpha` when translucent). */
function OklchEditor({ value, onChange, label }: { value: { l: number; c: number; h: number; alpha: number }; onChange: (text: string) => void; label: string }) {
  const write = (next: Partial<typeof value>) => {
    const v = { ...value, ...next };
    onChange(`oklch(${round(v.l, 4)} ${round(v.c, 4)} ${round(v.h, 2)}${v.alpha < 1 ? ` / ${round(v.alpha, 3)}` : ""})`);
  };
  return (
    <div className="flex flex-col gap-stack-sm">
      <Slider aria-label={`${label} lightness`} min={0} max={1} step={0.0025} value={value.l} onValueChange={(l) => write({ l: Number(l) })} />
      <Slider aria-label={`${label} chroma`} min={0} max={0.4} step={0.001} value={value.c} onValueChange={(c) => write({ c: Number(c) })} />
      <Slider aria-label={`${label} hue`} min={0} max={360} step={0.5} value={value.h} onValueChange={(h) => write({ h: Number(h) })} />
    </div>
  );
}

export function TokenDetail({ theme, derived, onChange, selected, onSelect }: TokenEditorProps) {
  const token = selected ? derived.set.tokens.get(selected) : undefined;
  if (!token) {
    return <p className="text-body text-fg-muted">Choose a token to see its values, its contrast pairs and to change it.</p>;
  }
  const own = overrideOf(theme, token.path);
  const axis = token.axis ? derived.set.axes.find((a) => a.name === token.axis) : undefined;
  const editModes: readonly (string | undefined)[] = axis ? axis.modes : [undefined];
  const contrast = contrastOf(derived.contrast, token.path);
  const problems = diagnosticsOf(derived.diagnostics, token.path);
  const canHoldLiteral = token.tier === "primitive" || token.type !== "color";

  return (
    <article className="flex flex-col gap-stack-lg" aria-label={`Token ${token.path}`}>
      <header className="flex flex-col gap-stack-xs">
        <div className="flex flex-wrap items-center gap-inline-sm">
          <h3 className="font-mono text-heading-4 text-fg">{token.path}</h3>
          <Badge>{token.tier}</Badge>
          <Badge appearance="outline">{token.type}</Badge>
          {own !== undefined && <Badge variant="accent">edited</Badge>}
        </div>
        <p className="text-body text-fg-muted">{token.description}</p>
        <p className="font-mono text-caption text-fg-muted">--by-{token.path.replace(/\./g, "-")}</p>
        <div className="flex gap-inline-sm">
          <Button appearance="secondary" size="small" disabled={own === undefined} onClick={() => onChange(setOverride(theme, token.path, undefined))}>
            Reset token
          </Button>
          <Button appearance="subtle" size="small" onClick={() => onSelect(undefined)}>
            Close
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-stack-sm" aria-label="Resolved values">
        <h4 className="text-label text-fg">Resolved values</h4>
        <Table aria-label="Resolved values">
          <TableHeader>
            <TableRow>
              <TableHead>Mode</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Through</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contextsOf(derived.set, token.path).map(({ label, context }) => {
              const view = resolvedView(derived.set, token, context);
              return (
                <TableRow key={label}>
                  <TableCell>
                    <span className="flex items-center gap-inline-sm">
                      {token.type === "color" && (
                        <span data-theme={context["theme"]}>
                          <Swatch path={token.path} />
                        </span>
                      )}
                      <span className="text-fg">{label}</span>
                    </span>
                  </TableCell>
                  <TableCell wrap>
                    <span className="font-mono text-caption">
                      {view.error ?? view.css}
                      {view.oklch && (
                        <span className="block text-fg-muted">
                          L {round(view.oklch.l, 4)} C {round(view.oklch.c, 4)} H {round(view.oklch.h, 2)}
                          {view.oklch.alpha < 1 ? ` α ${round(view.oklch.alpha, 3)}` : ""} · {view.oklch.hex}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell wrap>
                    <span className="font-mono text-caption text-fg-muted">{view.chain.slice(1).join(" → ") || "literal"}</span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-stack-md" aria-label="Change">
        <h4 className="text-label text-fg">Change</h4>
        {editModes.map((mode) => {
          const written = mode === undefined ? own : own !== null && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>)[mode] : own;
          const context = { ...Object.fromEntries(derived.set.axes.map((a) => [a.name, a.default])), ...(axis && mode ? { [axis.name]: mode } : {}) };
          const view = resolvedView(derived.set, token, context);
          const label = mode ?? "every mode";
          const set = (value: unknown) => onChange(setOverride(theme, token.path, value, mode, axis?.modes ?? []));
          return (
            <div key={label} className="flex flex-col gap-stack-sm rounded-md border border-border-muted bg-surface p-inset-md text-fg" data-theme={axis?.name === "theme" ? mode : undefined}>
              <p className="text-label text-fg">{label}</p>
              {token.type === "color" && !canHoldLiteral && (
                <Field>
                  <FieldLabel>Alias a colour primitive</FieldLabel>
                  <Combobox<string>
                    items={colourTargets(derived.set, axis?.name === "theme" ? mode : undefined)}
                    value={typeof written === "string" && written.startsWith("{") ? written.slice(1, -1) : null}
                    onValueChange={(path) => path && set(`{${path}}`)}
                    placeholder="color.brand.9"
                  >
                    {(path: string) => (
                      <ComboboxItem key={path} value={path}>
                        <span className="flex items-center gap-inline-sm">
                          <Swatch path={path} />
                          <span className="font-mono">{path}</span>
                        </span>
                      </ComboboxItem>
                    )}
                  </Combobox>
                </Field>
              )}
              {token.type === "color" && canHoldLiteral && view.oklch && <OklchEditor label={label} value={view.oklch} onChange={set} />}
              <Field>
                <FieldLabel>Value as written in the theme file</FieldLabel>
                <Input
                  size="sm"
                  className="font-mono"
                  placeholder={view.chain.length > 1 ? `{${view.chain[1]}}` : view.css}
                  value={overrideText(written)}
                  onValueChange={(text: string) => set(text.trim() === "" ? undefined : parseOverrideText(token.type, text))}
                />
                <FieldDescription>
                  {canHoldLiteral ? "An alias in braces ({color.brand.9}) or a literal of the token's type." : "An alias in braces: a role never holds a raw colour."} Empty removes the change.
                </FieldDescription>
              </Field>
            </div>
          );
        })}
      </section>

      {problems.length > 0 && (
        <section className="flex flex-col gap-stack-sm" aria-label="Problems">
          <h4 className="text-label text-fg">Problems</h4>
          <ul className="flex flex-col gap-stack-xs">
            {problems.map((problem, index) => (
              <li key={index} className="text-body text-fg">
                <Badge variant={problem.severity === "error" ? "danger" : "warning"}>{problem.rule}</Badge> {problem.message}
                {problem.fix && <span className="block text-caption text-fg-muted">Fix: {problem.fix.summary}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {contrast.length > 0 && (
        <section className="flex flex-col gap-stack-sm" aria-label="Contrast">
          <h4 className="text-label text-fg">Contrast pairs</h4>
          <Table aria-label="Contrast pairs">
            <TableHeader>
              <TableRow>
                <TableHead>Pair</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead align="end">WCAG</TableHead>
                <TableHead align="end">APCA Lc</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contrast.map((m, index) => (
                <TableRow key={index}>
                  <TableCell wrap>
                    <span className="flex items-center gap-inline-sm">
                      <span data-theme={m.mode["theme"]} className="rounded-xs px-inline-xs font-mono text-caption" style={{ color: cssVar(m.fg), background: cssVar(m.bg) }}>
                        Aa
                      </span>
                      <span className="font-mono text-caption text-fg">
                        {m.fg} on {m.bg}
                        {overText(m.over)}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>{modeLabel(m.mode)}</TableCell>
                  <TableCell align="end">
                    {m.ratio.toFixed(2)} / {m.required}
                  </TableCell>
                  <TableCell align="end">{m.apca.toFixed(1)}</TableCell>
                  <TableCell>
                    <Badge variant={m.pass ? "success" : "danger"}>{m.pass ? "pass" : "fail"}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </article>
  );
}
