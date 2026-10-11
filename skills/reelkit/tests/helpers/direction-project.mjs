// Builds a throwaway Reelkit project whose "captures" are real screenshots of a served fixture site,
// registered in .reelkit/results.json the way `reelkit shoot` registers them.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { saveResult } from '../../scripts/lib/state.mjs';

const VIEWS = {
  desktop: { width: 1440, height: 900, mobile: false },
  tablet: { width: 820, height: 1180, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};

export async function makeProject({ root, browser, siteUrl, views = ['desktop', 'tablet', 'mobile'], name = 'Fernhill', tagline = 'Native plants, delivered', extraYaml = '', theme = 'light' }) {
  mkdirSync(path.join(root, 'media'), { recursive: true });
  writeFileSync(
    path.join(root, 'reelkit.config.yaml'),
    `name: ${name}\ntagline: ${tagline}\nbaseUrl: ${siteUrl.replace(/\/$/, '')}\noutput: media\ndefaults:\n  viewports: [${views.join(', ')}]\n  theme: ${theme}\n  outputs: [still]\n${extraYaml}scenes:\n  - name: home\n    url: /\n`,
  );
  const cfg = loadConfig(path.join(root, 'reelkit.config.yaml'));
  for (const v of views) {
    const vp = VIEWS[v];
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.mobile, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(siteUrl);
    await page.evaluate(() => document.fonts.ready);
    const file = `home-${v}-${theme}.png`;
    await page.screenshot({ path: path.join(root, 'media', file), animations: 'disabled' });
    await ctx.close();
    saveResult(cfg, file, { scene: 'home', viewport: v, theme, kind: 'still', status: 'PASS' });
  }
  return { root, cfg };
}
