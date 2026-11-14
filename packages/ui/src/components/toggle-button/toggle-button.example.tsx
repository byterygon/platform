import { ToggleButton } from "@/components/toggle-button/toggle-button";

const WrapIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8m1.5-1.5L8 13l1.5 1.5M2 12h3" />
  </svg>
);

/** The smallest useful ToggleButton: a setting with a visible name. */
export function ToggleButtonMinimal() {
  return <ToggleButton>Show nulls</ToggleButton>;
}

/** An editor toolbar: an icon-only toggle, a pressed one with text, an outline toggle and a disabled one, in each size. */
export function ToggleButtonRealistic() {
  return (
    <div className="flex flex-wrap items-center gap-inline-sm">
      <ToggleButton size="sm" aria-label="Word wrap">
        <WrapIcon />
      </ToggleButton>
      <ToggleButton defaultPressed>
        <WrapIcon />
        Word wrap
      </ToggleButton>
      <ToggleButton variant="outline" size="lg">
        Read only
      </ToggleButton>
      <ToggleButton disabled>Auto-commit</ToggleButton>
    </div>
  );
}
