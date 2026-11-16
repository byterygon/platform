// Picking a ramp's colour by eye: a palette of ready colours, a hue × chroma plane painted at the
// ramp's own solid lightness, and a field that takes a pasted #hex or oklch(). Whatever is picked
// becomes the two seeds a ramp has, `hue` and `chroma`; the ramp keeps deciding lightness, so its
// contrast promises still hold. The colour maths (OKLCH to sRGB, gamut, parsing) is the engine's.
//
// Studio-only for now: Base UI has no colour picker, and no other Byterygon app needs one yet.
import { maxChroma, oklchToDisplayRgb, oklchToHex, parseColor } from "@byterygon/design-tokens";
import { Badge } from "@/components/badge/badge";
import { Button } from "@/components/button/button";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { NumberInput } from "@/components/number-input/number-input";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/popover/popover";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

/** The largest chroma the plane and the fields offer (the engine accepts 0.4; sRGB rarely shows more than 0.32). */
export const PICKER_MAX_CHROMA = 0.32;
const PLANE_WIDTH = 288;
const PLANE_HEIGHT = 112;

export type PaletteKind = "accent" | "neutral";

/** Ready colours: 12 hues, at three chromas for an accent and four low ones for a neutral. */
export function paletteOf(kind: PaletteKind): { hue: number; chroma: number }[] {
  const chromas = kind === "neutral" ? [0, 0.012, 0.025, 0.04] : [0.07, 0.12, 0.17];
  const hues = Array.from({ length: 12 }, (_, i) => i * 30 + (kind === "neutral" ? 0 : 15));
  return chromas.flatMap((chroma) => hues.map((hue) => ({ hue, chroma })));
}

const round = (n: number, step: number) => Math.round(n / step) * step;
const tidy = (hue: number, chroma: number) => ({ hue: Math.round(((hue % 360) + 360) % 360), chroma: Number(round(chroma, 0.001).toFixed(3)) });

export interface ColorSeedProps {
  /** "Brand", "Neutral", "Red (danger)". */
  readonly label: string;
  /** The ramp's name, for the swatch (`--by-color-<ramp>-9`). */
  readonly ramp: string;
  readonly hue: number;
  readonly chroma: number;
  /** Lightness of the ramp's solid step (light scheme), at which colours are shown. */
  readonly lightness: number;
  readonly kind: PaletteKind;
  /** False while the seed is the engine default. */
  readonly set: boolean;
  readonly onChange: (value: { hue: number; chroma: number }) => void;
}

/** The hue × chroma plane on a canvas (painted with the engine's gamut-mapped sRGB), with a marker. */
function Plane({ hue, chroma, lightness, onChange }: { hue: number; chroma: number; lightness: number; onChange: (v: { hue: number; chroma: number }) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return; // jsdom
    const image = context.createImageData(PLANE_WIDTH, PLANE_HEIGHT);
    for (let y = 0; y < PLANE_HEIGHT; y += 1) {
      const c = (1 - y / (PLANE_HEIGHT - 1)) * PICKER_MAX_CHROMA;
      for (let x = 0; x < PLANE_WIDTH; x += 1) {
        const h = (x / PLANE_WIDTH) * 360;
        const rgb = oklchToDisplayRgb({ l: lightness, c, h });
        // Beyond what sRGB shows at this lightness the engine lowers chroma; dim that region.
        const dim = c > maxChroma(lightness, h) ? 0.55 : 1;
        const i = (y * PLANE_WIDTH + x) * 4;
        image.data[i] = Math.round(rgb.r * 255 * dim + 255 * (1 - dim) * 0.5);
        image.data[i + 1] = Math.round(rgb.g * 255 * dim + 255 * (1 - dim) * 0.5);
        image.data[i + 2] = Math.round(rgb.b * 255 * dim + 255 * (1 - dim) * 0.5);
        image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [lightness]);

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    onChange(tidy(x * 360, (1 - y) * PICKER_MAX_CHROMA));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const big = event.shiftKey;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [big ? -10 : -1, 0],
      ArrowRight: [big ? 10 : 1, 0],
      ArrowUp: [0, big ? 0.02 : 0.005],
      ArrowDown: [0, big ? -0.02 : -0.005],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    onChange(tidy(hue + move[0], Math.min(PICKER_MAX_CHROMA, Math.max(0, chroma + move[1]))));
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Hue and chroma"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={hue}
      aria-valuetext={`hue ${hue}, chroma ${chroma}`}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
      className="relative cursor-crosshair touch-none overflow-hidden rounded-md border border-border outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring"
      style={{ width: PLANE_WIDTH, height: PLANE_HEIGHT }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
      }}
      onKeyDown={keys}
    >
      <canvas ref={canvas} width={PLANE_WIDTH} height={PLANE_HEIGHT} aria-hidden="true" className="block" />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute size-icon-sm -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-fg-on-accent shadow-raised"
        style={{ left: `${(hue / 360) * 100}%`, top: `${(1 - Math.min(chroma, PICKER_MAX_CHROMA) / PICKER_MAX_CHROMA) * 100}%`, background: oklchToHex({ l: lightness, c: chroma, h: hue }) }}
      />
    </div>
  );
}

export function ColorSeed({ label, ramp, hue, chroma, lightness, kind, set, onChange }: ColorSeedProps) {
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string>();
  const current = tidy(hue, chroma);
  const palette = paletteOf(kind);
  const columns = 12;

  const applyText = (text: string) => {
    setPasted(text);
    if (text.trim() === "") return setPasteError(undefined);
    const parsed = parseColor(text.trim());
    if (!parsed) return setPasteError("Not a colour: use #rrggbb, rgb(), or oklch(L C H).");
    setPasteError(undefined);
    onChange(tidy(parsed.h, Math.min(PICKER_MAX_CHROMA, parsed.c)));
  };

  return (
    <div className="flex items-center gap-inline-md">
      <Popover>
        <PopoverTrigger
          render={<Button variant="ghost" className="h-auto w-full justify-start gap-inline-md px-inline-sm py-inline-sm" />}
          aria-label={`${label}: hue ${current.hue}, chroma ${current.chroma}. Choose a colour`}
        >
          <span aria-hidden="true" className="inline-block size-control-md shrink-0 rounded-md border border-border" style={{ background: `var(--by-color-${ramp}-9)` }} />
          <span className="flex min-w-0 flex-1 flex-col items-start">
            <span className="flex items-center gap-inline-sm text-label text-fg">
              {label}
              {!set && <Badge appearance="outline">default</Badge>}
            </span>
            <span className="font-mono text-caption text-fg-muted">
              hue {current.hue} · chroma {current.chroma}
            </span>
          </span>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" className="max-w-panel-lg">
          <PopoverTitle>{label}</PopoverTitle>
          <PopoverDescription>Pick a colour. The ramp keeps its own lightness per step, so text on it keeps its contrast.</PopoverDescription>
          <div className="flex flex-col gap-stack-md pt-inset-sm">
            <div role="group" aria-label="Ready colours" className="grid gap-inline-xs" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {palette.map((swatch) => {
                const chosen = swatch.hue === current.hue && Math.abs(swatch.chroma - current.chroma) < 0.0005;
                return (
                  <button
                    key={`${swatch.hue}-${swatch.chroma}`}
                    type="button"
                    aria-label={`hue ${swatch.hue}, chroma ${swatch.chroma}`}
                    aria-pressed={chosen}
                    onClick={() => onChange(swatch)}
                    className="size-icon-lg rounded-sm border border-border-muted outline-none aria-pressed:border-fg aria-pressed:shadow-raised focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring"
                    style={{ background: oklchToHex({ l: lightness, c: swatch.chroma, h: swatch.hue }) }}
                  />
                );
              })}
            </div>
            <Plane hue={current.hue} chroma={current.chroma} lightness={lightness} onChange={onChange} />
            <Field invalid={pasteError !== undefined}>
              <FieldLabel>Paste a colour</FieldLabel>
              <Input size="sm" className="font-mono" placeholder="#0e7490 or oklch(0.55 0.11 230)" value={pasted} onValueChange={applyText} />
              <FieldDescription>{pasteError ?? "Its hue and chroma are used; lightness stays with the ramp."}</FieldDescription>
            </Field>
            <div className="flex items-end gap-inline-md">
              <Field className="flex-1">
                <FieldLabel>Hue</FieldLabel>
                <NumberInput size="sm" min={0} max={360} step={1} value={current.hue} onValueChange={(v) => v !== null && onChange(tidy(v, current.chroma))} />
              </Field>
              <Field className="flex-1">
                <FieldLabel>Chroma</FieldLabel>
                <NumberInput size="sm" min={0} max={0.4} step={0.005} format={{ maximumFractionDigits: 3 }} value={current.chroma} onValueChange={(v) => v !== null && onChange(tidy(current.hue, v))} />
              </Field>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
