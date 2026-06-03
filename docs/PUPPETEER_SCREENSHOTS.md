# Puppeteer Screenshots

This is the repeatable workflow used to capture TubeVault options and popup screenshots from WSL.

## Why The Script Uses A Shim

Chrome extension pages expect the `chrome.*` extension APIs. For screenshots, the most reliable WSL flow is to serve the built extension HTML through a tiny local HTTP server and inject a `window.chrome` shim before the bundled script loads.

That lets Puppeteer render the real built `dist/options.js` and `dist/popup.js` without needing Chrome to load the unpacked extension cleanly across the WSL/Windows boundary.

## Workflow

1. Build the extension:

```bash
npm run build --prefix extension
```

2. Start Chrome from Windows with remote debugging:

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = "C:\Users\natha\AppData\Local\Temp\tubevault-puppeteer-profile"
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=9225",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1200,900"
)
```

3. Install `puppeteer-core` outside the repo:

```powershell
npm install --prefix C:\Users\natha\AppData\Local\Temp\tubevault-puppeteer-core puppeteer-core
```

4. Run a Node script that:

- Serves `extension/options.html`, `extension/popup.html`, and `extension/dist/*.js`.
- Injects a `window.chrome` shim into each HTML page.
- Connects to Chrome with `puppeteer.connect({ browserURL: "http://127.0.0.1:9225" })`.
- Opens `http://127.0.0.1:<port>/options.html`, clicks the Support tab, and screenshots it.
- Opens `http://127.0.0.1:<port>/popup.html` and screenshots it.

Use `waitUntil: "domcontentloaded"` plus explicit text waits. Avoid `networkidle0` for extension UI screenshots because mocked extension messaging and browser internals can keep the page busy longer than expected.

Current output files:

```text
docs/screenshots/tubevault-options-support.png
docs/screenshots/tubevault-popup.png
```

For popup captures, crop the screenshot to the popup panel if Puppeteer captures extra viewport padding:

```bash
ffmpeg -y -i docs/screenshots/tubevault-popup.png -vf crop=380:287:0:0 docs/screenshots/tubevault-popup-cropped.png
mv docs/screenshots/tubevault-popup-cropped.png docs/screenshots/tubevault-popup.png
```
