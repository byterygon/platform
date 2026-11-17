// An error as DBee spec §8 shows it: the message from the error code and its typed details, the
// SQLSTATE and position when there are, the correlation id behind a Details disclosure (to match
// the audit log), and the remedy as a button. Used by the results panel and, for a failed
// connect, under the connections tree.
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import type { Described } from "./messages";

export interface ErrorAlertProps {
  error: Described;
  onRemedy?: ((remedy: string) => void) | undefined;
  className?: string;
}

export function ErrorAlert({ error, onRemedy, className }: ErrorAlertProps) {
  return (
    <Alert variant="danger" {...(className ? { className } : {})}>
      <AlertTitle>{error.title}</AlertTitle>
      <AlertDescription>
        {error.description ? <span>{error.description} </span> : null}
        {error.sqlstate ? (
          <span>
            SQLSTATE <Code>{error.sqlstate}</Code>{" "}
          </span>
        ) : null}
        {error.position !== undefined ? <span>at position {error.position} </span> : null}
        {error.correlationId ? (
          <details className="inline">
            <summary className="inline cursor-pointer text-fg-link">Details</summary> Correlation id <Code>{error.correlationId}</Code>
          </details>
        ) : null}
      </AlertDescription>
      {error.remedy && onRemedy ? (
        <AlertActions>
          <Button size="small" appearance="secondary" onClick={() => onRemedy(error.remedy!)}>
            {error.remedyLabel}
          </Button>
        </AlertActions>
      ) : null}
    </Alert>
  );
}
