#!/usr/bin/env node
// Makes a ready-to-post image and caption for each upcoming Daily Blitz, for scheduling on social media.
//
//   node scripts/daily-cards.js                     the next 7 days, starting today (US Eastern)
//   node scripts/daily-cards.js --start 2026-11-20 --days 3 --out cards
//
// Needs SUPABASE_DB_URL (via .env) and playwright with a Chromium (npm install --no-save playwright).
// Looking at a date saves that day's player in daily_puzzles, same as the site does when someone opens it.
// Cards show the player's name and teams only, no photo.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { createDaily, todayInTimeZone } = require('../daily');

const SITE = 'nameateammate.com/daily';
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');

function parseArgs(argv) {
  const args = { start: todayInTimeZone(), days: 7, out: 'daily-cards' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') args.start = argv[++i];
    else if (a === '--days') args.days = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start)) throw new Error('--start must look like 2026-11-20');
  if (!(args.days >= 1 && args.days <= 31)) throw new Error('--days must be between 1 and 31');
  return args;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const years = s => (s.start === s.end ? `${s.start}` : `${s.start}–${String(s.end).slice(2)}`);

function cardHtml(puzzle) {
  const p = puzzle.player;
  const verb = puzzle.active ? 'has had' : 'had';
  const chips = puzzle.stints.map(s => `<span class="chip"><b>${esc(s.team)}</b> ${esc(years(s))}</span>`).join('');
  const font = (w, f) => `@font-face{font-family:Barlow Condensed;font-weight:${w};src:url("file://${FONT_DIR}/${f}")}`;
  return `<!doctype html><meta charset="utf-8"><style>
${font(700, 'barlow-condensed-latin-700-normal.woff2')}${font(800, 'barlow-condensed-latin-800-normal.woff2')}
@font-face{font-family:Barlow;font-weight:500;src:url("file://${FONT_DIR}/barlow-latin-500-normal.woff2")}
@font-face{font-family:Barlow;font-weight:600;src:url("file://${FONT_DIR}/barlow-latin-600-normal.woff2")}
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1350px;background:#0c0d0f;color:#f4efe8;font-family:Barlow,sans-serif;display:flex;flex-direction:column;justify-content:space-between;padding:96px 88px 80px}
.eyebrow{color:#ff6a13;font:700 44px/1 'Barlow Condensed'}
.mid{display:flex;flex-direction:column;gap:44px}
.label{color:#a8a49d;font:500 40px/1 Barlow}
#name{font:800 168px/0.95 'Barlow Condensed';letter-spacing:.01em}
.chips{display:flex;flex-wrap:wrap;gap:14px}
.chip{padding:12px 20px;border:2px solid #34373d;border-radius:14px;color:#c9c5be;font:500 34px/1 Barlow}
.chip b{color:#f4efe8;font-weight:600}
.ask{font:600 52px/1.2 Barlow;color:#f4efe8}.ask em{color:#ff6a13;font-style:normal}
.foot{display:flex;flex-direction:column;align-items:flex-start;gap:26px;color:#a8a49d;font:500 30px/1.3 Barlow}
.cta{background:#ff6a13;color:#0c0d0f;padding:26px 40px;border-radius:20px;font:800 46px/1 'Barlow Condensed'}
</style>
<body><div class="eyebrow">Daily Blitz #${puzzle.number}</div>
<div class="mid"><div class="label">Today's player</div><div id="name">${esc(p.player_name)}</div><div class="chips">${chips}</div>
<div class="ask">He ${verb} <em>${puzzle.teammates.size}</em> teammates.<br>How many can you name in 60 seconds?</div></div>
<div class="foot"><span class="cta">${SITE}</span><span>Not affiliated with the NBA</span></div></body>`;
}

function caption(puzzle) {
  const verb = puzzle.active ? 'has had' : 'had';
  return `Daily Blitz #${puzzle.number}: ${puzzle.player.player_name}\n\n` +
    `He ${verb} ${puzzle.teammates.size} teammates. How many can you name in 60 seconds?\n\n` +
    `Play free at ${SITE} (link in bio). Drop your score below.\n\n` +
    '#nba #nbabasketball #basketballtrivia #nbatrivia #dailygame';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is not set (put it in .env)');
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { throw new Error('playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium'); }

  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  const browser = await chromium.launch();
  try {
    const daily = createDaily(db);
    fs.mkdirSync(args.out, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
    const captions = [];
    for (let i = 0; i < args.days; i++) {
      const date = addDays(args.start, i);
      const puzzle = await daily.getPuzzle(date);
      const html = path.join(args.out, `${date}.html`);
      fs.writeFileSync(html, cardHtml(puzzle));
      await page.goto(`file://${path.resolve(html)}`);
      await page.evaluate(() => document.fonts.ready);
      // Long names shrink until they fit on at most two lines
      await page.evaluate(() => {
        const el = document.getElementById('name');
        let size = 168;
        while (el.offsetHeight > size * 0.95 * 2 + 4 && size > 80) { size -= 6; el.style.fontSize = size + 'px'; }
      });
      await page.screenshot({ path: path.join(args.out, `${date}.png`) });
      fs.unlinkSync(html);
      captions.push(`=== ${date} (post ${date}.png) ===\n${caption(puzzle)}\n`);
      console.log(`${date}  #${puzzle.number}  ${puzzle.player.player_name}`);
    }
    fs.writeFileSync(path.join(args.out, 'captions.txt'), captions.join('\n'));
    console.log(`\nWrote ${args.days} cards and captions.txt to ${args.out}/`);
  } finally {
    await browser.close();
    await db.end();
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
