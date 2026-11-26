#!/usr/bin/env node
// The Mightyconsole test lab (TSK-79, spec section 14): one command over docker compose.
//
//   node lab.mts up [tool...]        build, generate credentials, start healthy, seed
//   node lab.mts seed [tool...]      seed again (idempotent)
//   node lab.mts check [tool...]     every service up and seeded, every port on 127.0.0.1
//   node lab.mts down                stop and remove everything, volumes and .generated included
//   node lab.mts images save FILE    one `docker save` tarball of every lab image, for an offline machine
//   node lab.mts images check        every compose image is pinned by digest and listed in images.lock
//   node lab.mts lock                re-lock the Python packages with hashes (uv, in a container)
//   node lab.mts langgraph-offline   the LangGraph server starts and serves a run with no egress
//
// Tools: nats, kafka (with the Schema Registry), k8s, temporal, docker, langgraph, and idp (Dex, the
// identity provider for sign-in, TSK-136), and routes (squid, Dante and targets on an internal
// network, for net-route: TSK-115); none means all.
// Through pnpm: `pnpm --filter @byterygon/mightyconsole lab up nats`. Needs Docker with compose.
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LAB = dirname(fileURLToPath(import.meta.url));
export const TOOLS = ["nats", "kafka", "k8s", "temporal", "docker", "langgraph", "idp", "routes"] as const;
type Tool = (typeof TOOLS)[number];

const UV = "ghcr.io/astral-sh/uv:0.9-python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58";
const GENERATED = join(LAB, ".generated");

const env = {
  ...process.env,
  // The user the tools container writes .generated/ as: this process's, unless LAB_UID/LAB_GID say.
  LAB_UID: process.env["LAB_UID"] ?? String(process.getuid?.() ?? 0),
  LAB_GID: process.env["LAB_GID"] ?? String(process.getgid?.() ?? 0),
};

function run(command: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(command, args, { cwd: LAB, env, stdio: options.stdio ?? "inherit", encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}${typeof result.stderr === "string" && result.stderr ? `:\n${result.stderr}` : ""}`);
  return typeof result.stdout === "string" ? result.stdout : "";
}

const compose = (args: string[], options: SpawnSyncOptions = {}) => run("docker", ["compose", "-f", join(LAB, "compose.yaml"), ...args], options);
const profiles = (tools: readonly Tool[]) => tools.flatMap((t) => ["--profile", t]);

function parseTools(args: string[]): Tool[] {
  if (args.length === 0) return [...TOOLS];
  for (const a of args) if (!(TOOLS as readonly string[]).includes(a)) throw new Error(`unknown tool ${a} (one of ${TOOLS.join(", ")})`);
  return args as Tool[];
}

function generate(): void {
  // Created here, owned by whoever runs the lab: a directory Docker creates for a bind mount is
  // root's, and the tools container (run as this user) could not write into it.
  mkdirSync(GENERATED, { recursive: true });
  compose(["--profile", "tools", "build", "tools"]);
  compose(["run", "--rm", "--no-deps", "tools", "generate"]);
}

function seed(tools: readonly Tool[]): void {
  // Temporal: the worker starts its samples; the seed starts the long histories (TSK-109) and waits for them.
  const python = tools.filter((t) => t === "nats" || t === "kafka" || t === "temporal" || t === "langgraph");
  if (python.length > 0) compose(["run", "--rm", "--no-deps", "tools", "seed", ...python]);
  if (tools.includes("k8s")) {
    compose(["cp", "k3s:/output/kubeconfig.yaml", join(GENERATED, "kubeconfig")]);
    compose(["exec", "-T", "k3s", "kubectl", "apply", "-f", "/lab-seed/00-crd.yaml"]);
    compose(["exec", "-T", "k3s", "kubectl", "wait", "--for=condition=established", "--timeout=60s", "crd/widgets.lab.byterygon.dev"]);
    compose(["exec", "-T", "k3s", "kubectl", "apply", "-f", "/lab-seed/10-lab.yaml"]);
  }
  if (tools.includes("docker")) compose(["exec", "-T", "docker-host", "sh", "/lab/seed.sh"]);
  // Temporal: the worker starts its sample workflows itself.
}

async function sshBanner(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no SSH banner"));
    }, 10_000);
    socket.once("data", (data) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(data.toString().trim());
    });
    socket.once("error", reject);
  });
}

async function tcpOpen(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no answer"));
    }, 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function check(tools: readonly Tool[]): Promise<number> {
  const failures: string[] = [];
  // Every published port of the running lab is on 127.0.0.1.
  const rows = compose(["ps", "--format", "json"], { stdio: ["ignore", "pipe", "inherit"] })
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      const parsed = JSON.parse(l) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    }) as { Service: string; Publishers?: { URL: string; PublishedPort: number }[] }[];
  for (const row of rows) {
    for (const p of row.Publishers ?? []) if (p.PublishedPort > 0 && p.URL !== "127.0.0.1") failures.push(`${row.Service} publishes port ${p.PublishedPort} on ${p.URL}`);
  }
  const python = tools.filter((t) => t === "nats" || t === "kafka" || t === "temporal" || t === "langgraph" || t === "idp");
  if (python.length > 0) {
    try {
      compose(["run", "--rm", "--no-deps", "tools", "check", ...python]);
    } catch (e) {
      failures.push(String((e as Error).message.split("\n")[0]));
    }
  }
  if (tools.includes("kafka")) {
    // The listeners advertise localhost, as host clients reach them: check them from Kafka's own
    // network namespace, where localhost is the broker.
    const kafka = compose(["ps", "-q", "kafka"], { stdio: ["ignore", "pipe", "inherit"] }).trim();
    try {
      run("docker", ["run", "--rm", "--network", `container:${kafka}`, "-u", `${env.LAB_UID}:${env.LAB_GID}`, "-v", `${GENERATED}:/generated`, "mightyconsole-lab-tools:local", "check", "kafka-listeners"]);
    } catch (e) {
      failures.push(String((e as Error).message.split("\n")[0]));
    }
  }
  if (tools.includes("k8s")) {
    const out = (args: string[]) => compose(["exec", "-T", "k3s", "kubectl", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const kinds = out(["get", "deploy,sts,ds,job,cronjob,svc,ingress,cm,secret,widgets", "-n", "lab", "-o", "name"]);
    for (const name of ["deployment.apps/web", "statefulset.apps/db", "daemonset.apps/node-agent", "job.batch/migrate", "cronjob.batch/report", "service/web", "ingress.networking.k8s.io/web", "configmap/shop-config", "secret/shop-db", "widget.lab.byterygon.dev/blue-small", "widget.lab.byterygon.dev/red-large"]) {
      if (!kinds.includes(name)) failures.push(`k8s: ${name} is missing`);
    }
    if (!existsSync(join(GENERATED, "kubeconfig"))) failures.push("k8s: .generated/kubeconfig is missing");
    else if (!readFileSync(join(GENERATED, "kubeconfig"), "utf8").includes("https://127.0.0.1:6443")) failures.push("k8s: the kubeconfig does not point at 127.0.0.1:6443");
  }
  if (tools.includes("docker")) {
    const names = compose(["exec", "-T", "docker-host", "docker", "ps", "-a", "--format", "{{.Names}} {{.State}} {{.Label \"com.docker.compose.project\"}}"], { stdio: ["ignore", "pipe", "pipe"] });
    for (const expected of [/shop-web-1 running shop/, /shop-worker-1 running shop/, /^stopped exited/m, /^tty running/m]) if (!expected.test(names)) failures.push(`docker: no container matching ${expected}`);
    try {
      const banner = await sshBanner(2222);
      if (!banner.startsWith("SSH-2.0-")) failures.push(`docker: port 2222 answered ${banner}`);
    } catch (e) {
      failures.push(`docker: SSH on 127.0.0.1:2222: ${(e as Error).message}`);
    }
  }
  if (tools.includes("routes")) {
    // The proxies answer on 127.0.0.1 and reach the internal targets; the targets publish nothing.
    for (const port of [3128, 3129, 1080]) {
      try {
        await tcpOpen(port);
      } catch (e) {
        failures.push(`routes: 127.0.0.1:${port}: ${(e as Error).message}`);
      }
    }
    for (const [service, target] of [["routes-squid", "echo.routes.internal 7"], ["routes-socks", "nats.routes.internal 4222"]] as const) {
      try {
        compose(["exec", "-T", service, "sh", "-c", `nc -z -w 3 ${target}`], { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        failures.push(`routes: ${service} does not reach ${target.replace(" ", ":")}`);
      }
    }
  }
  if (failures.length > 0) {
    console.error(`lab check: ${failures.length} failed:\n- ${failures.join("\n- ")}`);
    return 1;
  }
  console.log(`lab check: ok (${tools.join(", ")})`);
  return 0;
}

/** The compose images and the images.lock lines: every pulled image pinned by digest and listed. */
export function imagePins(): { compose: string[]; lock: string[]; problems: string[] } {
  const composeText = readFileSync(join(LAB, "compose.yaml"), "utf8");
  const images = [...composeText.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
  const dockerfiles = ["tools/Dockerfile", "langgraph/Dockerfile", "docker-host/Dockerfile", "routes/Dockerfile"].map((f) => readFileSync(join(LAB, f), "utf8"));
  const bases = dockerfiles.flatMap((d) => [...d.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!));
  const inner = [...readFileSync(join(LAB, "k8s", "10-lab.yaml"), "utf8").matchAll(/image:\s*(\S+)/g), ...readFileSync(join(LAB, "docker-host", "shop.yaml"), "utf8").matchAll(/image:\s*(\S+)/g)].map((m) => m[1]!);
  const lock = readFileSync(join(LAB, "images.lock"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const problems: string[] = [];
  const pulled = [...images.filter((i) => !i.startsWith("mightyconsole-lab-")), ...bases, ...inner, UV];
  for (const image of pulled) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) problems.push(`${image} is not pinned by digest`);
    else if (!lock.includes(image)) problems.push(`${image} is not in images.lock`);
  }
  for (const line of lock) if (!pulled.includes(line)) problems.push(`images.lock lists ${line}, which nothing uses`);
  return { compose: images, lock, problems };
}

function imagesSave(file: string): void {
  const { lock } = imagePins();
  for (const image of lock) run("docker", ["pull", "-q", image]);
  compose(["--profile", "all", "--profile", "tools", "build"]);
  const built = ["mightyconsole-lab-tools:local", "mightyconsole-lab-docker-host:local", "mightyconsole-lab-langgraph:local", "mightyconsole-lab-routes:local"];
  run("docker", ["save", "-o", file, ...lock, ...built]);
  console.log(`lab images save: wrote ${file} (${lock.length + built.length} images). The images k3s and the Docker host pull inside (busybox, k3s's own) are pulled there on first use.`);
}

function lock(): void {
  for (const dir of ["tools", "langgraph"]) {
    run("docker", ["run", "--rm", "-u", `${env.LAB_UID}:${env.LAB_GID}`, "-e", "UV_CACHE_DIR=/tmp/uv", "-v", `${join(LAB, dir)}:/w`, "-w", "/w", UV, "uv", "pip", "compile", "requirements.in", "--generate-hashes", "--python-version", "3.12", "--universal", "-o", "requirements.lock"]);
  }
}

/** spec section 14, "LangGraph check": the lab server on a network without egress serves a run. */
function langgraphOffline(): number {
  compose(["--profile", "langgraph", "--profile", "tools", "build", "langgraph", "tools"]);
  const net = "mightyconsole-lab-offline";
  spawnSync("docker", ["rm", "-f", "mightyconsole-lab-langgraph-offline"], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", net], { stdio: "ignore" });
  run("docker", ["network", "create", "--internal", net], { stdio: "ignore" });
  try {
    run("docker", ["run", "-d", "--name", "mightyconsole-lab-langgraph-offline", "--network", net, "--network-alias", "langgraph", "mightyconsole-lab-langgraph:local"], { stdio: "ignore" });
    const probe = `
import requests, time
b = "http://langgraph:2024"
for _ in range(120):
    try:
        if requests.get(b + "/ok", timeout=2).ok: break
    except Exception: time.sleep(1)
try:
    requests.get("https://pypi.org", timeout=5); raise SystemExit("egress is not blocked")
except requests.RequestException: pass
tid = requests.post(b + "/threads", json={}, timeout=10).json()["thread_id"]
r = requests.post(f"{b}/threads/{tid}/runs/wait", json={"assistant_id": "agent", "input": {"messages": [{"role": "user", "content": "What is 6 times 7?"}]}}, timeout=60).json()
assert r.get("__interrupt__"), r
r = requests.post(f"{b}/threads/{tid}/runs/wait", json={"assistant_id": "agent", "command": {"resume": "approved"}}, timeout=60).json()
assert "42" in r["messages"][-1]["content"], r
print("langgraph-offline: started and served a run with no egress and no licence key")
`;
    run("docker", ["run", "--rm", "--network", net, "--entrypoint", "python", "mightyconsole-lab-tools:local", "-c", probe]);
    return 0;
  } finally {
    spawnSync("docker", ["rm", "-f", "mightyconsole-lab-langgraph-offline"], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", net], { stdio: "ignore" });
  }
}

async function main(argv: string[]): Promise<number> {
  const [command = "", ...rest] = argv;
  switch (command) {
    case "up": {
      const tools = parseTools(rest);
      generate();
      compose([...profiles(tools), "build"]);
      compose([...profiles(tools), "up", "-d", "--wait", "--wait-timeout", "600"]);
      seed(tools);
      console.log(`lab up: ${tools.join(", ")} running and seeded; credentials in ${join(GENERATED, "credentials.json")}`);
      return 0;
    }
    case "seed":
      seed(parseTools(rest));
      return 0;
    case "check":
      return check(parseTools(rest));
    case "down":
      compose(["--profile", "all", "--profile", "tools", "down", "--volumes", "--remove-orphans"]);
      rmSync(GENERATED, { recursive: true, force: true });
      return 0;
    case "images":
      if (rest[0] === "save" && rest[1]) {
        imagesSave(rest[1]);
        return 0;
      }
      if (rest[0] === "check") {
        const { problems } = imagePins();
        if (problems.length > 0) {
          console.error(`lab images check:\n- ${problems.join("\n- ")}`);
          return 1;
        }
        console.log("lab images check: every image is pinned by digest and listed in images.lock");
        return 0;
      }
      break;
    case "lock":
      lock();
      return 0;
    case "langgraph-offline":
      return langgraphOffline();
  }
  console.error("usage: lab.mts up|seed|check [tool...] | down | images save FILE | images check | lock | langgraph-offline");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`lab: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
