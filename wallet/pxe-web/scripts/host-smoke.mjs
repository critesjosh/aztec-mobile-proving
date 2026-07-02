/**
 * Host-side smoke test for the WebView PXE bundle: loads the bundle in
 * headless Chromium (same engine family as the Android WebView) from a local
 * URL, captures console + page errors, and optionally drives a storageProbe
 * RPC. Usage:
 *   node scripts/host-smoke.mjs [url]
 * Default url http://127.0.0.1:39999/index.html (adb forward of the on-device
 * asset server) — or serve dist/ locally with any static server.
 */
import {chromium} from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:39999/index.html';
// Use the locally cached chromium build (avoids playwright-core/browser
// version skew — same workaround the rn-spike harness needed).
const executablePath =
  process.env.CHROMIUM_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1187/chrome-linux/chrome`;
const browser = await chromium.launch({headless: true, executablePath});
const page = await browser.newPage();

page.on('console', m => console.log(`[console:${m.type()}]`, m.text().slice(0, 500)));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('requestfailed', r => console.log('[requestfailed]', r.url(), r.failure()?.errorText));

console.log('loading', url);
await page.goto(url, {waitUntil: 'load', timeout: 60_000});

// The bundle posts {type:'ready'} to console when no ReactNativeWebView is present.
await page.waitForTimeout(15_000);

// Drive a storageProbe through the host-message entrypoint.
const result = await page.evaluate(async () => {
  return await new Promise(resolve => {
    let done = false;
    const orig = console.log.bind(console);
    console.log = (...args) => {
      if (typeof args[1] === 'string' && args[1].includes('rpcResult')) {
        if (!done) {
          done = true;
          resolve(args[1]);
        }
      }
      orig(...args);
    };
    // @ts-ignore
    window.__aztecOnHostMessage({type: 'rpc', id: 1, method: 'storageProbe', params: {}});
    setTimeout(() => {
      if (!done) {
        resolve('TIMEOUT waiting for rpcResult');
      }
    }, 20_000);
  });
});
console.log('storageProbe →', result);
await browser.close();
