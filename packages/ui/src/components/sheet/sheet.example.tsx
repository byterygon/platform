import { Button } from "@/components/button/button";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { NumberInput } from "@/components/number-input/number-input";
import { PasswordInput } from "@/components/password-input/password-input";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/sheet/sheet";
import { Switch } from "@/components/switch/switch";

/** The smallest useful Sheet: a cell's full value beside the grid. */
export function SheetMinimal() {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="secondary" />}>Open cell value</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>orders.notes</SheetTitle>
          <SheetDescription>text, row 128</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <p className="font-mono text-code text-fg">Customer asked for delivery after 18:00; gate code 4411.</p>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/**
 * DBee's sheets: the connection form on the right (lg, a scrolling body of Fields and a footer),
 * a narrow filter panel on the left (sm), and a notices strip from the bottom.
 */
export function SheetRealistic() {
  return (
    <div className="flex flex-wrap items-center gap-inline-sm">
      <Sheet size="lg">
        <SheetTrigger render={<Button />}>Add connection</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New connection</SheetTitle>
            <SheetDescription>The password is stored in the OS keychain. Nothing connects before you approve access.</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input defaultValue="orders-prod" />
            </Field>
            <Field>
              <FieldLabel>Host</FieldLabel>
              <Input placeholder="db.internal" />
            </Field>
            <Field>
              <FieldLabel>Port</FieldLabel>
              <NumberInput defaultValue={5432} format={{ useGrouping: false }} />
            </Field>
            <Field>
              <FieldLabel>Password</FieldLabel>
              <PasswordInput />
              <FieldDescription>Optional: trust authentication needs none.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>
                <Switch defaultChecked />
                Allow cancel connection
              </FieldLabel>
            </Field>
          </SheetBody>
          <SheetFooter>
            <SheetClose render={<Button variant="ghost" />}>Cancel</SheetClose>
            <Button>Continue</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet side="left" size="sm">
        <SheetTrigger render={<Button variant="ghost" />}>Filters</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Filter the tree</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <Field>
              <FieldLabel>
                <Switch />
                Show system schemas
              </FieldLabel>
            </Field>
          </SheetBody>
        </SheetContent>
      </Sheet>

      <Sheet side="bottom">
        <SheetTrigger render={<Button variant="ghost" />}>Notices (2)</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Notices</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <p className="text-body text-fg">NOTICE: table “tmp_orders” does not exist, skipping</p>
          </SheetBody>
        </SheetContent>
      </Sheet>

      <Sheet side="top">
        <SheetTrigger render={<Button variant="ghost" />}>Find in workspace</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Find in workspace</SheetTitle>
          </SheetHeader>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input placeholder="Table, view or column" />
          </Field>
        </SheetContent>
      </Sheet>
    </div>
  );
}
