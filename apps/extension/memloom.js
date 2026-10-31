// Everything the extension says to the daemon. The daemon binds 127.0.0.1:4319 and lets this
// extension's origin through: in Chrome by the id the manifest key pins, in Firefox by the
// profile's UUID once it is in MEMLOOM_EXTENSION_IDS.
const DAEMON = "http://127.0.0.1:4319";
export const DAEMON_ORIGINS = { origins: [`${DAEMON}/*`] };

export const DEFAULT_FOLDER = "reading-list";

// /context/url refuses html over 10M characters. A page that big is handed over as a bare
// URL instead and the daemon fetches it.
const MAX_HTML_CHARS = 9_500_000;

async function call(path, init = {}) {
  let res;
  try {
    res = await fetch(DAEMON + path, {
      ...init,
      headers: { "content-type": "application/json" },
    });
  } catch {
    throw new Error("memloom isn't running. Start it with `memloom serve`.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 403 && location.protocol === "moz-extension:") {
    throw new Error(
      `memloom doesn't know this Firefox install yet. Add MEMLOOM_EXTENSION_IDS=${location.host} ` +
        "to ~/.memloom/config.env and restart the daemon.",
    );
  }
  if (!res.ok) throw new Error(body.error ?? `memloom answered HTTP ${res.status}`);
  return body;
}

function post(path, body) {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

/** Every folder path, depth-first, for the folder picker. */
export async function folderPaths() {
  const { scopes } = await call("/scopes");
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(scopes);
  return out;
}

/**
 * Save one page: the page itself as a context document, plus a short memory that says it was
 * saved to study later. The document makes the page's text recallable; the memory is what an
 * agent finds when asked "what did I want to read?", which the page's own text never answers.
 */
export async function savePage({ url, title, html, folder, note }) {
  // Saves resolve folders strictly, so make sure this one exists. Idempotent.
  await post("/scopes", { path: folder });
  const doc = await post("/context/url", {
    url,
    scope: folder,
    ...(html && html.length <= MAX_HTML_CHARS ? { html } : {}),
  });
  const name = doc.title || title || url;
  // Re-saving a page that hasn't changed with nothing new to say would only add a duplicate.
  if (doc.outcome === "unchanged" && !note) return { title: name, outcome: doc.outcome };
  const lines = [`Saved "${name}" to study later: ${url}`];
  if (note) lines.push(`Why: ${note}`);
  await post("/memory/save", {
    content: lines.join("\n"),
    memoryType: "episode",
    scope: folder,
    tags: ["saved-link"],
  });
  return { title: name, outcome: doc.outcome };
}

/** The rendered DOM of a tab, or undefined where Chrome won't let an extension read it. */
export async function pageHtml(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return result?.result;
  } catch {
    return undefined;
  }
}

export async function lastFolder() {
  const { folder } = await chrome.storage.local.get("folder");
  return folder || DEFAULT_FOLDER;
}

export function rememberFolder(folder) {
  return chrome.storage.local.set({ folder });
}

export function isSavable(url) {
  return /^https?:\/\//i.test(url ?? "");
}
