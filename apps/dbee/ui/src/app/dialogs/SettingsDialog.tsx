// Settings (DBee spec §3.9): Appearance, Editor and Advanced tabs. No telemetry toggle exists
// because there is no telemetry.
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldItem, FieldLabel, FieldLegend } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AppInfo } from "@/gen/api";
import type { Settings } from "../persistence";
import { PRESETS, PRESET_LABELS, type Preset } from "../presets";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  info: AppInfo | null;
  /** The desktop shell applied a window material (Windows 11), so the setting does something. */
  materialAvailable?: boolean;
  onOpenDiagnostics: () => void;
}

export function SettingsDialog({ open, onOpenChange, settings, onChange, info, materialAvailable = false, onOpenDiagnostics }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Changes apply at once and are kept across restarts.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs defaultValue="appearance">
            <TabsList>
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
              <TabsTrigger value="editor">Editor</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>
            <TabsContent value="appearance" className="flex flex-col gap-stack-md pt-inset-md">
              <Field>
                <FieldLabel>Theme preset</FieldLabel>
                <Select items={Object.fromEntries(PRESETS.map((p) => [p, PRESET_LABELS[p]]))} value={settings.preset} onValueChange={(v) => v && onChange({ preset: v as Preset })}>
                  {PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRESET_LABELS[p]}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              <Field>
                <RadioGroup value={settings.colorScheme} onValueChange={(v) => onChange({ colorScheme: v as Settings["colorScheme"] })}>
                  <FieldLegend>Colour scheme</FieldLegend>
                  <FieldItem>
                    <FieldLabel>
                      <RadioGroupItem value="system" /> Follow the system
                    </FieldLabel>
                  </FieldItem>
                  <FieldItem>
                    <FieldLabel>
                      <RadioGroupItem value="light" /> Light
                    </FieldLabel>
                  </FieldItem>
                  <FieldItem>
                    <FieldLabel>
                      <RadioGroupItem value="dark" /> Dark
                    </FieldLabel>
                  </FieldItem>
                </RadioGroup>
              </Field>
              <Field>
                <FieldLabel id="density-label">Density</FieldLabel>
                <ToggleGroup aria-label="Density" value={[settings.density]} onValueChange={(v) => v[0] && onChange({ density: v[0] as Settings["density"] })}>
                  <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
                  <ToggleGroupItem value="comfortable">Comfortable</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              {materialAvailable && (
                <Field>
                  <FieldLabel>
                    <Switch checked={settings.windowMaterial} onCheckedChange={(v) => onChange({ windowMaterial: v })} /> Window material (Mica)
                  </FieldLabel>
                  <FieldDescription>Shows the Windows 11 material through the Aurora theme. Turning it off applies at once; turning it on again after starting without it needs a restart.</FieldDescription>
                </Field>
              )}
              <div className="grid grid-cols-2 gap-gap-md">
                <Field>
                  <FieldLabel>Editor font size</FieldLabel>
                  <NumberInput value={settings.editorFontSize} onValueChange={(v) => v !== null && onChange({ editorFontSize: v })} min={9} max={32} />
                </Field>
                <Field>
                  <FieldLabel>Grid font size</FieldLabel>
                  <NumberInput value={settings.gridFontSize} onValueChange={(v) => v !== null && onChange({ gridFontSize: v })} min={9} max={32} />
                </Field>
              </div>
            </TabsContent>
            <TabsContent value="editor" className="flex flex-col gap-stack-md pt-inset-md">
              <Field>
                <FieldLabel>Tab size</FieldLabel>
                <NumberInput value={settings.tabSize} onValueChange={(v) => v !== null && onChange({ tabSize: v })} min={1} max={8} />
              </Field>
              <Field>
                <FieldLabel>
                  <Switch checked={settings.wordWrap} onCheckedChange={(v) => onChange({ wordWrap: v })} /> Word wrap
                </FieldLabel>
              </Field>
              <Field>
                <FieldLabel>
                  <Switch checked readOnly /> Confirm destructive statements
                </FieldLabel>
                <FieldDescription>Always on in this version; the server classifies and authorizes on its own regardless.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>
                  <Switch checked={settings.screenReaderOptimized} onCheckedChange={(v) => onChange({ screenReaderOptimized: v })} /> Screen reader optimised editor
                </FieldLabel>
                <FieldDescription>Minimap is off; this turns on Monaco's screen reader mode instead of detecting one.</FieldDescription>
              </Field>
            </TabsContent>
            <TabsContent value="advanced" className="flex flex-col gap-stack-md pt-inset-md">
              <Field>
                <FieldLabel>Workspace path</FieldLabel>
                <Code>{info?.workspacePath ?? "…"}</Code>
                <FieldDescription>Read-only: connections (never passwords), settings and tabs of the core.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Audit log path</FieldLabel>
                <Code>{info?.auditLogPath ?? "…"}</Code>
              </Field>
              <Field>
                <FieldLabel>Secret store</FieldLabel>
                <span className="text-body text-fg">{info?.secretStore === "keychain" ? "OS keychain" : "Session only"}</span>
                {info?.secretStoreNote ? <FieldDescription>{info.secretStoreNote}</FieldDescription> : null}
              </Field>
              <div>
                <Button appearance="secondary" onClick={onOpenDiagnostics}>
                  Open diagnostics
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button appearance="primary" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
