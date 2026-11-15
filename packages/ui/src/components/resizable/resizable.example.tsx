import { Resizable, ResizableHandle, ResizablePanel } from "@/components/resizable/resizable";

/** The smallest useful Resizable: two panes side by side. */
export function ResizableMinimal() {
  return (
    <div className="h-panel-xs w-full max-w-panel-lg rounded-md border border-border">
      <Resizable aria-label="Layout">
        <ResizablePanel defaultSize={30} minSize={15}>
          <p className="p-inset-sm text-body text-fg">Schema</p>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize schema" />
        <ResizablePanel>
          <p className="p-inset-sm text-body text-fg">Editor</p>
        </ResizablePanel>
      </Resizable>
    </div>
  );
}

/** DBee's main layout: a collapsible sidebar, then the editor over the results, with grips. */
export function ResizableRealistic() {
  return (
    <div className="h-panel-md w-full max-w-panel-xl rounded-md border border-border bg-surface">
      <Resizable aria-label="Workspace">
        <ResizablePanel defaultSize={25} minSize={15} maxSize={45} collapsible>
          <div className="flex h-full flex-col gap-stack-xs bg-inset p-inset-sm text-body text-fg">
            <p className="text-label text-fg-muted">Connections</p>
            <p className="truncate">orders-prod / public / customer_lifetime_value_by_region_and_month</p>
          </div>
        </ResizablePanel>
        <ResizableHandle withGrip aria-label="Resize sidebar" />
        <ResizablePanel>
          <Resizable orientation="vertical" aria-label="Query and results">
            <ResizablePanel defaultSize={45} minSize={20}>
              <pre className="h-full p-inset-sm font-mono text-code text-fg">select * from orders where status = 'open';</pre>
            </ResizablePanel>
            <ResizableHandle withGrip aria-label="Resize results" />
            <ResizablePanel minSize={20}>
              <p className="p-inset-sm text-body text-fg-muted">1,204 rows</p>
            </ResizablePanel>
          </Resizable>
        </ResizablePanel>
      </Resizable>
    </div>
  );
}
