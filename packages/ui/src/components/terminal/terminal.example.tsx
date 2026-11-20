import { useRef, useState } from "react";
import { Button } from "@/components/button/button";
import { Terminal, type TerminalHandle } from "@/components/terminal/terminal";

/** The smallest useful Terminal: output written once it is ready. */
export function TerminalMinimal() {
  const ref = useRef<TerminalHandle>(null);
  return <Terminal ref={ref} aria-label="Output" readOnly onReady={() => ref.current?.write("build finished in 4.2 s\r\n")} className="h-panel-xs" />;
}

const ESC = "\u001b";

/**
 * An exec session, with a local echo standing in for the process: what is typed comes back, Enter
 * gives a new prompt, the size is shown. An app sends `onData` to the process's stdin instead and
 * writes its stdout with `ref.write`.
 */
export function TerminalRealistic() {
  const ref = useRef<TerminalHandle>(null);
  const [size, setSize] = useState<string>("");
  const [ended, setEnded] = useState(false);
  const prompt = `${ESC}[32mroot@orders-api${ESC}[0m:${ESC}[34m/app${ESC}[0m# `;
  const decoder = new TextDecoder();
  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="flex items-center gap-inline-sm">
        <span className="min-w-0 flex-1 text-caption-1 text-fg-muted">{ended ? "Exited with code 0" : size ? `Connected · ${size}` : "Connecting…"}</span>
        <Button
          appearance="secondary"
          size="small"
          onClick={() => {
            ref.current?.reset();
            ref.current?.write(prompt);
            setEnded(false);
            ref.current?.focus();
          }}
        >
          Reconnect
        </Button>
      </div>
      <Terminal
        ref={ref}
        aria-label="orders-api shell"
        readOnly={ended}
        onReady={() => ref.current?.write(`${ESC}[1mbash${ESC}[0m 5.2 · /bin/sh fallback\r\n${prompt}`)}
        onResize={(cols, rows) => setSize(`${cols} × ${rows}`)}
        onData={(bytes) => {
          const text = decoder.decode(bytes);
          if (text === "\u0004") {
            ref.current?.write("exit\r\n");
            setEnded(true);
          } else if (text === "\r") ref.current?.write(`\r\n${prompt}`);
          else ref.current?.write(bytes);
        }}
        className="h-panel-sm"
      />
    </div>
  );
}
