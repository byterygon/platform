import { useState } from "react";
import { Icon } from "@/components/icon/icon";
import { ToggleButton } from "@/components/toggle-button/toggle-button";
import { TextWrap } from "@/lib/icons";

/** The smallest useful ToggleButton: a setting with a visible name. */
export function ToggleButtonMinimal() {
  return <ToggleButton>Show nulls</ToggleButton>;
}

/**
 * An editor toolbar: an icon-only toggle whose icon fills while pressed (Fluent), a pressed one with
 * text, the other appearances and a disabled one, in each size.
 */
export function ToggleButtonRealistic() {
  const [wrap, setWrap] = useState(true);
  return (
    <div className="flex flex-wrap items-center gap-inline-sm">
      <ToggleButton size="small" aria-label="Word wrap" pressed={wrap} onPressedChange={setWrap}>
        <Icon icon={TextWrap} filled={wrap} />
      </ToggleButton>
      <ToggleButton pressed={wrap} onPressedChange={setWrap}>
        <Icon icon={TextWrap} filled={wrap} />
        Word wrap
      </ToggleButton>
      <ToggleButton appearance="secondary" defaultPressed>
        Show nulls
      </ToggleButton>
      <ToggleButton appearance="outline" size="large">
        Read only
      </ToggleButton>
      <ToggleButton appearance="primary">Live</ToggleButton>
      <ToggleButton appearance="transparent" defaultPressed>
        Pinned
      </ToggleButton>
      <ToggleButton disabled>Auto-commit</ToggleButton>
    </div>
  );
}
