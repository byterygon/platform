import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/accordion/accordion";

/** The smallest useful Accordion: two sections, one open at a time. */
export function AccordionMinimal() {
  return (
    <Accordion className="max-w-panel-md">
      <AccordionItem value="tls">
        <AccordionTrigger>TLS</AccordionTrigger>
        <AccordionPanel>Verify the server certificate against the pinned CA.</AccordionPanel>
      </AccordionItem>
      <AccordionItem value="timeouts">
        <AccordionTrigger>Timeouts</AccordionTrigger>
        <AccordionPanel>Statement timeout 30 s, idle session timeout 10 min.</AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

/** Connection settings in a sheet: outline frame, several open, a disabled section, a long heading. */
export function AccordionRealistic() {
  return (
    <Accordion variant="outline" multiple defaultValue={["network", "grant"]} className="max-w-panel-md">
      <AccordionItem value="network">
        <AccordionTrigger>Network</AccordionTrigger>
        <AccordionPanel>db.internal:5432 through the Plugin Host broker; no other host is reachable.</AccordionPanel>
      </AccordionItem>
      <AccordionItem value="grant">
        <AccordionTrigger>Access grant</AccordionTrigger>
        <AccordionPanel>Read-only, approved 14 Nov 2026 09:12, expires in 52 minutes.</AccordionPanel>
      </AccordionItem>
      <AccordionItem value="audit" disabled>
        <AccordionTrigger>Audit log (available after the first query)</AccordionTrigger>
        <AccordionPanel>Entries</AccordionPanel>
      </AccordionItem>
      <AccordionItem value="advanced">
        <AccordionTrigger>Advanced: application_name, search_path, statement_timeout and other session parameters sent on connect</AccordionTrigger>
        <AccordionPanel>application_name=dbee, search_path=public.</AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
