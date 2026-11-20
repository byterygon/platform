export interface TokenReader {
  color: (cssVar: string) => string;
  value: (cssVar: string) => string;
}

// Token reader (TSK-46; its own lib item since TSK-81): the tokens are OKLCH CSS variables, and
// libraries that draw their own colours (Monaco's defineTheme, xterm.js's theme) take hex. The
// browser resolves a variable at an element (so a data-theme or data-density region, or a swapped
// preset, is honoured) and the result is converted here. TokenReader (above) reads token
// variables at an element: colours as hex, other values as the computed text. @/lib/monaco and
// @/lib/xterm import it.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toByte = (x: number) => Math.round(clamp01(x) * 255);
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

/** OKLab (L 0..1) to gamma-encoded sRGB 0..1, clipped to the gamut (the ramps are in gamut already). */
export function oklabToSrgb(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(gamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    clamp01(gamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    clamp01(gamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
  ];
}

const number = (part: string | undefined, percentScale = 1): number => {
  if (part === undefined || part === "none") return 0;
  return part.endsWith("%") ? (Number.parseFloat(part) / 100) * percentScale : Number.parseFloat(part);
};

/**
 * A computed CSS colour (`rgb()`, `rgba()`, `oklch()`, `oklab()`, `color(srgb ...)` or hex) as
 * `#rrggbb`, or `#rrggbbaa` when it is translucent. Returns null for a format it does not know.
 */
export function cssColorToHex(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return "#00000000";
  const out = (rgb: [number, number, number], alpha: number) => {
    const hex = `#${rgb.map((c) => hex2(toByte(c))).join("")}`;
    return alpha >= 1 ? hex : `${hex}${hex2(toByte(alpha))}`;
  };
  const short = /^#([0-9a-f]{3,8})$/.exec(text);
  if (short) {
    const h = short[1]!;
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    if (full.length !== 6 && full.length !== 8) return null;
    return full.length === 8 && full.endsWith("ff") ? `#${full.slice(0, 6)}` : `#${full}`;
  }
  const fn = /^([a-z]+)\((.*)\)$/.exec(text);
  if (!fn) return null;
  const [, name, body] = fn as unknown as [string, string, string];
  const [main, alphaPart] = body.includes("/") ? body.split("/").map((s) => s.trim()) : [body, undefined];
  const parts = main!.split(/[\s,]+/).filter(Boolean);
  let alpha = alphaPart !== undefined ? number(alphaPart) : 1;
  switch (name) {
    case "rgb":
    case "rgba": {
      if (parts.length === 4 && alphaPart === undefined) alpha = number(parts[3]);
      return out([number(parts[0], 255) / 255, number(parts[1], 255) / 255, number(parts[2], 255) / 255], alpha);
    }
    case "oklab":
      return out(oklabToSrgb(number(parts[0]), number(parts[1], 0.4), number(parts[2], 0.4)), alpha);
    case "oklch": {
      const hue = (number(parts[2]) * Math.PI) / 180;
      const chroma = number(parts[1], 0.4);
      return out(oklabToSrgb(number(parts[0]), chroma * Math.cos(hue), chroma * Math.sin(hue)), alpha);
    }
    case "color": {
      if (parts[0] !== "srgb") return null;
      return out([number(parts[1]), number(parts[2]), number(parts[3])], alpha);
    }
    default:
      return null;
  }
}

/**
 * A reader that resolves variables in the cascade of `element` (its data-theme and data-density
 * region, and whatever preset stylesheet is loaded). A hidden probe element inside it lets the
 * browser substitute the variable chain; colours the converter does not know are drawn on a
 * canvas pixel instead.
 */
export function tokenReader(element: HTMLElement): TokenReader & { dispose: () => void } {
  const probe = element.ownerDocument.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.hidden = true;
  element.append(probe);
  const view = element.ownerDocument.defaultView ?? window;
  let canvas: CanvasRenderingContext2D | null | undefined;
  return {
    color(cssVar) {
      probe.style.color = `var(${cssVar})`;
      const computed = view.getComputedStyle(probe).color;
      const hex = cssColorToHex(computed);
      if (hex) return hex;
      // Unresolved (no token stylesheet, or an environment without CSS): transparent.
      if (computed === "" || computed.includes("var(")) return "#00000000";
      canvas ??= element.ownerDocument.createElement("canvas").getContext("2d", { willReadFrequently: true });
      if (!canvas) return "#00000000";
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = computed;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return cssColorToHex(`rgb(${r} ${g} ${b} / ${(a ?? 255) / 255})`) ?? "#00000000";
    },
    value(cssVar) {
      return view.getComputedStyle(element).getPropertyValue(cssVar).trim();
    },
    dispose() {
      probe.remove();
    },
  };
}
