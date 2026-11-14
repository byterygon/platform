// The gallery's list of components: one entry per folder in src/components (a test checks it).
// `pnpm ui:new` inserts new entries between the markers, in name order.
import type { ComponentType } from "react";

export interface GalleryEntry {
  name: string;
  load: () => Promise<Record<string, ComponentType>>;
}

export const gallery: GalleryEntry[] = [
  // ui:new entries start
  { name: "button", load: () => import("@/components/button/button.example") },
  { name: "input", load: () => import("@/components/input/input.example") },
  // ui:new entries end
];
