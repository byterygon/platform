import { useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { Slider } from "@/components/slider/slider";

/** The smallest useful Slider: a labelled value between 0 and 100. */
export function SliderMinimal() {
  return (
    <Field className="w-full">
      <FieldLabel>Sample rate</FieldLabel>
      <Slider defaultValue={25} />
    </Field>
  );
}

/**
 * Query tuning: a sample size with its value shown, a range of row lengths with two named thumbs,
 * a disabled slider, and the small and large thumbs.
 */
export function SliderRealistic() {
  const [sample, setSample] = useState(10);
  const [range, setRange] = useState([20, 80]);
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <Field name="sample">
        <FieldLabel>Sample size: {sample}%</FieldLabel>
        <Slider value={sample} onValueChange={(value) => setSample(value as number)} min={1} max={100} />
        <FieldDescription>Percentage of rows read for the preview.</FieldDescription>
      </Field>
      <Field name="length">
        <FieldLabel>
          Row length: {range[0]} to {range[1]} bytes
        </FieldLabel>
        <Slider
          size="lg"
          value={range}
          onValueChange={(value) => setRange(value as number[])}
          step={10}
          minStepsBetweenValues={1}
          getAriaLabel={(index) => (index === 0 ? "Minimum length" : "Maximum length")}
        />
      </Field>
      <Field name="parallel" disabled>
        <FieldLabel>Parallel workers</FieldLabel>
        <Slider size="sm" defaultValue={4} max={16} />
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
    </div>
  );
}
