import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const source = dirname(fileURLToPath(import.meta.url));
const collection = resolve(source, '..');
const repo = resolve(source, '../../../../..');
const prefix = relative(repo, collection);
const journal = JSON.parse(await readFile(resolve(source, 'generation-journal.json'), 'utf8'));
const generated = new Map([...journal.stills, ...journal.videos].map((a) => [a.path, a]));
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['source', 'previews', 'node_modules'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (['.png', '.svg', '.mp4'].includes(extname(path))) files.push(path);
  }
  return files.sort();
}
const assets = [];
await mkdir(resolve(collection, 'previews'), { recursive: true });
for (const path of await walk(collection)) {
  const local = relative(collection, path);
  const extension = extname(path);
  const bytes = await readFile(path);
  let width, height, duration, pixelFormat;
  if (extension === '.svg') {
    const svg = bytes.toString();
    width = Number(svg.match(/width="(\d+)"/)?.[1]);
    height = Number(svg.match(/height="(\d+)"/)?.[1]);
    if (!width || !height) throw new Error(`SVG dimensions missing: ${local}`);
  } else {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_type,width,height,pix_fmt:format=duration','-of','json',path], { encoding: 'utf8' }));
    if (probe.streams.some((s) => s.codec_type === 'audio')) throw new Error(`Unexpected audio: ${local}`);
    const visual = probe.streams.find((s) => s.width);
    if (!visual) throw new Error(`Missing visual stream: ${local}`);
    ({ width, height, pix_fmt: pixelFormat } = visual);
    if (extension === '.mp4') duration = Number(probe.format.duration);
  }
  const origin = generated.get(local);
  const category = local.split('/')[0];
  const system = local.includes('/light/') || local.includes('light-') || local.includes('-day') || local.includes('judge-lookout') ? 'island' : local.includes('/dark/') || local.includes('dark-') || local.includes('-night') || local.includes('reply-path') ? 'landing' : category === 'maps' ? 'tabletop-map' : 'shared';
  const record = { id: `marketing-2026-09--${local.replaceAll('/', '--')}`, path: `${prefix}/${local}`, category, system, role: category === 'social' ? 'Editable-source social post export' : category === 'maps' ? 'Reusable illustrative map element or composition' : 'Reusable marketing visual or silent motion module', storage: 'repository', status: 'draft-export', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width, height, ...(duration ? { duration_seconds: duration, audio: false } : {}), ...(pixelFormat ? { pixel_format: pixelFormat } : {}), provenance: { source: origin ? `${prefix}/source/generation-journal.json` : `${prefix}/source/`, generator: origin?.generator ?? origin?.provider ?? (extension === '.svg' ? 'Authored SVG' : 'Remotion'), ...(origin?.taskId ? { task_id: origin.taskId } : {}) }, rights: { status: 'unrecorded', evidence: 'Production sources recorded; no new rights verification of pre-existing brand references.' }, review: { status: 'production-qc', reviewer: 'Codex', date: '2026-09-08' }, notes: 'Generated for user review. No publication approval implied. Product workflows are illustrative; no current product capture.' };
  assets.push(record);
  if (extension === '.mp4') execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-ss',String(Math.min(4, duration / 2)),'-i',path,'-frames:v','1','-vf','scale=640:-1',resolve(collection, 'previews', `${record.id}.jpg`)]);
}
await writeFile(resolve(collection, 'manifest.json'), JSON.stringify({ schema_version: 1, date: '2026-09-08', path_base: 'repository-root', assets }, null, 2) + '\n');
if (process.argv.includes('--register')) {
  const path = resolve(repo, 'docs/brand-asset-library/digital-asset-management/catalog.json');
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  catalog.assets = [...catalog.assets.filter((a) => !a.path.startsWith(prefix + '/')), ...assets];
  catalog.collection_manifests = [...new Set([...(catalog.collection_manifests ?? []), `${prefix}/manifest.json`])];
  await writeFile(path, JSON.stringify(catalog, null, 2) + '\n');
}
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const order = ['agent-worlds','panoramas','maps','cinematic','social','agents','motion','backgrounds','objects'];
const cards = [...assets].sort((a,b) => order.indexOf(a.category) - order.indexOf(b.category)).map((a) => {
  const local = a.path.slice(prefix.length + 1);
  const title = local.split('/').at(-1).replace(/\.[^.]+$/, '').replaceAll('-', ' ');
  const isVideo = local.endsWith('.mp4');
  return `<article data-category="${a.category}" data-system="${a.system}" data-search="${escape(local)}"><div class="preview ${local.includes('/props/') || local.endsWith('.svg') ? 'cutout' : ''}">${isVideo ? `<video controls muted playsinline preload="none" poster="previews/${a.id}.jpg" src="${local}"></video>` : `<a href="${local}" target="_blank"><img loading="lazy" src="${local}" alt="${escape(title)}"></a>`}</div><div class="caption"><h2>${escape(title)}</h2><p>${a.category} · ${a.system} · ${a.width} × ${a.height}${a.duration_seconds ? ` · ${a.duration_seconds.toFixed(1)}s` : ''}</p><a href="${local}" download>Download ${isVideo ? 'video' : local.endsWith('.svg') ? 'editable SVG' : 'image'} ↗</a></div></article>`;
}).join('\n');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RepWorth — Marketing Asset Collection</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f6f2;color:#15191a;font:16px system-ui,sans-serif}header{padding:64px 5vw 32px;border-bottom:1px solid #ced2cd}header p{max-width:760px;line-height:1.6;color:#526058}.eyebrow{font-size:12px;letter-spacing:.12em;color:#2e5b4f}h1{font-weight:400;font-size:clamp(34px,5vw,64px);margin:18px 0}nav{display:flex;gap:20px;margin:24px 0}a{color:inherit;text-underline-offset:4px}form{display:flex;flex-wrap:wrap;gap:12px;padding:22px 5vw;background:#f6f6f2;position:sticky;top:0;z-index:2;border-bottom:1px solid #d7dcd5}label{font-size:13px;color:#526058;display:flex;align-items:center;gap:8px}select,input{font:inherit;padding:10px;border:1px solid #b9c5bb;border-radius:6px;background:white;color:#15191a}input{min-width:190px}#count{align-self:center;margin-left:auto;color:#526058;font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:26px;padding:32px 5vw 70px}article{background:white;border:1px solid #d7dcd5;border-radius:8px;overflow:hidden}article[hidden]{display:none}.preview{height:270px;background:#e8ebe5;display:flex;align-items:center;justify-content:center}.preview a{height:100%;width:100%;display:flex;justify-content:center}.preview img,.preview video{width:100%;height:100%;object-fit:contain}.cutout{background-color:#d4d8d1;background-image:linear-gradient(45deg,#bfc8be 25%,transparent 25%),linear-gradient(-45deg,#bfc8be 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#bfc8be 75%),linear-gradient(-45deg,transparent 75%,#bfc8be 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}.caption{padding:20px}.caption h2{font-size:18px;font-weight:500;margin:0 0 10px;text-transform:capitalize}.caption p{font-size:12px;color:#526058;margin-bottom:20px}.caption a{font-size:14px}footer{padding:20px 5vw 50px;color:#526058;font-size:14px}@media(max-width:550px){header{padding-top:36px}.grid{grid-template-columns:1fr}form{position:static}#count{width:100%;margin:0}nav{flex-wrap:wrap}}</style>
<header><div class="eyebrow">REPWORTH / BRAND ASSET LIBRARY / SEPTEMBER 2026</div><h1>A world of reusable stories.</h1><p>Miniature agent worlds, quiet panoramas, parchment maps, and light and dark editorial collections. Download individual assets below. All videos are silent; editable copy and animation sources are included.</p><nav><a href="README.md">Use the collection</a><a href="source/content.json">Editable copy</a><a href="manifest.json">Asset manifest</a></nav></header>
<form onsubmit="return false"><label>Collection <select id="category"><option value="all">Everything</option>${order.map((s) => `<option value="${s}">${s.replaceAll('-', ' ')}</option>`).join('')}</select></label><label>Look <select id="system"><option value="all">All looks</option><option value="island">Light</option><option value="landing">Dark</option><option value="tabletop-map">Tabletop map</option><option value="shared">Shared</option></select></label><label>Search <input id="search" placeholder="Reply, story, lighthouse…"></label><span id="count">${assets.length} assets</span></form><main class="grid">${cards}</main><footer>Production drafts for your review. Workflows and maps are illustrative. Original brand sources remain in the repository.</footer><script>
const cards=[...document.querySelectorAll('article')];const category=document.getElementById('category');const system=document.getElementById('system');const search=document.getElementById('search');function filter(){let count=0;for(const card of cards){card.hidden=!((category.value==='all'||card.dataset.category===category.value)&&(system.value==='all'||card.dataset.system===system.value)&&card.dataset.search.toLowerCase().includes(search.value.toLowerCase()));if(!card.hidden)count++;else card.querySelector('video')?.pause()}document.getElementById('count').textContent=count+' assets'}for(const control of [category,system,search])control.addEventListener('input',filter);
</script></html>`;
await writeFile(resolve(collection, 'gallery.html'), html);
const counts = assets.reduce((all,a) => ({ ...all, [extname(a.path)]: (all[extname(a.path)] ?? 0) + 1 }), {});
console.log(JSON.stringify({ assets: assets.length, counts, bytes: assets.reduce((n,a) => n + a.bytes,0), silentVideos: assets.filter((a) => a.duration_seconds).length }, null, 2));
