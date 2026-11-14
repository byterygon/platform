import { useState } from "react";
import { IconButton } from "@/components/icon-button/icon-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/tabs/tabs";

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
const RunningDot = () => <span aria-label="running" role="img" className="size-icon-xs shrink-0 rounded-full bg-accent-solid" />;

const PlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

/**
 * DBee's query tabs: enclosed and small, each closable (the button, or Delete) and reorderable
 * (drag, or Alt+Shift+Arrow), with a status before the title and a disabled tab.
 */
export function TabsRealistic() {
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
    <Tabs variant="enclosed" size="sm" value={active} onValueChange={(value) => setActive(value as string)} className="w-full">
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
        <IconButton aria-label="New query tab" size="sm" onClick={add}>
          <PlusIcon />
        </IconButton>
      </div>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="font-mono text-code text-fg">
          {tab.title}
        </TabsContent>
      ))}
    </Tabs>
  );
}
