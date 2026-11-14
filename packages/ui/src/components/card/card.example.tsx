import { Button } from "@/components/button/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/card/card";

/** The smallest useful Card: a title and a line of content. */
export function CardMinimal() {
  return (
    <Card className="max-w-panel-sm">
      <CardHeader>
        <CardTitle>orders-prod</CardTitle>
      </CardHeader>
      <CardContent>PostgreSQL 17 on db.internal:5432</CardContent>
    </Card>
  );
}

/** Connection cards on a start page: every part, the three variants, and a long name that wraps. */
export function CardRealistic() {
  return (
    <div className="flex flex-wrap items-start gap-gap-lg bg-canvas p-inset-md">
      <Card className="w-panel-sm">
        <CardHeader>
          <CardTitle>orders-prod</CardTitle>
          <CardDescription>Read-only grant, expires in 52 minutes</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm">
              Edit
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-fg-muted">db.internal:5432 · TLS verified · user analyst</p>
        </CardContent>
        <CardFooter>
          <Button size="sm">Connect</Button>
          <Button variant="secondary" size="sm">
            New query
          </Button>
        </CardFooter>
      </Card>
      <Card variant="raised" className="w-panel-sm">
        <CardHeader>
          <CardTitle>analytics_warehouse_replica_eu_central_1_long_name_for_overflow</CardTitle>
          <CardDescription>A name with no spaces wraps inside the card instead of pushing it wider.</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm">
              Edit
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>Raised: lifted off the canvas.</CardContent>
      </Card>
      <Card variant="inset" className="w-panel-xs">
        <CardHeader>
          <CardTitle render={<h4 />}>Inset</CardTitle>
        </CardHeader>
        <CardContent>A quiet group inside another surface.</CardContent>
      </Card>
    </div>
  );
}
