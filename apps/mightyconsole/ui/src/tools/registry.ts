// The tools the shell shows (Mightyconsole spec §2.2, §3.1). The shell knows tools only through
// this list; each tool task adds its module here (NATS, Kafka, Kubernetes, Temporal, Docker,
// LangGraph). `echo` is the foundation's sample. The navigation orders tools by their optional
// `order` and groups them by `category` (DOC-21 Open question 45); the helpers below give the
// defaults, so a module that sets neither keeps working.
import type { IconDefinition } from "@/lib/icons";
import { dockerTool } from "./docker";
import { echoTool } from "./echo";
import { langgraphTool } from "./langgraph";
import { natsTool } from "./nats";
import { temporalTool } from "./temporal";
import type { ToolCategory, ToolModule } from "./types";

export const TOOLS: readonly ToolModule[] = [echoTool, natsTool, dockerTool, langgraphTool, temporalTool];

/** The navigation's groups in display order. */
export const TOOL_CATEGORIES: readonly ToolCategory[] = ["Messaging", "Infrastructure", "Workflows and agents", "Other"];

export function toolById(tools: readonly ToolModule[], id: string): ToolModule | undefined {
  return tools.find((t) => t.id === id);
}

/** What to draw for a tool: its own mark, or its Fluent icon when it has none. */
export function toolIcon(tool: ToolModule): IconDefinition {
  return tool.mark ?? tool.icon;
}

/** The tool's navigation group, "Other" when it sets none. */
export function toolCategory(tool: ToolModule): ToolCategory {
  return tool.category ?? "Other";
}

/** The tools in navigation order: by `order`, then registry order for ties and for tools without one. */
export function orderedTools(tools: readonly ToolModule[]): ToolModule[] {
  return tools
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => (a.tool.order ?? Number.POSITIVE_INFINITY) - (b.tool.order ?? Number.POSITIVE_INFINITY) || a.index - b.index)
    .map(({ tool }) => tool);
}
