import { useState } from "react";
import { Field, FieldDescription, FieldError, FieldItem, FieldLabel, FieldLegend } from "@/components/field/field";
import { RadioGroup, RadioGroupItem } from "@/components/radio-group/radio-group";

/** The smallest useful RadioGroup: a named choice of two. */
export function RadioGroupMinimal() {
  return (
    <Field>
      <RadioGroup defaultValue="ssd">
        <FieldLegend>Storage</FieldLegend>
        <FieldItem>
          <FieldLabel>
            <RadioGroupItem value="ssd" />
            SSD
          </FieldLabel>
        </FieldItem>
        <FieldItem>
          <FieldLabel>
            <RadioGroupItem value="hdd" />
            HDD
          </FieldLabel>
        </FieldItem>
      </RadioGroup>
    </Field>
  );
}

const modes = [
  { value: "require", label: "Require", hint: "Encrypt, and fail if the server does not support TLS." },
  { value: "verify-full", label: "Verify full", hint: "Encrypt, and check the certificate and host name." },
  { value: "disable", label: "Disable", hint: "Send everything in clear text." },
];

/**
 * The TLS mode of a connection: a description per option, an option the policy forbids, an error
 * until one is chosen, and the small and large sizes.
 */
export function RadioGroupRealistic() {
  const [mode, setMode] = useState("");
  return (
    <div className="flex flex-col gap-stack-lg">
      <Field name="sslmode" invalid={mode === ""}>
        <RadioGroup value={mode} onValueChange={setMode}>
          <FieldLegend>TLS mode</FieldLegend>
          {modes.map((option) => (
            <FieldItem key={option.value} disabled={option.value === "disable"}>
              <FieldLabel>
                <RadioGroupItem value={option.value} />
                {option.label}
              </FieldLabel>
              <FieldDescription className="ps-inset-lg">{option.hint}</FieldDescription>
            </FieldItem>
          ))}
        </RadioGroup>
        <FieldError>Choose how the connection is encrypted.</FieldError>
      </Field>
      <div className="flex flex-wrap gap-inline-xl">
        <Field>
          <RadioGroup size="sm" defaultValue="lf">
            <FieldLegend>Line endings</FieldLegend>
            <FieldItem>
              <FieldLabel className="text-caption">
                <RadioGroupItem value="lf" />
                LF
              </FieldLabel>
            </FieldItem>
            <FieldItem>
              <FieldLabel className="text-caption">
                <RadioGroupItem value="crlf" />
                CRLF
              </FieldLabel>
            </FieldItem>
          </RadioGroup>
        </Field>
        <Field>
          <RadioGroup size="lg" defaultValue="utf8">
            <FieldLegend>Encoding</FieldLegend>
            <FieldItem>
              <FieldLabel className="text-body">
                <RadioGroupItem value="utf8" />
                UTF-8
              </FieldLabel>
            </FieldItem>
            <FieldItem>
              <FieldLabel className="text-body">
                <RadioGroupItem value="latin1" />
                Latin-1
              </FieldLabel>
            </FieldItem>
          </RadioGroup>
        </Field>
      </div>
    </div>
  );
}
