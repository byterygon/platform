#!/usr/bin/env node
// End-to-end check of the registry (TSK-42): the real shadcn CLI installs a theme item and the
// Byterygon components into a blank Vite app, offline, once from the registry folder on disk and
// once from a static server on loopback; stock shadcn/ui components (the Base UI "base-nova"
// style, test/fixtures) go in next to them. Then Vite builds the app and the built CSS is read
// back: stock classes (bg-primary, bg-card, border-input...) and Byterygon classes must resolve,
// through the shadcn aliases, to the token values of @byterygon/design-tokens in Light, Dark and
// Compact.
//
// Offline: every HTTP(S) request is sent to a dead proxy (127.0.0.1:9) and npm is set offline, so
// any download fails at once; CI also runs this script in a network namespace with only loopback.
//
//   node scripts/verify-install.ts [--keep] [--json]
// Exit codes: 0 ok, 1 a check failed, 3 registry/ is stale.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokens } from "@byterygon/design-tokens/default/tokens";
import { parseCss, resolveVars, selectors, walk, type Rule } from "./lib/css.ts";
import { PACKAGE_ROOT, syncRegistry } from "./registry.ts";

const REGISTRY = join(PACKAGE_ROOT, "registry");
const FIXTURES = join(PACKAGE_ROOT, "test", "fixtures", "shadcn-base-nova");
const SHADCN = join(PACKAGE_ROOT, "node_modules", "shadcn", "dist", "index.js");
const STOCK = ["button", "card", "input"];
/**
 * The Byterygon items named on the command line. Button comes in through the registry
 * dependencies of icon-button and input-group as well; cn through every item, and theme-scope
 * through select, combobox, multi-select, date-picker and the overlays.
 */
const ITEMS = [
  "button", "input", "field", "form", "textarea", "input-group", "icon-button", "kbd",
  "toggle-button", "toggle-group", "checkbox", "radio-group", "switch",
  "number-input", "password-input", "search-input", "slider", "file-input",
  "select", "combobox", "multi-select",
  "calendar", "date-picker", "time-picker",
  "dialog", "alert-dialog", "sheet", "popover", "tooltip",
  "hover-card", "dropdown-menu", "context-menu", "menubar", "split-button",
  "tabs", "toast", "command-palette",
  "breadcrumb", "pagination", "stepper", "navigation-menu",
  "sidebar", "tree",
  "sql-editor", "code-input",
];

const DEAD_PROXY = "http://127.0.0.1:9";
const OFFLINE_ENV = {
  ...process.env,
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  npm_config_offline: "true",
};

const failures: string[] = [];
const log: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  return ok;
};

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const version = (name: string) => pkg.dependencies[name] ?? pkg.devDependencies[name]!;

/** What `npm create vite` plus `shadcn init` would leave, minus anything fetched. */
function blankApp(dir: string, registryTemplate: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  const write = (path: string, content: unknown) => writeFileSync(join(dir, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  // Every package the items need is listed, as an air-gapped project provisions them from a
  // mirror; the shadcn CLI installs only what is missing, which here would mean the network.
  write("package.json", {
    name: "blank-vite-app",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(["react", "react-dom", "@base-ui/react", "@tanstack/react-form", "cn", "class-variance-authority", "react-day-picker", "date-fns", "monaco-editor", "@codemirror/commands", "@codemirror/lang-json", "@codemirror/lang-sql", "@codemirror/language", "@codemirror/state", "@codemirror/view", "@lezer/highlight"].map((n) => [n, version(n)])),
    devDependencies: Object.fromEntries(["vite", "@tailwindcss/vite", "tailwindcss"].map((n) => [n, version(n)])),
  });
  write("tsconfig.json", { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, baseUrl: ".", paths: { "@/*": ["./src/*"] } }, include: ["src"] });
  write(
    "vite.config.ts",
    `import { fileURLToPath } from "node:url";\nimport tailwindcss from "@tailwindcss/vite";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({\n  plugins: [tailwindcss()],\n  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },\n});\n`,
  );
  write("index.html", `<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>blank</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n`);
  write("src/index.css", `@import "tailwindcss";\n`);
  // baseColor "" keeps the CLI from downloading a base colour; the theme item supplies the colours.
  write("components.json", {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "base-nova",
    rsc: false,
    tsx: true,
    tailwind: { config: "", css: "src/index.css", baseColor: "", cssVariables: true, prefix: "" },
    aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" },
    iconLibrary: "none",
    registries: { "@byterygon": registryTemplate },
  });
  // The packages themselves come from packages/ui's own install.
  symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
}

// Asynchronous: the static server of step 2 runs in this process and must keep answering.
async function shadcnAdd(app: string, items: string[]): Promise<boolean> {
  const child = spawn(process.execPath, [SHADCN, "add", ...items, "--yes", "--overwrite"], { cwd: app, env: OFFLINE_ENV, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 120_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  log.push(`shadcn add (${app}):\n${output.trim()}`);
  return check(status === 0, `shadcn add failed in ${app} (exit ${status}):\n${output.trim()}`);
}

/** The stock items, renamed so they land in src/components/stock/ beside the Byterygon ones. */
function stockItems(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return STOCK.map((name) => {
    const item = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as { name: string; files: { type: string; target?: string }[] };
    item.name = `stock-${name}`;
    item.files = item.files.map((file) => ({ ...file, type: "registry:file", target: `src/components/stock/${name}.tsx` }));
    const path = join(dir, `stock-${name}.json`);
    writeFileSync(path, JSON.stringify(item));
    return path;
  });
}

function serve(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]!.slice(1));
    const path = join(dir, name);
    if (!/^[a-z0-9-]+\.(json|txt)$/.test(name) || !existsSync(path)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": name.endsWith(".json") ? "application/json" : "text/plain" }).end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const itemContent = (name: string) => (JSON.parse(readFileSync(join(REGISTRY, `${name}.json`), "utf8")) as { files: { content: string }[] }).files[0]!.content;

function checkInstalledFiles(app: string, label: string): void {
  for (const [path, item] of [["src/lib/cn.ts", "cn"], ["src/lib/theme-scope.ts", "theme-scope"], ["src/lib/monaco.ts", "monaco"], ...ITEMS.map((name) => [`src/components/ui/${name}.tsx`, name] as const)] as const) {
    const full = join(app, path);
    if (check(existsSync(full), `${label}: ${path} was not installed`)) {
      check(readFileSync(full, "utf8") === itemContent(item), `${label}: ${path} differs from the registry item ${item}`);
    }
  }
  const css = readFileSync(join(app, "src/index.css"), "utf8");
  check(css.includes("--by-color-bg-surface:"), `${label}: src/index.css has no token variables after installing the theme`);
  check(css.includes("--primary: var(--by-color-accent-bg)"), `${label}: src/index.css has no shadcn aliases`);
  check(/@theme inline\s*\{[\s\S]*--color-accent-solid: var\(--by-color-accent-bg\)/.test(css), `${label}: src/index.css has no Tailwind role names`);
}

const MAIN = `import { useForm } from "@tanstack/react-form";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { CommandPalette } from "@/components/ui/command-palette";
import { NavigationMenu, NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, NavigationMenuTrigger } from "@/components/ui/navigation-menu";
import { Pagination } from "@/components/ui/pagination";
import { Sidebar, SidebarContent, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Stepper } from "@/components/ui/stepper";
import { Tree } from "@/components/ui/tree";
import { SqlEditor } from "@/components/ui/sql-editor";
import { CodeInput } from "@/components/ui/code-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toast } from "@/components/ui/toast";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarTrigger } from "@/components/ui/menubar";
import { SplitButton } from "@/components/ui/split-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox, CheckboxGroup } from "@/components/ui/checkbox";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";
import { Field, FieldDescription, FieldError, FieldItem, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Form } from "@/components/ui/form";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { MultiSelect } from "@/components/ui/multi-select";
import { NumberInput } from "@/components/ui/number-input";
import { PasswordInput } from "@/components/ui/password-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectSeparator } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TimePicker } from "@/components/ui/time-picker";
import { ToggleButton } from "@/components/ui/toggle-button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button as StockButton } from "@/components/stock/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/stock/card";
import { Input as StockInput } from "@/components/stock/input";

function Overlays() {
  return (
    <TooltipProvider>
      <Dialog open size="lg">
        <DialogTrigger render={<Button variant="secondary" />}>Export</DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>Export result</DialogTitle><DialogDescription>The whole result.</DialogDescription></DialogHeader>
          <DialogBody><Input aria-label="File" /></DialogBody>
          <DialogFooter><DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="danger" />}>Delete</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete it?</AlertDialogTitle></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="danger">Delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet side="left" size="sm">
        <SheetTrigger render={<Button />}>Edit</SheetTrigger>
        <SheetContent><SheetHeader><SheetTitle>Edit</SheetTitle></SheetHeader><SheetBody /></SheetContent>
      </Sheet>
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" />}>Grant</PopoverTrigger>
        <PopoverContent><PopoverTitle>Access</PopoverTitle><PopoverDescription>TLS required.</PopoverDescription></PopoverContent>
      </Popover>
      <Tooltip>
        <TooltipTrigger render={<IconButton aria-label="Run" />}><svg aria-hidden="true" viewBox="0 0 16 16" /></TooltipTrigger>
        <TooltipContent>Run <TooltipShortcut>Ctrl+Enter</TooltipShortcut></TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="secondary" />}>Copy</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Copy cells <DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem defaultChecked>Include headers</DropdownMenuCheckboxItem>
          <DropdownMenuItem danger>Clear</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ContextMenu>
        <ContextMenuTrigger>orders</ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem>Open query tab</ContextMenuItem></ContextMenuContent>
      </ContextMenu>
      <Menubar>
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent><MenubarItem>New tab</MenubarItem></MenubarContent>
        </MenubarMenu>
      </Menubar>
      <HoverCard>
        <HoverCardTrigger href="#orders">public.orders</HoverCardTrigger>
        <HoverCardContent>12 columns</HoverCardContent>
      </HoverCard>
      <Tabs variant="enclosed" size="sm" defaultValue="q1">
        <TabsList onReorder={() => {}}>
          <TabsTrigger value="q1" onClose={() => {}}>Query 1</TabsTrigger>
          <TabsTrigger value="q2">Query 2</TabsTrigger>
        </TabsList>
        <TabsContent value="q1">select 1;</TabsContent>
      </Tabs>
      <Toast placement="static" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink href="#db">orders-prod</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>orders</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Pagination page={3} pageCount={20} />
      <SidebarProvider hotkey={false}>
        <Sidebar aria-label="Connections" collapsible="icon">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton active>Connections</SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
            <Tree nodes={[{ id: "db", label: "orders-prod", children: [{ id: "public", label: "public" }] }]} defaultExpanded={["db"]} defaultSelected="public" aria-label="Schema" />
          </SidebarContent>
        </Sidebar>
        <SidebarInset><SidebarTrigger /></SidebarInset>
      </SidebarProvider>
      <Stepper steps={[{ title: "Details" }, { title: "Approve" }, { title: "Connect", error: true }]} value={1} />
      <NavigationMenu>
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger>Workspace</NavigationMenuTrigger>
            <NavigationMenuContent><NavigationMenuLink href="#c" active>Connections</NavigationMenuLink></NavigationMenuContent>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
      <CommandPalette groups={[{ label: "Query", items: [{ id: "run", label: "Run statement", shortcut: "Ctrl+Enter", onSelect: () => {} }] }]} hotkeys={["Mod+K"]} />
      <SplitButton menuLabel="Run options" menu={<DropdownMenuItem>Run selection</DropdownMenuItem>}>Run</SplitButton>
    </TooltipProvider>
  );
}

function Connection() {
  const form = useForm({ defaultValues: { host: "" } });
  return (
    <Form form={form} aria-label="Connection">
      <form.Field name="host" validators={{ onBlur: ({ value }) => (value ? undefined : "Enter a host.") }}>
        {(field) => (
          <Field field={field}>
            <FieldLabel>Host</FieldLabel>
            <InputGroup>
              <InputGroupAddon>postgres://</InputGroupAddon>
              <InputGroupInput value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} />
              <InputGroupButton>Test</InputGroupButton>
            </InputGroup>
            <FieldDescription>A name on your network.</FieldDescription>
            <FieldError />
          </Field>
        )}
      </form.Field>
      <Textarea aria-label="Notes" />
      <IconButton aria-label="Copy"><svg aria-hidden="true" viewBox="0 0 16 16" /></IconButton>
      <KbdGroup><Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd></KbdGroup>
      <FieldSet>
        <FieldLegend>Options</FieldLegend>
        <Field name="tls">
          <RadioGroup defaultValue="require">
            <FieldLegend>TLS</FieldLegend>
            <FieldItem><FieldLabel><RadioGroupItem value="require" />Require</FieldLabel></FieldItem>
            <FieldItem><FieldLabel><RadioGroupItem value="disable" />Disable</FieldLabel></FieldItem>
          </RadioGroup>
        </Field>
        <Field name="tables">
          <CheckboxGroup defaultValue={["orders"]}>
            <FieldLegend>Tables</FieldLegend>
            <FieldItem><FieldLabel><Checkbox value="orders" />orders</FieldLabel></FieldItem>
          </CheckboxGroup>
        </Field>
        <Field><FieldLabel><Switch defaultChecked />Auto-commit</FieldLabel></Field>
      </FieldSet>
      <Field><FieldLabel>Port</FieldLabel><NumberInput defaultValue={5432} min={1} max={65535} /></Field>
      <Field><FieldLabel>Password</FieldLabel><PasswordInput /></Field>
      <SearchInput aria-label="Search tables" />
      <Field><FieldLabel>Sample</FieldLabel><Slider defaultValue={25} /></Field>
      <Field><FieldLabel>CA certificate</FieldLabel><FileInput accept=".pem" /></Field>
      <FileInput aria-label="Scripts" variant="dropzone" multiple />
      <Field>
        <FieldLabel>Engine</FieldLabel>
        <Select items={{ pg: "PostgreSQL", duck: "DuckDB" }} defaultValue="pg">
          <SelectGroup><SelectGroupLabel>Engines</SelectGroupLabel><SelectItem value="pg">PostgreSQL</SelectItem></SelectGroup>
          <SelectSeparator />
          <SelectItem value="duck">DuckDB</SelectItem>
        </Select>
      </Field>
      <Field>
        <FieldLabel>Schema</FieldLabel>
        <Combobox items={["public", "audit"]} status="">
          {(schema: string) => <ComboboxItem key={schema} value={schema}>{schema}</ComboboxItem>}
        </Combobox>
      </Field>
      <Field>
        <FieldLabel>Columns</FieldLabel>
        <MultiSelect items={["id", "status"]} defaultValue={["id"]}>
          {(column: string) => <ComboboxItem key={column} value={column}>{column}</ComboboxItem>}
        </MultiSelect>
      </Field>
      <Field><FieldLabel>Restore to</FieldLabel><DatePicker /></Field>
      <Field><FieldLabel>History</FieldLabel><DatePicker mode="range" /></Field>
      <Field><FieldLabel>Backup at</FieldLabel><TimePicker defaultValue="02:30" /></Field>
      <Calendar mode="range" aria-label="History window" defaultMonth={new Date(2026, 10, 1)} selected={{ from: new Date(2026, 10, 3), to: new Date(2026, 10, 9) }} />
      <ToggleButton defaultPressed>Wrap</ToggleButton>
      <ToggleGroup aria-label="View" defaultValue={["grid"]}>
        <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
        <ToggleGroupItem value="json">JSON</ToggleGroupItem>
      </ToggleGroup>
    </Form>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Button>Byterygon</Button>
    <Input aria-label="Byterygon input" />
    <Connection />
    <Overlays />
    <SqlEditor aria-label="Query" defaultValue="select 1;" onRun={(run) => console.log(run.text)} markers={[{ start: 7, message: "check" }]} />
    <Field><FieldLabel>Filter</FieldLabel><CodeInput language="sql" defaultValue="id = 1" onSubmit={(v) => console.log(v)} /></Field>
    <CodeInput aria-label="Cell value" language="json" pretty value='{"id":1}' />
    <Card>
      <CardHeader><CardTitle>Stock card</CardTitle></CardHeader>
      <CardContent>
        <StockButton>Stock</StockButton>
        <StockButton variant="ghost">Ghost</StockButton>
        <StockButton variant="destructive">Delete</StockButton>
        <StockInput aria-label="Stock input" />
      </CardContent>
    </Card>
  </StrictMode>,
);
`;

async function buildApp(app: string): Promise<string> {
  writeFileSync(join(app, "src/main.tsx"), MAIN);
  const vite = await import("vite");
  await vite.build({
    root: app,
    configFile: join(app, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: join(app, "dist"),
      cssMinify: false,
      rolldownOptions: {
        onwarn(warning, warn) {
          if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
        },
      },
    },
  });
  const assets = join(app, "dist", "assets");
  // The page's own stylesheet is the one index.html links; Monaco's CSS comes with its lazy chunks.
  const html = readFileSync(join(app, "dist", "index.html"), "utf8");
  const linked = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\/assets\/([^"]+\.css)"/g)].map((m) => m[1]!);
  check(linked.length === 1, `expected index.html to link one stylesheet, found ${linked.length}`);
  // SqlEditor (TSK-46): Monaco is not in the entry chunk, its worker is a bundled file, nothing names a CDN.
  const files = readdirSync(assets);
  const entry = [...html.matchAll(/<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]!);
  check(entry.length === 1 && !readFileSync(join(assets, entry[0]!), "utf8").includes("monaco-scrollable-element"), "Monaco is in the entry chunk; SqlEditor must load it on demand");
  check(files.some((f) => /^editor\.worker-.*\.js$/.test(f) && readFileSync(join(assets, f)).length > 100_000), "no bundled Monaco editor worker in the build");
  check(files.some((f) => f.endsWith(".ttf") && f.startsWith("codicon")), "Monaco's codicon font is not in the build");
  const js = files.filter((f) => /\.(js|css)$/.test(f)).map((f) => readFileSync(join(assets, f), "utf8")).join("\n");
  check(!/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh/.test(js), "the build names a CDN");
  return readFileSync(join(assets, linked[0] ?? ""), "utf8");
}

const escapeClass = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

/** Compares CSS values after the minifier's rewrites: `oklch(46% .0213 230)` equals `oklch(0.46 0.0213 230)`. */
function sameValue(a: string, b: string): boolean {
  const numbers = (value: string) => {
    const fn = /^([a-z-]+)\(/.exec(value.trim())?.[1] ?? "";
    const list = [...value.matchAll(/(-?\d*\.?\d+)(%?)/g)].map((m, i) => (m[2] === "%" && fn === "oklch" && i === 0 ? Number(m[1]) / 100 : Number(m[1])));
    return { fn, list, unit: value.replace(/[-\d.%\s/(),]/g, "").replace(fn, "") };
  };
  const x = numbers(a);
  const y = numbers(b);
  return x.fn === y.fn && x.unit === y.unit && x.list.length === y.list.length && x.list.every((n, i) => Math.abs(n - y.list[i]!) < 1e-4);
}

/** `.hover\:bg-muted:hover` belongs to `.hover\:bg-muted`; `.bg-muted-foo` does not. */
const selectsClass = (selector: string, escaped: string) => selector.startsWith(escaped) && !/^[a-zA-Z0-9_\\-]/.test(selector.slice(escaped.length));

interface Mode {
  theme: "light" | "dark";
  density: "comfortable" | "compact";
}

/** The custom properties a root element with these attributes gets, in cascade order. */
function variablesFor(rules: readonly Rule[], mode: Mode): Map<string, string> {
  const applies = new Set([":root", ":host", `[data-theme="${mode.theme}"]`, `.${mode.theme}`, `[data-density="${mode.density}"]`]);
  const vars = new Map<string, string>();
  for (const { rule, parents } of walk(rules)) {
    if (parents.some((p) => !p.startsWith("@layer"))) continue;
    if (!selectors(rule.prelude).some((s) => applies.has(s))) continue;
    for (const [property, value] of rule.declarations) if (property.startsWith("--")) vars.set(property, value);
  }
  return vars;
}

/** The declarations a utility class produces, with those of its nested variant rules. */
function utility(rules: readonly Rule[], name: string): Map<string, string> {
  const selector = `.${escapeClass(name)}`;
  const out = new Map<string, string>();
  const collect = (rule: Rule) => {
    for (const [p, v] of rule.declarations) out.set(p, v);
    rule.children.forEach(collect);
  };
  for (const { rule } of walk(rules)) if (selectors(rule.prelude).some((s) => selectsClass(s, selector))) collect(rule);
  return out;
}

/** The selectors (with nested ones) of the rules for a utility class. */
function utilitySelectors(rules: readonly Rule[], name: string): string[] {
  const selector = `.${escapeClass(name)}`;
  const out: string[] = [];
  const collect = (rule: Rule) => {
    out.push(rule.prelude);
    rule.children.forEach(collect);
  };
  for (const { rule } of walk(rules)) if (selectors(rule.prelude).some((s) => selectsClass(s, selector))) collect(rule);
  return out;
}

type TokenPath = keyof typeof tokens;
const EXPECT: [string, string, TokenPath, string][] = [
  // stock shadcn/ui (base-nova) classes, through the shadcn alias layer
  ["bg-primary", "background-color", "color.accent.bg", "stock Button default"],
  ["text-primary-foreground", "color", "color.fg.on-accent", "stock Button default"],
  ["hover:bg-muted", "background-color", "color.bg.inset", "stock Button ghost"],
  ["text-destructive", "color", "color.status.danger.solid", "stock Button destructive"],
  ["bg-card", "background-color", "color.bg.surface", "stock Card"],
  ["text-card-foreground", "color", "color.fg.default", "stock Card"],
  ["text-muted-foreground", "color", "color.fg.muted", "stock Input placeholder"],
  ["border-input", "border-color", "color.border.strong", "stock Input"],
  ["focus-visible:border-ring", "border-color", "color.ring", "stock Input focus"],
  ["rounded-lg", "border-radius", "radius.lg", "stock Button"],
  // Byterygon classes, through the Tailwind role names
  ["bg-accent-solid", "background-color", "color.accent.bg", "Byterygon Button primary"],
  ["text-accent-solid-fg", "color", "color.accent.fg", "Byterygon Button primary"],
  ["h-control-md", "height", "size.control.md", "Byterygon Button md (density)"],
  ["bg-surface", "background-color", "color.bg.surface", "Byterygon Input"],
  ["border-border-strong", "border-color", "color.border.strong", "Byterygon Input"],
  ["text-danger-fg", "color", "color.status.danger.fg", "Byterygon FieldError"],
  ["has-[[data-slot=input-group-input]:focus-visible]:outline-ring", "outline-color", "color.ring", "Byterygon InputGroup focus"],
  ["size-control-md", "width", "size.control.md", "Byterygon IconButton md (density)"],
  ["bg-inset", "background-color", "color.bg.inset", "Byterygon Kbd"],
  ["data-pressed:bg-selected", "background-color", "color.interactive.selected", "Byterygon ToggleButton pressed"],
  ["data-checked:bg-accent-solid", "background-color", "color.accent.bg", "Byterygon Checkbox, Radio and Switch checked"],
  ["bg-border-strong", "background-color", "color.border.strong", "Byterygon Switch off"],
  ["h-track", "height", "size.track", "Byterygon Slider track"],
  ["bg-overlay", "background-color", "color.bg.overlay", "Byterygon Select, Combobox and MultiSelect popup"],
  ["bg-neutral-subtle", "background-color", "color.neutral.subtle-bg", "Byterygon MultiSelect chip"],
  ["data-selected:bg-accent-solid", "background-color", "color.accent.bg", "Byterygon Calendar chosen day"],
  ["bg-accent-subtle", "background-color", "color.accent.subtle-bg", "Byterygon Calendar range band"],
  ["bg-scrim", "background-color", "color.bg.scrim", "Byterygon Dialog, AlertDialog and Sheet scrim"],
  ["max-w-panel-lg", "max-width", "size.panel.lg", "Byterygon Dialog lg"],
  ["bg-neutral-solid", "background-color", "color.neutral.bg", "Byterygon Tooltip"],
  ["data-highlighted:bg-hover", "background-color", "color.interactive.hover", "Byterygon menu item highlighted"],
  ["data-danger:text-danger-fg", "color", "color.status.danger.fg", "Byterygon menu item danger"],
  ["border-s-accent-solid-active", "border-inline-start-color", "color.accent.bg-active", "Byterygon SplitButton divider"],
  ["data-active:border-accent-solid", "border-color", "color.accent.bg", "Byterygon Tabs line active"],
  ["data-active:bg-surface", "background-color", "color.bg.surface", "Byterygon Tabs enclosed active"],
  ["w-panel-sm", "width", "size.panel.sm", "Byterygon Toast region"],
  ["data-current:bg-selected", "background-color", "color.interactive.selected", "Byterygon Pagination current page"],
  ["data-[status=error]:text-danger-fg", "color", "color.status.danger.fg", "Byterygon Stepper failed step"],
  ["w-panel-xs", "width", "size.panel.xs", "Byterygon Sidebar width"],
  ["h-control-sm", "height", "size.control.sm", "Byterygon Tree row (density)"],
  ["bg-editor", "background-color", "editor.bg", "Byterygon SqlEditor frame"],
  ["p-inset-sm", "padding", "space.inset.sm", "Byterygon SqlEditor fallback (density)"],
  ["data-readonly:bg-inset", "background-color", "color.bg.inset", "Byterygon CodeInput read-only and pretty"],
];

function expected(path: TokenPath, mode: Mode): string {
  const values = tokens[path].values as Record<string, string>;
  return values.base ?? values[mode.theme] ?? values[mode.density]!;
}

function checkTheming(css: string): void {
  const rules = parseCss(css);
  const modes: Mode[] = [
    { theme: "light", density: "comfortable" },
    { theme: "dark", density: "comfortable" },
    { theme: "light", density: "compact" },
  ];
  for (const mode of modes) {
    const vars = variablesFor(rules, mode);
    for (const [name, property, path, where] of EXPECT) {
      const declarations = utility(rules, name);
      const value = declarations.get(property);
      if (!check(value !== undefined, `${name} (${where}): no ${property} in the built CSS`)) continue;
      const { value: resolved, chain } = resolveVars(value!, vars);
      const cssVar = tokens[path].cssVar;
      check(chain.includes(cssVar), `${name} (${where}, ${mode.theme}/${mode.density}): resolves through ${chain.join(" -> ") || "no variable"}, not ${cssVar}`);
      check(sameValue(resolved, expected(path, mode)), `${name} (${where}, ${mode.theme}/${mode.density}): resolves to ${resolved}, expected ${path} = ${expected(path, mode)}`);
    }
  }
  // Stock dark: variants follow the Byterygon dark modes (data-theme="dark" as well as .dark).
  const dark = utilitySelectors(rules, "dark:bg-input/30");
  check(dark.some((s) => s.includes('[data-theme="dark"]')), `dark:bg-input/30 (stock Input) does not follow [data-theme="dark"]: ${dark.join(" | ") || "no rule"}`);
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const keep = argv.includes("--keep");
  const stale = syncRegistry({ check: true }).stale;
  if (stale.length > 0) {
    const message = `registry/ is stale (${stale.join(", ")}); run \`pnpm --filter @byterygon/ui registry\` first`;
    process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, command: "verify-install", ok: false, exitCode: 3, failures: [message] })}\n` : `error: ${message}\n`);
    return 3;
  }
  const work = mkdtempSync(join(tmpdir(), "byterygon-ui-verify-"));
  let server: Server | undefined;
  try {
    // 1. From the registry folder on disk, with stock shadcn components next to Byterygon's. Items
    // named on the command line are file paths (the CLI fetches a namespaced name over HTTP);
    // their dependencies (@byterygon/cn) resolve through the registries template to files.
    const local = join(work, "local");
    blankApp(local, join(REGISTRY, "{name}.json"));
    if (await shadcnAdd(local, [join(REGISTRY, "theme-default.json"), ...ITEMS.map((name) => join(REGISTRY, `${name}.json`)), ...stockItems(join(work, "stock"))])) {
      checkInstalledFiles(local, "local path");
      for (const name of STOCK) check(existsSync(join(local, `src/components/stock/${name}.tsx`)), `stock ${name} was not installed`);
    }

    // 2. From a self-hosted static server (loopback only).
    server = await serve(REGISTRY);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const http = join(work, "http");
    blankApp(http, `${base}/{name}.json`);
    if (await shadcnAdd(http, [`${base}/theme-default.json`, ...ITEMS.map((name) => `@byterygon/${name}`)])) {
      checkInstalledFiles(http, "static server");
      check(readFileSync(join(http, "src/index.css"), "utf8") === readFileSync(join(local, "src/index.css"), "utf8"), "the static-server install wrote a different src/index.css than the local-path install");
    }

    // 3. Build the app and follow the built CSS back to the tokens.
    if (failures.length === 0) checkTheming(await buildApp(local));
  } finally {
    server?.close();
    if (keep) log.push(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  const ok = failures.length === 0;
  if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "verify-install", ok, exitCode: ok ? 0 : 1, failures, ...(keep ? { kept: work } : {}) })}\n`);
  else if (ok) process.stdout.write(`verify-install: ok. shadcn CLI installed theme-default, ${ITEMS.join(", ")} offline from a folder and from a static server; stock base-nova Button, Card and Input and the Byterygon components resolve to the token values in light, dark and compact.${keep ? `\nkept ${work}` : ""}\n`);
  else process.stdout.write(`${failures.map((f) => `FAIL ${f}`).join("\n")}\n\n${log.join("\n\n")}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
