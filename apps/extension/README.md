# memloom browser extension

Saves the page you're on to your local memloom daemon so your agents can find it later. It's
plain JavaScript with no build step.

In Chrome, load it from `chrome://extensions`: turn on Developer mode, click Load unpacked and
pick this folder. In Firefox, use Load Temporary Add-on on `about:debugging` and pick
`manifest.json`, then add the Internal UUID it shows to `MEMLOOM_EXTENSION_IDS`. The daemon has to be running (`memloom serve`, or any memloom command starts it).

The `key` in `manifest.json` pins the extension id to `ebfjmgjkgcdcmpcgpbgglcdmddfndmnp`. The
daemon allows that id and refuses every other extension, so don't change the key unless you also
add the new id to `MEMLOOM_EXTENSION_IDS`.

Setup and usage: [docs/guides/browser-extension.mdx](../../docs/guides/browser-extension.mdx).
