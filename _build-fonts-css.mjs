// throwaway: run the repo's own buildFonts (tools/assets/fonts.mjs) over the three fonts we just fetched, so
// public/fonts matches what tools/fetch-assets.mjs would have produced (woff2 + fonts.css), with its own validation.
import { buildFonts } from './tools/assets/fonts.mjs';
const r = await buildFonts('public/fonts', console.log);
console.log('files:', JSON.stringify(r.files, null, 1));
console.log('errors:', r.errors);
process.exitCode = r.errors.length ? 1 : 0;
