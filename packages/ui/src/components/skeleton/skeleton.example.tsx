import { Skeleton } from "@/components/skeleton/skeleton";

/** The smallest useful Skeleton: a line of text loading. */
export function SkeletonMinimal() {
  return (
    <div role="group" aria-busy="true" aria-label="Loading description" className="w-panel-sm">
      <Skeleton variant="text" />
    </div>
  );
}

/** A schema tree loading, then a connection card loading: rows, an avatar, text lines and a block. */
export function SkeletonRealistic() {
  return (
    <div className="flex flex-wrap items-start gap-gap-lg">
      <div role="group" aria-busy="true" aria-label="Loading tables" className="flex w-panel-xs flex-col gap-stack-xs">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex h-control-sm items-center gap-inline-sm ps-inset-xs">
            <Skeleton className="size-icon-sm" />
            <Skeleton variant="text" className={row % 2 ? "w-panel-xs" : "w-2/3"} />
          </div>
        ))}
      </div>
      <div role="group" aria-busy="true" aria-label="Loading connection" className="flex w-panel-sm flex-col gap-stack-sm rounded-lg border border-border p-inset-md">
        <div className="flex items-center gap-inline-md">
          <Skeleton variant="circle" className="size-control-md" />
          <div className="flex flex-1 flex-col gap-stack-xs">
            <Skeleton variant="text" className="w-1/2" />
            <Skeleton variant="text" className="w-3/4" />
          </div>
        </div>
        <Skeleton className="h-control-lg w-full" />
        <Skeleton className="h-control-sm w-1/3" animated={false} />
      </div>
    </div>
  );
}
