import { localService, localName, serviceOn } from "./platform-host.js";
import { powershell, psQuote } from "./platform-command.js";
import { paths } from "./platform-paths.js";
import { clipboardApi } from "./platform-clipboard.js";
import { fileApi } from "./platform-files.js";
import { systemApi } from "./platform-system.js";
import { markdownApi } from "./platform-markdown.js";
// md-viewer: a Markdown window and tabs for Herdr. Copyright 2026 zxlew693. Apache-2.0 (see LICENSE, NOTICE).
// Based on the markdown-panel mod by jlopezlira (https://github.com/jlopezlira/herdr-kanso), Apache-2.0;
// reviews (md-review and Done), Escape and "From this terminal" by Johannes Hund (https://github.com/h0ru5),
// from his remix https://github.com/h0ru5/herdr-md-review. Modified here: the window draws its own frame
// and resizes from any edge, maximizes and restores; files open in new tabs; the list has a filter and
// is grouped by folder. This copy is maintained on its own and no longer synced with kanso-panel.
// markdown-handler.sh leaves .md paths opened from outside in data/kanso-open; md-review leaves
// the ones to review in data/markdown-review; watchOpens picks both up.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { appHome, exec, watchFolder, focused, spaces, props, nextCommand, run, openOverlay, closeOverlay, shared, setShared, theme, home, pickFolder, readTextFile, writeTextFile } from "herdr";
import { MarkdownDoc, tildePath } from "./doc.js";
import { afterMount } from "./pure.js";
import { pollStart, pollNext, takeStamp, ArmPoll, asOf } from "./remote-file.js";

const ICONS = "mods/md-viewer/icons";
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);
const folderOf = (path) => paths.dirname(path);
const nameOf = (path) => paths.basename(path);
// A download's toast is a small md-viewer window of its own (Herdr's toast runs one action; this
// one has two). Copies share this module: one toast at a time, and the boot copy's toggle check
// doesn't count it as the panel's window.
const TOAST = { w: 360, h: 68, margin: 16, seconds: 30, tick: 50 };
let toastId = null;
// Where the open window lists (copies share this module): Ctrl+Shift+M from another folder moves
// it there instead of closing it.
let livePlace = null;
// The windows that each show one file ("Open in window"): not the panel's window, so the boot
// copy's toggle check doesn't count them, and Ctrl+Shift+M leaves them open.
const docWindows = new Set();
const samePlace = (a, b) => Boolean(a && b) && (a.on ?? null) === (b.on ?? null)
  && String(a.folder ?? "").replace(/[\\/]+$/, "").toLowerCase() === String(b.folder ?? "").replace(/[\\/]+$/, "").toLowerCase();
const showDownloaded = (file) => {
  if (toastId) closeOverlay(toastId);
  const v = viewport() ?? { width: 1600, height: 1000 };
  toastId = openOverlay({ mod: "md-viewer", kind: "window", frame: "none", width: TOAST.w, height: TOAST.h,
    at: { x: v.width - TOAST.w - TOAST.margin, y: v.height - TOAST.h - TOAST.margin }, props: { reopened: true, toast: file } });
};
const WINDOWS_REVEAL = "using System; using System.Runtime.InteropServices; public static class MdViewerReveal { " +
  "[DllImport(\"shell32.dll\", CharSet = CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bc, out IntPtr pidl, uint sfgaoIn, out uint sfgaoOut); " +
  "[DllImport(\"shell32.dll\")] static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, IntPtr items, uint flags); " +
  "[DllImport(\"ole32.dll\")] static extern int CoInitializeEx(IntPtr reserved, uint init); " +
  "[DllImport(\"ole32.dll\")] static extern void CoTaskMemFree(IntPtr p); " +
  "public static void Show(string path) { path = path.Replace('/', '\\\\'); CoInitializeEx(IntPtr.Zero, 2); IntPtr pidl; uint o; " +
  "int hr = SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out o); if (hr != 0) throw new Exception(\"Cannot find \" + path); " +
  "try { hr = SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0); if (hr != 0) throw new Exception(\"Explorer did not open it (\" + hr + \")\"); } finally { CoTaskMemFree(pidl); } } }";
const checkedReveal = (r) => { if (r?.code) throw new Error(String(r.stderr || "Explorer did not open it").trim()); return r; };
// Where a download goes. Windows: its Save As dialog (shows the files there, lets the copy be
// renamed, asks before replacing one), opened by PowerShell on top of Herdr and starting in the
// folder used last (Downloads at first). Elsewhere Herdr's folder picker, and a name already
// taken there gets " (1)", " (2)"… like a browser's download. Resolves with the path, or null.
const DOWNLOAD_DIR = "md-viewer.download-dir";
async function chooseDownload(name) {
  const last = shared(DOWNLOAD_DIR);
  if (localName() === "windows") {
    const script = [
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
      "$d = New-Object Windows.Forms.SaveFileDialog",
      `$d.Title = ${psQuote(`Download ${name}`)}; $d.FileName = ${psQuote(name)}; $d.OverwritePrompt = $true`,
      "$d.Filter = 'Markdown (*.md)|*.md;*.markdown|All files (*.*)|*.*'",
      `$dir = ${psQuote(typeof last === "string" && last ? last : "")}; if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { $dir = Join-Path $HOME 'Downloads' }`,
      "$d.InitialDirectory = $dir",
      // Exit as soon as it closes: the hidden owner form would otherwise keep PowerShell running.
      "$picked = if ($d.ShowDialog($owner) -eq 'OK') { $d.FileName } else { '' }",
      "$d.Dispose(); $owner.Dispose(); [Console]::Out.Write($picked); [Console]::Out.Flush(); [Environment]::Exit(0)",
    ].join("; ");
    // The dialog waits for the person: give it Herdr's longest wait (10 minutes).
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { timeout: 600000 });
    if (r.code !== 0) throw new Error(String(r.stderr || "the Save As dialog did not open").trim());
    const dest = r.stdout.trim();
    if (dest) setShared(DOWNLOAD_DIR, paths.dirname(dest));
    return dest || null;
  }
  const folder = await pickFolder({ prompt: `Download ${name} to` }).catch(() => null);
  if (!folder) return null;
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  // readTextFile gives null for a missing file (it rejects only when the file can't be read).
  const taken = async (p) => (await readTextFile(p).catch(() => "")) !== null;
  let dest = paths.join(folder, name);
  for (let i = 1; await taken(dest); i++) {
    if (i > 999) throw new Error("too many copies of it there already");
    dest = paths.join(folder, `${stem} (${i})${ext}`);
  }
  return dest;
}

// The folder holding a file of this computer, with the file selected where the system can.
const showInFolder = (file) => {
  const os = localName();
  // Asks the Explorer already running (SHOpenFolderAndSelectItems): Herdr ends what a command
  // starts when it finishes, so starting explorer.exe from here opens nothing.
  if (os === "windows") return powershell(exec, `Add-Type -TypeDefinition ${psQuote(WINDOWS_REVEAL)}; [MdViewerReveal]::Show(${psQuote(file)})`).then(checkedReveal);
  return os === "macos" ? exec("open", ["-R", file]) : exec("xdg-open", [paths.dirname(file)]);
};
const OPEN_DIR = "data/kanso-open", REVIEW_DIR = "data/markdown-review", WAITING_DIR = "data/markdown-review-waiting", DONE_DIR = "data/markdown-review-done";
const RECENT_MAX = 15, MAX_FILES = 500; // the folder list stops at MAX_FILES (shallowest first)
// The window. Herdr's windows can't be resized or moved by a mod, so the panel does it itself:
// - The window has no Herdr frame (frame "none"); the panel draws its own, inside an invisible
//   resize border of RESIZE px, as Windows does.
// - Every window shown is opened by this mod at an explicit spot (`at`), so its top left stays put
//   when its size changes. mod.open's own window (centered, which Herdr re-centers on every size
//   change) only reopens itself at the same spot ("boot").
// - Right, bottom and that corner resize in place; while dragging, the window reaches to the edges
//   of Herdr so the pointer can't leave it. Left and top move the window: the drag goes on in a
//   transparent layer over all of Herdr ("canvas"), and on release a window opens at the new spot.
// - Maximize fills Herdr; restore goes back to the size and spot it had.
// A swap hands the panel's state (open file, edits, scroll, list) to the next window: nothing reloads.
// mod.open closes only the window it opened, so Ctrl+Shift+M reaches a "boot" copy, which closes the
// shown window instead when there is one.
const NORMAL_W = 560, WINDOW_KEY = "md-viewer.reopened", SIZE_KEY = "md-viewer.size";
const RESIZE = 6, MIN_W = 360, MIN_H = 240;
const HANDOFF = new Map(); // module scope is shared by every copy of this version
const savedSize = (v) => {
  const s = shared(SIZE_KEY);
  const w = Number(s?.w) > 0 ? Number(s.w) : NORMAL_W, h = Number(s?.h) > 0 ? Number(s.h) : Math.round(v.height * 0.9);
  return { w: Math.round(Math.max(MIN_W, Math.min(w, v.width - 2 * RESIZE))), h: Math.round(Math.max(MIN_H, Math.min(h, v.height - 2 * RESIZE))) };
};
const viewport = () => { try { return globalThis.window.viewport_size(); } catch { return null; } };

// Reads and removes the paths waiting in the inbox, oldest first.
export async function takeAllOpens(dir) {
  const r = await localService(fileApi).drain(dir);
  return (r.stdout ?? "").split("\0").map((p) => p.trim()).filter((p) => paths.isAbsolute(p));
}
// The newest of them.
export async function takeOpens(dir) { return (await takeAllOpens(dir)).at(-1) ?? null; }

// The reviews `md-review` still waits on, as [{ id, path }]: one file per waiting process,
// named by its pid; one whose process is gone is removed.
export async function waitingReviews(dir) {
  const r = await localService(markdownApi).waiting(dir);
  return reviewsIn(r.stdout ?? "");
}
export const reviewsIn = (out) => out.split("\0").map((l) => l.split("\t")).filter(([id, path]) => /^\d+$/.test(id ?? "") && path && paths.isAbsolute(path)).map(([id, path]) => ({ id, path: path.trim() }));

export function markdownIn(listing) {
  return listing.split("\n").map((l) => l.trim()).filter((l) => /\.(md|markdown|mdx)$/i.test(l))
    .toSorted((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b)).slice(0, MAX_FILES);
}

// The focused pane's machine (null: this one) and folder. A pane on an SSH
// machine has a folder on that machine, so its files are listed and read there.
export function placeOf(focus, list, localHome) {
  const space = list.find((s) => s.id === focus?.space);
  const on = space?.machine ?? null;
  return { on, folder: focus?.cwd || space?.folder || (on ? "" : localHome) };
}

// "From this terminal": what recent.sh printed, existing absolute Markdown paths, once each, best first.
export function recentIn(listing) {
  return [...new Set(listing.split("\n").map((l) => l.trim()).filter((l) => paths.isAbsolute(l) && isMarkdown(l)))].slice(0, RECENT_MAX);
}

export default class MdViewer extends View {
  init(_props, cx) {
    this.doc = null; this.files = null; this.recent = [];
    this.reviewing = []; // the reviews `md-review` waits on ({ id, path }); their files show Done
    this.notice = null;
    const { on, folder } = placeOf(focused(), spaces(), home());
    this.on = on; this.folder = folder;
    this.handle = cx.focus_handle();
    // A binding, not on_key_down: a focused Textarea takes Escape first.
    cx.bind_keys(["MdViewer", "MdViewer > Input"].map((context) => ({ keystroke: "escape", action: "md_viewer_escape", context })));
    const given = props() ?? {};
    const v = viewport() ?? { width: 1600, height: 1000 };
    if (typeof given.toast === "string") {
      this.mode = "toast"; this.toastFile = given.toast; this.full = false;
      // It counts down (the strip along its bottom) and waits while the pointer is on it.
      // Timed by the clock (timer ticks run late); `left` is what remains while it waits.
      this.hovered = false; this.left = TOAST.seconds * 1000; this.until = Date.now() + this.left;
      cx.timer.every(TOAST.tick, (cx) => {
        if (this.hovered || this.gone) return;
        this.left = this.until - Date.now();
        if (this.left <= 0) { this.gone = true; this.dismiss(); } else cx.notify();
      });
      return;
    }
    this.drag = null; this.grow = false; this.handedOff = false;
    if (typeof given.file === "string" && given.file) {
      // A pane (a tab opened with "Open in new tab"): the file, sized by its pane, no window.
      this.mode = "pane"; this.full = false;
      this.makeFilter("");
      afterMount(cx, (cx) => { this.list(cx); this.open(given.file, cx, given.on ?? null); });
      this.listen(cx);
      return;
    }
    if (given.reopened !== true) {
      // mod.open's copy: centered, as the window will be. It only places the real one.
      this.mode = "boot"; this.full = false;
      const s = savedSize(v);
      this.rect = { x: Math.round((v.width - s.w) / 2), y: Math.round((v.height - s.h) / 2), ...s };
      this.win = { x: this.rect.x - RESIZE, y: this.rect.y - RESIZE };
      afterMount(cx, (cx) => this.boot(cx));
      return;
    }
    this.mode = given.canvas ? "canvas" : "window";
    this.full = given.full === true;
    this.rect = given.rect;                 // the panel, in Herdr's coordinates
    this.restore = given.restore ?? null;   // the rect to go back to from full screen
    this.win = given.at ?? { x: 0, y: 0 };  // where this window's top left is
    this.drag = given.drag ?? null;         // a resize begun in the window before this one
    this.docWin = given.docWin === true;    // a window of one file, over every space
    if (given.overlay) { if (this.docWin) docWindows.add(given.overlay); else setShared(WINDOW_KEY, given.overlay); }
    const handed = given.handoff ? HANDOFF.get(given.handoff) : null;
    if (handed) { HANDOFF.delete(given.handoff); Object.assign(this, handed); }
    this.makeFilter(handed?.filterText ?? "");
    // Files sent to md-viewer (Ctrl-click, md-review) go to the panel's window, not a file's.
    if (!this.docWin) {
      this.watchOpens(cx, OPEN_DIR, false);
      this.watchOpens(cx, REVIEW_DIR, true);
      this.watchReviews(cx);
    }
    this.listen(cx);
    afterMount(cx, (cx) => {
      if (!handed && this.docWin) { this.open(given.windowFile, cx, given.on ?? null); return; }
      if (!handed) { this.list(cx); this.findRecent(focused()?.terminal ?? null, cx); return; }
      // The window before this one watched the file and timed the save; this one does now.
      if (this.doc) { this.watch(this.doc.path, cx); if (this.doc.dirty) this.doc.later(cx); }
    });
  }

  // mod.open's copy: closes the shown window (Ctrl+Shift+M pressed while one is open), or opens the
  // real window at this one's spot.
  boot(cx) {
    cx.spawn(async () => {
      const other = shared(WINDOW_KEY);
      if (typeof other === "string" && other) {
        const r = await exec("herdr-app", ["status"]).catch(() => null);
        const count = (String(r?.stdout ?? "").match(/"md-viewer"/g) ?? []).length - (toastId ? 1 : 0) - docWindows.size;
        setShared(WINDOW_KEY, null);
        if (count >= 2) {
          // Pressed from another folder: the open window shows that one; from its own, it closes.
          const here = placeOf(focused(), spaces(), home());
          if (livePlace && !samePlace(here, livePlace)) { setShared(WINDOW_KEY, other); run("md-viewer.retarget"); this.closeSelf(); return; }
          closeOverlay(other); this.closeSelf(); return;
        }
        // Otherwise it was left over from a window that closed without saying so.
      }
      this.swap({ rect: this.rect });
    });
  }

  // The list's filter box. Its text goes to the next window on a swap.
  makeFilter(value) {
    this.filterText = value;
    this.filter = InputState.new({ placeholder: "Filter Markdown files", value });
    this.filter.on("change", (_e, cx) => { this.filterText = this.filter.value(); cx.notify(); });
  }

  clearFilter(cx) {
    this.filter?.set_value(""); this.filterText = "";
    cx.notify();
  }

  closeSelf() {
    this.handedOff = true;
    const id = props()?.overlay;
    docWindows.delete(id);
    if (id) closeOverlay(id);
  }

  // Opens the next window and closes this one, handing it the panel's state.
  //   full: fills Herdr; canvas: a layer over all of Herdr while a left/top resize goes on.
  swap({ rect, full = false, restore = null, canvas = false, drag = null }) {
    const at = full || canvas ? { x: 0, y: 0 } : { x: rect.x - RESIZE, y: rect.y - RESIZE };
    const token = this.mode === "boot" ? null : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (token) HANDOFF.set(token, { doc: this.doc, files: this.files, recent: this.recent, reviewing: this.reviewing,
      folder: this.folder, on: this.on, notice: this.notice, poll: this.poll, filterText: this.filterText });
    openOverlay({ mod: "md-viewer", kind: "window", frame: "none", at,
      props: { reopened: true, handoff: token, full, rect, restore, canvas, drag, at, docWin: this.docWin === true } });
    this.doc = null; // the next window has it now
    this.closeSelf();
  }

  findRecent(terminal, cx) {
    if (this.on) return;
    cx.spawn(async (cx) => {
      const r = await localService(markdownApi).recent(terminal, home(), appHome(), localService(clipboardApi).read(cx) ?? "").catch(() => null);
      this.recent = recentIn(r?.stdout ?? "");
      cx.notify();
    });
  }

  // Ctrl+Shift+M from another folder: this window lists that folder (a file open here is saved
  // and closed first). Only the window does this, not a file's tab.
  retarget(cx) {
    if (this.mode !== "window" && this.mode !== "canvas") return;
    const doc = this.doc;
    cx.spawn(async (cx) => {
      if (doc) { if (!(await doc.flush())) { cx.notify(); return; } doc.release(); this.doc = null; }
      this.clearFilter(cx);
      this.refreshList(cx);
    });
  }

  // The list again: the focused pane's folder now (it may have moved), its files, and the terminal's.
  refreshList(cx) {
    const { on, folder } = placeOf(focused(), spaces(), home());
    this.on = on; this.folder = folder; this.files = null; this.recent = [];
    cx.notify();
    this.list(cx); this.findRecent(focused()?.terminal ?? null, cx);
  }

  list(cx) {
    const on = this.on;
    cx.spawn(async (cx) => {
      // A machine's home when its pane told no folder: where its commands start.
      const files = await serviceOn(fileApi, on);
      const folder = this.folder || await (await serviceOn(systemApi, on)).userHome();
      this.folder = folder;
      const where = { cwd: folder || undefined, on };
      const git = await exec("git", ["ls-files", "--", "*.md", "*.markdown", "*.mdx"], where).catch(() => null);
      const fallback = git?.code === 0 && git.stdout.trim() ? null : await files.walk([folder], { depth: 3, skip: ["node_modules"] });
      const out = fallback ? fallback.filter((file) => /\.(md|mdx)$/i.test(file)).map((file) => paths.relative(folder, file)).join("\n") : git.stdout;
      this.files = markdownIn(out.replace(/^\.\//gm, ""));
      cx.notify();
    });
  }

  watchOpens(cx, inbox, review) {
    const dir = paths.join(appHome(), inbox);
    cx.spawn(async (cx) => {
      try {
        await localService(fileApi).mkdir(dir);
        for (;;) {
          const paths = (await takeAllOpens(dir)).filter(isMarkdown);
          if (paths.length) this.open(paths.at(-1), cx, null, review);
          await watchFolder(dir);
        }
      } catch { /* no inbox: nothing opens from outside */ }
    });
  }

  // What waits is kept by md-review itself, so closing the window or many agents asking at once loses none.
  watchReviews(cx) {
    const dir = paths.join(appHome(), WAITING_DIR);
    cx.spawn(async (cx) => {
      try {
        await localService(fileApi).mkdir(dir);
        for (;;) {
          this.reviewing = await waitingReviews(dir);
          cx.notify();
          await watchFolder(dir);
        }
      } catch { /* no folder: no reviews */ }
    });
  }

  // Saves what you typed in the file shown before, then shows this one.
  // on: the machine the file is on (null: this one); paths opened from outside are here.
  // review: `md-review` waits on it. While the file shown before can't be saved (a conflict
  // to settle), a review waits for it instead of being dropped, since an agent waits on it.
  open(path, cx, on = null, review = false) {
    const before = this.doc;
    cx.spawn(async (cx) => {
      if (before && !(await before.flush())) {
        cx.notify();
        if (!review) return;
        await cx.sleep(1000);
        this.open(path, cx, on, review);
        return;
      }
      before?.release();
      this.notice = null;
      this.doc = new MarkdownDoc(path, on, (to) => { if (isMarkdown(to)) this.open(to, cx, on); }, ICONS);
      this.doc.load(cx);
      this.watch(path, cx);
      cx.notify();
    });
  }

  // Another machine's folder can't be watched from here: one stat, and a read only when it changed.
  watch(path, cx) {
    const doc = this.doc, dir = folderOf(path);
    if (!doc?.on) {
      cx.spawn(async (cx) => {
        try { while (this.doc === doc) { await watchFolder(dir); if (this.doc === doc) doc.load(cx); } } catch {}
      });
      return;
    }
    this.poll = pollStart(); this.stamp = null; this.arm = null;
    new ArmPoll(this).start(cx, (tick) => this.probeDoc(doc, path, tick));
  }

  probeDoc(doc, path, cx) {
    if (this.doc !== doc) return;
    cx.spawn(async (cx) => {
      const { outcome, next } = await takeStamp(async () => (await serviceOn(fileApi, doc.on)).stat(path), this.stamp);
      if (this.doc !== doc) return;
      if (outcome === "seen") this.stamp = next;
      if (outcome === "changed") { this.stamp = next; doc.load(cx); }
      if (outcome === "failed" && this.doc?.saved != null) this.doc.held = { at: this.doc.fresh ?? Date.now() };
      this.poll = pollNext(this.poll, outcome);
      this.arm = null;
      if (this.doc === doc) new ArmPoll(this).start(cx, (tick) => this.probeDoc(doc, path, tick));
      cx.notify();
    });
  }

  // Also what Herdr calls when this window goes; after a swap there is nothing left to do.
  close(cx) {
    if (this.handedOff) return;
    const doc = this.doc, id = props()?.overlay;
    if (id && shared(WINDOW_KEY) === id) setShared(WINDOW_KEY, null);
    docWindows.delete(id);
    const done = () => { if (id) closeOverlay(id); };
    if (!doc) { done(); return; }
    cx.spawn(async (cx) => {
      if (!(await doc.flush())) { cx.notify(); return; }
      doc.release(); this.doc = null;
      done();
    });
  }

  // Saves, tells `md-review` the review is finished, closes.
  done(cx) {
    const doc = this.doc;
    if (!doc) return;
    cx.spawn(async (cx) => {
      if (!(await doc.flush())) { cx.notify(); return; }
      // Every md-review waiting on this file is answered.
      const ids = this.reviewing.filter((x) => x.path === doc.path).map((x) => x.id);
      const dir = paths.join(appHome(), DONE_DIR);
      const r = await localService(fileApi).mkdir(dir).then(() => localService(fileApi).touch(ids.map((id) => paths.join(dir, id)))).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) { this.notice = `md-review was not told: ${(r.stderr || "the marker could not be written").trim()}`; cx.notify(); return; }
      this.reviewing = this.reviewing.filter((x) => x.path !== doc.path); this.notice = null;
      // Another review still waits: show it rather than close.
      if (this.reviewing.length) this.open(this.reviewing.at(-1).path, cx, null, true); else this.close(cx);
    });
  }

  // A new tab in the focused space whose only pane shows this file (split a shell beside it like
  // any tab). The tab is named after the file.
  // A file in a window of its own: floats over every space (a tab stays in its space), moves,
  // resizes and maximizes like this one. Each new one opens a little lower right than the last.
  openInWindow(path, on = null) {
    const v = viewport() ?? { width: 1600, height: 1000 };
    const s = savedSize(v), step = 28 * ((docWindows.size % 8) + 1);
    const rect = this.fit({ x: Math.round((v.width - s.w) / 2) + step, y: Math.round((v.height - s.h) / 2) + step, ...s });
    const at = { x: rect.x - RESIZE, y: rect.y - RESIZE };
    openOverlay({ mod: "md-viewer", kind: "window", frame: "none", at,
      props: { reopened: true, docWin: true, windowFile: path, on, rect, at } });
  }

  docInWindow(cx) {
    const doc = this.doc;
    if (!doc) return;
    cx.spawn(async (cx) => {
      if (!(await doc.flush())) { cx.notify(); return; }
      this.openInWindow(doc.path, doc.on);
    });
  }

  openInTab(path, on = null) {
    run("tab.new", { name: nameOf(path), mod: "md-viewer", props: { file: path, on } });
  }

  // The file shown here, in a new tab: what you typed is saved first, so the tab reads it.
  docInTab(cx) {
    const doc = this.doc;
    if (!doc) return;
    cx.spawn(async (cx) => {
      if (!(await doc.flush())) { cx.notify(); return; }
      this.openInTab(doc.path, doc.on);
    });
  }

  // "md-viewer.full" (a key or `herdr-app do`) does what the button does.
  listen(cx) {
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (this.docWin) continue; if (c === "full") this.toggleFull(cx); if (c === "retarget") this.retarget(cx); } });
  }

  // A copy of a file, where the person chooses (chooseDownload: Save As on Windows). For the file
  // shown here it is what is on screen now, edits included; from the list, the file as it is (read
  // from its machine, so a file on another machine comes here).
  download(cx) {
    const doc = this.doc;
    if (!doc) return;
    const text = doc.text ?? doc.saved;
    if (text == null) { this.notice = "Nothing to download yet: the file has not been read."; cx.notify(); return; }
    this.downloadFile(doc.path, doc.on, text, cx);
  }

  downloadFile(path, on, text, cx) {
    const name = nameOf(path);
    cx.spawn(async (cx) => {
      try {
        const dest = await chooseDownload(name);
        if (!dest) return;
        if (text == null) text = on ? await (await serviceOn(fileApi, on)).read(path) : await readTextFile(path);
        if (text == null) throw new Error("it is no longer there");
        // Replacing a file the person agreed to replace: what is there now is what we expect.
        const there = await readTextFile(dest).catch(() => null);
        await writeTextFile(dest, text, there);
        this.notice = null;
        showDownloaded(dest);
      } catch (e) {
        this.notice = `Could not download ${name}: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  // Maximize fills Herdr; restore goes back to the size and spot the window had.
  toggleFull() {
    if (this.mode !== "window" || this.drag) return;
    if (!this.full) this.swap({ rect: this.rect, full: true, restore: this.rect });
    else this.swap({ rect: this.fit(this.restore ?? this.rect) });
  }

  // A rect kept inside Herdr and at least the smallest size.
  fit(r) {
    const v = viewport() ?? { width: 1600, height: 1000 };
    const w = Math.round(Math.max(MIN_W, Math.min(r.w, v.width - 2 * RESIZE)));
    const h = Math.round(Math.max(MIN_H, Math.min(r.h, v.height - 2 * RESIZE)));
    const x = Math.round(Math.max(RESIZE, Math.min(r.x, v.width - RESIZE - w)));
    const y = Math.round(Math.max(RESIZE, Math.min(r.y, v.height - RESIZE - h)));
    return { x, y, w, h };
  }

  // A press on a resize edge. Right and bottom keep the window's top left, so they resize in place
  // (the window reaches to Herdr's edges meanwhile); left and top go on in the canvas.
  startResize(edge, e, cx) {
    cx.stop_propagation();
    if (this.full || this.mode !== "window") return;
    const drag = { edge, x0: e.position.x, y0: e.position.y, rect0: this.rect };
    if (edge.l || edge.t) { this.swap({ rect: this.rect, canvas: true, drag }); return; }
    this.drag = drag; this.grow = true;
    cx.notify();
  }

  // The opposite edges stay where they are, as in any window.
  moveResize(e, cx) {
    const d = this.drag;
    if (!d) return;
    const v = viewport() ?? { width: 1600, height: 1000 };
    const dx = e.position.x - d.x0, dy = e.position.y - d.y0, r0 = d.rect0;
    let { x, y, w, h } = r0;
    if (d.edge.r) w = Math.min(r0.w + dx, v.width - RESIZE - r0.x);
    if (d.edge.b) h = Math.min(r0.h + dy, v.height - RESIZE - r0.y);
    if (d.edge.l) { w = Math.min(r0.w - dx, r0.x + r0.w - RESIZE); }
    if (d.edge.t) { h = Math.min(r0.h - dy, r0.y + r0.h - RESIZE); }
    w = Math.round(Math.max(MIN_W, w)); h = Math.round(Math.max(MIN_H, h));
    if (d.edge.l) x = r0.x + r0.w - w;
    if (d.edge.t) y = r0.y + r0.h - h;
    if (x === this.rect.x && y === this.rect.y && w === this.rect.w && h === this.rect.h) return;
    this.rect = { x, y, w, h };
    cx.notify();
  }

  endResize(cx) {
    if (!this.drag) return;
    this.drag = null; this.grow = false;
    setShared(SIZE_KEY, { w: this.rect.w, h: this.rect.h });
    if (this.mode === "canvas") this.swap({ rect: this.rect });
    else cx.notify();
  }

  // Herdr moved the window (a drag on the panel): the panel moved with it.
  track(e) {
    const b = e.bounds;
    if (!b || this.drag || this.full || this.mode !== "window") return;
    if (b.x === this.win.x && b.y === this.win.y) return;
    this.win = { x: b.x, y: b.y };
    this.rect = { ...this.rect, x: b.x + RESIZE, y: b.y + RESIZE };
  }

  // The invisible resize border around the panel, at its spot inside this window.
  resizeHandles(px, py, w, h) {
    const T = RESIZE, IN = 3, C = 14; // border outside, overlap inside, corner square
    const zone = (id, x, y, zw, zh, edge, cursor) => cursor(div().id(id).absolute().left(x).top(y).w(zw).h(zh))
      .on_mouse_down("left", (e, cx) => this.startResize(edge, e, cx));
    return [
      zone("md-rz-l", px - T, py + C - T, T + IN, h - 2 * (C - T), { l: 1 }, (el) => el.cursor_ew_resize()),
      zone("md-rz-r", px + w - IN, py + C - T, T + IN, h - 2 * (C - T), { r: 1 }, (el) => el.cursor_ew_resize()),
      zone("md-rz-t", px + C - T, py - T, w - 2 * (C - T), T + IN, { t: 1 }, (el) => el.cursor_ns_resize()),
      zone("md-rz-b", px + C - T, py + h - IN, w - 2 * (C - T), T + IN, { b: 1 }, (el) => el.cursor_ns_resize()),
      zone("md-rz-tl", px - T, py - T, C, C, { l: 1, t: 1 }, (el) => el.cursor_nwse_resize()),
      zone("md-rz-br", px + w + T - C, py + h + T - C, C, C, { r: 1, b: 1 }, (el) => el.cursor_nwse_resize()),
      zone("md-rz-tr", px + w + T - C, py - T, C, C, { r: 1, t: 1 }, (el) => el.cursor_nesw_resize()),
      zone("md-rz-bl", px - T, py + h + T - C, C, C, { l: 1, b: 1 }, (el) => el.cursor_nesw_resize()),
    ];
  }

  back(cx) {
    const doc = this.doc;
    if (!doc) return;
    cx.spawn(async (cx) => {
      if (!(await doc.flush())) { cx.notify(); return; }
      doc.release(); this.doc = null;
      cx.notify();
    });
  }

  dismiss() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
    if (toastId === id) toastId = null;
  }

  // The toast after a download: its buttons open the copy in a tab or show it in Explorer
  // (Finder on macOS). Only the close button or the countdown takes it away; clicks don't.
  toastView(t) {
    const file = this.toastFile, stop = (_e, cx) => cx.stop_propagation();
    const action = (id, icon, tip, fn) => div().id(id).flex_none().p(6).rounded(6).cursor_pointer().text_color(t.muted).tooltip(tip)
      .hover((s) => s.bg(t.raised).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(); })
      .child(svg(`${ICONS}/${icon}.svg`).size(15));
    // The hover color is see-through, so it sits on an opaque layer: nothing behind shows.
    const share = Math.max(0, Math.min(1, this.left / (TOAST.seconds * 1000)));
    return div().size_full().relative().rounded(8).overflow_hidden().bg(t.popover).child(h_flex().id("md-toast").size_full().pl(16).pr(8).gap(12).items_center()
      .rounded(8).border_1().border_color(t.border).on_mouse_down("left", stop)
      .on_hover((hovered, cx) => {
        if (hovered === this.hovered) return;
        if (hovered) this.left = Math.max(0, this.until - Date.now());
        else this.until = Date.now() + this.left;
        this.hovered = hovered; cx.notify();
      })
      .child(div().size(8).rounded(4).flex_none().bg(t.done))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(`Downloaded ${nameOf(file)}`))
        .child(div().truncate().text_size(12).text_color(t.muted).child(file)))
      .child(action("md-toast-tab", "open-tab", "Open in new tab", () => this.openInTab(file)))
      .child(action("md-toast-folder", "folder-open", "Show in folder", () => { showInFolder(file).catch(() => {}); }))
      .child(action("md-toast-close", "close", "Dismiss", () => this.dismiss())))
      // Time left: full at first, empty when it goes; dimmer while it waits under the pointer.
      .child(div().absolute().left(0).bottom(0).h(3).w(Math.round(TOAST.w * share)).bg(t.accent).opacity(this.hovered ? 0.4 : 1));
  }

  render() {
    const t = theme();
    if (this.mode === "toast") return this.toastView(t);
    if ((this.mode === "window" || this.mode === "canvas") && !this.docWin) livePlace = { folder: this.folder, on: this.on };
    const doc = this.doc;
    const button = (id, icon, tip, action) => div().id(id).p(4).rounded(6).cursor_pointer().text_color(t.muted).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => action(cx))
      .child(svg(`${ICONS}/${icon}.svg`).size(14));
    // Where the panel is (in Herdr's coordinates) and how far this window reaches.
    const v = viewport() ?? { width: 1600, height: 1000 };
    const pane = this.mode === "pane";
    const full = this.full;
    const r = full ? { x: 0, y: 0, w: v.width, h: v.height } : (this.rect ?? { x: 0, y: 0, w: NORMAL_W, h: 600 });
    const win = full || this.mode === "canvas" || !this.win ? { x: 0, y: 0 } : this.win;
    const reach = full || this.mode === "canvas" || this.grow
      ? { x: v.width, y: v.height } : { x: r.x + r.w + RESIZE, y: r.y + r.h + RESIZE };
    const px = r.x - win.x, py = r.y - win.y;
    const reviewing = Boolean(doc) && !doc.on && this.reviewing.some((x) => x.path === doc.path);
    const panel = v_flex().id("md-viewer").key_context("MdViewer").track_focus(this.handle)
      .on_action("md_viewer_escape", (_e, cx) => {
        if (doc && doc.active !== null) { doc.close(); cx.notify(); }
        else if (!doc && this.filterText) this.clearFilter(cx); // Escape clears the filter first
        else if (!pane) this.close(cx);
      })
      .when(pane, (el) => el.size_full())
      .when(!pane, (el) => el.absolute().left(px).top(py).w(r.w).h(r.h))
      .overflow_hidden()
      .when(!full && !pane, (el) => el.rounded(8).border_1().border_color(t.border).shadow_lg())
      // A maximized window stays put: a press on it doesn't drag it.
      .when(full, (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()))
      .min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => doc?.key(e, cx))
      .child(h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(doc) && !this.docWin, (el) => el.child(button("md-back", "chevron-left", "Markdown in this folder", (cx) => this.back(cx))))
        .child(v_flex().flex_1().min_w(0).pl(doc && !this.docWin ? 0 : 4)
          .child(div().truncate().font_semibold().child(doc ? nameOf(doc.path) : "Markdown"))
          .child(div().truncate().text_size(11).text_color(t.dim).child(`${tildePath(doc ? folderOf(doc.path) : this.folder, doc ? doc.on : this.on)}${doc?.held ? ` · ${asOf(doc.held.at, Date.now())}` : ""}`)))
        .children(doc ? doc.controls(t, "md") : [])
        .when(Boolean(doc) && !doc.editing, (el) => el.child(button("md-refresh", "refresh", doc.held ? "Retry" : "Read again", (cx) => { this.poll = pollStart(); doc.load(cx); })))
        .when(!doc, (el) => el.child(button("md-refresh-list", "refresh", "Look for Markdown again", (cx) => this.refreshList(cx))))
        .when(reviewing, (el) => el.child(div().id("md-done").flex_none().px(8).py(3).rounded(6).cursor_pointer().text_size(12)
          .bg(t.raised).border_1().border_color(t.border).tooltip("Review done: tell the agent").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.done(cx)).child("Done")))
        .when(Boolean(doc), (el) => el.child(button("md-download", "download", "Download a copy", (cx) => this.download(cx))))
        .when(Boolean(doc) && !this.docWin, (el) => el.child(button("md-win", "open-window", "Open in window (stays over every space)", (cx) => this.docInWindow(cx))))
        .when(Boolean(doc) && !pane, (el) => el.child(button("md-tab", "open-tab", "Open in new tab", (cx) => this.docInTab(cx))))
        .when(!pane, (el) => el
          .child(button("md-full", this.full ? "restore" : "maximize", this.full ? "Restore window" : "Full screen", (cx) => this.toggleFull(cx)))
          .child(button("md-close", "close", "Close", (cx) => this.close(cx)))))
      .when(Boolean(this.notice), (el) => el.child(div().flex_none().px(14).py(6).text_size(12).text_color(t.blocked).border_b(1).border_color(t.border).child(this.notice ?? "")))
      .child(doc ? doc.body(t, "md-doc") : this.listView(t));
    // The window: transparent, the panel and its resize border inside. While resizing, a release
    // (or a press, if a release was missed outside Herdr) ends it.
    if (pane) return panel;
    return div().id("md-window").relative().w(reach.x - win.x).h(reach.y - win.y)
      .on_mouse_move((e, cx) => { this.track(e); this.moveResize(e, cx); })
      .on_mouse_up("left", (_e, cx) => this.endResize(cx))
      .when(Boolean(this.drag), (el) => el.on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.endResize(cx); }))
      .child(panel)
      .when(!full && this.mode !== "boot", (el) => el.children(this.resizeHandles(px, py, r.w, r.h)));
  }

  // The files: a filter box, then reviews waiting, files the terminal mentioned, and the folder's
  // files grouped by subfolder. A click shows a file here; the icon at a row's end opens a new tab.
  listView(t) {
    const q = (this.filterText ?? "").trim().toLowerCase();
    const hit = (p) => !q || p.toLowerCase().includes(q);
    // Relative paths can use either separator (git prints "/", a folder walk on Windows "\").
    const parts = (f) => { const bits = String(f).split(/[\\/]/).filter(Boolean); return { name: bits.at(-1) ?? f, dir: bits.slice(0, -1).join("/") }; };
    const sep = String(this.folder).includes("\\") ? "\\" : "/";
    const absolute = (f) => `${this.folder}${sep}${String(f).replace(/[\\/]/g, sep)}`;
    const shortDir = (p) => tildePath(paths.dirname(p), null);

    const all = this.files ?? [];
    const files = all.filter(hit);
    const waiting = [...new Set(this.reviewing.map((x) => x.path))].filter(hit);
    const recent = this.recent.filter(hit);
    const groups = [...Map.groupBy(files, (f) => parts(f).dir)].toSorted(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

    const tabButton = (id, path, on) => div().id(`${id}-tab`).flex_none().p(4).rounded(6).cursor_pointer().text_color(t.dim).tooltip("Open in new tab")
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openInTab(path, on); })
      .child(svg(`${ICONS}/open-tab.svg`).size(13));
    const downloadButton = (id, path, on) => div().id(`${id}-download`).flex_none().p(4).rounded(6).cursor_pointer().text_color(t.dim).tooltip("Download a copy")
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.downloadFile(path, on, null, cx); })
      .child(svg(`${ICONS}/download.svg`).size(13));
    const windowButton = (id, path, on) => div().id(`${id}-win`).flex_none().p(4).rounded(6).cursor_pointer().text_color(t.dim).tooltip("Open in window")
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openInWindow(path, on); })
      .child(svg(`${ICONS}/open-window.svg`).size(13));
    const row = (id, name, sub, path, on = null, indent = 10) => h_flex().id(id).flex_none().h(30).pl(indent).pr(4).gap(9).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(path, cx, on))
      .child(svg(`${ICONS}/file.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().max_w(320).truncate().text_size(13).text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(sub))
      .child(h_flex().flex_none().gap(2).child(downloadButton(id, path, on)).child(windowButton(id, path, on)).child(tabButton(id, path, on)));
    const section = (icon, label, count) => h_flex().flex_none().h(30).px(10).mt(6).gap(8).items_center()
      .child(svg(`${ICONS}/${icon}.svg`).size(14).flex_none().text_color(t.foreground))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(label))
      .child(div().flex_none().px(7).py(1).rounded(9).bg(t.raised).text_size(11).text_color(t.muted).child(String(count)));
    const folderName = parts(this.folder.replace(/[\\/]+$/, "")).name || this.folder;

    const searching = this.files === null;
    const nothing = !searching && !files.length && !waiting.length && !recent.length;
    const empty = v_flex().flex_none().items_center().gap(8).pt(48).pb(24).px(24)
      .child(svg(`${ICONS}/${q ? "search" : "file"}.svg`).size(26).text_color(t.dim))
      .child(div().text_size(13).text_color(t.muted).child(q ? `Nothing matches "${this.filterText.trim()}"` : "No Markdown files here"))
      .child(div().text_size(11.5).text_color(t.dim).child(q ? "Try part of a file or folder name." : "Ctrl-click a .md path in a terminal to read it here."));
    const count = searching ? "" : q ? `${files.length} of ${all.length}` : `${all.length} ${all.length === 1 ? "file" : "files"}`;

    const toolbar = h_flex().flex_none().px(10).py(8).gap(10).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("md-filter").flex_1().min_w(0).h(30).px(9).gap(7).items_center().rounded(7)
        .border_1().border_color(q ? t.accent : t.input).bg(t.raised).cursor_text()
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.filter?.focus(); })
        .child(svg(`${ICONS}/search.svg`).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).when(Boolean(this.filter), (el) => el.child(Input.new(this.filter).h(28).text_size(12.5).text_color(t.foreground))))
        .when(Boolean(q), (el) => el.child(div().id("md-filter-clear").flex_none().p(2).rounded(4).cursor_pointer().text_color(t.dim).tooltip("Clear")
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.clearFilter(cx))
          .child(svg(`${ICONS}/close.svg`).size(12)))))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(count));

    const body = div().id("md-files").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(10)
      .when(waiting.length > 0, (el) => el.child(section("review", "Waiting for your review", waiting.length))
        .children(waiting.map((p, i) => row(`md-waiting-${i}`, nameOf(p), shortDir(p), p))))
      .when(recent.length > 0, (el) => el.child(section("terminal", "From this terminal", recent.length))
        .children(recent.map((p, i) => row(`md-recent-${i}`, nameOf(p), shortDir(p), p))))
      .when(searching, (el) => el.child(div().flex_none().px(10).pt(14).text_size(12.5).text_color(t.dim)
        .loop("opacity", { from: 0.4, to: 1, period: 1200 }).child("Looking for Markdown…")))
      .when(nothing, (el) => el.child(empty))
      .children(groups.flatMap(([dir, list], g) => [
        section("folder", dir ? dir.replaceAll("/", " / ") : folderName, list.length),
        ...list.map((f, i) => row(`md-file-${g}-${i}`, parts(f).name, "", absolute(f), this.on, 30)),
      ]));
    return v_flex().flex_1().min_h(0).child(toolbar).child(body);
  }
}
