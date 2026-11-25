// Settings (Mightyconsole spec §3.6): Appearance, Live views, Profiles and Advanced, one setting
// per row as in DBee's Settings (TSK-64). "Forget everything in this browser" deletes the IndexedDB
// database after the user types FORGET.
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArrowExport, ArrowImport, Delete, Filter, Flash, type IconDefinition, List, Server, Star, TextT, Window } from "@/lib/icons";
import { PRESETS, PRESET_LABELS, type Preset } from "../presets";
import type { Settings } from "../store";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  serverAddress: string;
  storageKind: "indexeddb" | "memory";
  profileCount: number;
  storageUsed: () => Promise<number | null>;
  onExportAll: () => void;
  onImport: () => void;
  onForgetEverything: () => Promise<void>;
}

function SettingRow({ icon, label, description, children }: { icon: IconDefinition; label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Field orientation="horizontal" className="gap-inline-lg rounded-md border border-border-subtle bg-layer-alt px-inset-md py-inset-sm">
      <Icon icon={icon} size="lg" tone="muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
        <FieldLabel>{label}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </div>
      {children}
    </Field>
  );
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onOpenChange, settings, onChange } = props;
  const [used, setUsed] = useState<number | null>(null);
  const [confirm, setConfirm] = useState("");
  const [forgetting, setForgetting] = useState(false);
  useEffect(() => {
    if (!open) return;
    setConfirm("");
    void props.storageUsed().then(setUsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Changes apply at once and are kept in this browser.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs defaultValue="appearance" orientation="vertical" className="min-h-panel-xs">
            <TabsList aria-label="Settings sections">
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
              <TabsTrigger value="live">Live views</TabsTrigger>
              <TabsTrigger value="profiles">Profiles</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>
            <TabsContent value="appearance" className="flex flex-col gap-stack-sm">
              <SettingRow icon={Star} label="Theme" description="The token preset; Aurora is the Fluent 2 look.">
                <Select aria-label="Theme" value={settings.preset} onValueChange={(v) => onChange({ preset: v as Preset })} className="w-panel-xs">
                  {PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRESET_LABELS[p]}
                    </SelectItem>
                  ))}
                </Select>
              </SettingRow>
              <SettingRow icon={Window} label="Colour scheme">
                <ToggleGroup aria-label="Colour scheme" value={[settings.colorScheme]} onValueChange={(v) => v[0] && onChange({ colorScheme: v[0] as Settings["colorScheme"] })}>
                  <ToggleGroupItem value="system">System</ToggleGroupItem>
                  <ToggleGroupItem value="light">Light</ToggleGroupItem>
                  <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              <SettingRow icon={List} label="Density" description="Comfortable is Fluent's default; compact fits more rows.">
                <ToggleGroup aria-label="Density" value={[settings.density]} onValueChange={(v) => v[0] && onChange({ density: v[0] as Settings["density"] })}>
                  <ToggleGroupItem value="comfortable">Comfortable</ToggleGroupItem>
                  <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
                </ToggleGroup>
              </SettingRow>
              <SettingRow icon={TextT} label="Editor font size">
                <NumberInput aria-label="Editor font size" value={settings.editorFontSize} min={9} max={32} onValueChange={(v) => v !== null && onChange({ editorFontSize: v })} className="w-panel-xs" />
              </SettingRow>
            </TabsContent>
            <TabsContent value="live" className="flex flex-col gap-stack-sm">
              <SettingRow icon={Flash} label="Messages kept in a live view" description="Older ones are dropped from the view.">
                <NumberInput aria-label="Messages kept in a live view" value={settings.liveBuffer} min={100} max={1_000_000} step={1000} onValueChange={(v) => v !== null && onChange({ liveBuffer: v })} className="w-panel-xs" />
              </SettingRow>
              <SettingRow icon={List} label="Lines kept in a log view">
                <NumberInput aria-label="Lines kept in a log view" value={settings.logBuffer} min={1000} max={1_000_000} step={1000} onValueChange={(v) => v !== null && onChange({ logBuffer: v })} className="w-panel-xs" />
              </SettingRow>
              <SettingRow icon={ArrowImport} label="Messages a consume reads by default">
                <NumberInput aria-label="Messages a consume reads by default" value={settings.consumeLimit} min={1} max={100_000} onValueChange={(v) => v !== null && onChange({ consumeLimit: v })} className="w-panel-xs" />
              </SettingRow>
              <SettingRow icon={Server} label="Time limit of a jq query, in seconds" description="The server stops a query that runs longer (0.5 to 30 s).">
                <NumberInput aria-label="Time limit of a jq query, in seconds" value={settings.jqTimeoutMs / 1000} min={0.5} max={30} step={0.5} onValueChange={(v) => v !== null && onChange({ jqTimeoutMs: Math.round(Math.min(30, Math.max(0.5, v)) * 1000) })} className="w-panel-xs" />
              </SettingRow>
              <SettingRow icon={Filter} label="Time limit of the filter's jq on one message, in seconds" description="A live view's filter is stopped on a message it runs on longer; the message counts as a decode error (0.5 to 30 s).">
                <NumberInput aria-label="Time limit of the filter's jq on one message, in seconds" value={settings.jqFilterTimeoutMs / 1000} min={0.5} max={30} step={0.5} onValueChange={(v) => v !== null && onChange({ jqFilterTimeoutMs: Math.round(Math.min(30, Math.max(0.5, v)) * 1000) })} className="w-panel-xs" />
              </SettingRow>
            </TabsContent>
            <TabsContent value="profiles" className="flex flex-col gap-stack-sm">
              <SettingRow icon={ArrowExport} label="Export all profiles" description={`${props.profileCount} profiles in this browser${used !== null ? `, ${Math.ceil(used / 1024)} KiB stored` : ""}.`}>
                <Button onClick={props.onExportAll} disabled={props.profileCount === 0}>
                  Export…
                </Button>
              </SettingRow>
              <SettingRow icon={ArrowImport} label="Import profiles" description="From a file another browser exported.">
                <Button onClick={props.onImport}>Import…</Button>
              </SettingRow>
            </TabsContent>
            <TabsContent value="advanced" className="flex flex-col gap-stack-sm">
              <SettingRow icon={Server} label="Server" description={props.storageKind === "memory" ? "Profiles are kept in memory only: this browser refused IndexedDB." : "Profiles are kept in this browser's IndexedDB."}>
                <span className="text-body-1 text-fg">{props.serverAddress}</span>
              </SettingRow>
              <Field className="flex flex-col gap-stack-sm rounded-md border border-border-subtle bg-layer-alt px-inset-md py-inset-sm">
                <div className="flex items-center gap-inline-lg">
                  <Icon icon={Delete} size="lg" tone="danger" />
                  <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
                    <FieldLabel>Forget everything in this browser</FieldLabel>
                    <FieldDescription>Deletes every profile, secret, tab and setting stored here. Type FORGET to confirm.</FieldDescription>
                  </div>
                </div>
                <div className="flex items-center gap-inline-sm">
                  <Input aria-label="Type FORGET to confirm" value={confirm} onValueChange={setConfirm} autoComplete="off" />
                  <Button
                    appearance="danger"
                    disabled={confirm !== "FORGET"}
                    loading={forgetting}
                    onClick={() => {
                      setForgetting(true);
                      void props.onForgetEverything().finally(() => setForgetting(false));
                    }}
                  >
                    Forget everything
                  </Button>
                </div>
              </Field>
            </TabsContent>
          </Tabs>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button appearance="primary" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
