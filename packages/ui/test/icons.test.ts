// The vendored Fluent UI System Icons (icons/) and src/lib/icons.ts: the module is current, every
// vendored file matches its manifest entry, the MIT notice travels in the module, the curated set
// covers every icon drawn by hand in the components and DBee (TSK-53/55 swap them), and icons are
// added from a copy on disk, never the network.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import { ICONS_DIR, MODULE_PATH, exportName, optimizedSvg, parseUpstream, readManifest, readVendored, renderModule, run } from "../scripts/icons.ts";
import { ICON_NAMES } from "@/lib/icons";

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "by-icons-"));
  temps.push(dir);
  return dir;
};

/**
 * Every hand-drawn svg in packages/ui/src/components and apps/dbee/ui (inventory of 2026-11-16)
 * and the Fluent icon that replaces it; packages/ui/AGENTS.md ("Icons") carries the same table.
 */
export const REPLACEMENTS: Record<string, string> = {
  "accordion, select, combobox, navigation-menu, split-button: chevron": "chevron-down",
  "breadcrumb, collapsible, json-viewer, tree, dropdown-menu submenu, pagination next: chevron": "chevron-right",
  "pagination previous, calendar previous month": "chevron-left",
  "table sort (none / ascending / descending)": "arrow-sort",
  "table sort ascending": "arrow-sort-up",
  "table sort descending": "arrow-sort-down",
  "alert info": "info",
  "alert success": "checkmark-circle",
  "alert warning": "warning",
  "alert danger, stepper error": "error-circle",
  "alert, dialog, sheet, popover, tabs, tag, toast close": "dismiss",
  "combobox, search-input, file-input clear": "dismiss",
  "checkbox, select, dropdown-menu, code-block copied, stepper done": "checkmark",
  "checkbox indeterminate, number-input decrement": "subtract",
  "number-input increment, tabs new, DBee new": "add",
  "radio-group and menu radio dot": "circle",
  "breadcrumb, dropdown-menu, DBee more": "more-horizontal",
  "code-block, icon-button copy": "copy",
  "command-palette, search-input, input-group search": "search",
  "date-picker": "calendar-ltr",
  "password-input show": "eye",
  "password-input hide": "eye-off",
  "popover filters (sliders)": "options",
  "sidebar history": "history",
  "sidebar, DBee settings (gear)": "settings",
  "sidebar collapse": "panel-left",
  "stat trend up": "arrow-up",
  "stat trend down": "arrow-down",
  "stat trend flat": "subtract",
  "toggle-button wrap": "text-wrap",
  "toggle-group align": "text-align-left",
  "toggle-group align centre": "text-align-center",
  "toggle-group align right": "text-align-right",
  "toolbar, tooltip, icon-button, DBee run": "play",
  "toolbar, tooltip, DBee stop": "stop",
  "tooltip, DBee download": "arrow-download",
  "tree folder, DBee schema": "folder",
  "tree, command-palette, DBee table": "table",
  "tree, sidebar, avatar, empty-state, status-bar, DBee database": "database",
  "icon-button, DBee refresh": "arrow-clockwise",
  "icon-button delete": "delete",
  "DBee view": "eye",
  "DBee column": "column-triple",
  "DBee help": "question-circle",
};

describe("vendored icons", () => {
  test("src/lib/icons.ts is current (run `pnpm --filter @byterygon/ui icons build`)", () => {
    expect(readFileSync(MODULE_PATH, "utf8")).toBe(renderModule());
    expect(run(["build", "--check"]).exitCode).toBe(0);
  });

  test("the source is pinned and its MIT notice travels in the module the registry ships", () => {
    const { source } = readManifest();
    expect(source).toMatchObject({ package: "@fluentui/svg-icons", license: "MIT", licenseFile: "LICENSE", repository: "https://github.com/microsoft/fluentui-system-icons" });
    expect(source.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.licenseSource).toContain(source.commit);
    const licence = readFileSync(join(ICONS_DIR, "LICENSE"), "utf8");
    expect(licence).toMatch(/^MIT License/);
    expect(licence).toContain("Copyright (c) 2020 Microsoft Corporation");
    const module = readFileSync(MODULE_PATH, "utf8");
    expect(module).toContain(" * Copyright (c) 2020 Microsoft Corporation");
    expect(module).toContain(" * Permission is hereby granted, free of charge");
    expect(module).toContain(source.version);
    // The shadcn CLI drops the comments before the first statement when it installs an item, so
    // the notice must come after one, in a block bundlers keep (`/*!`, `@license`).
    expect(module.split("\n")[0]).toBe("export type IconSize = 16 | 20 | 24;");
    expect(module).toMatch(/^export type IconSize = 16 \| 20 \| 24;\n\n\/\*!\n \* @license\n/);
  });

  test("every vendored file is listed with its sha256, in the vendored form, in regular and filled", () => {
    const { manifest, icons } = readVendored();
    for (const icon of manifest.icons) {
      for (const file of icon.files) {
        const svg = readFileSync(join(ICONS_DIR, file.path), "utf8");
        expect(createHash("sha256").update(svg).digest("hex"), file.path).toBe(file.sha256);
        expect(svg, file.path).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${file.size} ${file.size}" fill="currentColor">(<path d="[^"]+"/>)+</svg>\\n$`));
      }
      expect(new Set(icon.files.map((file) => file.style)), icon.name).toEqual(new Set(["regular", "filled"]));
    }
    expect(icons.map((icon) => icon.name)).toEqual([...ICON_NAMES]);
  });

  test("the curated set replaces every hand-drawn icon in the components and DBee", () => {
    const missing = [...new Set(Object.values(REPLACEMENTS))].filter((name) => !(ICON_NAMES as readonly string[]).includes(name));
    expect(missing).toEqual([]);
  });

  test("names become exports in PascalCase", () => {
    expect(exportName("chevron-down")).toBe("ChevronDown");
    expect(exportName("text-align-left")).toBe("TextAlignLeft");
    expect(exportName("3d-cube")).toBe("Icon3dCube");
  });
});

/** A tar archive (ustar) of `files`, gzipped: the shape of an npm tarball. */
function tgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("icons add (offline, from a copy on disk)", () => {
  const upstream = (size: number, d: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><path d="${d}"/></svg>`;

  function sandbox() {
    const root = temp();
    const icons = join(root, "icons");
    mkdirSync(icons);
    cpSync(join(ICONS_DIR, "LICENSE"), join(icons, "LICENSE"));
    const manifest = readManifest();
    writeFileSync(join(icons, "manifest.json"), JSON.stringify({ ...manifest, icons: [] }, null, 2));
    return { icons, module: join(root, "icons.ts"), version: manifest.source.version };
  }

  test("from an npm tarball: vendors the optimised artwork, records checksums, writes the module", () => {
    const { icons, module, version } = sandbox();
    const archive = join(temp(), "svg-icons.tgz");
    writeFileSync(
      archive,
      tgz({
        "package/package.json": JSON.stringify({ name: "@fluentui/svg-icons", version }),
        "package/icons/beaker_16_regular.svg": upstream(16, "M1 1h14v14H1z"),
        "package/icons/beaker_16_filled.svg": upstream(16, "M2 2h12v12H2z"),
        "package/icons/beaker_20_regular.svg": upstream(20, "M1 1h18v18H1z"),
        "package/icons/beaker_20_filled.svg": upstream(20, "M2 2h16v16H2z"),
        "package/icons/RTL/beaker_16_regular.svg": upstream(16, "M0 0h1"),
      }),
    );
    const result = run(["add", "beaker", "--from", archive], icons, module);
    expect(result).toMatchObject({ ok: true, exitCode: 0, added: ["beaker"], missingSizes: ["beaker 24 regular", "beaker 24 filled"] });
    expect(readFileSync(join(icons, "fluent/beaker-16-regular.svg"), "utf8")).toBe(optimizedSvg(16, ["M1 1h14v14H1z"]));
    const entry = JSON.parse(readFileSync(join(icons, "manifest.json"), "utf8")).icons[0];
    expect(entry.files).toHaveLength(4);
    expect(entry.files[0].upstreamSha256).toBe(createHash("sha256").update(upstream(16, "M1 1h14v14H1z")).digest("hex"));
    const source = readFileSync(module, "utf8");
    expect(source).toContain('export const Beaker: IconDefinition = {');
    expect(source).toContain('16: ["M1 1h14v14H1z"]');
    expect(run(["build", "--check"], icons, module).exitCode).toBe(0);
  });

  test("from a repository checkout; refuses colour icons, unknown names and another release", () => {
    const { icons, module, version } = sandbox();
    const checkout = temp();
    mkdirSync(join(checkout, "assets/Beaker/SVG"), { recursive: true });
    for (const style of ["regular", "filled"]) writeFileSync(join(checkout, `assets/Beaker/SVG/ic_fluent_beaker_24_${style}.svg`), upstream(24, "M0 0h24v24H0z"));
    writeFileSync(join(checkout, "assets/Beaker/SVG/ic_fluent_rainbow_24_regular.svg"), '<svg viewBox="0 0 24 24"><defs><linearGradient id="a"/></defs><path d="M0 0" fill="url(#a)"/></svg>');
    writeFileSync(join(checkout, "assets/Beaker/SVG/ic_fluent_rainbow_24_filled.svg"), upstream(24, "M0 0h1"));
    expect(run(["add", "beaker", "--from", checkout], icons, module)).toMatchObject({ ok: true, added: ["beaker"] });
    const colour = run(["add", "rainbow", "--from", checkout], icons, module);
    expect(colour.exitCode).toBe(1);
    expect(String(colour.problems)).toMatch(/colour icons are not vendored|only monochrome/);
    expect(run(["add", "nope", "--from", checkout], icons, module)).toMatchObject({ exitCode: 1 });
    expect(run(["add", "beaker"], icons, module)).toMatchObject({ exitCode: 2 });
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: `${version}-newer` }));
    expect(String(run(["add", "beaker", "--from", checkout], icons, module).problems)).toContain("refresh");
  });

  test("a vendored file that was edited by hand fails the build", () => {
    const { icons, module, version } = sandbox();
    const dir = temp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
    for (const style of ["regular", "filled"]) writeFileSync(join(dir, `beaker_16_${style}.svg`), upstream(16, "M1 1h14"));
    run(["add", "beaker", "--from", dir], icons, module);
    writeFileSync(join(icons, "fluent/beaker-16-regular.svg"), optimizedSvg(16, ["M0 0h16"]));
    expect(run(["build"], icons, module)).toMatchObject({ exitCode: 1 });
    expect(() => parseUpstream('<svg viewBox="0 0 16 16"><circle r="1"/></svg>', 16, "x")).toThrow(/other than <path>/);
  });
});
