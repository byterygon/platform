// The gallery's list of components: one entry per folder in src/components (a test checks it).
// `pnpm ui:new` inserts new entries between the markers, in name order.
import type { ComponentType } from "react";

export interface GalleryEntry {
  name: string;
  load: () => Promise<Record<string, ComponentType>>;
}

export const gallery: GalleryEntry[] = [
  // ui:new entries start
  { name: "alert-dialog", load: () => import("@/components/alert-dialog/alert-dialog.example") },
  { name: "button", load: () => import("@/components/button/button.example") },
  { name: "calendar", load: () => import("@/components/calendar/calendar.example") },
  { name: "checkbox", load: () => import("@/components/checkbox/checkbox.example") },
  { name: "combobox", load: () => import("@/components/combobox/combobox.example") },
  { name: "date-picker", load: () => import("@/components/date-picker/date-picker.example") },
  { name: "dialog", load: () => import("@/components/dialog/dialog.example") },
  { name: "field", load: () => import("@/components/field/field.example") },
  { name: "file-input", load: () => import("@/components/file-input/file-input.example") },
  { name: "form", load: () => import("@/components/form/form.example") },
  { name: "icon-button", load: () => import("@/components/icon-button/icon-button.example") },
  { name: "input", load: () => import("@/components/input/input.example") },
  { name: "input-group", load: () => import("@/components/input-group/input-group.example") },
  { name: "kbd", load: () => import("@/components/kbd/kbd.example") },
  { name: "multi-select", load: () => import("@/components/multi-select/multi-select.example") },
  { name: "number-input", load: () => import("@/components/number-input/number-input.example") },
  { name: "password-input", load: () => import("@/components/password-input/password-input.example") },
  { name: "popover", load: () => import("@/components/popover/popover.example") },
  { name: "radio-group", load: () => import("@/components/radio-group/radio-group.example") },
  { name: "search-input", load: () => import("@/components/search-input/search-input.example") },
  { name: "select", load: () => import("@/components/select/select.example") },
  { name: "sheet", load: () => import("@/components/sheet/sheet.example") },
  { name: "slider", load: () => import("@/components/slider/slider.example") },
  { name: "switch", load: () => import("@/components/switch/switch.example") },
  { name: "textarea", load: () => import("@/components/textarea/textarea.example") },
  { name: "time-picker", load: () => import("@/components/time-picker/time-picker.example") },
  { name: "toggle-button", load: () => import("@/components/toggle-button/toggle-button.example") },
  { name: "toggle-group", load: () => import("@/components/toggle-group/toggle-group.example") },
  { name: "tooltip", load: () => import("@/components/tooltip/tooltip.example") },
  // ui:new entries end
];
