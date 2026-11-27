// TSK-145, the network map (DOC-23 section 10 "The network map", (aa) to (ad), (bl)): Settings →
// Network map draws this server, SSH hosts, proxies and the profiles' targets as nodes and the saved
// links between them; a link is dragged from a node's dot, a command link is read and confirmed, a
// path is tested link by link and saved as a route. The server's checks: tests/routes.rs (links.*
// over the wire). The UI's: test/network-map-model.test.ts (path, loops, way in, hops) and
// test/network-map.test.tsx (jsdom). Run `pnpm --filter @byterygon/mightyconsole acceptance
// network-map --strict`.
import { type Checklist, cargo, vitest } from "../checklist.mts";

export default {
  id: "network-map",
  task: "TSK-145",
  title: "The network map",
  builtWhen: "apps/mightyconsole/ui/src/app/map/NetworkMap.tsx",
  lab: [],
  items: [
    {
      id: "links",
      text: "(DOC-23 (aa), (bl)) A link between this server, an SSH host and a proxy is saved by itself and stays until a person deletes it: one per pair of nodes, no loop, nothing into this server, the method its source allows, nodes of one owner; a link a route names is not deleted (the refusal lists the routes) and a deleted node takes its links.",
      lab: false,
      checks: [cargo("the_map_s_links_are_saved_by_themselves_and_keep_to_the_rules_of_the_map")],
    },
    {
      id: "draw",
      text: "(DOC-23 §10) Settings → Network map draws every node and link from the server's rows (inline SVG, no graph library), a profile's target from its route, and a node with two ways in has the one chosen, which lights the route to it.",
      lab: false,
      checks: [vitest("test/network-map.test.tsx", "the map"), vitest("test/network-map-model.test.ts", "the graph"), vitest("test/network-map-model.test.ts", "ways in and paths")],
    },
    {
      id: "link-two-nodes",
      text: "(DOC-23 (ad)) Dragging from the dot on a node to another links them with the first method the source allows; a refusal says why (a target cannot connect onward, nothing connects into the server, no duplicate, no loop); Connect to… does the same by keyboard and Delete removes a link.",
      lab: false,
      checks: [vitest("test/network-map.test.tsx", "linking"), vitest("test/network-map-model.test.ts", "the rules of a new link")],
    },
    {
      id: "proxy-command",
      text: "(DOC-23 11.3, (s)) A local command (ProxyCommand) or an SSH command link shows the line that will run, is not confirmed until read, and saving a change to what it runs clears the confirmation.",
      lab: false,
      checks: [cargo("a_command_link_needs_host_access_and_a_confirmation_and_a_change_asks_again"), vitest("test/network-map.test.tsx", "a command link")],
    },
    {
      id: "test-and-save",
      text: "(DOC-23 §9, §10) Test route runs the hops of the path to the selected node and colours each link; a host that forbids forwarding offers \"Use SSH command instead\"; a path with an unconfirmed command is not tested; Save as route saves the path as a route.",
      lab: false,
      checks: [vitest("test/network-map.test.tsx", "Test and Save as route"), vitest("test/network-map-model.test.ts", "from a path to hops"), vitest("test/network-map-model.test.ts", "a test colours the links")],
    },
    {
      id: "nodes",
      text: "(DOC-23 §10) Nodes are added (an SSH host or a proxy through its own editor, a target kept in this browser) and removed (refused while a route uses it, listing the routes); positions and chosen ways in are kept in this browser.",
      lab: false,
      checks: [vitest("test/network-map.test.tsx", "adding nodes"), vitest("test/network-map-model.test.ts", "where nodes are drawn")],
    },
  ],
} satisfies Checklist;
