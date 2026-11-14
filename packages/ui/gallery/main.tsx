// The component gallery: every example of every component, in Light and Dark and both densities,
// side by side. `pnpm --filter @byterygon/ui gallery` serves it; `build` writes it to dist/gallery.
import { StrictMode, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "./gallery.css";
import { gallery } from "./entries.ts";

const manifests = import.meta.glob<{ usage: string }>("../src/components/*/*.manifest.json", { eager: true, import: "default" });
const usage = (name: string) => manifests[`../src/components/${name}/${name}.manifest.json`]?.usage;

const modes = [
  { theme: "light", density: "comfortable" },
  { theme: "dark", density: "comfortable" },
  { theme: "light", density: "compact" },
  { theme: "dark", density: "compact" },
] as const;

function Entry({ name, load }: (typeof gallery)[number]) {
  const [examples, setExamples] = useState<[string, ComponentType][]>([]);
  useEffect(() => {
    void load().then((module) => setExamples(Object.entries(module)));
  }, [load]);
  return (
    <section className="flex flex-col gap-stack-sm">
      <h2 className="text-heading-3 text-fg">{name}</h2>
      <p className="text-body text-fg-muted">{usage(name)}</p>
      <div className="grid grid-cols-2 gap-gap-md">
        {modes.map((mode) => (
          <div key={`${mode.theme}-${mode.density}`} data-theme={mode.theme} data-density={mode.density} className="flex flex-col items-start gap-stack-md rounded-lg border border-border bg-canvas p-inset-lg text-fg">
            <p className="text-caption text-fg-muted">
              {mode.theme}, {mode.density}
            </p>
            {examples.map(([exportName, Example]) => (
              <Example key={exportName} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Gallery() {
  return (
    <main className="flex flex-col gap-stack-xl bg-canvas p-inset-xl font-sans text-fg">
      <h1 className="text-heading-1">Byterygon UI</h1>
      {gallery.map((entry) => (
        <Entry key={entry.name} {...entry} />
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
