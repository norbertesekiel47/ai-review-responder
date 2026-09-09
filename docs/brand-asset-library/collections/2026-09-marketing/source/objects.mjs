import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const collection = resolve(source, '..');
const { palettes } = JSON.parse(await readFile(resolve(source, 'palette-snapshot.json'), 'utf8'));
// Vector masters have transparent canvases and named groups for timeline editing.
const objects = {
  'speech-bubble': '<path id="bubble" d="M90 100h332v245H245l-100 80v-80H90Z"/><path id="message" d="M155 185h200M155 240h140"/>',
  envelope: '<rect id="envelope" x="70" y="130" width="372" height="250" rx="18"/><path id="flap" d="m82 145 174 135 174-135M80 365l126-112m226 112L306 253"/>',
  shield: '<path id="shield" d="M256 60 415 125v145c0 90-85 155-159 183C182 425 97 360 97 270V125Z"/><path id="check" d="m174 252 57 58 111-121"/>',
  'route-arrow': '<path id="route" d="M65 365h115c135 0 30-215 165-215h85M368 91l63 59-63 59"/>',
  'approval-check': '<circle id="ring" cx="256" cy="256" r="177"/><path id="check" d="m158 255 69 70 131-147"/>',
  'pause-gate': '<circle id="ring" cx="256" cy="256" r="177"/><path id="pause" d="M212 168v176M300 168v176" stroke-width="20"/>',
  'report-sheet': '<path id="paper" d="M125 60h190l72 72v320H125Z"/><path id="fold" d="M315 60v72h72"/><path id="lines" d="M174 196h162M174 253h162M174 310h105M174 367h138"/>',
  'radar-rings': '<circle id="outer" cx="256" cy="256" r="180"/><circle id="middle" cx="256" cy="256" r="115"/><circle id="inner" cx="256" cy="256" r="50"/><path id="needle" d="m256 256 132-132"/>',
  'compass-rose': '<circle id="compass" cx="256" cy="256" r="179"/><path id="north" d="m256 104 45 152-45 152-45-152ZM104 256h304M256 77v-25m0 408v-25M77 256H52m408 0h-25"/>',
  'attention-beacon': '<path id="body" d="M167 350V229a89 89 0 0 1 178 0v121ZM133 350h246v47H133Z"/><path id="rays" d="M256 74V38M115 145l-30-25m312 25 30-25M85 255H42m385 0h43"/>',
  'paper-stack': '<path id="back" d="M154 76h250v295H154Z"/><path id="front" d="M108 141h250v295H108Z"/><path id="lines" d="M155 211h154M155 266h154M155 321h103"/>',
  'connection-nodes': '<path id="connections" d="m135 145 237 0M135 145l120 245m117-245L255 390"/><circle id="node-a" cx="135" cy="145" r="48"/><circle id="node-b" cx="372" cy="145" r="48"/><circle id="node-c" cx="255" cy="390" r="48"/>',
};
for (const [theme, colors] of Object.entries(palettes)) {
  const dir = resolve(collection, 'objects', theme);
  await mkdir(dir, { recursive: true });
  for (const [name, shape] of Object.entries(objects)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><title>RepWorth ${name}</title><g fill="none" stroke="${colors.accent}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">${shape}</g></svg>\n`;
    await writeFile(resolve(dir, `${name}.svg`), svg);
  }
}
const mapDir = resolve(collection, 'maps', 'overlays');
await mkdir(mapDir, { recursive: true });
const content = JSON.parse(await readFile(resolve(source, 'content.json'), 'utf8'));
for (const [i, label] of content.mapLabels.entries()) await writeFile(resolve(mapDir, `label-${i + 1}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100" viewBox="0 0 500 100"><title>${label}</title><path d="M14 14H486V86H14Z" fill="#f0e3c4" stroke="#8c784f"/><text x="250" y="61" text-anchor="middle" font-family="Georgia,serif" font-size="30" fill="#302e22">${label}</text></svg>\n`);
await writeFile(resolve(mapDir, 'connected-route.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><title>Editable golden journey</title><path id="route" d="M360 730C660 730 560 280 970 430S1240 780 1520 370" fill="none" stroke="#e5be70" stroke-width="7" stroke-linecap="round"/><g fill="#e5be70"><circle cx="360" cy="730" r="14"/><circle cx="970" cy="430" r="14"/><circle cx="1520" cy="370" r="14"/></g></svg>\n');
console.log('Exported 24 editable graphic objects and 7 map overlays.');
