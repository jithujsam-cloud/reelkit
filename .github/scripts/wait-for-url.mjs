// Cross-platform "wait until a URL answers 2xx/3xx". Usage: node wait-for-url.mjs <url> [seconds]
const [url, seconds = '60'] = process.argv.slice(2);
const deadline = Date.now() + Number(seconds) * 1000;
while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status < 400) {
      console.log(`${url} is up (${res.status})`);
      process.exit(0);
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error(`Timed out waiting for ${url}`);
process.exit(1);
