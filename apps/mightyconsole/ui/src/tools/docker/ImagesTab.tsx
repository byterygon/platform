// `docker.images {}` (Mightyconsole spec §10.4 "Images", TSK-81 mockup frame docker-images): the
// host's images, a row per tag as `docker images` shows them (an image pulled by digest only shows
// its digest; a dangling one `<none>`, behind a toggle), with the short id and Copy, the size, when
// it was made and the containers that use it; "Only unused" keeps the others. A row's menu has
// Inspect, Copy ID, Copy the `docker pull` name and Remove…, which is off while a running
// container uses the image (Docker refuses even with Force) and says what to do. Removing a tag
// of an image with other tags only takes the tag off; Force removes an image stopped containers
// use. Live through `docker.events`. Pull, build and prune are later (DOC-20).
import { useContext, useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { SearchInput } from "@/components/ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, NoticeContext, Page, PageBar, PageFooter, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { linkTo } from "@/app/tab-view";
import type { ImageRow } from "@/gen/api";
import { ArrowClockwise, Code, Copy, Delete, MoreHorizontal } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { LinkEvent, TabProps } from "../types";
import { formatBytes, formatCreated, shortId } from "./format";
import { type InspectTarget, InspectSheet, UsedBy, namesText, removeOutcome, runningUsers, useDockerList } from "./resources";

/** One row of the table: an image under one of its names. */
export interface ImageLine {
  key: string;
  image: ImageRow;
  /** `ghcr.io/acme/shop-api`, `<none>`. */
  repository: string;
  /** `2.4.1`, `<none>`. */
  tag: string;
  /** What Inspect and Remove name: the tag, else the image id. */
  ref: string;
  /** What `docker pull` takes, when the image has a name. */
  pull?: string;
}

/** `registry.lan:5000/shop/api:1.4` as repository and tag (the port's colon is not the tag's). */
export function splitTag(ref: string): { repository: string; tag: string } {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? { repository: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { repository: ref, tag: "latest" };
}

/** The table's rows: a row per tag, else one per digest name, else one `<none>` row; sorted by name, nameless last. */
export function imageLines(images: readonly ImageRow[]): ImageLine[] {
  const lines: ImageLine[] = [];
  for (const image of images) {
    if (image.repoTags.length > 0) {
      for (const tag of image.repoTags) lines.push({ key: `${image.id}|${tag}`, image, ...splitTag(tag), ref: tag, pull: tag });
    } else if (image.repoDigests.length > 0) {
      const digest = image.repoDigests[0]!;
      lines.push({ key: `${image.id}|${digest}`, image, repository: digest.slice(0, digest.indexOf("@")), tag: "<none>", ref: image.id, pull: digest });
    } else {
      lines.push({ key: image.id, image, repository: "<none>", tag: "<none>", ref: image.id });
    }
  }
  const nameless = (l: ImageLine) => (l.repository === "<none>" ? 1 : 0);
  return lines.sort((a, b) => nameless(a) - nameless(b) || a.repository.localeCompare(b.repository) || a.tag.localeCompare(b.tag) || a.image.id.localeCompare(b.image.id));
}

export function matchesImage(line: ImageLine, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === "") return true;
  return [line.repository, line.tag, line.image.id.replace(/^sha256:/, "")].some((s) => s.toLowerCase().includes(q));
}

export function ImagesTab({ profile, connId, client, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const notify = useContext(NoticeContext);
  const list = useDockerList({ client, connId, note, kind: "image", load: (id) => client.docker.images.list({ connId: id }) });
  const [search, setSearch] = useState("");
  const [showDangling, setShowDangling] = useState(false);
  const [onlyUnused, setOnlyUnused] = useState(false);
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [confirm, setConfirm] = useState<ImageLine | null>(null);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  useTabActions({ refresh: list.reload });

  const images = useMemo(() => list.data ?? [], [list.data]);
  const lines = useMemo(() => imageLines(images), [images]);
  const dangling = images.filter((i) => i.dangling);
  const shown = lines.filter((l) => (showDangling || !l.image.dangling) && (!onlyUnused || l.image.usedBy.length === 0) && matchesImage(l, search));

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const openContainer = (name: string, event?: LinkEvent) => go({ kind: "docker.container", params: { id: name, view: "overview" }, title: name }, event);
  const total = images.reduce((n, i) => n + i.size, 0);

  const remove = async (line: ImageLine) => {
    setBusy(true);
    try {
      const [result] = await client.docker.images.remove({ connId, ids: [line.ref], force });
      if (result?.error !== undefined) {
        notify(removeOutcome("image", [], [{ name: line.ref === line.image.id ? shortId(line.ref) : line.ref, error: result.error }]));
      } else {
        const name = line.ref === line.image.id ? shortId(line.ref) : line.ref;
        const deleted = result?.deleted.length ?? 0;
        notify({ title: `Removed ${name}`, description: deleted > 0 ? `${deleted} ${deleted === 1 ? "image or layer" : "images and layers"} deleted` : "Only the tag was taken off; the image stays for its other tags", type: "success" });
      }
      setConfirm(null);
    } catch (e) {
      const d = note(e);
      notify({ title: d.title, ...(d.description ? { description: d.description } : {}), type: "warning" });
    } finally {
      setBusy(false);
      list.reload();
    }
  };

  return (
    <Page>
      <PageHeader
        title="Images"
        adornment={
          list.events.live ? (
            <Badge appearance="tint" variant="success">
              Live
            </Badge>
          ) : null
        }
        subtitle={[
          profile.name,
          list.data ? `${images.length} ${images.length === 1 ? "image" : "images"}` : null,
          list.data ? formatBytes(total) : null,
          dangling.length > 0 ? `${dangling.length} dangling (${formatBytes(dangling.reduce((n, i) => n + i.size, 0))})${showDangling ? "" : " hidden"}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <Button appearance="subtle" onClick={list.reload} loading={list.loading && list.data !== null}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <PageBar aria-label="Filters">
        <SearchInput aria-label="Filter images" value={search} onValueChange={setSearch} placeholder="Filter by repository, tag or ID" className="w-panel-sm" />
        <label className="flex items-center gap-inline-sm whitespace-nowrap text-body-1 text-fg">
          <Checkbox checked={showDangling} onCheckedChange={(c) => setShowDangling(c === true)} /> Show dangling ({dangling.length})
        </label>
        <label className="flex items-center gap-inline-sm whitespace-nowrap text-body-1 text-fg">
          <Checkbox checked={onlyUnused} onCheckedChange={(c) => setOnlyUnused(c === true)} /> Only unused
        </label>
      </PageBar>
      <PageRegion>
        {list.error ? (
          <div className="px-inset-lg pt-stack-md">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : null}
        {list.data === null && list.loading ? <LoadingRows label="Loading the images" /> : null}
        {list.data !== null && shown.length === 0 && !list.error ? <EmptyLine>{images.length === 0 ? "No images on this host." : "No image matches the filter."}</EmptyLine> : null}
        {shown.length > 0 ? (
          <Table aria-label="Images" size="small" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead>Tag</TableHead>
                <TableHead>ID</TableHead>
                <TableHead align="end">Size</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead align="end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((line) => {
                const running = runningUsers(line.image.usedBy);
                const label = line.repository === "<none>" ? shortId(line.image.id) : `${line.repository}:${line.tag}`;
                return (
                  <TableRow key={line.key}>
                    <TableCell className={cn("max-w-panel-xs truncate font-mono text-code", line.repository === "<none>" && "text-fg-muted")} title={line.repository}>
                      {line.repository}
                    </TableCell>
                    <TableCell className={cn("font-mono text-code", line.tag === "<none>" && "text-fg-muted")}>{line.tag}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-inline-xs font-mono text-code text-fg-muted" title={line.image.id}>
                        {shortId(line.image.id)}
                        <CopyButton value={line.image.id} what="image ID" />
                      </span>
                    </TableCell>
                    <TableCell align="end" className="whitespace-nowrap tabular-nums">
                      {formatBytes(line.image.size)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-fg-muted">{formatCreated(line.image.created)}</TableCell>
                    <TableCell className="max-w-panel-sm overflow-hidden">
                      <UsedBy list={line.image.usedBy} onOpen={openContainer} />
                    </TableCell>
                    <TableCell align="end">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<IconButton size="small" appearance="subtle" aria-label={`Actions for ${label}`} />}>
                          <Icon icon={MoreHorizontal} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-w-panel-xs">
                          <DropdownMenuItem onClick={() => setInspect({ what: "image", name: line.ref, load: () => client.docker.images.inspect({ connId, id: line.image.id }) })}>
                            <Icon icon={Code} /> Inspect
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void copy(notify, line.image.id, "image ID")}>
                            <Icon icon={Copy} /> Copy ID
                          </DropdownMenuItem>
                          {line.pull ? (
                            <DropdownMenuItem onClick={() => void copy(notify, line.pull!, "docker pull name")}>
                              <Icon icon={Copy} /> Copy <span className="font-mono">docker pull</span> name
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={running.length > 0}
                            onClick={() => {
                              setForce(false);
                              setConfirm(line);
                            }}
                          >
                            <Icon icon={Delete} /> Remove…
                          </DropdownMenuItem>
                          {running.length > 0 ? (
                            <p className="px-inset-sm py-stack-xs text-caption-1 text-fg-muted">
                              Used by {running.length} running {running.length === 1 ? "container" : "containers"} ({namesText(running)}). Stop and remove {running.length === 1 ? "it" : "them"} first; Docker refuses to remove an image a running container uses.
                            </p>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
        <PageFooter>
          <span>Pull, build and prune are later (DOC-20)</span>
          <span className="flex-1" />
          <span>Remove of an unused image asks once; Force also removes it when stopped containers use it</span>
        </PageFooter>
      </PageRegion>
      <InspectSheet target={inspect} host={profile.name} note={note} onClose={() => setInspect(null)} />
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          {confirm ? <RemoveImageBody line={confirm} host={profile.name} force={force} onForce={setForce} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {confirm ? (
              <AlertDialogAction appearance="danger" loading={busy} onClick={() => void remove(confirm)}>
                {untagsOnly(confirm) ? "Remove tag" : "Remove image"}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/** Removing this row only takes a tag off: the image keeps its other tags. */
export function untagsOnly(line: ImageLine): boolean {
  return line.ref !== line.image.id && line.image.repoTags.length > 1;
}

async function copy(notify: (n: { title: string; description?: string; type: "success" | "warning" }) => void, value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    notify({ title: `Copied ${what}`, description: value, type: "success" });
  } catch {
    notify({ title: `Could not copy ${what}`, description: "The browser refused the clipboard.", type: "warning" });
  }
}

function RemoveImageBody({ line, host, force, onForce }: { line: ImageLine; host: string; force: boolean; onForce(v: boolean): void }) {
  const name = line.ref === line.image.id ? shortId(line.image.id) : line.ref;
  const others = line.image.repoTags.filter((t) => t !== line.ref);
  const stopped = line.image.usedBy.filter((u) => u.state !== "running");
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          Remove <span className="font-mono">{name}</span>?
        </AlertDialogTitle>
        <AlertDialogDescription>
          {untagsOnly(line)
            ? `Only the tag goes: the image stays on ${host} for ${others.length === 1 ? "its other tag" : "its other tags"} ${others.join(", ")}.`
            : `The image (${formatBytes(line.image.size)}) is deleted from ${host} with the layers no other image uses. Pulling it again needs its registry.`}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {!untagsOnly(line) ? (
        <AlertDialogBody className="flex flex-col gap-stack-sm">
          {stopped.length > 0 ? (
            <p className="text-body-1 text-fg">
              Stopped containers use it: {namesText(stopped)}. Docker refuses without Force; with it, the image goes and they cannot start again until it is pulled.
            </p>
          ) : null}
          <label className="flex items-center gap-inline-sm text-body-1 text-fg">
            <Checkbox checked={force} onCheckedChange={(c) => onForce(c === true)} /> Force
            <span className="text-fg-muted">· remove it even when stopped containers use it or other tags point at it</span>
          </label>
        </AlertDialogBody>
      ) : null}
    </>
  );
}
