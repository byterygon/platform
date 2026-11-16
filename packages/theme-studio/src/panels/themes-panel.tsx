// The presets gallery (spec section 5, "Presets"; TSK-49): every built-in preset and every theme
// saved in this browser, each on a card with a small preview drawn by the theme's own tokens.css
// (the engine's renderTokensCss, declared on the card instead of :root, so seven themes show on one
// page next to the edited one). Open, duplicate, save, delete and export; the export is the theme
// file, the same bytes `by-tokens export theme --theme <name>.theme.json` prints.
import { THEME_NAME_PATTERN, copyName, duplicateTheme } from "@byterygon/design-tokens";
import { exportFormat, exportTheme } from "@byterygon/design-tokens/build";
import { Alert, AlertDescription } from "@/components/alert/alert";
import { Badge } from "@/components/badge/badge";
import { Button } from "@/components/button/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/dialog/dialog";
import { useMemo, useState } from "react";
import { scopedThemeCss } from "../engine.ts";
import { type Library, type SavedTheme, readLibrary, themeName, withSaved, withoutSaved, writeLibrary } from "../state/library.ts";
import { type StorageLike, type View, safeStorage } from "../state/persist.ts";
import { PRESETS, presetTheme } from "../state/presets.ts";
import type { ThemeDoc } from "../state/theme-edit.ts";
import { downloadText } from "./export-panel.tsx";

const PREVIEW_ATTRIBUTE = "data-studio-preview";

/** A small picture of a theme: backdrop, a layer with text, the accent, the status solids. */
function ThemeThumb({ id, theme, mode, label }: { id: string; theme: ThemeDoc; mode: View["mode"]; label: string }) {
  const key = JSON.stringify(theme);
  // The theme's tokens.css on this card only. Recomputed when the theme changes (a few ms).
  const css = useMemo(() => scopedThemeCss(JSON.parse(key) as ThemeDoc, `[${PREVIEW_ATTRIBUTE}="${id}"]`), [key, id]);
  return (
    <div {...{ [PREVIEW_ATTRIBUTE]: id }} data-theme={mode} aria-hidden="true" className="flex flex-col gap-stack-sm bg-canvas bg-(image:--by-gradient-backdrop) p-inset-md font-sans text-fg">
      <style>{css}</style>
      <div className="flex flex-col gap-stack-xs rounded-lg border border-border-subtle bg-layer p-inset-sm shadow-layer">
        <span className="truncate text-body-1-strong text-fg">{label}</span>
        <span className="truncate text-caption-1 text-fg-muted">The quick brown fox, 0123</span>
        <span className="flex items-center gap-inline-sm">
          <span className="inline-flex h-control-sm items-center rounded-md bg-accent-solid px-inline-md text-caption-1-strong text-accent-solid-fg">Primary</span>
          <span className="inline-flex h-control-sm items-center rounded-md border border-border bg-layer-alt px-inline-md text-caption-1 text-fg">Secondary</span>
          <span className="text-caption-1 text-fg-link underline">Link</span>
        </span>
      </div>
      <span className="flex gap-inline-xs">
        {["bg-accent-solid", "bg-neutral-solid", "bg-danger", "bg-warning", "bg-success", "bg-info"].map((fill) => (
          <span key={fill} className={`h-icon-sm flex-1 rounded-sm ${fill}`} />
        ))}
      </span>
    </div>
  );
}

interface CardAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
  readonly disabled?: boolean;
}

function ThemeCard({ id, title, name, description, theme, mode, current, actions }: { id: string; title: string; name: string; description: string; theme: ThemeDoc; mode: View["mode"]; current: boolean; actions: readonly CardAction[] }) {
  return (
    <li aria-label={title} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <ThemeThumb id={id} theme={theme} mode={mode} label={title} />
      <div className="flex flex-1 flex-col gap-stack-xs p-inset-md">
        <span className="flex flex-wrap items-center gap-inline-sm">
          <span className="text-body-1-strong text-fg">{title}</span>
          <code className="font-mono text-caption-1 text-fg-muted">{name}</code>
          {current && <Badge variant="accent">Open</Badge>}
        </span>
        {description && <p className="line-clamp-3 text-caption-1 text-fg-muted">{description}</p>}
        <span className="mt-auto flex flex-wrap gap-inline-xs pt-inset-xs">
          {actions.map((action) => (
            <Button key={action.label} size="small" appearance={action.primary ? "primary" : "subtle"} disabled={action.disabled} onClick={action.onClick} aria-label={`${action.label} ${title}`}>
              {action.label}
            </Button>
          ))}
        </span>
      </div>
    </li>
  );
}

/** Downloads a theme file, exactly what by-tokens export theme prints for it. */
async function exportThemeFile(theme: ThemeDoc): Promise<boolean> {
  const result = await exportTheme(theme, "theme");
  if (!result.ok || result.content === undefined) return false;
  const info = exportFormat("theme")!;
  downloadText(result.content, info.download(result.theme), info.mediaType);
  return true;
}

const same = (a: ThemeDoc, b: ThemeDoc) => JSON.stringify(a) === JSON.stringify(b);

export interface ThemesPanelProps {
  readonly theme: ThemeDoc;
  readonly view: View;
  /** Opens a theme in the editor (replacing the edited one). */
  readonly onOpen: (theme: ThemeDoc) => void;
  /** Replaces browser storage (tests). */
  readonly storage?: StorageLike | undefined;
}

export function ThemesPanel({ theme, view, onOpen, storage = safeStorage() }: ThemesPanelProps) {
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<Library>(() => readLibrary(storage));
  const [status, setStatus] = useState<{ text: string; undo?: SavedTheme[] }>();

  const name = themeName(theme);
  const validName = THEME_NAME_PATTERN.test(name);
  const savedNames = library.themes.map((t) => themeName(t.theme));
  const taken = [...PRESETS.map((p) => p.name), ...savedNames];
  const alreadySaved = savedNames.includes(name);
  const isPreset = PRESETS.some((p) => p.name === name);

  const store = (themes: readonly SavedTheme[], text: string, undo?: SavedTheme[]): boolean => {
    if (!writeLibrary(themes, storage)) {
      setStatus({ text: "The browser refused to save (storage full or turned off). Export the theme file to keep it." });
      return false;
    }
    setLibrary({ ...library, themes, diagnostics: [] });
    setStatus({ text, ...(undo ? { undo } : {}) });
    return true;
  };

  const openTheme = (next: ThemeDoc) => {
    onOpen(next);
    setOpen(false);
  };

  const duplicate = (base: ThemeDoc, baseName: string, fromPreset: boolean) => {
    const copy = duplicateTheme(base, copyName(baseName, taken), baseName);
    if (!fromPreset) copy["description"] = `Based on the ${baseName} theme.`;
    // Without storage the copy still opens; it is only not kept.
    if (library.available) store(withSaved(library.themes, copy), `Saved ${themeName(copy)}, a copy of ${baseName}.`);
    openTheme(copy);
  };

  const exportFile = (target: ThemeDoc) => {
    void exportThemeFile(target).then((ok) => setStatus({ text: ok ? `Downloaded ${themeName(target)}.theme.json.` : `${themeName(target)} breaks a rule, so it exports nothing; open it and see Problems.` }));
  };

  return (
    <Dialog
      size="xl"
      open={open}
      onOpenChange={(next: boolean) => {
        if (next) {
          setLibrary(readLibrary(storage));
          setStatus(undefined);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button appearance="secondary" size="small" />}>Themes</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Themes</DialogTitle>
          <DialogDescription>Start from a preset or from a theme saved in this browser. Opening one replaces the theme you are editing, so save that first to keep it.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-lg overflow-y-auto">
          <p className="text-caption-1 text-fg-muted" aria-live="polite">
            {status?.text}{" "}
            {status?.undo && (
              <Button size="small" appearance="transparent" onClick={() => store(status.undo!, "Restored.")}>
                Undo
              </Button>
            )}
          </p>

          <section aria-label="Saved in this browser" className="flex flex-col gap-stack-sm">
            <div className="flex flex-wrap items-center gap-inline-md">
              <h3 className="text-subtitle-2 text-fg">Saved in this browser</h3>
              <Button
                size="small"
                appearance="primary"
                className="ms-auto"
                disabled={!library.available || !validName}
                onClick={() => store(withSaved(library.themes, theme), alreadySaved ? `Updated the saved ${name}.` : `Saved ${name} in this browser.`)}
              >
                {alreadySaved ? `Update saved ${name}` : `Save ${validName ? name : "theme"}`}
              </Button>
            </div>
            {!library.available && (
              <Alert intent="warning">
                <AlertDescription>This browser keeps nothing for this page (a private window, or storage turned off for files). Export the theme file to keep a theme.</AlertDescription>
              </Alert>
            )}
            {library.available && !validName && <p className="text-caption-1 text-fg-muted">To save, give the theme a name of lower-case letters, digits and dashes.</p>}
            {library.available && validName && isPreset && !alreadySaved && <p className="text-caption-1 text-fg-muted">This theme is named after a preset; saving keeps your copy here, the preset itself never changes.</p>}
            {library.diagnostics.length > 0 && (
              <Alert intent="warning">
                <AlertDescription>{library.diagnostics.map((d) => d.message).join(" ")}</AlertDescription>
              </Alert>
            )}
            {library.themes.length === 0 ? (
              library.available && <p className="text-body-1 text-fg-muted">No saved themes yet. Duplicate a preset or save the theme you are editing.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-gap-md sm:grid-cols-2 md:grid-cols-3">
                {library.themes.map((saved, index) => {
                  const savedName = themeName(saved.theme);
                  return (
                    <ThemeCard
                      key={savedName}
                      id={`saved-${index}`}
                      title={savedName}
                      name={saved.savedAt ? `saved ${saved.savedAt.slice(0, 16).replace("T", " ")}` : "saved"}
                      description={typeof saved.theme["description"] === "string" ? saved.theme["description"] : ""}
                      theme={saved.theme}
                      mode={view.mode}
                      current={same(saved.theme, theme)}
                      actions={[
                        { label: "Open", primary: true, onClick: () => openTheme(structuredClone(saved.theme)) },
                        { label: "Duplicate", onClick: () => duplicate(saved.theme, savedName, false) },
                        { label: "Export", onClick: () => exportFile(saved.theme) },
                        { label: "Delete", onClick: () => store(withoutSaved(library.themes, savedName), `Deleted ${savedName}.`, [...library.themes]) },
                      ]}
                    />
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label="Presets" className="flex flex-col gap-stack-sm">
            <h3 className="text-subtitle-2 text-fg">Presets</h3>
            <ul className="grid grid-cols-1 gap-gap-md sm:grid-cols-2 md:grid-cols-3">
              {PRESETS.map((preset) => {
                const file = presetTheme(preset);
                return (
                  <ThemeCard
                    key={preset.name}
                    id={`preset-${preset.name}`}
                    title={preset.label}
                    name={preset.name}
                    description={preset.description}
                    theme={file}
                    mode={view.mode}
                    current={same(file, theme)}
                    actions={[
                      { label: "Open", primary: true, onClick: () => openTheme(file) },
                      { label: "Duplicate", onClick: () => duplicate(file, preset.name, true) },
                      { label: "Export", onClick: () => exportFile(file) },
                    ]}
                  />
                );
              })}
            </ul>
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
