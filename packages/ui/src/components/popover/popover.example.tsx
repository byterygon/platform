import { Button } from "@/components/button/button";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { IconButton } from "@/components/icon-button/icon-button";
import { NumberInput } from "@/components/number-input/number-input";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/popover/popover";
import { Switch } from "@/components/switch/switch";

/** The smallest useful Popover: a few words about a status, attached to it. */
export function PopoverMinimal() {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>Expires in 14 min</PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>Access expires at 14:02</PopoverTitle>
        <PopoverDescription>Sessions drop at expiry. Renew access to keep working on orders-prod.</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}

const SlidersIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M3 4h10M3 8h10M3 12h10" />
    <circle cx="6" cy="4" r="1.5" fill="currentColor" />
    <circle cx="10" cy="8" r="1.5" fill="currentColor" />
    <circle cx="5" cy="12" r="1.5" fill="currentColor" />
  </svg>
);

/** The query toolbar's run options: a small form under an icon button, with its own actions. */
export function PopoverRealistic() {
  return (
    <div className="flex items-center gap-inline-sm">
      <Popover>
        <PopoverTrigger render={<IconButton aria-label="Run options" variant="ghost" />}>
          <SlidersIcon />
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
            <PopoverClose render={<Button variant="ghost" size="sm" />}>Cancel</PopoverClose>
            <PopoverClose render={<Button size="sm" />}>Apply</PopoverClose>
          </div>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger render={<Button variant="secondary" size="sm" />}>Grant</PopoverTrigger>
        <PopoverContent side="right">
          <PopoverDescription>TLS required, verified against the deployment CA bundle.</PopoverDescription>
        </PopoverContent>
      </Popover>
    </div>
  );
}
