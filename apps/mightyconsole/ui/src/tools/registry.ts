// The tools the shell shows, in the order of the tool rail (Mightyconsole spec §2.2, §3.1). The
// shell knows tools only through this list; each tool task adds its module here (NATS, Kafka,
// Kubernetes, Temporal, Docker, LangGraph). `echo` is the foundation's sample.
import { echoTool } from "./echo";
import type { ToolModule } from "./types";

export const TOOLS: readonly ToolModule[] = [echoTool];

export function toolById(tools: readonly ToolModule[], id: string): ToolModule | undefined {
  return tools.find((t) => t.id === id);
}
