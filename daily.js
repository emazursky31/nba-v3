// Daily Teammate Blitz: one player per day, name as many of their teammates as you can.
// Everyone gets the same player for a given date (US Eastern), no account needed.

const DAILY_TIME_ZONE = 'America/New_York';
const LAUNCH_DATE = '2026-10-08'; // puzzle #1
const MIN_SEASONS = 10;
const MIN_TEAMMATES = 40;

function normalizeName(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function todayInTimeZone(date = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function puzzleNumber(dateStr) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${LAUNCH_DATE}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

// FNV-1a, so the pick for a date never changes between restarts
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function createDaily(client) {
  let eligibleIds = null;
  const puzzles = new Map(); // dateStr -> puzzle

  async function getEligiblePlayerIds() {
    if (eligibleIds) return eligibleIds;
    const { rows } = await client.query(`
      WITH seasons AS (
        SELECT player_id,
               generate_series(CAST(start_season AS INT), CAST(end_season AS INT)) AS season
        FROM player_team_stints
        WHERE start_season >= '2000'
      ),
      long_careers AS (
        SELECT player_id FROM seasons
        GROUP BY player_id
        HAVING COUNT(DISTINCT season) >= $1
      )
      SELECT lc.player_id
      FROM long_careers lc
      JOIN player_team_stints a ON a.player_id = lc.player_id
      JOIN player_team_stints b ON b.team_abbr = a.team_abbr
        AND b.player_id <> a.player_id
        AND b.start_date <= a.end_date
        AND b.end_date >= a.start_date
      GROUP BY lc.player_id
      HAVING COUNT(DISTINCT b.player_id) >= $2
      ORDER BY lc.player_id
    `, [MIN_SEASONS, MIN_TEAMMATES]);
    eligibleIds = rows.map(r => r.player_id);
    return eligibleIds;
  }

  async function getPuzzle(dateStr) {
    if (puzzles.has(dateStr)) return puzzles.get(dateStr);

    const ids = await getEligiblePlayerIds();
    if (ids.length === 0) throw new Error('No eligible players for the daily puzzle');
    const playerId = ids[hashString(`daily:${dateStr}`) % ids.length];

    const { rows: [player] } = await client.query(
      'SELECT player_id, player_name, headshot_url FROM players WHERE player_id = $1',
      [playerId]
    );

    const { rows: teammateRows } = await client.query(`
      SELECT DISTINCT p2.player_name
      FROM player_team_stints a
      JOIN player_team_stints b ON b.team_abbr = a.team_abbr
        AND b.player_id <> a.player_id
        AND b.start_date <= a.end_date
        AND b.end_date >= a.start_date
      JOIN players p2 ON p2.player_id = b.player_id
      WHERE a.player_id = $1
      ORDER BY p2.player_name
    `, [playerId]);

    const teammates = new Map(); // normalized -> display name
    for (const { player_name } of teammateRows) {
      teammates.set(normalizeName(player_name), player_name);
    }

    const puzzle = { date: dateStr, number: puzzleNumber(dateStr), player, teammates };
    puzzles.set(dateStr, puzzle);
    // Keep only a few days around
    if (puzzles.size > 3) puzzles.delete(puzzles.keys().next().value);
    return puzzle;
  }

  let knownNames = null;
  async function isKnownPlayer(normalizedGuess) {
    if (!knownNames) {
      const { rows } = await client.query('SELECT player_name FROM players');
      knownNames = new Set(rows.map(r => normalizeName(r.player_name)));
    }
    return knownNames.has(normalizedGuess);
  }

  function register(app) {
    app.get('/api/daily', async (req, res) => {
      try {
        const puzzle = await getPuzzle(todayInTimeZone());
        res.json({
          date: puzzle.date,
          number: puzzle.number,
          playerName: puzzle.player.player_name,
          headshotUrl: puzzle.player.headshot_url || null,
          totalTeammates: puzzle.teammates.size
        });
      } catch (err) {
        console.error('[daily] Error loading puzzle:', err);
        res.status(500).json({ error: 'Could not load today\'s puzzle' });
      }
    });

    app.post('/api/daily/guess', async (req, res) => {
      try {
        const { date, guess } = req.body || {};
        if (date !== todayInTimeZone()) {
          return res.status(409).json({ error: 'stale', message: 'A new daily puzzle is out. Refresh to play it.' });
        }
        const puzzle = await getPuzzle(date);
        const normalized = normalizeName(guess);
        if (!normalized) return res.json({ result: 'empty' });

        if (normalized === normalizeName(puzzle.player.player_name)) {
          return res.json({ result: 'self' });
        }
        const match = puzzle.teammates.get(normalized);
        if (match) return res.json({ result: 'correct', name: match });

        const known = await isKnownPlayer(normalized);
        res.json({ result: known ? 'not_teammate' : 'unknown' });
      } catch (err) {
        console.error('[daily] Error checking guess:', err);
        res.status(500).json({ error: 'Could not check that guess' });
      }
    });

    // Full answer list, shown once the timer runs out
    app.get('/api/daily/answers', async (req, res) => {
      try {
        const date = req.query.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date > todayInTimeZone()) {
          return res.status(400).json({ error: 'Invalid date' });
        }
        const puzzle = await getPuzzle(date);
        res.json({ teammates: [...puzzle.teammates.values()] });
      } catch (err) {
        console.error('[daily] Error loading answers:', err);
        res.status(500).json({ error: 'Could not load answers' });
      }
    });
  }

  return { register };
}

module.exports = { createDaily, normalizeName, todayInTimeZone, puzzleNumber, hashString };
