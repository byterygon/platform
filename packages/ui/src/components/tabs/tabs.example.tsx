import { Icon } from "@/components/icon/icon";
import { useState } from "react";
import { IconButton } from "@/components/icon-button/icon-button";
import { Badge } from "@/components/badge/badge";
import { Tabs, TabsContent, TabsLabel, TabsList, TabsTrigger } from "@/components/tabs/tabs";
import { Add, Clock, Flash } from "@/lib/icons";

/** The smallest useful Tabs: the sections of the Settings dialog. */
export function TabsMinimal() {
  return (
    <Tabs defaultValue="appearance" className="w-full">
      <TabsList>
        <TabsTrigger value="appearance">Appearance</TabsTrigger>
        <TabsTrigger value="editor">Editor</TabsTrigger>
        <TabsTrigger value="advanced">Advanced</TabsTrigger>
      </TabsList>
      <TabsContent value="appearance" className="text-body text-fg">
        Theme preset, colour scheme and density.
      </TabsContent>
      <TabsContent value="editor" className="text-body text-fg">
        Tab size, word wrap.
      </TabsContent>
      <TabsContent value="advanced" className="text-body text-fg">
        Workspace and audit log paths.
      </TabsContent>
    </Tabs>
  );
}

interface QueryTab {
  id: string;
  title: string;
  modified?: boolean;
  running?: boolean;
}

const ModifiedDot = () => <span aria-label="modified" role="img" className="size-icon-xs shrink-0 rounded-full bg-fg-muted" />;
const RunningDot = () => <span aria-label="running" role="img" className="size-icon-xs shrink-0 rounded-full bg-accent-compound" />;

const PlusIcon = () => <Icon icon={Add} />;

/**
 * DBee's query tabs: enclosed and small, each closable (the button, or Delete) and reorderable
 * (drag, or Alt+Shift+Arrow), with a status before the title and a disabled tab; below them the
 * results' tabs, each with its count in its own badge (`count`): neutral by default, a tone for
 * what needs attention, a count of 0 hidden unless asked for, a large one shortened (48k). Then a
 * strip grouped by tool, as Mightyconsole's: the open group's heading (TabsLabel) and tabs, and a
 * folded group's chip that never goes into "More tabs" (keepVisible).
 */
export function TabsRealistic() {
  return (
    <div className="flex w-full flex-col gap-stack-lg">
      <QueryTabs />
      <GroupedTabs />
    </div>
  );
}

function QueryTabs() {
  const [tabs, setTabs] = useState<QueryTab[]>([
    { id: "q1", title: "select * from orders limit 1000;", running: true },
    { id: "q2", title: "Orders by region", modified: true },
    { id: "q3", title: "Query 3" },
  ]);
  const [active, setActive] = useState<string>("q1");
  const [next, setNext] = useState(4);

  const close = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const rest = current.filter((tab) => tab.id !== id);
      if (id === active && rest.length > 0) setActive(rest[Math.min(index, rest.length - 1)]!.id);
      return rest;
    });
  };
  const reorder = (id: string | number, index: number) => {
    setTabs((current) => {
      const moving = current.find((tab) => tab.id === id)!;
      const rest = current.filter((tab) => tab.id !== id);
      return [...rest.slice(0, index), moving, ...rest.slice(index)];
    });
  };
  const add = () => {
    const id = `q${next}`;
    setTabs((current) => [...current, { id, title: `Query ${next}` }]);
    setActive(id);
    setNext(next + 1);
  };

  return (
    <Tabs appearance="enclosed" size="small" value={active} onValueChange={(value) => setActive(value as string)} className="w-full">
      <div className="flex items-stretch">
        <TabsList onReorder={reorder} className="min-w-0 flex-1">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} icon={tab.running ? <RunningDot /> : tab.modified ? <ModifiedDot /> : undefined} onClose={() => close(tab.id)}>
              {tab.title}
            </TabsTrigger>
          ))}
          <TabsTrigger value="locked" disabled>
            Read-only
          </TabsTrigger>
        </TabsList>
        <IconButton aria-label="New query tab" size="small" onClick={add}>
          <PlusIcon />
        </IconButton>
      </div>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-stack-sm font-mono text-code text-fg">
          {tab.title}
          <ResultTabs />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** The results of a query: row count, messages, errors (a tone, and 0 hidden) and the plan. */
function ResultTabs() {
  return (
    <Tabs defaultValue="rows" className="w-full font-sans">
      <TabsList aria-label="Results">
        <TabsTrigger value="rows" count={48_002} countLabel="rows">
          Results
        </TabsTrigger>
        <TabsTrigger value="messages" count={2} countLabel="messages">
          Messages
        </TabsTrigger>
        <TabsTrigger value="errors" count={3} countLabel="errors" countTone="danger">
          Errors
        </TabsTrigger>
        <TabsTrigger value="warnings" count={0} countLabel="warnings" countTone="warning">
          Warnings
        </TabsTrigger>
        <TabsTrigger value="plan">Plan</TabsTrigger>
      </TabsList>
      <TabsContent value="rows" className="text-body text-fg">
        48,002 rows, first 1,000 shown.
      </TabsContent>
      <TabsContent value="messages" className="text-body text-fg">
        Two notices from the server.
      </TabsContent>
      <TabsContent value="errors" className="text-body text-fg">
        Three statements failed.
      </TabsContent>
      <TabsContent value="warnings" className="text-body text-fg">
        None: a count of 0 is hidden.
      </TabsContent>
      <TabsContent value="plan" className="text-body text-fg">
        The query plan.
      </TabsContent>
    </Tabs>
  );
}

/** Mightyconsole's strip grouped by tool: NATS open behind its heading, Temporal folded to a chip. */
function GroupedTabs() {
  const [active, setActive] = useState("orders");
  const nats = ["orders", "payments"];
  return (
    <Tabs value={active} onValueChange={(value) => setActive(value === "group:temporal" ? "workflows" : (value as string))} className="w-full">
      <TabsList aria-label="Tabs" className="border-b-0">
        {nats.includes(active) ? (
          <TabsLabel value="group:nats" icon={<Icon icon={Flash} />} className="rounded-s-lg bg-neutral-subtle text-body-1-strong">
            NATS<span className="sr-only">, 2 tabs</span>
            <Badge aria-hidden="true">2</Badge>
          </TabsLabel>
        ) : (
          <TabsTrigger value="orders" keepVisible icon={<Icon icon={Flash} />} count={2} countLabel={["tab", "tabs"]}>
            <span className="sr-only">NATS</span>
          </TabsTrigger>
        )}
        {nats.includes(active)
          ? nats.map((id, i) => (
              <TabsTrigger key={id} value={id} className={i === nats.length - 1 ? "rounded-e-lg bg-neutral-subtle" : "bg-neutral-subtle"}>
                {id === "orders" ? "ORDERS" : "PAYMENTS"}
              </TabsTrigger>
            ))
          : null}
        {active === "workflows" ? (
          <>
            <TabsLabel value="group:temporal" icon={<Icon icon={Clock} />} className="rounded-s-lg bg-neutral-subtle text-body-1-strong">
              Temporal<span className="sr-only">, 1 tab</span>
              <Badge aria-hidden="true">1</Badge>
            </TabsLabel>
            <TabsTrigger value="workflows" className="rounded-e-lg bg-neutral-subtle">
              Workflows
            </TabsTrigger>
          </>
        ) : (
          <TabsTrigger value="group:temporal" keepVisible icon={<Icon icon={Clock} />} count={1} countLabel={["tab", "tabs"]}>
            <span className="sr-only">Temporal</span>
          </TabsTrigger>
        )}
      </TabsList>
      {[...nats, "workflows"].map((id) => (
        <TabsContent key={id} value={id} className="text-body text-fg">
          The {id} tab.
        </TabsContent>
      ))}
    </Tabs>
  );
}
