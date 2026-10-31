import {
  DAEMON_ORIGINS,
  DEFAULT_FOLDER,
  folderPaths,
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

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
$("title").textContent = tab?.title ?? "";
$("url").textContent = tab?.url ?? "";
$("folder").value = await lastFolder();

if (!isSavable(tab?.url)) {
  $("save").disabled = true;
  show("Only http and https pages can be saved.");
} else if (!(await chrome.permissions.contains(DAEMON_ORIGINS))) {
  // Firefox installs host permissions unticked. Asking needs a click, so Save asks.
  show("Click Save once to let the extension reach memloom.");
} else {
  // The folder list doubles as the "is the daemon up" check, so a stopped daemon shows
  // before the user types a note.
  folderPaths()
    .then((paths) => {
      $("folders").replaceChildren(
        ...paths.map((path) => Object.assign(document.createElement("option"), { value: path })),
      );
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
  const folder = $("folder").value.trim() || DEFAULT_FOLDER;
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
    await rememberFolder(folder);
    show(saved.outcome === "unchanged" ? "Already saved." : "Saved.", "good");
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    show(err.message, "bad");
    $("save").disabled = false;
  }
});
