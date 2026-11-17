// Settings (DBee spec §3.9): Appearance, Editor and Advanced as vertical tabs, one setting per row
// (TSK-64 mockup screen 6). No telemetry toggle exists because there is no telemetry.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Code as CodeText } from "@/components/ui/code";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AppInfo } from "@/gen/api";
import { Code, Eye, type IconDefinition, List, PanelBottom, Shield, Star, Table, TextNumberFormat, TextT, TextWrap, Warning, Window } from "@/lib/icons";
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

/**
 * One setting per row (TSK-64, the Windows 11 Settings pattern): an icon, the name and a line of
 * explanation, the control at the end. A Field, so the label and description reach the control.
 */
function SettingRow({ icon, label, description, children, labelWraps = false }: { icon: IconDefinition; label: string; description?: ReactNode; children: ReactNode; labelWraps?: boolean }) {
  return (
    <Field className="flex-row items-center gap-inline-lg rounded-md border border-border-subtle bg-layer-alt px-inset-md py-inset-sm">
      <Icon icon={icon} size="lg" tone="muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
        {labelWraps ? (
          <FieldLabel className="flex items-center justify-between gap-inline-lg">
            <span>{label}</span>
            {children}
          </FieldLabel>
        ) : (
          <FieldLabel>{label}</FieldLabel>
        )}
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </div>
      {labelWraps ? null : children}
    </Field>
  );
}

export function SettingsDialog({ open, onOpenChange, settings, onChange, info, materialAvailable = false, onOpenDiagnostics }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Changes apply at once and are kept across restarts.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs defaultValue="appearance" orientation="vertical" className="min-h-panel-sm gap-gap-lg">
            <TabsList className="shrink-0">
              <TabsTrigger value="appearance" icon={<Icon icon={Window} />}>
                Appearance
              </TabsTrigger>
              <TabsTrigger value="editor" icon={<Icon icon={Code} />}>
                Editor
              </TabsTrigger>
              <TabsTrigger value="advanced" icon={<Icon icon={Shield} />}>
                Advanced
              </TabsTrigger>
            </TabsList>
            <TabsContent value="appearance" className="flex flex-col gap-stack-xs">
              <SettingRow icon={Star} label="Theme preset" description="Aurora is the default; the others change colour and type.">
                <Select className="w-panel-xs" items={Object.fromEntries(PRESETS.map((p) => [p, PRESET_LABELS[p]]))} value={settings.preset} onValueChange={(v) => v && onChange({ preset: v as Preset })}>
                  {PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRESET_LABELS[p]}
                    </SelectItem>
                  ))}
                </Select>
              </SettingRow>
              <SettingRow icon={Window} label="Colour scheme" description="System follows the operating system.">
                <ToggleGroup aria-label="Colour scheme" value={[settings.colorScheme]} onValueChange={(v) => v[0] && onChange({ colorScheme: v[0] as Settings["colorScheme"] })}>
                  <ToggleGroupItem value="system">System</ToggleGroupItem>
                  <ToggleGroupItem value="light">Light</ToggleGroupItem>
                  <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              <SettingRow icon={List} label="Density" description="Comfortable uses Fluent's medium sizes; compact fits more rows.">
                <ToggleGroup aria-label="Density" value={[settings.density]} onValueChange={(v) => v[0] && onChange({ density: v[0] as Settings["density"] })}>
                  <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
                  <ToggleGroupItem value="comfortable">Comfortable</ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              <SettingRow icon={TextT} label="Editor font size">
                {/* eslint-disable-next-line byterygon/no-arbitrary-value -- two digits and the steppers: a width in characters, which no token measures */}
                <NumberInput className="w-[14ch]" value={settings.editorFontSize} onValueChange={(v) => v !== null && onChange({ editorFontSize: v })} min={9} max={32} />
              </SettingRow>
              <SettingRow icon={Table} label="Grid font size">
                {/* eslint-disable-next-line byterygon/no-arbitrary-value -- two digits and the steppers: a width in characters, which no token measures */}
                <NumberInput className="w-[14ch]" value={settings.gridFontSize} onValueChange={(v) => v !== null && onChange({ gridFontSize: v })} min={9} max={32} />
              </SettingRow>
              {materialAvailable && (
                <SettingRow icon={PanelBottom} label="Window material (Mica)" description="Shows the Windows 11 material through the Aurora theme. Turning it off applies at once; turning it on again after starting without it needs a restart." labelWraps>
                  <Switch checked={settings.windowMaterial} onCheckedChange={(v) => onChange({ windowMaterial: v })} />
                </SettingRow>
              )}
            </TabsContent>
            <TabsContent value="editor" className="flex flex-col gap-stack-xs">
              <SettingRow icon={TextNumberFormat} label="Tab size">
                {/* eslint-disable-next-line byterygon/no-arbitrary-value -- one digit and the steppers: a width in characters, which no token measures */}
                <NumberInput className="w-[14ch]" value={settings.tabSize} onValueChange={(v) => v !== null && onChange({ tabSize: v })} min={1} max={8} />
              </SettingRow>
              <SettingRow icon={TextWrap} label="Word wrap" labelWraps>
                <Switch checked={settings.wordWrap} onCheckedChange={(v) => onChange({ wordWrap: v })} />
              </SettingRow>
              <SettingRow icon={Warning} label="Confirm destructive statements" description="Always on in this version; the server classifies and authorizes on its own regardless." labelWraps>
                <Switch checked readOnly />
              </SettingRow>
              <SettingRow icon={Eye} label="Screen reader optimised editor" description="Minimap is off; this turns on Monaco's screen reader mode instead of detecting one." labelWraps>
                <Switch checked={settings.screenReaderOptimized} onCheckedChange={(v) => onChange({ screenReaderOptimized: v })} />
              </SettingRow>
            </TabsContent>
            <TabsContent value="advanced" className="flex flex-col gap-stack-md">
              <Field>
                <FieldLabel>Workspace path</FieldLabel>
                <CodeText>{info?.workspacePath ?? "…"}</CodeText>
                <FieldDescription>Read-only: connections (never passwords), settings and tabs of the core.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Audit log path</FieldLabel>
                <CodeText>{info?.auditLogPath ?? "…"}</CodeText>
              </Field>
              <Field>
                <FieldLabel>Secret store</FieldLabel>
                <span className="text-body-1 text-fg">{info?.secretStore === "keychain" ? "OS keychain" : "Session only"}</span>
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
