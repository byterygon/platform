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
  { name: "checkbox", load: () => import("@/components/checkbox/checkbox.example") },
  { name: "field", load: () => import("@/components/field/field.example") },
  { name: "form", load: () => import("@/components/form/form.example") },
  { name: "icon-button", load: () => import("@/components/icon-button/icon-button.example") },
  { name: "input", load: () => import("@/components/input/input.example") },
  { name: "input-group", load: () => import("@/components/input-group/input-group.example") },
  { name: "kbd", load: () => import("@/components/kbd/kbd.example") },
  { name: "radio-group", load: () => import("@/components/radio-group/radio-group.example") },
  { name: "switch", load: () => import("@/components/switch/switch.example") },
  { name: "textarea", load: () => import("@/components/textarea/textarea.example") },
  { name: "toggle-button", load: () => import("@/components/toggle-button/toggle-button.example") },
  { name: "toggle-group", load: () => import("@/components/toggle-group/toggle-group.example") },
  // ui:new entries end
];
