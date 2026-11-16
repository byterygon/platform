// The preview (spec section 5, "Preview"): real Byterygon UI components, through their own
// realistic examples (the same files the component tests render, so the preview cannot drift from
// the components), and a swatch board of every ramp and every colour role. The theme reaches them
// only through the token CSS variables the Studio writes, so a change shows at once.
import type { Token, TokenSet } from "@byterygon/design-tokens";
import { AlertRealistic } from "@/components/alert/alert.example";
import { BadgeRealistic } from "@/components/badge/badge.example";
import { ButtonRealistic } from "@/components/button/button.example";
import { CardRealistic } from "@/components/card/card.example";
import { ChartRealistic } from "@/components/chart/chart.example";
import { CheckboxRealistic } from "@/components/checkbox/checkbox.example";
import { CodeInputRealistic } from "@/components/code-input/code-input.example";
import { DialogRealistic } from "@/components/dialog/dialog.example";
import { DropdownMenuRealistic } from "@/components/dropdown-menu/dropdown-menu.example";
import { FormRealistic } from "@/components/form/form.example";
import { IconButtonRealistic } from "@/components/icon-button/icon-button.example";
import { InputRealistic } from "@/components/input/input.example";
import { RadioGroupRealistic } from "@/components/radio-group/radio-group.example";
import { SelectRealistic } from "@/components/select/select.example";
import { SliderRealistic } from "@/components/slider/slider.example";
import { SqlEditorRealistic } from "@/components/sql-editor/sql-editor.example";
import { SwitchRealistic } from "@/components/switch/switch.example";
import { TableRealistic } from "@/components/table/table.example";
import { TabsRealistic } from "@/components/tabs/tabs.example";
import { ToastRealistic } from "@/components/toast/toast.example";
import { ToggleGroupRealistic } from "@/components/toggle-group/toggle-group.example";
import { type ComponentType, type ReactNode, memo } from "react";

interface Group {
  readonly id: string;
  readonly title: string;
  readonly examples: readonly ComponentType[];
}

/** The groups the spec and the task name, in order. */
export const PREVIEW_GROUPS: readonly Group[] = [
  { id: "forms", title: "Forms", examples: [FormRealistic, InputRealistic, SelectRealistic, CheckboxRealistic, RadioGroupRealistic, SwitchRealistic, SliderRealistic] },
  { id: "buttons", title: "Buttons", examples: [ButtonRealistic, IconButtonRealistic, ToggleGroupRealistic, BadgeRealistic] },
  { id: "table", title: "Table", examples: [TableRealistic] },
  { id: "dialog", title: "Dialog", examples: [DialogRealistic] },
  { id: "menu", title: "Menu", examples: [DropdownMenuRealistic] },
  { id: "toast", title: "Toast and alerts", examples: [ToastRealistic, AlertRealistic] },
  { id: "chart", title: "Chart", examples: [ChartRealistic] },
  { id: "editor", title: "Editors", examples: [SqlEditorRealistic, CodeInputRealistic] },
  { id: "surfaces", title: "Cards and tabs", examples: [CardRealistic, TabsRealistic] },
];

function Region({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-stack-md">
      <h3 className="text-heading-3 text-fg">{title}</h3>
      {children}
    </section>
  );
}

/** Memoised: it takes no props and reads the theme only through CSS variables. */
export const Gallery = memo(function Gallery() {
  return (
    <div className="flex flex-col gap-stack-xl">
      {PREVIEW_GROUPS.map((group) => (
        <Region key={group.id} title={group.title}>
          <div className="flex flex-col items-start gap-stack-lg rounded-lg border border-border bg-canvas p-inset-lg">
            {group.examples.map((Example, index) => (
              <Example key={index} />
            ))}
          </div>
        </Region>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Swatch board

const cssVar = (path: string) => `var(--by-${path.replace(/\./g, "-")})`;
const STEPS = Array.from({ length: 12 }, (_, i) => i + 1);

/** The ramps of the theme, as the engine generated them (every seed colour, in catalogue order). */
export function rampsOf(set: TokenSet): string[] {
  const names: string[] = [];
  for (const token of set.tokens.values()) {
    if (token.ramp && token.ramp.scheme === "light" && !names.includes(token.ramp.name)) names.push(token.ramp.name);
  }
  return names;
}

function RampRow({ ramp, scheme }: { ramp: string; scheme: "light" | "dark" }) {
  const group = scheme === "light" ? ramp : `${ramp}-dark`;
  return (
    <div className="flex items-center gap-inline-sm" data-theme={scheme}>
      <span className="w-24 shrink-0 font-mono text-caption text-fg-muted">{group}</span>
      <div className="grid flex-1 grid-cols-12 gap-inline-xs" role="list" aria-label={`${group} ramp`}>
        {STEPS.map((step) => (
          <span
            key={step}
            role="listitem"
            title={`color.${group}.${step}`}
            aria-label={`color.${group}.${step}`}
            className="flex h-control-md items-end justify-center rounded-xs border border-border-muted pb-inline-xs font-mono text-caption"
            style={{ background: cssVar(`color.${group}.${step}`), color: cssVar(step >= 9 ? `color.${group}.contrast` : `color.${group}.12`) }}
          >
            {step}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Colour roles grouped by their group path (`color.bg`, `color.fg`, `color.status.danger`). */
function roleGroups(set: TokenSet): [string, Token[]][] {
  const out = new Map<string, Token[]>();
  for (const token of set.tokens.values()) {
    if (token.type !== "color" || token.tier === "primitive") continue;
    const group = token.path.slice(0, token.path.lastIndexOf("."));
    out.set(group, [...(out.get(group) ?? []), token]);
  }
  return [...out];
}

function RoleBoard({ set, scheme }: { set: TokenSet; scheme: "light" | "dark" }) {
  return (
    <div data-theme={scheme} className="flex flex-1 flex-col gap-stack-md rounded-lg border border-border bg-canvas p-inset-lg text-fg">
      <p className="text-label text-fg-muted">{scheme === "light" ? "Light" : "Dark"}</p>
      {roleGroups(set).map(([group, tokens]) => (
        <div key={group} className="flex flex-col gap-stack-xs">
          <p className="font-mono text-caption text-fg-muted">{group}</p>
          <div className="flex flex-wrap gap-inline-sm">
            {tokens.map((token) => (
              <span key={token.path} className="flex items-center gap-inline-xs" title={token.description}>
                <span aria-hidden="true" className="inline-block size-icon-lg rounded-sm border border-border" style={{ background: cssVar(token.path) }} />
                <span className="font-mono text-caption">{token.path.slice(group.length + 1)}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SwatchBoard({ set }: { set: TokenSet }) {
  const ramps = rampsOf(set);
  return (
    <div className="flex flex-col gap-stack-xl">
      <Region title="Ramps">
        <p className="text-body text-fg-muted">Twelve steps per colour and scheme: 1-2 app backgrounds, 3-5 component backgrounds, 6-8 borders, 9-10 solids, 11-12 text.</p>
        <div className="flex flex-col gap-stack-sm">
          {ramps.map((ramp) => (
            <div key={ramp} className="flex flex-col gap-stack-xs">
              {(["light", "dark"] as const).map((scheme) => (
                <div key={scheme} data-theme={scheme} className="rounded-md bg-canvas p-inset-sm">
                  <RampRow ramp={ramp} scheme={scheme} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </Region>
      <Region title="Colour roles">
        <div className="flex flex-col gap-gap-md xl:flex-row">
          <RoleBoard set={set} scheme="light" />
          <RoleBoard set={set} scheme="dark" />
        </div>
      </Region>
    </div>
  );
}
