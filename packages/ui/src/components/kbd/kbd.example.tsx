import { Kbd, KbdGroup } from "@/components/kbd/kbd";

/** The smallest useful Kbd: one key. */
export function KbdMinimal() {
  return <Kbd>Esc</Kbd>;
}

/** Shortcut hints in a query editor's help text: combinations, a symbol with a name, a sequence. */
export function KbdRealistic() {
  return (
    <ul className="flex flex-col gap-stack-xs text-body text-fg">
      <li className="flex items-center gap-inline-md">
        Run the query
        <KbdGroup>
          <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
        </KbdGroup>
      </li>
      <li className="flex items-center gap-inline-md">
        Open the command palette
        <KbdGroup>
          <Kbd title="Command">
            <span aria-hidden="true">⌘</span>
            <span className="sr-only">Command</span>
          </Kbd>
          +<Kbd>K</Kbd>
        </KbdGroup>
      </li>
      <li className="flex items-center gap-inline-md">
        Go to a table
        <KbdGroup>
          <Kbd>G</Kbd>then<Kbd>T</Kbd>
        </KbdGroup>
      </li>
    </ul>
  );
}
