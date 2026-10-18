// throwaway: fetch ONLY the three self-hosted font files (tools/assets/fonts.mjs FONTS) so the Windows bundler's
// public/fonts requirement is met. The 550 MB art/audio asset set is NOT downloaded (the lite bundle is meant to
// download it on first launch; a full bundle would need tools/fetch-assets.mjs in full).
import { writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const RAW = 'https://raw.githubusercontent.com/TimWangZi/The-font-of-Arknights/master/font';
const MIRRORS = [
  (u) => `https://cdn.jsdelivr.net/gh/TimWangZi/The-font-of-Arknights@master/font/${u}`,
  (u) => `https://gh-proxy.com/https://raw.githubusercontent.com/TimWangZi/The-font-of-Arknights/master/font/${u}`,
];
const OUT = 'public/fonts';
const FILES = [
  { src: 'Bender/BENDER.OTF', name: 'bender-regular.otf', bytes: 52536 },
  { src: 'Bender/BenderLight.woff.ttf', name: 'bender-light.ttf', bytes: 68256 },
  { src: 'Novecento-Wide-Normal-2.otf', name: 'novecento-wide-normal.otf', bytes: 45356 },
];

mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(s);
for (const f of FILES) {
  const dst = join(OUT, f.name);
  if (existsSync(dst) && statSync(dst).size === f.bytes) { log(`skip ${f.name} (already ${f.bytes} bytes)`); continue; }
  const url = `${RAW}/${f.src}`;
  let buf = null;
  const tries = [url, ...MIRRORS.map((m) => m(f.src))];
  for (const t of tries) {
    try {
      const r = await fetch(t, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) { log(`  ${f.name} <- HTTP ${r.status} at ${new URL(t).host}`); continue; }
      buf = Buffer.from(await r.arrayBuffer());
      log(`  ${f.name} <- ${new URL(t).host}`);
      break;
    } catch (e) {
      log(`  ${f.name} <- ${new URL(t).host} failed: ${e && e.message}`);
    }
  }
  if (!buf) { log(`FAIL ${f.name}: no source answered`); process.exitCode = 1; continue; }
  if (buf.length !== f.bytes) { log(`SIZE MISMATCH ${f.name}: ${buf.length} != ${f.bytes}`); process.exitCode = 1; continue; }
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 8);
  writeFileSync(dst, buf);
  log(`ok ${f.name} ${buf.length} bytes sha8=${sha}`);
}
log(`public/fonts entries: ${readdirSync(OUT).length}`);
