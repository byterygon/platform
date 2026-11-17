// The in-page half of the desktop acceptance driver (TSK-61), installed by the driver as a Tauri
// initialization script on the `main` window only. It is inert until the driver calls
// `__acc.start(step, args)`; every step works through the DOM the user sees (clicks on the
// tree's chevrons and the toolbar's buttons, the grid's scroller) and the TSK-39 bench hook
// (`__DBEE_BENCH__`, apps/dbee/ui/src/app/bench.ts). Results go to `__acc.results[step]`, which
// the driver polls with `eval_with_callback`. Times are `performance.now()` deltas: a condition
// is checked once per animation frame, so a duration includes the frame that showed the change.
(() => {
  if (window.__acc) return;
  // The page's console errors and warnings and uncaught errors, for the report.
  const logs = [];
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logs.push(`${level}: ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`.slice(0, 500));
      original(...args);
    };
  }
  window.addEventListener("error", (e) => logs.push(`uncaught: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => logs.push(`unhandled rejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  window.__DBEE_BENCH__ = {};
  const hook = window.__DBEE_BENCH__;
  const results = {};
  const now = () => performance.now();
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(predicate, timeoutMs, what) {
    const t0 = now();
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await frame();
    }
  }
  const items = () => [...document.querySelectorAll('[role="treeitem"]')];
  const label = (el) => (el.querySelector('[data-slot="tree-label"]') ?? el).textContent.trim();
  const treeItem = (name) => items().find((el) => label(el) === name || label(el).startsWith(`${name} `) || el.textContent.trim().startsWith(name));
  const chevron = (el) => el.querySelector('[data-slot="tree-chevron"]') ?? el;
  // Double click is the node's action (as Enter): on a disconnected connection it connects and
  // expands (DOC-18 §3.2, §9 "Connect / disconnect selected: Enter on node").
  const activate = (el) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
  const toolbarButton = (toolbar, text) => [...document.querySelectorAll(`[aria-label="${toolbar}"] button`)].find((b) => b.textContent.includes(text) && !b.disabled);
  const status = () => document.querySelector('[data-pane="results"] [role="status"]')?.textContent.trim() ?? "";
  const quantile = (sorted, q) => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);

  async function refresh() {
    // The display's refresh interval: the median idle rAF interval over 60 frames.
    const d = [];
    let last = await new Promise((resolve) => requestAnimationFrame(resolve));
    for (let i = 0; i < 60; i++) {
      const t = await new Promise((resolve) => requestAnimationFrame(resolve));
      d.push(t - last);
      last = t;
    }
    d.sort((a, b) => a - b);
    return quantile(d, 0.5);
  }

  const steps = {
    // The shell is usable: the connection is in the tree and the editor is mounted.
    async usable({ connection, editor = true }) {
      await until(() => treeItem(connection) && (!editor || document.querySelector(".monaco-editor")), 60000, "the shell");
      return { atMs: now(), userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio };
    },
    // Connect and show the tree: expand the connection (opens the browser session, lists the
    // schemas), then the schema (lists its tables), then its Tables group.
    async tree({ connection, schema, firstTable }) {
      const out = {};
      let t0 = now();
      activate(treeItem(connection));
      await until(() => treeItem(schema), 30000, `schema ${schema}`);
      out.firstLevelMs = now() - t0;
      t0 = now();
      chevron(treeItem(schema)).click();
      await until(() => treeItem("Tables"), 30000, "the Tables group");
      out.schemaExpandMs = now() - t0;
      t0 = now();
      chevron(treeItem("Tables")).click();
      const first = await until(() => treeItem(firstTable), 30000, firstTable);
      out.tablesGroupExpandMs = now() - t0;
      out.tableCount = Number(first.getAttribute("aria-setsize"));
      out.renderedTreeItems = items().length;
      return out;
    },
    // Run the tab's statement (the toolbar's Run, the same action as Ctrl+Enter), time to the
    // first rows painted, then scroll 200 px per frame for `seconds` while the stream runs, then
    // wait for the end of the stream.
    async run({ seconds, tab }) {
      // The active tab is restored from the workspace, which may be the cancel tab of an earlier run.
      if (tab) {
        // Exactly this statement: the cancel tab's title starts with the same text.
        const tabEl = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes(tab) && !t.textContent.includes(`${tab} cross join`));
        if (!tabEl) throw new Error(`no tab ${tab}`);
        tabEl.click();
        await until(() => tabEl.getAttribute("aria-selected") === "true", 5000, "the bench tab");
        await frame();
      }
      const refreshMs = await refresh();
      hook.samples.length = 0;
      const run = toolbarButton("Query", "Run");
      if (!run) throw new Error("no enabled Run button");
      const t0 = now();
      run.click();
      await until(() => hook.grid && hook.grid.progress.rows > 0 && document.querySelector('[role="gridcell"]'), 60000, "the first rows");
      await frame();
      const firstRowsMs = now() - t0;
      const grid = hook.grid;
      const scroller = grid.scroller;
      const rowsAtStart = grid.progress.rows;
      const start = hook.samples.length;
      const s0 = now();
      await new Promise((resolve) => {
        const step = () => {
          scroller.scrollTop += 200;
          if (now() - s0 < seconds * 1000) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      const samples = hook.samples.slice(start);
      const rowsAtEnd = grid.progress.rows;
      const finalRows = () => hook.grid.progress.rows;
      const stateAtEnd = grid.progress.state;
      await until(() => !["schema", "streaming"].includes(hook.grid.progress.state), 600000, "the end of the stream");
      const totalMs = now() - t0;
      await until(() => status() !== "" && !status().includes("…"), 10000, "the final status line");
      const stats = (list) => {
        const d = list.map((s) => s.duration).sort((a, b) => a - b);
        const w = list.map((s) => s.work).sort((a, b) => a - b);
        return { frames: d.length, p50: quantile(d, 0.5), p95: quantile(d, 0.95), p99: quantile(d, 0.99), max: d.at(-1) ?? NaN, over32: d.filter((x) => x > 32).length, long: d.filter((x) => x > 1.5 * refreshMs).length, workP50: quantile(w, 0.5), workP95: quantile(w, 0.95) };
      };
      // Frames while the stream ran: the grid held fewer rows than at the end.
      const streaming = samples.filter((s) => s.rowCount < finalRows());
      return {
        refreshMs,
        firstRowsMs,
        totalMs,
        rows: hook.grid.progress.rows,
        bytes: hook.grid.progress.bytes,
        state: hook.grid.progress.state,
        status: status(),
        scroll: {
          seconds,
          ...stats(samples),
          whileStreaming: stats(streaming),
          rowsAtStart,
          rowsAtEnd,
          stateAtEnd,
        },
      };
    },
    // Run again and press Cancel once rows arrive; the driver compares the click's wall-clock
    // time with the audit entry of the cancel connection.
    async cancel({ afterRows, tab }) {
      const tabEl = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim().startsWith(tab));
      if (!tabEl) throw new Error(`no tab ${tab}`);
      tabEl.click();
      await until(() => tabEl.getAttribute("aria-selected") === "true", 5000, "the cancel tab");
      await frame();
      const previous = hook.grid;
      const run = await until(() => toolbarButton("Query", "Run"), 5000, "an enabled Run button");
      run.click();
      await until(() => hook.grid && hook.grid !== previous && hook.grid.progress.rows >= afterRows, 60000, `${afterRows} rows of the new run`);
      const cancel = toolbarButton("Query", "Cancel");
      if (!cancel) throw new Error(`no Cancel button while running (status: ${status()})`);
      const clickedAtUnixMs = Date.now();
      const rowsAtClick = hook.grid.progress.rows;
      const t0 = now();
      cancel.click();
      await until(() => status().startsWith("Cancel"), 30000, "the cancelled status");
      return { clickedAtUnixMs, rowsAtClick, statusMs: now() - t0, status: status(), rowsKept: hook.grid.progress.rows, state: hook.grid.progress.state };
    },
    async idle({ ms }) {
      await sleep(ms);
      return { jsHeapBytes: performance.memory?.usedJSHeapSize ?? null };
    },

    // Starts a Worker from the app's own decoder asset and reports whether it loads and answers.
    async probeWorker({ asset } = {}) {
      const url = asset ? new URL(asset, location.href).href : performance.getEntriesByType("resource").map((e) => e.name).find((n) => /arrow-worker/.test(n)) ?? [...document.scripts].map((s) => s.src).find(Boolean);
      const scripts = performance.getEntriesByType("resource").map((e) => e.name.replace(location.origin, ""));
      const result = { location: location.href, url, resources: scripts.slice(0, 40) };
      if (!url) return result;
      result.outcome = await new Promise((resolve) => {
        try {
          const w = new Worker(url, { type: "module" });
          const timer = setTimeout(() => resolve("no answer in 5 s"), 5000);
          w.onerror = (e) => { clearTimeout(timer); resolve(`error event: ${e.message ?? e.type}`); };
          w.onmessageerror = () => { clearTimeout(timer); resolve("messageerror"); };
          w.onmessage = (m) => { clearTimeout(timer); resolve(`message: ${JSON.stringify(m.data).slice(0, 200)}`); };
          // The decoder protocol: open a stream and end it at once; a live decoder answers "error" (no schema).
          w.postMessage({ channel: "ambidex.arrow.v1", op: "open", stream: 1 });
          w.postMessage({ channel: "ambidex.arrow.v1", op: "end", stream: 1 });
        } catch (e) {
          resolve(`throws: ${e}`);
        }
      });
      return result;
    },

    // --- flows (DOC-18 §3.2-§3.7, §14): the connection form, the approval dialog, connect, run, delete.

    async empty() {
      const text = await until(() => {
        const t = document.querySelector('[data-slot="empty-state"]')?.textContent ?? "";
        return t.includes("No connections yet") && t;
      }, 30000, "the first-run empty state");
      return { text: text.replace(/\s+/g, " ").trim() };
    },
    // Fills the form as a user would (value setters plus input and blur events, so TanStack Form
    // validates as on typing), continues to approval and reads the dialog. With `approve`, approves
    // and waits for the connection node.
    async add({ name, host, port, database, user, password, tls, caPem, fingerprint, serverName, approve }) {
      const opener = [...document.querySelectorAll("button")].find((b) => (b.textContent.trim().startsWith("Add connection") || (b.getAttribute("aria-label") ?? "").startsWith("Add connection")) && !b.disabled);
      if (!opener) throw new Error("no Add connection button");
      opener.click();
      const sheet = await until(() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector("form")), 10000, "the connection sheet");
      const control = (text) => {
        const lab = [...sheet.querySelectorAll("label")].find((l) => l.textContent.trim() === text);
        if (!lab) throw new Error(`no field ${text}`);
        const byFor = lab.htmlFor ? document.getElementById(lab.htmlFor) : null;
        const el = byFor && byFor.matches("input,textarea") ? byFor : lab.closest('[data-slot="field"]')?.querySelector("input,textarea") ?? byFor;
        if (!el) throw new Error(`no control for ${text}`);
        return el;
      };
      const fill = (text, value) => {
        const el = control(text);
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        el.focus();
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
      };
      fill("Name", name);
      fill("Host", host);
      fill("Port", port);
      fill("Database", database);
      fill("User", user);
      if (password !== undefined) fill("Password", password);
      const radioText = { "deployment-ca": "Required, deployment CAs", "pinned-ca": "Required, pinned CA file", "pinned-cert": "Required, pinned server certificate", plaintext: "Plaintext" }[tls];
      const radioLabel = [...sheet.querySelectorAll("label")].find((l) => l.textContent.trim() === radioText);
      if (!radioLabel) throw new Error(`no TLS option ${tls}`);
      (radioLabel.querySelector('[role="radio"]') ?? radioLabel).click();
      await frame();
      if (tls === "pinned-ca") {
        const input = await until(() => sheet.querySelector('input[type="file"]'), 5000, "the CA file input");
        const dt = new DataTransfer();
        dt.items.add(new File([caPem], "ca.pem", { type: "application/x-pem-file" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await until(() => sheet.textContent.includes("Loaded; the digest is shown at approval."), 5000, "the CA file loaded");
      }
      if (tls === "pinned-cert") fill("Server certificate fingerprint", fingerprint);
      if (serverName) fill("Server name (optional)", serverName);
      await frame();
      const submit = [...sheet.querySelectorAll('button[type="submit"]')][0];
      submit.click();
      const dialog = await until(() => document.querySelector('[role="alertdialog"]'), 15000, "the approval dialog");
      await until(() => dialog.querySelector("dt"), 5000, "the approval details");
      const fields = {};
      for (const dt of dialog.querySelectorAll("dt")) fields[dt.textContent.trim()] = dt.nextElementSibling?.textContent.replace(/\s+/g, " ").trim() ?? "";
      const title = dialog.querySelector("h2")?.textContent.trim() ?? "";
      const buttons = [...dialog.querySelectorAll("button")].map((b) => b.textContent.trim());
      const alert = dialog.querySelector('[role="alert"]')?.textContent.replace(/\s+/g, " ").trim() ?? null;
      if (approve) {
        const ok = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Approve"));
        ok.click();
        await until(() => !document.querySelector('[role="alertdialog"]') && treeItem(name), 15000, "the new connection node");
      }
      return { title, fields, buttons, alert, node: approve ? treeItem(name).textContent.replace(/\s+/g, " ").trim() : null };
    },
    // Expands the connection node; reports the schemas it lists or the error the UI shows.
    async connect({ name, expectSchema }) {
      const node = treeItem(name);
      if (!node) throw new Error(`no node ${name}`);
      const toasts = () => [...document.querySelectorAll('[data-slot="toast"], [role="alert"], [role="alertdialog"], [role="dialog"]')].map((t) => t.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
      const seen = new Set(toasts());
      activate(node);
      const t0 = now();
      const outcome = await until(() => {
        const text = treeItem(name)?.textContent ?? "";
        if (expectSchema && treeItem(expectSchema)) return { connected: true };
        const err = document.querySelector('[data-slot="tree-error"]');
        if (err) return { connected: false, error: err.textContent.replace(/\s+/g, " ").trim() };
        const fresh = toasts().filter((t) => !seen.has(t) && t.startsWith(`${name}:`));
        if (/error|expired/.test(text.replace(name, "")) || fresh.some((t) => /password/i.test(t))) {
          return { connected: false, shown: fresh.join(" | ") || text };
        }
        return null;
      }, 30000, `the outcome of connecting ${name}`);
      await sleep(300);
      return { ...outcome, ms: now() - t0, node: treeItem(name)?.textContent.replace(/\s+/g, " ").trim() ?? null };
    },
    // Opens a query tab on the connection from its context menu, types the statement into Monaco
    // (its input textarea), runs it and reads the status line and the first row.
    async query({ name, sql }) {
      const node = treeItem(name);
      const r = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5, button: 2 }));
      const item = await until(() => [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim().startsWith("Open query tab")), 5000, "Open query tab");
      item.click();
      await sleep(300);
      const panes = [...document.querySelectorAll('[data-pane="editor"]')].filter((p) => p.offsetParent !== null);
      const pane = panes.at(-1);
      const textarea = await until(() => pane?.querySelector("textarea"), 10000, "the editor");
      textarea.focus();
      await frame();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, sql);
      textarea.setSelectionRange(sql.length, sql.length);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: sql }));
      await until(() => (pane.querySelector(".view-lines")?.textContent ?? "").replace(/\s+/g, " ").includes(sql.slice(0, 20)), 5000, `the editor to show the statement (shows: ${pane.querySelector(".view-lines")?.textContent})`);
      await until(() => toolbarButton("Query", "Run"), 5000, "an enabled Run button");
      toolbarButton("Query", "Run").click();
      await until(() => /rows in|in \d/.test(status()) || document.querySelector('[data-pane="results"] [role="alert"]'), 30000, "the result");
      await frame();
      const cells = [...document.querySelectorAll('[role="row"]')].slice(0, 3).map((row) => [...row.querySelectorAll('[role="gridcell"], [role="columnheader"]')].map((c) => c.textContent.trim()));
      const workers = performance.getEntriesByType("resource").filter((e) => /worker/i.test(e.name)).map((e) => e.name.replace(location.origin, ""));
      return { status: status(), alert: document.querySelector('[data-pane="results"] [role="alert"]')?.textContent.replace(/\s+/g, " ").trim() ?? null, cells, workers };
    },
    // Deletes the connection from its context menu, confirming the destructive dialog.
    async remove({ name }) {
      const node = treeItem(name);
      const r = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5, button: 2 }));
      const item = await until(() => [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim().startsWith("Delete")), 5000, "Delete");
      item.click();
      const dialog = await until(() => document.querySelector('[role="alertdialog"]'), 5000, "the delete confirmation");
      const text = dialog.textContent.replace(/\s+/g, " ").trim();
      [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Delete")).click();
      await until(() => !treeItem(name), 10000, "the node to go");
      return { confirmation: text };
    },
  };

  window.__acc = {
    results,
    start(name, args) {
      results[name] = { pending: true };
      steps[name](args ?? {}).then(
        (value) => {
          results[name] = { ok: value };
        },
        (error) => {
          const tree = items().map((el) => `${el.getAttribute("aria-level")}:${el.getAttribute("aria-expanded")}:${el.textContent.trim()}`);
          results[name] = { error: `${error && error.message ? error.message : error} | tree: ${tree.slice(0, 12).join(" ; ")} | status: ${status()} | console: ${logs.join(" || ")}` };
        },
      );
      return true;
    },
    logs,
    poll(name) {
      return JSON.stringify(results[name] ?? null);
    },
  };
})();
