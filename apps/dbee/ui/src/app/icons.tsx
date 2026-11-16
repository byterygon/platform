// The few icons the shell needs: Fluent UI System Icons (vendored in src/lib/icons.ts, MIT) through
// the Icon component, aria-hidden unless given a label. Nothing is fetched.
import type { ComponentProps } from "react";
import { Icon } from "@/components/ui/icon";
import { Add, ArrowClockwise, ArrowDownload, ColumnTriple, Database, Eye, Folder, MoreHorizontal, Play, QuestionCircle, Settings, Stop, Table } from "@/lib/icons";

type Props = Omit<ComponentProps<typeof Icon>, "icon" | "children">;

export const PlusIcon = (p: Props) => <Icon icon={Add} {...p} />;
export const PlayIcon = (p: Props) => <Icon icon={Play} {...p} />;
export const StopIcon = (p: Props) => <Icon icon={Stop} {...p} />;
export const DatabaseIcon = (p: Props) => <Icon icon={Database} {...p} />;
export const SchemaIcon = (p: Props) => <Icon icon={Folder} {...p} />;
export const TableIcon = (p: Props) => <Icon icon={Table} {...p} />;
export const ViewIcon = (p: Props) => <Icon icon={Eye} {...p} />;
export const ColumnIcon = (p: Props) => <Icon icon={ColumnTriple} {...p} />;
export const GearIcon = (p: Props) => <Icon icon={Settings} {...p} />;
export const DownloadIcon = (p: Props) => <Icon icon={ArrowDownload} {...p} />;
export const MoreIcon = (p: Props) => <Icon icon={MoreHorizontal} {...p} />;
export const RefreshIcon = (p: Props) => <Icon icon={ArrowClockwise} {...p} />;
export const HelpIcon = (p: Props) => <Icon icon={QuestionCircle} {...p} />;
