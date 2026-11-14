import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/field/field";
import { Switch } from "@/components/switch/switch";

/** The smallest useful Switch: one setting with its label. */
export function SwitchMinimal() {
  return (
    <Field>
      <FieldLabel>
        <Switch />
        Read-only connection
      </FieldLabel>
    </Field>
  );
}

/**
 * Connection settings: switches with descriptions, text before the switch, a setting the workspace
 * locks, and the small and large sizes.
 */
export function SwitchRealistic() {
  return (
    <FieldSet>
      <FieldLegend>Session</FieldLegend>
      <Field>
        <FieldLabel>
          <Switch defaultChecked />
          Auto-commit
        </FieldLabel>
        <FieldDescription>Commit every statement as soon as it runs.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel className="w-full justify-between">
          Keep the connection alive
          <Switch size="sm" />
        </FieldLabel>
      </Field>
      <Field disabled>
        <FieldLabel>
          <Switch defaultChecked />
          Read-only connection
        </FieldLabel>
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel className="text-body">
          <Switch size="lg" />
          Show query plans
        </FieldLabel>
      </Field>
    </FieldSet>
  );
}
