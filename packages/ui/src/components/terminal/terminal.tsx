import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { cn } from "@/lib/cn";
import { tokenReader } from "@/lib/token-reader";
import { loadXterm, xtermMetrics, xtermTheme } from "@/lib/xterm";

// A terminal (Mightyconsole spec §15, TSK-81): xterm.js loaded lazily from the app's own bundle
// (@/lib/xterm), themed from the terminal.* roles of its region and rethemed when the region's
// data-theme or data-density or a stylesheet changes. It knows no transport: keystrokes leave as
// bytes through `onData`, size changes through `onResize`, and the app writes the process's output
// with `ref.write`. Mod+Shift+C copies the selection and Mod+Shift+V pastes (Ctrl+C goes to the
// process). xterm.js's own DOM sits in a `data-foreign-dom` element, like CodeInput's CodeMirror.
// Base UI has no part for it, so it is plain elements.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const terminalVariants = {} as const;

const classes = {
  root: [
    "relative flex w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-terminal p-inset-sm text-terminal-fg",
    "focus-within:outline-solid focus-within:outline-[length:var(--by-ring-width)] focus-within:outline-offset-[var(--by-ring-inner-width)] focus-within:outline-ring",
    "data-loading:cursor-progress",
  ],
  fallback: "absolute inset-0 p-inset-sm font-mono text-code text-fg-muted",
  surface: "min-h-0 min-w-0 flex-1",
} as const;

/** What `ref` gives: write output, focus, clear, search. */
export interface TerminalHandle {
  /** Writes the process's output (UTF-8 bytes, or text); queued until xterm.js has loaded. */
  write: (data: Uint8Array | string) => void;
  /** Moves the keyboard focus into the terminal. */
  focus: () => void;
  /** Clears the scrollback, keeping the prompt line. */
  clear: () => void;
  /** Clears the screen and the scrollback and resets the modes (a new session in the same terminal). */
  reset: () => void;
  /** Selects the next match of `query` after the selection; false when there is none. */
  findNext: (query: string) => boolean;
  /** Selects the previous match of `query`; false when there is none. */
  findPrevious: (query: string) => boolean;
  /** The size in character cells, null before xterm.js has loaded. */
  size: () => { cols: number; rows: number } | null;
}

export interface TerminalProps {
  /** Keystrokes, pastes and terminal replies as bytes (UTF-8), for the process's stdin. */
  onData?: ((data: Uint8Array) => void) | undefined;
  /** The size in cells, once loaded and whenever the element's size changes. */
  onResize?: ((cols: number, rows: number) => void) | undefined;
  /** Called once xterm.js has loaded and the terminal is open. */
  onReady?: (() => void) | undefined;
  /** The font size in px; text.code's size of the region by default. */
  fontSize?: number | undefined;
  /** Lines kept above the screen. */
  scrollback?: number | undefined;
  /** Output only: keystrokes are ignored and no cursor blinks (a finished session). */
  readOnly?: boolean | undefined;
  /** xterm.js's screen reader mode: an accessible buffer of the output (costs some speed). */
  screenReaderMode?: boolean | undefined;
  /** Accessible name of the terminal. */
  "aria-label"?: string | undefined;
  /** Extra classes, merged after the component's own so they win; set the height here. */
  className?: string | undefined;
  ref?: Ref<TerminalHandle> | undefined;
}

type XtermTerminal = InstanceType<Awaited<ReturnType<typeof loadXterm>>["Terminal"]>;
type XtermSearch = InstanceType<Awaited<ReturnType<typeof loadXterm>>["SearchAddon"]>;

const encoder = new TextEncoder();

/** Bytes of xterm.js's binary strings (one char per byte, mouse reports in X10 mode). */
function binaryBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** True for Mod+Shift+<key>: Ctrl on Windows and Linux, Cmd on macOS. */
const modShift = (event: KeyboardEvent, code: string) => event.type === "keydown" && event.shiftKey && (event.ctrlKey || event.metaKey) && event.code === code;

/** An interactive terminal on xterm.js, themed from the terminal.* tokens; the app wires its bytes to a process. */
export function Terminal({ onData, onResize, onReady, fontSize, scrollback = 5000, readOnly = false, screenReaderMode = false, "aria-label": label = "Terminal", className, ref }: TerminalProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  const searchRef = useRef<XtermSearch | null>(null);
  const pending = useRef<(Uint8Array | string)[]>([]);
  const callbacks = useRef({ onData, onResize, onReady });
  callbacks.current = { onData, onResize, onReady };
  const options = useRef({ fontSize, readOnly });
  options.current = { fontSize, readOnly };
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      write(data) {
        const term = termRef.current;
        if (term) term.write(data);
        else pending.current.push(data);
      },
      focus() {
        termRef.current?.focus();
      },
      clear() {
        termRef.current?.clear();
      },
      reset() {
        pending.current = [];
        termRef.current?.reset();
      },
      findNext: (query) => searchRef.current?.findNext(query) ?? false,
      findPrevious: (query) => searchRef.current?.findPrevious(query) ?? false,
      size: () => (termRef.current ? { cols: termRef.current.cols, rows: termRef.current.rows } : null),
    }),
    [],
  );

  // Created once per mount; the options below follow their props.
  useEffect(() => {
    const root = rootRef.current;
    const surface = surfaceRef.current;
    if (!root || !surface) return undefined;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    loadXterm().then(
      (xterm) => {
        if (disposed) return;
        const reader = tokenReader(root);
        const term = new xterm.Terminal({
          ...xtermMetrics(reader, options.current.fontSize),
          theme: xtermTheme(reader),
          scrollback,
          screenReaderMode,
          disableStdin: options.current.readOnly,
          cursorBlink: !options.current.readOnly,
          allowProposedApi: false,
        });
        const fit = new xterm.FitAddon();
        const search = new xterm.SearchAddon();
        term.loadAddon(fit);
        term.loadAddon(search);
        term.attachCustomKeyEventHandler((event) => {
          if (modShift(event, "KeyC")) {
            const text = term.getSelection();
            if (text) void navigator.clipboard?.writeText(text);
            return false;
          }
          if (modShift(event, "KeyV")) {
            void navigator.clipboard?.readText().then((text) => {
              if (text && !options.current.readOnly) term.paste(text);
            });
            return false;
          }
          return true;
        });
        term.open(surface);
        term.textarea?.setAttribute("aria-label", label);
        let reported = "";
        const report = (cols: number, rows: number) => {
          if (`${cols}x${rows}` === reported) return;
          reported = `${cols}x${rows}`;
          callbacks.current.onResize?.(cols, rows);
        };
        const subscriptions = [
          term.onData((text) => {
            if (!options.current.readOnly) callbacks.current.onData?.(encoder.encode(text));
          }),
          term.onBinary((text) => {
            if (!options.current.readOnly) callbacks.current.onData?.(binaryBytes(text));
          }),
          term.onResize(({ cols, rows }) => report(cols, rows)),
        ];
        termRef.current = term;
        searchRef.current = search;
        for (const data of pending.current) term.write(data);
        pending.current = [];

        let frame = 0;
        const refit = () => {
          frame = 0;
          if (disposed || surface.clientWidth === 0 || surface.clientHeight === 0) return;
          fit.fit();
        };
        const scheduleFit = () => {
          if (!frame) frame = requestAnimationFrame(refit);
        };
        const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleFit);
        resizeObserver?.observe(surface);
        refit();
        report(term.cols, term.rows);

        // Retheme when the region's theme or density, or a stylesheet, changes.
        const doc = root.ownerDocument;
        let themeFrame = 0;
        const retheme = () => {
          themeFrame = 0;
          if (disposed) return;
          term.options.theme = xtermTheme(reader);
          const metrics = xtermMetrics(reader, options.current.fontSize);
          term.options.fontFamily = metrics.fontFamily;
          term.options.fontSize = metrics.fontSize;
          term.options.lineHeight = metrics.lineHeight;
          scheduleFit();
        };
        const mutations = new MutationObserver((records) => {
          for (const r of records) {
            const target = r.target as Node;
            if (surface.contains(target)) continue;
            const sheet = (n: Node) => n.nodeName === "STYLE" || n.nodeName === "LINK";
            if ((r.type === "attributes" && target.contains(root)) || doc.head.contains(target) || [...r.addedNodes, ...r.removedNodes].some(sheet)) {
              if (!themeFrame) themeFrame = requestAnimationFrame(retheme);
              return;
            }
          }
        });
        mutations.observe(doc.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-density"], subtree: true, childList: true });

        cleanup = () => {
          if (frame) cancelAnimationFrame(frame);
          if (themeFrame) cancelAnimationFrame(themeFrame);
          resizeObserver?.disconnect();
          mutations.disconnect();
          for (const s of subscriptions) s.dispose();
          reader.dispose();
          term.dispose();
          termRef.current = null;
          searchRef.current = null;
        };
        setLoaded(true);
        callbacks.current.onReady?.();
      },
      (error: unknown) => {
        if (!disposed) setFailed(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      disposed = true;
      cleanup?.();
    };
    // xterm.js takes scrollback and screenReaderMode at creation; the others follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once per mount, see above
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = readOnly;
    term.options.cursorBlink = !readOnly;
  }, [readOnly, loaded]);

  useEffect(() => {
    const term = termRef.current;
    const root = rootRef.current;
    if (!term || !root) return;
    const reader = tokenReader(root);
    term.options.fontSize = xtermMetrics(reader, fontSize).fontSize;
    reader.dispose();
  }, [fontSize, loaded]);

  return (
    <div
      ref={rootRef}
      data-slot="terminal"
      data-loading={loaded ? undefined : ""}
      data-readonly={readOnly ? "" : undefined}
      role="group"
      aria-label={label}
      aria-busy={loaded ? undefined : true}
      className={cn(classes.root, className)}
    >
      <div data-slot="terminal-fallback" hidden={loaded} className={classes.fallback}>
        {failed ? `The terminal could not load: ${failed}` : "Loading the terminal…"}
      </div>
      <div ref={surfaceRef} data-slot="terminal-surface" data-foreign-dom="" className={classes.surface} />
    </div>
  );
}
