// The Studio: one theme file and one view (colour mode, density) are the whole state. Every edit
// replaces the theme file; the engine derives the tokens, the diagnostics and the preview CSS from
// it; the CSS is written into one <style> element, so the preview (and the Studio itself, which is
// built from the same components) changes at once. State goes to the URL hash and browser storage.
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/alert-dialog/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert/alert";
import { Badge } from "@/components/badge/badge";
import { Button } from "@/components/button/button";
import { Field, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { ScrollArea } from "@/components/scroll-area/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/tabs/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { derive } from "./engine.ts";
import { ContrastReport } from "./panels/contrast-report.tsx";
import { ExportPanel } from "./panels/export-panel.tsx";
import { ImportPanel } from "./panels/import-panel.tsx";
import { SeedsPanel } from "./panels/seeds-panel.tsx";
import { SharePanel } from "./panels/share-panel.tsx";
import { ThemesPanel } from "./panels/themes-panel.tsx";
import { TokenDetail, TokenList } from "./panels/token-editor.tsx";
import { Gallery, SwatchBoard } from "./panels/preview.tsx";
import { type Loaded, type View, loadState, saveState, startingTheme, stateHash, viewOf } from "./state/persist.ts";
import type { ThemeDoc } from "./state/theme-edit.ts";

/** The element the generated `tokens.css` is written into. */
export const THEME_STYLE_ATTRIBUTE = "data-studio-theme";

function applyThemeCss(css: string, doc: Document = document): void {
  let style = doc.head.querySelector<HTMLStyleElement>(`style[${THEME_STYLE_ATTRIBUTE}]`);
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute(THEME_STYLE_ATTRIBUTE, "");
    doc.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly [T, string][]; onChange: (value: T) => void }) {
  return (
    <ToggleGroup aria-label={label} size="small" value={[value]} onValueChange={(next: unknown[]) => next[0] !== undefined && onChange(next[0] as T)}>
      {options.map(([option, text]) => (
        <ToggleGroupItem key={option} value={option}>
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Status({ errors, warnings, checks }: { errors: number; warnings: number; checks: number }) {
  if (errors > 0) {
    return (
      <Badge variant="danger" appearance="solid" role="status">
        {errors} {errors === 1 ? "problem" : "problems"}
      </Badge>
    );
  }
  return (
    <Badge variant="success" role="status">
      {checks} contrast checks pass{warnings > 0 ? `, ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : ""}
    </Badge>
  );
}

export interface AppProps {
  readonly initial: Loaded;
  /** Replaces the persistence (tests). */
  readonly save?: (hash: string) => void;
}

export function App({ initial, save = saveState }: AppProps) {
  const [theme, setTheme] = useState<ThemeDoc>(initial.theme);
  const [view, setView] = useState<View>(initial.view);
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState("components");
  const [notices, setNotices] = useState(initial.diagnostics);
  // About 10 ms per edit. The gallery is memoised and reads only CSS variables, so an edit does not
  // re-render it (a deferred value never committed in a browser: the examples keep scheduling
  // urgent updates, which starved the deferred render).
  const derived = useMemo(() => derive(theme), [theme]);

  useLayoutEffect(() => applyThemeCss(derived.css), [derived.css]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset["theme"] = view.mode;
    root.dataset["density"] = view.density;
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void stateHash(theme, view).then((hash) => {
        if (!cancelled) save(hash);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [theme, view, save]);

  // A hash pasted into the address bar (or set by an agent) opens that state.
  useEffect(() => {
    const onHash = () => {
      void stateHash(theme, view).then((current) => {
        if (location.hash === current) return;
        void loadState(location.hash).then((loaded) => {
          if (loaded.source !== "hash") return;
          setTheme(loaded.theme);
          setView(loaded.view);
          setNotices(loaded.diagnostics);
        });
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [theme, view]);

  /** Replaces the edited theme (a preset, a saved theme, an import) and shows it in its own view. */
  const openTheme = (next: ThemeDoc) => {
    setTheme(next);
    setView(viewOf(next));
    setSelected(undefined);
    setNotices([]);
  };

  const name = typeof theme["name"] === "string" ? theme["name"] : "";
  const checks = derived.contrast.length;

  return (
    <div className="flex h-dvh flex-col bg-canvas bg-(image:--by-gradient-backdrop) text-fg">
      <header className="flex flex-wrap items-center gap-inline-md border-b border-border bg-surface px-inset-lg py-inset-sm">
        <h1 className="text-heading-3 text-fg">Theme Studio</h1>
        <Field className="w-panel-xs">
          <FieldLabel className="sr-only">Theme name</FieldLabel>
          <Input size="small" className="font-mono" value={name} onValueChange={(text: string) => setTheme({ ...theme, name: text })} aria-label="Theme name" />
        </Field>
        <Status errors={derived.errors} warnings={derived.warnings} checks={checks} />
        <div className="ms-auto flex flex-wrap items-center gap-inline-md">
          <Choice label="Colour mode" value={view.mode} options={[["light", "Light"], ["dark", "Dark"]]} onChange={(mode) => setView({ ...view, mode })} />
          <Choice label="Density" value={view.density} options={[["comfortable", "Comfortable"], ["compact", "Compact"]]} onChange={(density) => setView({ ...view, density })} />
          <ThemesPanel theme={theme} view={view} onOpen={openTheme} />
          <ImportPanel
            onOpen={(next) => {
              openTheme(next);
              // An imported theme that breaks a rule opens on the contrast report and its fixes.
              if (derive(next).errors > 0) setTab("contrast");
            }}
          />
          <SharePanel theme={theme} view={view} />
          <ExportPanel theme={theme} />
          <AlertDialog size="sm">
            <AlertDialogTrigger render={<Button appearance="subtle" size="small" />}>Start over</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Start over?</AlertDialogTitle>
                <AlertDialogDescription>Every seed and token change is removed and the default theme comes back. Export the theme first to keep it.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogCancel
                  variant="danger"
                  onClick={() => {
                    setTheme(startingTheme());
                    setSelected(undefined);
                  }}
                >
                  Start over
                </AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      {notices.length > 0 && (
        <div className="px-inset-lg pt-inset-sm">
          <Alert intent="warning" onDismiss={() => setNotices([])}>
            <AlertTitle>Opened with changes</AlertTitle>
            <AlertDescription>{notices.map((d) => d.message).join(" ")}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside aria-label="Edit" className="flex w-panel-md shrink-0 flex-col border-e border-border bg-surface">
          <Tabs defaultValue="seeds" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="px-inset-md">
              <TabsTrigger value="seeds">Seeds</TabsTrigger>
              <TabsTrigger value="tokens">Tokens</TabsTrigger>
            </TabsList>
            <TabsContent value="seeds" className="min-h-0 flex-1">
              <ScrollArea className="h-full" aria-label="Seeds">
                <div className="p-inset-lg">
                  <SeedsPanel theme={theme} seeds={derived.seeds} set={derived.set} onChange={setTheme} />
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="tokens" className="min-h-0 flex-1">
              <ScrollArea className="h-full" aria-label="Tokens">
                <div className="p-inset-lg">
                  <TokenList theme={theme} derived={derived} onChange={setTheme} selected={selected} onSelect={setSelected} />
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {selected && (
            <Pane label="Token">
              <TokenDetail theme={theme} derived={derived} onChange={setTheme} selected={selected} onSelect={setSelected} />
            </Pane>
          )}
          <Tabs value={tab} onValueChange={(next: unknown) => setTab(String(next))} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="px-inset-lg">
              <TabsTrigger value="components">Components</TabsTrigger>
              <TabsTrigger value="swatches">Swatches</TabsTrigger>
              <TabsTrigger value="contrast" count={derived.contrast.filter((m) => !m.pass).length} countLabel={["failing pair", "failing pairs"]} countTone="danger">
                Contrast
              </TabsTrigger>
              <TabsTrigger value="problems" count={derived.diagnostics.length} countLabel={["problem", "problems"]} countTone="warning">
                Problems
              </TabsTrigger>
            </TabsList>
            <TabsContent value="components" className="min-h-0 flex-1">
              <ScrollArea className="h-full" aria-label="Component preview">
                <div className="p-inset-lg">
                  <Gallery />
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="swatches" className="min-h-0 flex-1">
              <ScrollArea className="h-full" aria-label="Swatches">
                <div className="p-inset-lg">
                  <SwatchBoard set={derived.set} />
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="contrast" className="min-h-0 flex-1">
              <ScrollArea className="h-full" aria-label="Contrast">
                <div className="p-inset-lg">
                  <ContrastReport theme={theme} derived={derived} view={view} onChange={setTheme} onSelect={setSelected} />
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="problems" className="min-h-0 flex-1">
              <ScrollArea className="h-full" aria-label="Problems">
                <div className="p-inset-lg">
                  <Problems derived={derived} onSelect={setSelected} />
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

function Pane({ label, children }: { label: string; children: ReactNode }) {
  return (
    // eslint-disable-next-line byterygon/no-arbitrary-value -- a cap relative to the viewport; no token is a viewport fraction
    <section aria-label={label} className="max-h-[50dvh] shrink-0 border-b border-border bg-surface">
      {/* eslint-disable-next-line byterygon/no-arbitrary-value -- a cap relative to the viewport; no token is a viewport fraction */}
      <ScrollArea className="h-full max-h-[50dvh]" aria-label={label}>
        <div className="p-inset-lg">{children}</div>
      </ScrollArea>
    </section>
  );
}

/** Every diagnostic, as `by-tokens validate` lists it; a token name opens the token. */
function Problems({ derived, onSelect }: { derived: ReturnType<typeof derive>; onSelect: (path: string) => void }) {
  if (derived.diagnostics.length === 0) return <p className="text-body text-fg-muted">The theme breaks no rule: every role resolves and all {derived.contrast.length} contrast pairs pass.</p>;
  return (
    <ul className="flex flex-col gap-stack-sm">
      {derived.diagnostics.map((d, index) => (
        <li key={index} className="flex flex-col gap-stack-xs rounded-md border border-border-muted bg-surface p-inset-md">
          <span className="flex flex-wrap items-center gap-inline-sm">
            <Badge variant={d.severity === "error" ? "danger" : "warning"}>{d.rule}</Badge>
            {d.token && derived.set.tokens.has(d.token) ? (
              <Button appearance="subtle" size="small" className="font-mono" onClick={() => onSelect(d.token!)}>
                {d.token}
              </Button>
            ) : (
              d.token && <code className="font-mono text-caption">{d.token}</code>
            )}
          </span>
          <span className="text-body text-fg">{d.message}</span>
          {d.fix && <span className="text-caption text-fg-muted">Fix: {d.fix.summary}</span>}
        </li>
      ))}
    </ul>
  );
}
