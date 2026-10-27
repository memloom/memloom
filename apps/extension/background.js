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

// No popup on a right-click save, so the toolbar badge is the only answer: a tick, or a "!"
// with the error in the tooltip.
async function flash(tabId, ok, message) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? "#15803d" : "#b91c1c" });
  await chrome.action.setBadgeText({ tabId, text: ok ? "✓" : "!" });
  await chrome.action.setTitle({ tabId, title: message });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setTitle({ tabId, title: "Save to memloom" });
  }, 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const linkSave = info.menuItemId === "save-link";
  const url = linkSave ? info.linkUrl : tab.url;
  if (!isSavable(url)) {
    await flash(tabId, false, "Only http and https pages can be saved");
    return;
  }
  try {
    // A link the user hasn't opened has no DOM here, so the daemon fetches it.
    const html = linkSave ? undefined : await pageHtml(tabId);
    const saved = await savePage({
      url,
      title: linkSave ? undefined : tab.title,
      html,
      folder: await lastFolder(),
    });
    await flash(tabId, true, `Saved "${saved.title}"`);
  } catch (err) {
    await flash(tabId, false, err instanceof Error ? err.message : String(err));
  }
});
