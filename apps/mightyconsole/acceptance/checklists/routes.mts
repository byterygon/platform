// TSK-117, connection routes (DOC-23 section 12: "a routes checklist (each hop kind, multi-hop,
// errors per hop, host key on a jump host, a command hop, Test in the editor)"), against the lab's
// routes profile (squid, Dante, two jump hosts, targets on an internal network only a route
// reaches) with the Docker, Temporal and LangGraph profiles beside it. The server's checks:
// tests/routes.rs (storage, ownership, confirmation, routes.test through an in-process proxy),
// tests/docker.rs and tests/langgraph.rs (the tools through a route), tests/routes_lab.rs (feature
// lab-tests) and net-route's own lab test. The UI's: test/routes.test.tsx (jsdom). Run
// `pnpm --filter @byterygon/mightyconsole acceptance routes --lab-up --strict`.
import { type Checklist, cargo, command, vitest } from "../checklist.mts";

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

export default {
  id: "routes",
  task: "TSK-117",
  title: "Connection routes",
  builtWhen: "apps/mightyconsole/server/src/profiles/routes.rs",
  lab: ["routes", "docker", "temporal", "langgraph"],
  items: [
    {
      id: "storage",
      text: "(DOC-23 §8.1, (aa) to (ac)) Proxies, links and routes are saved once on the server with the owners of SSH hosts; a proxy's password and a command's secret variables are write-only; a proxy or an SSH host a route passes is not deleted; a deleted route leaves its profiles with Route missing, never Direct; export and import carry the routes the profiles name, their proxies and SSH hosts, never a secret value.",
      lab: false,
      checks: [
        cargo("a_route_goes_through_its_owner_s_proxies_and_hosts_and_they_stay_while_it_uses_them"),
        cargo("hops_become_a_path_of_links_and_back"),
        vitest("test/routes.test.tsx", "export and import"),
      ],
    },
    {
      id: "hop-kinds",
      text: "(DOC-23 §4) Each hop kind reaches a target only a route reaches: HTTP CONNECT (http and https, Basic), SOCKS5 (user and password), an SSH jump host, an SSH command, a local command, and the System route when chosen.",
      lab: true,
      checks: [command("net-route through the lab's proxies", ["cargo", "test", "-p", "net-route", "--locked", "--features", "lab-tests", "--test", "lab"])],
    },
    {
      id: "multi-hop",
      text: "(DOC-23 §4.3) Two SSH hops in a row are a multi-hop jump: routes.test through jump1 then jump2 reaches the internal target, each key trusted in its own SSH host.",
      lab: true,
      checks: [lab("a_test_through_two_jump_hosts_reaches_an_internal_target")],
    },
    {
      id: "tools",
      text: "(DOC-23 §7) Docker over SSH and over TCP (with TLS end to end, or plain with its warning), Temporal (with its codec server and S3) and LangGraph connect through a profile's route.",
      lab: true,
      checks: [
        cargo("a_docker_host_is_reached_through_a_route_over_ssh_and_tcp"),
        cargo("a_langgraph_server_is_reached_through_a_route"),
        lab("docker_on_the_internal_network_over_tcp_through_squid_and_with_tls_through_dante"),
        lab("temporal_and_langgraph_through_squid"),
      ],
    },
    {
      id: "errors-per-hop",
      text: "(DOC-23 §9, (q)) A failure names the hop (or the target) and its kind: routes.test stops at the first failing hop, a tool's error carries ToolError.hop through hyper and tonic, and the error state draws the path with the failing hop red and the later ones Not tried.",
      lab: false,
      checks: [
        cargo("a_test_reports_each_hop_and_names_the_one_that_failed"),
        cargo("a_hop_that_refuses_is_named_in_docker_s_error"),
        cargo("temporal_s_error_names_the_hop_through_tonic"),
        vitest("test/routes.test.tsx", "the path figure"),
      ],
    },
    {
      id: "host-key-on-a-jump-host",
      text: "(DOC-23 4.3, (r)) An SSH hop's unknown key stops the connection before any login, names the hop and the SSH host, and Trust saves it into that SSH host; the Docker host's own key behind the route is asked for next.",
      lab: true,
      checks: [lab("docker_over_ssh_through_a_jump_host_trusts_each_key_in_its_own_ssh_host")],
    },
    {
      id: "command-hop",
      text: "(DOC-23 4.4, 11.3, (s)) A local command needs profiles.hostAccess; a command starts not confirmed and cannot be tested, chosen or used until a person confirms it after reading it in full; a changed argument asks again.",
      lab: false,
      checks: [cargo("a_command_hop_needs_host_access_and_a_confirmation_and_a_change_asks_again"), vitest("test/routes.test.tsx", "a saved command asks to be confirmed")],
    },
    {
      id: "editor",
      text: "(DOC-23 §10, (p)) Settings → Routes lists the routes with their hops; the route editor reorders hops by drag, keyboard and buttons, tests the draft one line per hop and saves; every profile sheet of a tool that takes routes has Connect through (Direct, the routes, New route…, Route missing with its own confirmation).",
      lab: false,
      checks: [vitest("test/routes.test.tsx", "Settings → Routes"), vitest("test/routes.test.tsx", "the route editor"), vitest("test/routes.test.tsx", "Connect through")],
    },
  ],
} satisfies Checklist;
