import { useState } from "react";
import { Tag, TagGroup } from "@/components/tag/tag";

/** The smallest useful Tag. */
export function TagMinimal() {
  return <Tag>reporting</Tag>;
}

const initial = [
  { label: "reporting", swatch: 1 },
  { label: "finance", swatch: 2 },
  { label: "nightly", swatch: 3 },
  { label: "customer_lifetime_value_by_region", swatch: 4 },
] as const;

/** A saved query's labels: removable with swatches, an accent tag, a disabled one, a long label that truncates. */
export function TagRealistic() {
  const [tags, setTags] = useState<readonly { label: string; swatch: 1 | 2 | 3 | 4 }[]>(initial);
  return (
    <div className="flex max-w-panel-sm flex-col gap-stack-sm">
      <TagGroup aria-label="Labels">
        {tags.map((tag) => (
          <Tag key={tag.label} role="listitem" swatch={tag.swatch} onRemove={() => setTags((list) => list.filter((t) => t.label !== tag.label))}>
            {tag.label}
          </Tag>
        ))}
      </TagGroup>
      <TagGroup aria-label="Categories">
        {([1, 2, 3, 4, 5, 6, 7, 8] as const).map((swatch) => (
          <Tag key={swatch} role="listitem" swatch={swatch}>
            {`team ${swatch}`}
          </Tag>
        ))}
      </TagGroup>
      <TagGroup aria-label="Filters">
        <Tag role="listitem" variant="accent" size="md" onRemove={() => {}}>
          status = open
        </Tag>
        <Tag role="listitem" size="md" disabled onRemove={() => {}}>
          owner = me
        </Tag>
        <Tag role="listitem" size="md">
          read-only
        </Tag>
      </TagGroup>
    </div>
  );
}
