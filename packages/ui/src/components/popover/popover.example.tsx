import { Icon } from "@/components/icon/icon";
import { Button } from "@/components/button/button";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { IconButton } from "@/components/icon-button/icon-button";
import { NumberInput } from "@/components/number-input/number-input";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/popover/popover";
import { Switch } from "@/components/switch/switch";
import { Options } from "@/lib/icons";

/** The smallest useful Popover: a few words about a status, attached to it. */
export function PopoverMinimal() {
  return (
    <Popover>
      <PopoverTrigger render={<Button appearance="subtle" size="small" />}>Expires in 14 min</PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>Access expires at 14:02</PopoverTitle>
        <PopoverDescription>Sessions drop at expiry. Renew access to keep working on orders-prod.</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}

/** The query toolbar's run options: a small form under an icon button, with its own actions. */
export function PopoverRealistic() {
  return (
    <div className="flex items-center gap-inline-sm">
      <Popover>
        <PopoverTrigger render={<IconButton aria-label="Run options" appearance="subtle" />}>
          <Icon icon={Options} />
        </PopoverTrigger>
        <PopoverContent align="start">
          <PopoverTitle>Run options</PopoverTitle>
          <Field>
            <FieldLabel>Row limit</FieldLabel>
            <NumberInput defaultValue={1000} min={1} />
            <FieldDescription>Blank means no limit.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>
              <Switch defaultChecked />
              Confirm destructive statements
            </FieldLabel>
          </Field>
          <div className="flex justify-end gap-inline-sm">
            <PopoverClose render={<Button appearance="subtle" size="small" />}>Cancel</PopoverClose>
            <PopoverClose render={<Button size="small" />}>Apply</PopoverClose>
          </div>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger render={<Button appearance="secondary" size="small" />}>Grant</PopoverTrigger>
        <PopoverContent side="right">
          <PopoverDescription>TLS required, verified against the deployment CA bundle.</PopoverDescription>
        </PopoverContent>
      </Popover>
    </div>
  );
}
