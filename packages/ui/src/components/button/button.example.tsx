import { Button } from "@/components/button/button";
import { Icon } from "@/components/icon/icon";
import { ArrowClockwise, ArrowDownload, Copy, Delete, Play } from "@/lib/icons";

/** The smallest useful Button. */
export function ButtonMinimal() {
  return <Button>Save</Button>;
}

/** Every appearance in a query toolbar, the three sizes, and the running and disabled states. */
export function ButtonRealistic() {
  return (
    <div className="flex flex-col items-start gap-stack-md">
      <div className="flex flex-wrap items-center gap-inline-sm">
        <Button appearance="primary">
          <Icon icon={Play} />
          Run query
        </Button>
        <Button appearance="secondary">
          <Icon icon={Copy} />
          Duplicate
        </Button>
        <Button appearance="outline">
          <Icon icon={ArrowDownload} />
          Export
        </Button>
        <Button appearance="subtle">
          <Icon icon={ArrowClockwise} />
          Refresh
        </Button>
        <Button appearance="transparent">Show history</Button>
        <Button appearance="danger">
          <Icon icon={Delete} />
          Delete table
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-inline-sm">
        <Button size="small" appearance="secondary">
          Small
        </Button>
        <Button appearance="secondary">Medium</Button>
        <Button size="large">Lưu kết nối</Button>
        <Button loading>Running query</Button>
        <Button appearance="secondary" disabled>
          Disabled
        </Button>
      </div>
    </div>
  );
}
