import { useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/alert/alert";
import { Button } from "@/components/button/button";

/** The smallest useful Alert: a title and a sentence. */
export function AlertMinimal() {
  return (
    <Alert variant="info">
      <AlertTitle>Read-only connection</AlertTitle>
      <AlertDescription>Statements that write are refused.</AlertDescription>
    </Alert>
  );
}

/** A query error with SQLSTATE and Retry, a plaintext warning, the other tones, and a dismissible banner. */
export function AlertRealistic() {
  const [banner, setBanner] = useState(true);
  return (
    <div className="flex max-w-panel-lg flex-col gap-stack-sm">
      {banner ? (
        <Alert variant="warning" layout="banner" onDismiss={() => setBanner(false)} dismissLabel="Dismiss expiry warning">
          <AlertDescription>Access to orders-prod expires in 15 minutes. Ask for a new grant before then.</AlertDescription>
        </Alert>
      ) : null}
      <Alert variant="danger">
        <AlertTitle>Query failed</AlertTitle>
        <AlertDescription>
          <code>42P01</code> relation &quot;public.order_itemz&quot; does not exist at line 3, column 15. Check the table name or refresh the schema.
        </AlertDescription>
        <AlertActions>
          <Button size="sm" variant="secondary">
            Refresh schema
          </Button>
        </AlertActions>
      </Alert>
      <Alert variant="warning">
        <AlertTitle>Plaintext connection</AlertTitle>
        <AlertDescription>Without TLS, the password and every row cross the network unencrypted.</AlertDescription>
      </Alert>
      <Alert variant="success">
        <AlertDescription>Exported 1,000,000 rows to orders.csv.</AlertDescription>
      </Alert>
      <Alert variant="neutral" icon={false}>
        <AlertDescription>A_very_long_identifier_without_spaces_public.customer_lifetime_value_by_region_and_month_partition_2026_11 wraps.</AlertDescription>
      </Alert>
    </div>
  );
}
