// The resize handles of the shell (TSK-64): between layers, in the gap.
/**
 * A resize handle in the gap between two layers: transparent, as wide as `space.gap.sm`, with the
 * grip as the visible part (the component's default is a 1 px rule between flush panels).
 */
export const gapHandle =
  "bg-transparent hover:bg-transparent focus-visible:bg-transparent data-dragging:bg-transparent data-[orientation=horizontal]:w-gap-sm data-[orientation=vertical]:h-gap-sm hover:[&>span]:bg-border-focus data-dragging:[&>span]:bg-border-focus";

