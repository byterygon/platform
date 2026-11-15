import { Code } from "@/components/code/code";

/** The smallest useful Code: an identifier. */
export function CodeMinimal() {
  return <Code>public.orders</Code>;
}

/** Codes in DBee's messages: a SQLSTATE, an identifier, a long digest that breaks, output in a samp, plain. */
export function CodeRealistic() {
  return (
    <div className="flex max-w-panel-sm flex-col gap-stack-sm text-body text-fg">
      <p>
        <Code>42P01</Code> relation <Code>public.order_itemz</Code> does not exist.
      </p>
      <p>
        Plugin digest <Code>sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08</Code>
      </p>
      <p>
        The server answered <Code render={<samp />}>SELECT 1204</Code>.
      </p>
      <p className="text-fg-muted">
        Fingerprint <Code variant="plain">SHA256:qL5f…Zr2c</Code>
      </p>
    </div>
  );
}
