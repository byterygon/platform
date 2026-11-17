#!/usr/bin/env node
// `pnpm ui:new <name> [--part <base-ui-part>] [--json]` (spec sections 6 and 9a.6): scaffolds a
// component with the fixed layout (component.tsx, .manifest.json, .example.tsx, .test.tsx), a
// gallery entry and a registry entry. The result passes every convention test as generated; edit
// the classes, props and states from there, and the tests say what the manifest must list.
//
//   --part toggle      wrap a Base UI component (@base-ui/react/toggle)
//   (no --part)        build on Base UI's useRender (@base-ui/react/use-render), for a component
//                      that is a styled element with a render prop (Badge, Kbd, Card)
//
// Exit codes: 0 ok, 1 the name is taken or the registry build failed, 2 bad command line.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEBAB, camel, fileName, pascal, type Manifest } from "./lib/manifest.ts";
import { PACKAGE_ROOT, RegistryError, syncRegistry } from "./registry.ts";

export interface ScaffoldOptions {
  name: string;
  /** A Base UI part (`toggle`), or undefined for useRender. */
  part?: string | undefined;
  root?: string;
  /** Rebuild registry/ afterwards (default true). */
  registry?: boolean;
}

export interface ScaffoldResult {
  files: string[];
  next: string[];
}

export class ScaffoldError extends Error {
  readonly code: "usage" | "exists" | "unknown-part";
  readonly fix: string;
  constructor(code: "usage" | "exists" | "unknown-part", message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

// The tokens the template's classes resolve to; the conventions test checks it, so a template
// change that adds a token fails until this list is updated.
const TEMPLATE_TOKENS = [
  "color.bg.disabled",
  "color.bg.layer",
  "color.border.disabled",
  "color.border.subtle",
  "color.fg.default",
  "color.fg.disabled",
  "color.interactive.hover",
  "color.ring",
  "color.ring-inner",
  "font.sans",
  "motion.duration.faster",
  "motion.easing.easy-ease",
  "radius.md",
  "ring.inner-width",
  "ring.width",
  "size.control.lg",
  "size.control.md",
  "size.control.sm",
  "space.control.x",
  "space.inline.sm",
  "space.inset.md",
  "space.inset.xs",
  "text.body-1.leading",
  "text.body-1.size",
  "text.body-1.tracking",
  "text.body-1.weight",
  "text.body-2.leading",
  "text.body-2.size",
  "text.body-2.tracking",
  "text.body-2.weight",
  "text.caption-1.leading",
  "text.caption-1.size",
  "text.caption-1.tracking",
  "text.caption-1.weight",
];

const STYLES = `export const __camel__Variants = {
  appearance: {
    secondary: "border-border-subtle bg-layer text-fg hover:bg-hover",
    subtle: "border-transparent text-fg hover:bg-hover",
  },
  size: {
    small: "h-control-sm px-inset-xs text-caption-1",
    medium: "h-control-md px-control-x text-body-1",
    large: "h-control-lg px-inset-md text-body-2",
  },
} as const;

const base = [
  "inline-flex items-center gap-inline-sm rounded-md border font-sans",
  "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
  focusRing,
  "data-disabled:pointer-events-none data-disabled:border-border-disabled data-disabled:bg-disabled data-disabled:text-fg-disabled",
];`;

function componentSource(part: string | undefined): string {
  if (part) {
    const primitive = `${pascal(part)}Primitive`;
    return `import { ${pascal(part)} as ${primitive} } from "@base-ui/react/${part}";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";

/** Classes per variant prop. The manifest's \`variants\` lists the same keys; a test compares them. */
${STYLES}

export interface __Name__Props extends Omit<${primitive}.Props, "className"> {
  /** TODO: describe the appearances (Fluent 2 names: primary, secondary, outline, subtle, transparent). */
  appearance?: keyof typeof __camel__Variants.appearance;
  /** Fluent's small, medium and large, from the density-aware \`size.control.*\` roles. */
  size?: keyof typeof __camel__Variants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** TODO: one sentence on what __Name__ is for. Wraps Base UI's ${pascal(part)}; the ref reaches the rendered element. */
export function __Name__({ appearance = "secondary", size = "medium", className, ...props }: __Name__Props) {
  return (
    <${primitive}
      data-slot="__name__"
      data-appearance={appearance}
      data-size={size}
      className={cn(base, __camel__Variants.appearance[appearance], __camel__Variants.size[size], className)}
      {...props}
    />
  );
}
`;
  }
  return `import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";

/** Classes per variant prop. The manifest's \`variants\` lists the same keys; a test compares them. */
${STYLES}

export interface __Name__Props extends Omit<useRender.ComponentProps<"div">, "className"> {
  /** TODO: describe the appearances (Fluent 2 names: primary, secondary, outline, subtle, transparent). */
  appearance?: keyof typeof __camel__Variants.appearance;
  /** Fluent's small, medium and large, from the density-aware \`size.control.*\` roles. */
  size?: keyof typeof __camel__Variants.size;
  /** Fluent's disabled colours; sets data-disabled and aria-disabled. */
  disabled?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** TODO: one sentence on what __Name__ is for. Built on Base UI's useRender: \`render\` swaps the element, the ref reaches it. */
export function __Name__({ appearance = "secondary", size = "medium", disabled = false, className, render, ...props }: __Name__Props) {
  return useRender({
    defaultTagName: "div",
    render,
    state: { disabled },
    props: {
      "data-slot": "__name__",
      "data-appearance": appearance,
      "data-size": size,
      "aria-disabled": disabled || undefined,
      ...props,
      className: cn(base, __camel__Variants.appearance[appearance], __camel__Variants.size[size], className),
    },
  });
}
`;
}

function manifest(name: string, part: string | undefined): Manifest {
  return {
    $schema: "../../../component.manifest.schema.json",
    schemaVersion: 1,
    name,
    title: pascal(name),
    description: `TODO: what ${pascal(name)} is for, in one sentence.`,
    usage: `TODO: when to use ${pascal(name)}, how to compose it, and what to use instead.`,
    status: "experimental",
    base: part ? `@base-ui/react/${part}` : "@base-ui/react/use-render",
    dependencies: ["@base-ui/react"],
    props: [
      { name: "appearance", type: '"secondary" | "subtle"', default: "secondary", description: "TODO: what each appearance is for (Fluent 2 names)." },
      { name: "size", type: '"small" | "medium" | "large"', default: "medium", description: "Fluent's sizes: control height from size.control.*, which follows data-density." },
      { name: "disabled", type: "boolean", default: false, description: "Fluent's disabled colours; sets data-disabled." },
      { name: "render", type: "ReactElement | ((props, state) => ReactElement)", description: "Base UI render prop: render another element with the component's props." },
      { name: "className", type: "string", description: "Extra classes, merged after the component's own." },
      { name: "ref", type: "Ref<HTMLElement>", description: "Reaches the rendered element." },
    ],
    variants: { appearance: ["secondary", "subtle"], size: ["small", "medium", "large"] },
    slots: [{ name: "root", element: part ? "TODO: the element Base UI renders" : "div", description: `The root; data-slot="${name}", data-appearance and data-size name it.` }],
    states: [
      { name: "hover", variant: "hover", description: "Pointer over it: color.interactive.hover." },
      { name: "focus-visible", variant: "focus-visible", description: "Keyboard focus: Fluent's double ring (focusRing from @/lib/control)." },
      { name: "disabled", variant: "data-disabled", props: { disabled: true }, description: "Ignores interaction, in Fluent's disabled colours (color.bg.disabled, color.fg.disabled)." },
    ],
    tokens: TEMPLATE_TOKENS,
    examples: { minimal: `${pascal(name)}Minimal`, realistic: `${pascal(name)}Realistic` },
    accessibility: [
      "TODO: the element and role it renders, and how a keyboard user reaches and operates it.",
      "TODO: what needs a label (aria-label, a visible <label>) and what announces state.",
      "Focus shows the double ring: ring.width in color.ring around ring.inner-width in color.ring-inner (3:1 on every surface).",
    ],
  };
}

const EXAMPLE = `import { __Name__ } from "@/components/__name__/__name__";

/** The smallest useful __Name__. */
export function __Name__Minimal() {
  return <__Name__>__Name__</__Name__>;
}

/** TODO: __Name__ where it is really used, with its variants and states. */
export function __Name__Realistic() {
  return (
    <div className="flex flex-wrap items-center gap-inline-sm">
      <__Name__>Secondary</__Name__>
      <__Name__ appearance="subtle" size="small">
        Subtle
      </__Name__>
      <__Name__ size="large">Large</__Name__>
      <__Name__ disabled>Disabled</__Name__>
    </div>
  );
}
`;

const TEST = `import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { __Name__ } from "./__name__";

afterEach(cleanup);

// The conventions (layout, manifest, token-only classes, states, axe on the examples) run for every
// component in test/conventions.test.tsx. Test the behaviour here: keyboard, events, ARIA.
describe("__Name__", () => {
  test("renders its slot, appearance and size", () => {
    const { container } = render(<__Name__>Label</__Name__>);
    const root = container.querySelector('[data-slot="__name__"]') as HTMLElement;
    expect(root.dataset.appearance).toBe("secondary");
    expect(root.dataset.size).toBe("medium");
  });

  test("forwards the ref to the rendered element", () => {
    const ref = createRef<HTMLElement>();
    render(<__Name__ ref={ref as never}>Label</__Name__>);
    expect(ref.current).toBeInstanceOf(HTMLElement);
  });

  test("disabled sets data-disabled", () => {
    const { container } = render(<__Name__ disabled>Label</__Name__>);
    expect(container.querySelector("[data-disabled]")).not.toBeNull();
  });

  test("has no axe violations", async () => {
    const { container } = render(<__Name__>Label</__Name__>);
    expect(await axeViolations(container)).toEqual([]);
  });
});
`;

const fill = (template: string, name: string) => template.replaceAll("__Name__", pascal(name)).replaceAll("__camel__", camel(name)).replaceAll("__name__", name);

const START = "  // ui:new entries start";
const END = "  // ui:new entries end";

/** Adds `name` to gallery/entries.ts between the markers, in name order. */
export function addGalleryEntry(source: string, name: string): string {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start < 0 || end < start) throw new ScaffoldError("usage", "gallery/entries.ts has lost its ui:new markers", `Put "${START.trim()}" and "${END.trim()}" around the entries.`);
  const body = source.slice(start + START.length + 1, end);
  const lines = body.split("\n").filter((line) => line.trim());
  lines.push(`  { name: "${name}", load: () => import("@/components/${name}/${name}.example") },`);
  const key = (line: string) => /name: "([^"]+)"/.exec(line)?.[1] ?? line;
  lines.sort((a, b) => key(a).localeCompare(key(b)));
  return `${source.slice(0, start + START.length)}\n${lines.join("\n")}\n${source.slice(end)}`;
}

export function scaffold({ name, part, root = PACKAGE_ROOT, registry = true }: ScaffoldOptions): ScaffoldResult {
  if (!KEBAB.test(name)) throw new ScaffoldError("usage", `"${name}" is not a kebab-case name`, "Use lowercase words joined by hyphens: toggle-group, number-input.");
  if (part !== undefined && !KEBAB.test(part)) throw new ScaffoldError("usage", `"${part}" is not a Base UI part name`, "Pass the folder name under @base-ui/react, for example toggle or number-field.");
  if (part !== undefined && !existsSync(join(root, "node_modules", "@base-ui", "react", part))) {
    throw new ScaffoldError("unknown-part", `@base-ui/react/${part} does not exist`, "List the parts with `ls node_modules/@base-ui/react` in packages/ui.");
  }
  const dir = join(root, "src", "components", name);
  if (existsSync(dir)) throw new ScaffoldError("exists", `src/components/${name} already exists`, "Pick another name, or edit the existing component.");
  mkdirSync(dir, { recursive: true });
  const files: [string, string][] = [
    [fileName(name, "component.tsx"), fill(componentSource(part), name)],
    [fileName(name, "component.manifest.json"), `${JSON.stringify(manifest(name, part), null, 2)}\n`],
    [fileName(name, "component.example.tsx"), fill(EXAMPLE, name)],
    [fileName(name, "component.test.tsx"), fill(TEST, name)],
  ];
  for (const [file, content] of files) writeFileSync(join(dir, file), content);
  const entries = join(root, "gallery", "entries.ts");
  writeFileSync(entries, addGalleryEntry(readFileSync(entries, "utf8"), name));
  const written = [...files.map(([file]) => `src/components/${name}/${file}`), "gallery/entries.ts"];
  if (registry) written.push(...syncRegistry({ root }).written.map((file) => `registry/${file}`));
  return {
    files: written,
    next: [
      `Edit src/components/${name}/${name}.tsx: the classes (token roles only), props and states.`,
      `Fill in the TODOs of ${name}.manifest.json; run \`pnpm --filter @byterygon/ui test\`, which prints the exact token list the manifest must carry.`,
      `Run \`pnpm --filter @byterygon/ui registry\` after every edit and commit registry/.`,
    ],
  };
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const partAt = args.indexOf("--part");
  const part = partAt >= 0 ? args[partAt + 1] : undefined;
  const positional = partAt >= 0 ? args.filter((_, i) => i !== partAt && i !== partAt + 1) : args;
  const out = (doc: Record<string, unknown>, text: string) => process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, command: "ui:new", ...doc })}\n` : `${text}\n`);
  try {
    if (positional.length !== 1 || (partAt >= 0 && !part)) throw new ScaffoldError("usage", "expected one component name", "Usage: pnpm ui:new <name> [--part <base-ui-part>] [--json]");
    const result = scaffold({ name: positional[0]!, part });
    out({ ok: true, exitCode: 0, ...result }, `created:\n${result.files.map((f) => `  ${f}`).join("\n")}\nnext:\n${result.next.map((n) => `  - ${n}`).join("\n")}`);
    return 0;
  } catch (error) {
    if (error instanceof ScaffoldError) {
      const exitCode = error.code === "usage" ? 2 : 1;
      out({ ok: false, exitCode, error: { code: error.code, message: error.message, fix: error.fix } }, `error: ${error.message}\nfix: ${error.fix}`);
      return exitCode;
    }
    if (error instanceof RegistryError) {
      out({ ok: false, exitCode: 1, problems: error.problems }, error.problems.map((p) => `error: ${p}`).join("\n"));
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
