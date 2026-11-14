import { useState } from "react";
import { Stepper, type Step } from "@/components/stepper/stepper";

const connectionSteps: Step[] = [{ title: "Connection details" }, { title: "Approve access" }, { title: "Connect" }];

/** The smallest useful Stepper: three steps, the second current. */
export function StepperMinimal() {
  return <Stepper steps={connectionSteps} value={1} aria-label="New connection" />;
}

/**
 * The first run in a side panel (vertical, descriptions, completed steps clickable to go back) and
 * a row where the connection attempt failed.
 */
export function StepperRealistic() {
  const [value, setValue] = useState(2);
  const firstRun: Step[] = [
    { title: "Add a connection", description: "Host, database, user" },
    { title: "Approve access", description: "TLS and allowed addresses" },
    { title: "Connect", description: "Open a session" },
    { title: "Run a query", description: "Ctrl+Enter" },
  ];
  const failed: Step[] = [{ title: "Connection details" }, { title: "Approve access" }, { title: "Connect", error: true }];
  return (
    <div className="flex w-full flex-col gap-stack-lg">
      <Stepper steps={firstRun} value={value} onValueChange={setValue} orientation="vertical" aria-label="First run" />
      <Stepper steps={failed} value={2} aria-label="Reconnect orders-prod" />
    </div>
  );
}
