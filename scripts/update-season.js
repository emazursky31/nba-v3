#!/usr/bin/env node
// Brings players and player_team_stints up to date with an NBA season's game logs.
//
//   node scripts/update-season.js                  dry run for the current season
//   node scripts/update-season.js --apply          write the changes
//   node scripts/update-season.js --season 2026-27 --suffix _test --apply
//   node scripts/update-season.js --input gamelog.json   use a saved league game log instead of calling the NBA
//
// How it works: the league game log lists every player's every regular season game with the team
// they played for. For each player, only games after the end_date of their latest stint are looked
// at (so re-running changes nothing). Games for the same team as the latest stint extend it; a
// different team starts a new stint. Players that aren't in `players` yet are added.
// Stint dates are first and last game dates, and start_season/end_season are the calendar year of
// those dates, matching the existing rows.

require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

function parseArgs(argv) {
  const args = { apply: false, suffix: '', season: null, input: null, headshots: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--no-headshot-check') args.headshots = false;
    else if (a === '--suffix') args.suffix = argv[++i] || '';
    else if (a === '--season') args.season = argv[++i];
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!/^[A-Za-z0-9_]*$/.test(args.suffix)) throw new Error('--suffix may only contain letters, numbers and underscores');
  return args;
}

// Oct-Dec belongs to the season that starts that year, Jan-Sep to the one that started the year before.
function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  const start = now.getUTCMonth() >= 9 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function fetchGameLog(season) {
  const params = new URLSearchParams({
    Counter: '0', Direction: 'ASC', LeagueID: '00', PlayerOrTeam: 'P',
    Season: season, SeasonType: 'Regular Season', Sorter: 'DATE'
  });
  const url = `https://stats.nba.com/stats/leaguegamelog?${params}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    Referer: 'https://www.nba.com/',
    Origin: 'https://www.nba.com',
    Accept: 'application/json'
  };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.error(`NBA request failed (attempt ${attempt}/3): ${err.message}`);
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(
    `Could not reach the NBA stats API (${lastErr.message}). It sometimes blocks cloud servers; ` +
    'run this from your own computer, or save the response from the URL below and pass it with --input:\n' + url
  );
}

// -> Map<playerId, { name, games: [{ date, team }] sorted by date }>
function parseGameLog(json) {
  const set = (json.resultSets || []).find(s => s.name === 'LeagueGameLog') || (json.resultSets || [])[0];
  if (!set) throw new Error('Unexpected game log format: no result set');
  const col = Object.fromEntries(set.headers.map((h, i) => [h, i]));
  for (const need of ['PLAYER_ID', 'PLAYER_NAME', 'TEAM_ABBREVIATION', 'GAME_DATE']) {
    if (!(need in col)) throw new Error(`Unexpected game log format: missing ${need}`);
  }
  const players = new Map();
  for (const row of set.rowSet) {
    const id = row[col.PLAYER_ID];
    const date = String(row[col.GAME_DATE]).slice(0, 10);
    if (!players.has(id)) players.set(id, { name: row[col.PLAYER_NAME], games: [] });
    players.get(id).games.push({ date, team: row[col.TEAM_ABBREVIATION] });
  }
  for (const p of players.values()) p.games.sort((a, b) => a.date.localeCompare(b.date));
  return players;
}

// Consecutive games for one team become one run.
function toRuns(games) {
  const runs = [];
  for (const g of games) {
    const last = runs[runs.length - 1];
    if (last && last.team === g.team) last.end = g.date;
    else runs.push({ team: g.team, start: g.date, end: g.date });
  }
  return runs;
}

const yearOf = date => date.slice(0, 4);

// Decide what to do for one player given their games and their latest stint (or null).
function planPlayer(games, latest) {
  const fresh = latest ? games.filter(g => g.date > latest.end_date) : games; // earlier games are already recorded
  const changes = [];
  let stintNumber = latest ? latest.stint_number : 0;
  toRuns(fresh).forEach((run, i) => {
    if (i === 0 && latest && latest.team_abbr === run.team) {
      changes.push({ type: 'extend', stint_number: latest.stint_number, team: run.team, end_date: run.end, end_season: yearOf(run.end) });
      return;
    }
    stintNumber += 1;
    changes.push({
      type: 'new', stint_number: stintNumber, team: run.team,
      start_date: run.start, end_date: run.end, start_season: yearOf(run.start), end_season: yearOf(run.end)
    });
  });
  return changes;
}

async function headshotFor(id, check) {
  const url = `https://cdn.nba.com/headshots/nba/latest/260x190/${id}.png`;
  if (!check) return url;
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return res.ok ? url : null;
  } catch {
    return url; // can't tell; the image has a fallback if it fails to load
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
    return;
  }
  if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is not set (put it in .env)');

  const season = args.season || currentSeason();
  const playersTable = `players${args.suffix}`;
  const stintsTable = `player_team_stints${args.suffix}`;
  console.log(`${args.apply ? 'APPLYING' : 'Dry run'}: season ${season}, tables ${playersTable} / ${stintsTable}`);

  const json = args.input ? JSON.parse(fs.readFileSync(args.input, 'utf8')) : await fetchGameLog(season);
  const log = parseGameLog(json);
  console.log(`Game log: ${log.size} players with games`);
  if (log.size === 0) { console.log('Nothing to do.'); return; }

  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  try {
    const known = new Map((await db.query(`SELECT player_id, player_name FROM ${playersTable}`)).rows.map(r => [r.player_id, r.player_name]));
    const names = new Map();
    for (const [id, name] of known) names.set(name, id);

    const { rows: latestRows } = await db.query(`
      SELECT DISTINCT ON (player_id) player_id, team_abbr, stint_number, end_date::text AS end_date
      FROM ${stintsTable}
      ORDER BY player_id, stint_number DESC
    `);
    const latestByPlayer = new Map(latestRows.map(r => [r.player_id, r]));

    const newPlayers = [];
    const stintChanges = []; // { id, name, change }
    for (const [id, p] of log) {
      if (!known.has(id)) {
        newPlayers.push({ id, name: p.name });
        if (names.has(p.name)) console.warn(`  Warning: new player "${p.name}" (${id}) has the same name as existing player ${names.get(p.name)}`);
      }
      for (const change of planPlayer(p.games, latestByPlayer.get(id) || null)) {
        stintChanges.push({ id, name: p.name, change });
      }
    }

    const extended = stintChanges.filter(c => c.change.type === 'extend');
    const created = stintChanges.filter(c => c.change.type === 'new');
    console.log(`\nNew players: ${newPlayers.length}`);
    newPlayers.slice(0, 40).forEach(p => console.log(`  + ${p.name} (${p.id})`));
    console.log(`Stints extended (same team, more games): ${extended.length}`);
    console.log(`New stints (changed team or returning after a gap): ${created.length}`);
    created.filter(c => latestByPlayer.has(c.id)).slice(0, 60).forEach(c => {
      const prev = latestByPlayer.get(c.id);
      console.log(`  ${c.name}: new stint with ${c.change.team} from ${c.change.start_date} (latest on file: ${prev.team_abbr})`);
    });

    if (!args.apply) {
      console.log('\nDry run only. Re-run with --apply to write these changes.');
      return;
    }

    await db.query('BEGIN');
    try {
      for (const p of newPlayers) {
        await db.query(
          `INSERT INTO ${playersTable} (player_id, player_name, headshot_url) VALUES ($1, $2, $3)`,
          [p.id, p.name, await headshotFor(p.id, args.headshots)]
        );
      }
      for (const { id, change: c } of stintChanges) {
        if (c.type === 'extend') {
          await db.query(
            `UPDATE ${stintsTable} SET end_date = $3, end_season = $4 WHERE player_id = $1 AND stint_number = $2`,
            [id, c.stint_number, c.end_date, c.end_season]
          );
        } else {
          await db.query(
            `INSERT INTO ${stintsTable} (player_id, team_abbr, stint_number, start_season, end_season, start_date, end_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, c.team, c.stint_number, c.start_season, c.end_season, c.start_date, c.end_date]
          );
        }
      }
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    console.log('\nDone. Restart the site so cached lookups (like the Daily Blitz player pool) pick up the changes.');
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { parseGameLog, toRuns, planPlayer, currentSeason };
