// The seeds panel (spec section 5, "Edit"): hue, chroma and neutral tint of every ramp, radius,
// body font size, the default colour scheme and density, the contrast level, and the two font
// families. A seed the file does not set shows the engine's default; changing it writes the seed
// into the theme file; "Reset" removes it again. Every value range is the engine's own (seeds.ts).
import type { ResolvedSeeds, TokenSet } from "@byterygon/design-tokens";
import { ColorSeed } from "./color-picker.tsx";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/accordion/accordion";
import { Badge } from "@/components/badge/badge";
import { Button } from "@/components/button/button";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { NumberInput } from "@/components/number-input/number-input";
import { Slider } from "@/components/slider/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { type ReactNode, useId } from "react";
import { type ThemeDoc, overrideOf, overrideText, parseOverrideText, resetSeeds, seedOf, setOverride, setSeed } from "../state/theme-edit.ts";

export interface SeedsPanelProps {
  readonly theme: ThemeDoc;
  readonly seeds: ResolvedSeeds;
  /** The generated tokens, for the colour each ramp shows at. */
  readonly set: TokenSet;
  readonly onChange: (next: ThemeDoc) => void;
}

/** The ramps the default catalogue has, in the order the panel lists them. */
const PRIMARY_RAMPS = ["brand", "neutral"] as const;
const LABELS: Record<string, string> = {
  brand: "Brand",
  neutral: "Neutral",
  red: "Red (danger)",
  amber: "Amber (warning)",
  green: "Green (success)",
  blue: "Blue (info)",
  violet: "Violet",
  orange: "Orange",
  teal: "Teal",
  pink: "Pink",
};

function Section({ title, set, onReset, children }: { title: string; set: boolean; onReset: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-stack-md border-b border-border-muted pb-inset-lg" aria-label={title}>
      <div className="flex items-center justify-between gap-inline-sm">
        <h3 className="text-heading-4 text-fg">{title}</h3>
        <Button appearance="subtle" size="small" disabled={!set} onClick={onReset} aria-label={`Reset ${title.toLowerCase()}`}>
          Reset
        </Button>
      </div>
      {children}
    </section>
  );
}

interface NumberSeedProps {
  readonly label: string;
  readonly value: number;
  readonly set: boolean;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly description?: string | undefined;
  readonly onChange: (value: number) => void;
}

/** A seed with a slider and a number field side by side, both on the engine's range. */
function NumberSeed({ label, value, set, min, max, step, description, onChange }: NumberSeedProps) {
  const id = useId();
  const decimals = step < 1 ? String(step).split(".")[1]!.length : 0;
  const rounded = Number(value.toFixed(decimals));
  return (
    <Field className="w-full">
      <div className="flex items-center justify-between gap-inline-sm">
        <FieldLabel id={id}>{label}</FieldLabel>
        {!set && <Badge appearance="outline">default</Badge>}
      </div>
      <div className="flex items-center gap-inline-md">
        <Slider aria-labelledby={id} className="flex-1" min={min} max={max} step={step} value={rounded} onValueChange={(next) => onChange(Number(next as number))} />
        <NumberInput
          aria-label={label}
          // eslint-disable-next-line byterygon/no-off-scale-spacing -- fits the stepper buttons and a four-digit value; no size role is that wide
          className="w-36 shrink-0"
          size="small"
          min={min}
          max={max}
          step={step}
          format={{ maximumFractionDigits: decimals }}
          value={rounded}
          onValueChange={(next) => {
            if (next !== null && Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
        />
      </div>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

interface ChoiceSeedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly set: boolean;
  readonly options: readonly { value: T; label: string }[];
  readonly onChange: (value: T) => void;
}

function ChoiceSeed<T extends string>({ label, value, set, options, onChange }: ChoiceSeedProps<T>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-stack-xs">
      <div className="flex items-center justify-between gap-inline-sm">
        <span id={id} className="text-label text-fg">
          {label}
        </span>
        {!set && <Badge appearance="outline">default</Badge>}
      </div>
      <ToggleGroup aria-labelledby={id} size="small" value={[value]} onValueChange={(next: unknown[]) => next[0] !== undefined && onChange(next[0] as T)}>
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Lightness of a ramp's solid step in the light scheme, as the engine generated it. */
function solidLightness(set: TokenSet, ramp: string): number {
  const value = set.tokens.get(`color.${ramp}.9`)?.value as { components?: readonly number[] } | undefined;
  return value?.components?.[0] ?? 0.55;
}

function RampSeeds({ ramp, theme, seeds, set, onChange, label }: { ramp: string; label: string } & SeedsPanelProps) {
  const resolved = seeds.colors[ramp];
  if (!resolved) return null;
  const isSet = (field: string) => seedOf(theme, ["colors", ramp, field]) !== undefined;
  const brandHue = seeds.colors["brand"]?.hue ?? 0;
  const note =
    ramp === "neutral" && !isSet("hue")
      ? "The neutral follows the brand hue until you pick one."
      : ramp === "brand"
        ? "A chroma sRGB cannot show at a step is lowered by the engine, with a gamut warning."
        : undefined;
  return (
    <div className="flex flex-col gap-stack-md">
      <ColorSeed
        label={label}
        ramp={ramp}
        hue={resolved.hue ?? brandHue}
        chroma={resolved.chroma}
        lightness={solidLightness(set, ramp)}
        kind={ramp === "neutral" ? "neutral" : "accent"}
        set={isSet("hue") || isSet("chroma")}
        onChange={({ hue, chroma }) => onChange(setSeed(setSeed(theme, ["colors", ramp, "hue"], hue), ["colors", ramp, "chroma"], chroma))}
      />
      {note && <p className="text-caption text-fg-muted">{note}</p>}
      {ramp === "neutral" && (
        <NumberSeed
          label="Tint"
          value={resolved.tint ?? resolved.chroma}
          set={isSet("tint")}
          min={0}
          max={0.1}
          step={0.001}
          description="Chroma of the background steps 1-5 (a warm cream, a deep blue)."
          onChange={(value) => onChange(setSeed(theme, ["colors", ramp, "tint"], value))}
        />
      )}
    </div>
  );
}

const rampSeedPaths = (ramp: string) => [["colors", ramp]];

function FontSeed({ token, label, theme, onChange }: { token: string; label: string; theme: ThemeDoc; onChange: (next: ThemeDoc) => void }) {
  const current = overrideOf(theme, token);
  return (
    <Field className="w-full">
      <div className="flex items-center justify-between gap-inline-sm">
        <FieldLabel>{label}</FieldLabel>
        {current === undefined && <Badge appearance="outline">default</Badge>}
      </div>
      <Input
        size="small"
        placeholder={token === "font.sans" ? "Segoe UI Variable Text, Segoe UI Variable, Segoe UI, Inter, system-ui, sans-serif" : "Cascadia Mono, JetBrains Mono, ui-monospace, monospace"}
        value={overrideText(current)}
        onValueChange={(text: string) => onChange(setOverride(theme, token, text.trim() === "" ? undefined : parseOverrideText("fontFamily", text)))}
      />
      <FieldDescription>
        Families in order, comma-separated (the <code className="font-mono">{token}</code> token). Inter and JetBrains Mono are bundled; Segoe UI Variable and Cascadia Mono are the system's (Windows 11); others must be installed where the theme is used.
      </FieldDescription>
    </Field>
  );
}

export function SeedsPanel({ theme, seeds, set, onChange }: SeedsPanelProps) {
  const others = Object.keys(seeds.colors).filter((ramp) => !(PRIMARY_RAMPS as readonly string[]).includes(ramp));
  const anySet = (paths: readonly (readonly string[])[]) => paths.some((path) => seedOf(theme, path) !== undefined);
  const shapePaths = [["radius"], ["fontSize"]];
  const modePaths = [["colorScheme"], ["density"], ["contrast"]];
  return (
    <div className="flex flex-col gap-stack-lg">
      {PRIMARY_RAMPS.map((ramp) => (
        <Section key={ramp} title={LABELS[ramp]!} set={anySet(rampSeedPaths(ramp))} onReset={() => onChange(resetSeeds(theme, rampSeedPaths(ramp)))}>
          <RampSeeds ramp={ramp} label={LABELS[ramp] ?? ramp} theme={theme} seeds={seeds} set={set} onChange={onChange} />
        </Section>
      ))}

      <Section title="Shape and type" set={anySet(shapePaths) || ["font.sans", "font.mono"].some((t) => overrideOf(theme, t) !== undefined)} onReset={() => onChange(setOverride(setOverride(resetSeeds(theme, shapePaths), "font.sans", undefined), "font.mono", undefined))}>
        <NumberSeed label="Radius (px)" value={seeds.radius} set={seedOf(theme, ["radius"]) !== undefined} min={0} max={32} step={1} description="The md corner; the other radius steps follow it." onChange={(value) => onChange(setSeed(theme, ["radius"], value))} />
        <NumberSeed label="Body font size (px)" value={seeds.fontSize} set={seedOf(theme, ["fontSize"]) !== undefined} min={11} max={18} step={1} description="The size of body-1 (Fluent's step 300); the whole type ramp scales with it." onChange={(value) => onChange(setSeed(theme, ["fontSize"], value))} />
        <FontSeed token="font.sans" label="Interface font" theme={theme} onChange={onChange} />
        <FontSeed token="font.mono" label="Code font" theme={theme} onChange={onChange} />
      </Section>

      <Section title="Modes and contrast" set={anySet(modePaths)} onReset={() => onChange(resetSeeds(theme, modePaths))}>
        <ChoiceSeed label="Default colour scheme" value={seeds.colorScheme} set={seedOf(theme, ["colorScheme"]) !== undefined} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(value) => onChange(setSeed(theme, ["colorScheme"], value))} />
        <ChoiceSeed label="Default density" value={seeds.density} set={seedOf(theme, ["density"]) !== undefined} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} onChange={(value) => onChange(setSeed(theme, ["density"], value))} />
        <ChoiceSeed
          label="Contrast level"
          value={seeds.contrast.level}
          set={seedOf(theme, ["contrast", "level"]) !== undefined}
          options={[{ value: "AA", label: "AA (4.5:1, 3:1)" }, { value: "AAA", label: "AAA (7:1, 4.5:1)" }]}
          onChange={(value) => onChange(setSeed(theme, ["contrast", "level"], value))}
        />
      </Section>

      <section aria-label="More colours" className="flex flex-col gap-stack-sm">
        <h3 className="text-heading-4 text-fg">More colours</h3>
        <Accordion multiple>
          {others.map((ramp) => (
            <AccordionItem key={ramp} value={ramp}>
              <AccordionTrigger>
                <span className="flex items-center gap-inline-sm">
                  {LABELS[ramp] ?? ramp}
                  {anySet(rampSeedPaths(ramp)) && <Badge variant="accent">edited</Badge>}
                </span>
              </AccordionTrigger>
              <AccordionPanel>
                <div className="flex flex-col gap-stack-md">
                  <RampSeeds ramp={ramp} label={LABELS[ramp] ?? ramp} theme={theme} seeds={seeds} set={set} onChange={onChange} />
                  <Button appearance="subtle" size="small" className="self-start" disabled={!anySet(rampSeedPaths(ramp))} onClick={() => onChange(resetSeeds(theme, rampSeedPaths(ramp)))}>
                    Reset {LABELS[ramp] ?? ramp}
                  </Button>
                </div>
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
    </div>
  );
}
