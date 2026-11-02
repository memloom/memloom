import { DAEMON, folders, originsFor, saveSettings, settings } from "./memloom.js";

const $ = (id) => document.getElementById(id);

function show(message, kind = "") {
  $("status").textContent = message;
  $("status").className = `status ${kind}`;
}

const current = await settings();
$("server").value = current.server === DAEMON ? "" : current.server;
$("token").value = current.token;

// The folder list is the cheapest call that needs a working address and, on a hosted
// memloom, a valid token, so it doubles as the connection test.
async function test() {
  show("Connecting…");
  try {
    const all = await folders();
    show(`Connected. ${all.length} folder${all.length === 1 ? "" : "s"}.`, "good");
  } catch (err) {
    show(err.message, "bad");
  }
}

$("save").addEventListener("click", async () => {
  const typed = $("server").value.trim().replace(/\/+$/, "");
  let server = DAEMON;
  if (typed) {
    try {
      const url = new URL(typed);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
      server = url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
      show("That isn't an http or https address.", "bad");
      return;
    }
  }
  // Before any other await: the browser only shows the prompt while the click is still being
  // handled. Chrome grants the local daemon at install, so there this resolves true at once.
  const allowed = await chrome.permissions.request(originsFor(server));
  if (!allowed) {
    show(`The extension needs access to ${new URL(server).host} to save there.`, "bad");
    return;
  }
  await saveSettings({ server, token: $("token").value.trim() });
  await test();
});

$("local").addEventListener("click", async () => {
  $("server").value = "";
  $("token").value = "";
  await saveSettings({ server: DAEMON, token: "" });
  await test();
});
