import { Badge } from "@/components/badge/badge";

/** The smallest useful Badge. */
export function BadgeMinimal() {
  return <Badge>read-only</Badge>;
}

const tones = ["neutral", "accent", "danger", "warning", "success", "info"] as const;
const appearances = ["subtle", "solid", "outline", "dot"] as const;

/** Every tone in every appearance; DBee's connection states as dots; a long label that truncates. */
export function BadgeRealistic() {
  return (
    <div className="flex max-w-panel-lg flex-col gap-stack-sm text-body text-fg">
      {appearances.map((appearance) => (
        <div key={appearance} className="flex flex-wrap items-center gap-inline-sm">
          {tones.map((tone) => (
            <Badge key={tone} variant={tone} appearance={appearance}>
              {tone}
            </Badge>
          ))}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-inline-md">
        <Badge variant="success" appearance="dot" size="md">
          connected
        </Badge>
        <Badge variant="neutral" appearance="dot" size="md">
          disconnected
        </Badge>
        <Badge variant="danger" appearance="solid" size="md">
          plaintext
        </Badge>
        <Badge variant="accent" size="md">
          first-party
        </Badge>
      </div>
      <div className="flex w-panel-xs items-center gap-inline-sm">
        <span className="truncate">orders</span>
        <Badge variant="info" className="min-w-0">
          partitioned by created_at, 48 partitions, 3 detached
        </Badge>
      </div>
    </div>
  );
}
