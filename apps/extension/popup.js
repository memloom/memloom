import {
  DAEMON_ORIGINS,
  DEFAULT_FOLDER,
  folders,
  isSavable,
  lastFolder,
  pageHtml,
  rememberFolder,
  savePage,
} from "./memloom.js";

const $ = (id) => document.getElementById(id);

function show(message, kind = "") {
  $("status").textContent = message;
  $("status").className = `status ${kind}`;
}

// The folder picker. The daemon's tree, indented, with a search box that also creates: type a
// path that doesn't exist yet and the first row offers to make it.
const picker = {
  all: [],
  rows: [],
  active: 0,
  selected: DEFAULT_FOLDER,
};

function setFolder(path) {
  picker.selected = path;
  $("folder-text").textContent = path;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// The daemon's rule for turning a typed folder path into its stored path (scopeSlug in core),
// so a folder created here is the one highlighted next time.
function toPath(typed) {
  return typed
    .split("/")
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter((s) => s.length > 0)
    .join("/");
}

function renderList() {
  const query = $("folder-search").value.trim().toLowerCase();
  const matches = query
    ? picker.all.filter(
        (f) => f.path.toLowerCase().includes(query) || f.name.toLowerCase().includes(query),
      )
    : picker.all;
  // The create row keeps the typed spelling: the daemon names the folder with it and slugs
  // only the path.
  const typed = $("folder-search").value.trim();
  const exact = picker.all.some((f) => f.path === toPath(typed));
  picker.rows = [...(toPath(typed) && !exact ? [{ create: true, path: typed }] : []), ...matches];
  picker.active = Math.min(picker.active, Math.max(picker.rows.length - 1, 0));

  const list = $("folder-list");
  list.replaceChildren(
    ...picker.rows.map((row, i) => {
      const li = document.createElement("li");
      li.className = `item${row.create ? " create" : ""}${i === picker.active ? " active" : ""}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(!row.create && row.path === toPath(picker.selected)));
      li.dataset.index = String(i);
      const name = document.createElement("span");
      name.className = "item-name";
      if (row.create) {
        name.textContent = `Create folder "${row.path}"`;
        li.append(name);
        return li;
      }
      // Indent the tree when browsing. A search result shows its full path instead, since
      // its parents may not be in the list.
      if (query) {
        name.textContent = row.name;
        const path = document.createElement("span");
        path.className = "item-path";
        path.textContent = ` ${row.path}`;
        name.append(path);
      } else {
        name.textContent = row.name;
        li.style.paddingLeft = `${8 + row.depth * 14}px`;
      }
      const count = document.createElement("span");
      count.className = "item-count";
      count.textContent = String(row.memories + row.documents);
      count.title = `${plural(row.memories, "memory", "memories")}, ${plural(row.documents, "document", "documents")}`;
      li.append(name, count);
      return li;
    }),
  );
  if (picker.rows.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No folders yet. Type a name to create one.";
    list.append(li);
  }
  list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function openPicker() {
  $("folder-panel").hidden = false;
  $("folder").setAttribute("aria-expanded", "true");
  $("folder-search").value = "";
  picker.active = Math.max(
    picker.all.findIndex((f) => f.path === toPath(picker.selected)),
    0,
  );
  renderList();
  $("folder-search").focus();
}

function closePicker() {
  $("folder-panel").hidden = true;
  $("folder").setAttribute("aria-expanded", "false");
}

function choose(index) {
  const row = picker.rows[index];
  if (!row) return;
  setFolder(row.path);
  closePicker();
  $("folder").focus();
}

$("folder").addEventListener("click", () => {
  if ($("folder-panel").hidden) openPicker();
  else closePicker();
});

$("folder-search").addEventListener("input", () => {
  picker.active = 0;
  renderList();
});

$("folder-search").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    picker.active = (picker.active + step + picker.rows.length) % Math.max(picker.rows.length, 1);
    renderList();
  } else if (e.key === "Enter") {
    e.preventDefault();
    choose(picker.active);
  } else if (e.key === "Escape") {
    // Without this the browser closes the whole popup.
    e.preventDefault();
    closePicker();
    $("folder").focus();
  }
});

$("folder-list").addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (item) choose(Number(item.dataset.index));
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".picker")) closePicker();
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
$("title").textContent = tab?.title ?? "";
$("url").textContent = tab?.url ?? "";
setFolder(await lastFolder());

if (!isSavable(tab?.url)) {
  $("save").disabled = true;
  show("Only http and https pages can be saved.");
} else if (!(await chrome.permissions.contains(DAEMON_ORIGINS))) {
  // Firefox installs host permissions unticked. Asking needs a click, so Save asks.
  show("Click Save once to let the extension reach memloom.");
} else {
  // The folder list doubles as the "is the daemon up" check, so a stopped daemon shows
  // before the user types a note.
  folders()
    .then((all) => {
      picker.all = all;
      if (!$("folder-panel").hidden) renderList();
    })
    .catch((err) => show(err.message, "bad"));
}

$("save").addEventListener("click", async () => {
  // Before any await: Firefox only shows the prompt while the click is still being handled.
  // Chrome grants host permissions at install, so there this resolves true at once.
  const allowed = await chrome.permissions.request(DAEMON_ORIGINS);
  if (!allowed) {
    show("memloom needs access to 127.0.0.1:4319 to save.", "bad");
    return;
  }
  const folder = picker.selected || DEFAULT_FOLDER;
  $("save").disabled = true;
  show("Saving…");
  try {
    const saved = await savePage({
      url: tab.url,
      title: tab.title,
      html: await pageHtml(tab.id),
      folder,
      note: $("note").value.trim(),
    });
    await rememberFolder(toPath(folder));
    show(saved.outcome === "unchanged" ? "Already saved." : "Saved.", "good");
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    show(err.message, "bad");
    $("save").disabled = false;
  }
});
