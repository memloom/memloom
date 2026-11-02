import { isSavable, lastFolder, pageHtml, savePage } from "./memloom.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-link",
    title: "Save link to memloom",
    contexts: ["link"],
  });
  chrome.contextMenus.create({
    id: "save-page",
    title: "Save page to memloom",
    contexts: ["page"],
  });
});

// The toolbar badge carries every save's progress and result: "…" while the daemon works, then
// a tick, or a "!" with the error in the tooltip. A busy daemon (transcribing, indexing) can
// take many seconds over a save, and without the "…" a click looks like it did nothing.
async function badge(tabId, state, message) {
  const look = {
    saving: { text: "…", color: "#78716c" },
    ok: { text: "✓", color: "#15803d" },
    error: { text: "!", color: "#b91c1c" },
  }[state];
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: look.color });
    await chrome.action.setBadgeText({ tabId, text: look.text });
    await chrome.action.setTitle({ tabId, title: message });
  } catch {
    // The tab closed mid-save. The save itself carries on.
    return;
  }
  if (state === "saving") return;
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setTitle({ tabId, title: "Save to memloom" });
  }, 5000);
}

async function saveInBackground(tabId, page) {
  await badge(tabId, "saving", "Saving to memloom…");
  try {
    const saved = await savePage(page);
    await badge(tabId, "ok", `Saved "${saved.title}"`);
  } catch (err) {
    await badge(tabId, "error", err instanceof Error ? err.message : String(err));
  }
}

// The popup hands its save over and closes at once, so a slow daemon never holds it open.
// An in-flight fetch keeps the service worker alive until the save finishes.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "save") void saveInBackground(message.tabId, message.page);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const linkSave = info.menuItemId === "save-link";
  const url = linkSave ? info.linkUrl : tab.url;
  if (!isSavable(url)) {
    await badge(tabId, "error", "Only http and https pages can be saved");
    return;
  }
  // A link the user hasn't opened has no DOM here, so the daemon fetches it.
  await saveInBackground(tabId, {
    url,
    title: linkSave ? undefined : tab.title,
    html: linkSave ? undefined : await pageHtml(tabId),
    folder: await lastFolder(),
  });
});
