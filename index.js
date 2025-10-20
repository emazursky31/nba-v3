require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Client } = require('pg');

const rooms = {};
const waitingPlayers = [];

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["https://nameateammate.com"], // Add "https://www.nameateammate.com" too if you enable www
    methods: ["GET", "POST"],
    credentials: true
  }
});


const socketRoomMap = {};
const playersInGame = new Set(); // socket.id values
const activeTimers = new Map();
const gameCreationLocks = new Set();
const disconnectedPlayers = new Map(); // userId -> {roomId, disconnectTime, socketId, username}
const RECONNECTION_GRACE_PERIOD = 45000; // 45 seconds

const defaultPlayerImage = 
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAAvklEQVRoge3XsQ2AIBBF0ZLpDoBuwHFHqK8cQvMrIo3FLPHom/b2mX9rcNqZmZmZmZmZmZmdFz5ec3m6F3+v4PYs3PmR7DbiDD1N9g5IuT16CWYExozP7G9Czzxq/cE8ksYbFxExk2RcMUfYHNk0RMYPhk0QcMbJHUYyNsi9h5YDyYFSNqLD6c+5h3tGn+MO9ZftHJz5nz/rq3ZTzRzqkIxuYwAAAABJRU5ErkJggg==';


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
});

client.connect()
  .then(() => console.log('✅ Connected to Supabase PostgreSQL!'))
  .catch(err => {
    console.error('Connection error:', err);
    process.exit(1);
  });

app.use(express.json());


// Redirect Render subdomain to custom domain
app.use((req, res, next) => {
  const renderDomain = 'nba-head2head-v2.onrender.com';
  const customDomain = 'nameateammate.com';

  if (
    req.hostname === renderDomain &&
    !req.originalUrl.startsWith("/socket.io") // 🛑 Don't redirect WebSocket handshakes
  ) {
    return res.redirect(301, `https://${customDomain}${req.originalUrl}`);
  }

  next();
});


app.post('/api/create-share', async (req, res) => {
  try {
    const { winner, loser, turnCount, leadoffPlayer, finalPlayer, era, fullChain } = req.body;
    
    // Generate short random ID
    const shareId = Math.random().toString(36).substring(2, 8);
    
    const query = `
      INSERT INTO game_results (share_id, winner, loser, turn_count, leadoff_player, final_player, era, full_chain)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING share_id
    `;
    
    const result = await client.query(query, [shareId, winner, loser, turnCount, leadoffPlayer, finalPlayer, era, JSON.stringify(fullChain)]);
    
    res.json({ shareId: result.rows[0].share_id });
  } catch (error) {
    console.error('Error creating share:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});



function normalizeForSearch(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}





app.get('/players', async (req, res) => {
  const input = (req.query.q || '').trim();

  if (!input) {
    return res.json([]);
  }

  // Normalize the search input
  const normalizedInput = normalizeForSearch(input);
  const names = normalizedInput.split(/\s+/);

  let query;
  let params;

  if (names.length === 1) {
    query = `
      SELECT DISTINCT p.player_id, p.player_name,
        (SELECT pts.team_abbr 
         FROM player_team_stints pts 
         WHERE pts.player_id = p.player_id 
         ORDER BY pts.end_date DESC LIMIT 1) AS current_team,
        (SELECT MIN(CAST(pts.start_season AS INT))
         FROM player_team_stints pts 
         WHERE pts.player_id = p.player_id) AS first_year,
        (SELECT MAX(CAST(pts.end_season AS INT))
         FROM player_team_stints pts 
         WHERE pts.player_id = p.player_id) AS last_year
      FROM players p
      WHERE 
        LOWER(REGEXP_REPLACE(p.player_name, '[^\\w\\s]', '', 'g')) ILIKE $1 || '%'  
        OR LOWER(REGEXP_REPLACE(p.player_name, '[^\\w\\s]', '', 'g')) ILIKE '% ' || $1 || '%'  
      ORDER BY p.player_name
      LIMIT 20;
    `;
    params = [names[0]];
  } else {
    query = `
      SELECT DISTINCT p.player_id, p.player_name,
        (SELECT pts.team_abbr 
         FROM player_team_stints pts 
         WHERE pts.player_id = p.player_id 
         ORDER BY pts.end_date DESC LIMIT 1) AS current_team,
        (SELECT MIN(CAST(pts.start_season AS INT))
         FROM player_team_stints pts 
         WHERE pts.player_id = p.player_id) AS first_year,
        (SELECT MAX(CAST(pts.end_season AS INT))
         FROM player_team_stints pts 
         WHERE pts.player_id = p.player_id) AS last_year
      FROM players p
      WHERE 
        LOWER(REGEXP_REPLACE(p.player_name, '[^\\w\\s]', '', 'g')) ILIKE $1 || '%'  
        AND LOWER(REGEXP_REPLACE(p.player_name, '[^\\w\\s]', '', 'g')) ILIKE '% ' || $2 || '%'  
      ORDER BY p.player_name
      LIMIT 20;
    `;
    params = [names[0], names[1]];
  }

  try {
    const result = await client.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error querying players:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/player-career', async (req, res) => {
  try {
    const playerName = req.query.name;
    
    if (!playerName) {
      return res.status(400).json({ error: 'Player name is required' });
    }
    
    console.log(`[/player-career] Request for: ${playerName}`);
    
    const careerData = await getPlayerCareerDetails(playerName);
    
    if (!careerData) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    res.json(careerData);
    
  } catch (error) {
    console.error('[/player-career] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/user-stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const query = `
      SELECT 
        games_played, wins, losses, total_turns,
        modern_era_wins, modern_era_losses,
        golden_era_wins, golden_era_losses, 
        classic_era_wins, classic_era_losses,
        pioneer_era_wins, pioneer_era_losses
      FROM user_stats 
      WHERE user_id = $1
    `;
    
    const result = await client.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return res.json({
        games_played: 0, wins: 0, losses: 0, total_turns: 0,
        avg_turns: 0, win_rate: 0,
        era_stats: {
          'modern': { wins: 0, losses: 0 },
          'golden': { wins: 0, losses: 0 },
          'classic': { wins: 0, losses: 0 }, 
          'pioneer': { wins: 0, losses: 0 }
        }
      });
    }
    
    const stats = result.rows[0];
    const avgTurns = stats.games_played > 0 ? 
      Math.round((stats.total_turns / stats.games_played) * 10) / 10 : 0;
    const winRate = stats.games_played > 0 ? 
      Math.round((stats.wins / stats.games_played) * 100) : 0;
    
    res.json({
      games_played: stats.games_played,
      wins: stats.wins,
      losses: stats.losses,
      total_turns: stats.total_turns,
      avg_turns: avgTurns,
      win_rate: winRate,
      era_stats: {
        'modern': { 
          wins: stats.modern_era_wins || 0, 
          losses: stats.modern_era_losses || 0 
        },
        'golden': { 
          wins: stats.golden_era_wins || 0, 
          losses: stats.golden_era_losses || 0 
        },
        'classic': { 
          wins: stats.classic_era_wins || 0, 
          losses: stats.classic_era_losses || 0 
        },
        'pioneer': { 
          wins: stats.pioneer_era_wins || 0, 
          losses: stats.pioneer_era_losses || 0 
        }
      }
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/share/:shareId', (req, res) => {
  try {
    const { shareId } = req.params;
    // Fix: Use decodeURIComponent + atob instead of direct atob
    const gameData = JSON.parse(decodeURIComponent(atob(shareId)));
    
    const eraNames = {
      '2000-present': 'Modern Era',
      '1980-1999': 'Golden Era',
      '1960-1979': 'Classic Era',
      'pre-1960': 'Pioneer Era'
    };
    
    // Rest of the route code remains the same...
    const metaTags = `
      <meta property="og:title" content="NBA Teammate Game Results" />
      <meta property="og:description" content="${gameData.w} beat ${gameData.l} in ${gameData.t} turns! Connected ${gameData.s} to ${gameData.f} (${eraNames[gameData.e]}). View the full game flow!" />
      <meta property="og:type" content="website" />
      <meta property="og:url" content="${req.protocol}://${req.get('host')}/share/${shareId}" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content="NBA Teammate Game Results" />
      <meta name="twitter:description" content="${gameData.w} won in ${gameData.t} turns connecting ${gameData.s} to ${gameData.f}!" />
    `;
    
    const fs = require('fs');
    const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    
    html = html.replace('<head>', `<head>${metaTags}`);
    html = html.replace('</head>', `
      <script>
        window.sharedGameData = ${JSON.stringify(gameData)};
      </script>
      </head>
    `);
    
    // Set proper content type to ensure HTML is rendered correctly
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('Error parsing share link:', error);
    res.redirect('/');
  }
});



app.get('/s/:shareId', (req, res) => {
  try {
    const { shareId } = req.params;
    // Handle the compressed/shortened format
    const gameData = JSON.parse(decodeURIComponent(atob(shareId)));
    
    const eraNames = {
      'M': 'Modern Era',
      'G': 'Golden Era', 
      'C': 'Classic Era',
      'P': 'Pioneer Era'
    };
    
    const fullEraName = eraNames[gameData.e] || 'Modern Era';
    
    const metaTags = `
      <meta property="og:title" content="NBA Teammate Game Results" />
      <meta property="og:description" content="${gameData.w} beat ${gameData.l} in ${gameData.t} turns! ${gameData.s} ➜ ${gameData.f} (${fullEraName})" />
      <meta property="og:type" content="website" />
      <meta property="og:url" content="${req.protocol}://${req.get('host')}/s/${shareId}" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content="NBA Teammate Game Results" />
      <meta name="twitter:description" content="${gameData.w} won in ${gameData.t} turns!" />
    `;
    
    const fs = require('fs');
    const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    
    html = html.replace('<head>', `<head>${metaTags}`);
    html = html.replace('</head>', `
      <script>
        window.sharedGameData = ${JSON.stringify(gameData)};
      </script>
      </head>
    `);
    
    // Set proper content type to ensure HTML is rendered correctly
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('Error parsing short share link:', error);
    res.redirect('/');
  }
});





app.get('/g/:shareId([a-zA-Z0-9]+)', async (req, res) => {
  try {
    const { shareId } = req.params;
    
    console.log(`[SHARE] Request for shareId: ${shareId}`);
    
    const query = 'SELECT * FROM game_results WHERE share_id = $1';
    const result = await client.query(query, [shareId]);
    
    if (result.rows.length === 0) {
      console.log(`[SHARE] No game found for shareId: ${shareId}`);
      return res.redirect('/');
    }
    
    const gameData = result.rows[0];
    console.log(`[SHARE] Found game data:`, gameData);
    
    const eraNames = {
      '2000-present': 'Modern Era',
      '1980-1999': 'Golden Era',
      '1960-1979': 'Classic Era',
      'pre-1960': 'Pioneer Era'
    };
    
    const escapeHtml = (str) => {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    
    const metaTags = `
      <meta property="og:title" content="NBA Teammate Game Results" />
      <meta property="og:description" content="${escapeHtml(gameData.winner)} beat ${escapeHtml(gameData.loser)} in ${gameData.turn_count} turns! ${escapeHtml(gameData.leadoff_player)} ➜ ${escapeHtml(gameData.final_player)} (${eraNames[gameData.era] || 'Modern Era'})" />
      <meta property="og:type" content="website" />
      <meta property="og:url" content="${req.protocol}://${req.get('host')}/g/${shareId}" />
    `;
    
    const fs = require('fs');
    const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    
    html = html.replace('<head>', `<head>${metaTags}`);
    
    // Parse full_chain safely
    let fullChain = [];
    try {
      fullChain = Array.isArray(gameData.full_chain) ? gameData.full_chain : JSON.parse(gameData.full_chain || '[]');
    } catch (e) {
      console.error(`[SHARE] Error parsing full_chain:`, e);
      fullChain = [];
    }
    
    const escapeJs = (str) => {
      if (!str) return '';
      return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    };
    
    html = html.replace('</head>', `
      <script>
        console.log('[SHARE] Injecting sharedGameData for shareId: ${shareId}');
        window.sharedGameData = {
          w: "${escapeJs(gameData.winner)}",
          l: "${escapeJs(gameData.loser)}",
          t: ${gameData.turn_count || 0},
          s: "${escapeJs(gameData.leadoff_player)}",
          f: "${escapeJs(gameData.final_player)}",
          e: "${escapeJs(gameData.era)}",
          ts: ${Date.parse(gameData.created_at) || Date.now()},
          chain: ${JSON.stringify(fullChain)}
        };
        console.log('[SHARE] sharedGameData set:', window.sharedGameData);
      </script>
      </head>
    `);
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
    
  } catch (error) {
    console.error(`[SHARE] Error:`, error);
    res.redirect('/');
  }
});



// Serve static files
app.use(express.static(path.join(__dirname, 'public')));


// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory games state: roomId -> game data
const games = {};
console.log('Games object ID:', games);



async function getPlayerByName(playerName) {
  const query = `
    SELECT player_id, player_name, headshot_url
    FROM players
    WHERE LOWER(player_name) = LOWER($1)
    LIMIT 1;
  `;
  const { rows } = await client.query(query, [playerName]);
  console.log(`[DEBUG] getPlayerByName for "${playerName}":`, rows[0] || {});
  return rows[0] || {};
}


// Add this function with your other database functions
async function getPlayerCareerDetails(playerName) {
  try {
    console.log(`[getPlayerCareerDetails] Fetching career data for: ${playerName}`);
    
    // Get player basic info and career summary
    const playerQuery = `
      SELECT DISTINCT p.player_name, 
             MIN(CAST(pts.start_season AS INT)) as first_year,
             MAX(CAST(pts.end_season AS INT)) as last_year,
             COUNT(DISTINCT pts.team_abbr) as total_teams
      FROM players p
      JOIN player_team_stints pts ON p.player_id = pts.player_id
      WHERE p.player_name = $1
      GROUP BY p.player_name
    `;
    
    const playerResult = await client.query(playerQuery, [playerName]);
    
    if (playerResult.rows.length === 0) {
      return null;
    }
    
    const playerInfo = playerResult.rows[0];
    
    // Get team stints
    const stintsQuery = `
      SELECT pts.team_abbr, pts.start_season, pts.end_season
      FROM players p
      JOIN player_team_stints pts ON p.player_id = pts.player_id
      WHERE p.player_name = $1
      ORDER BY CAST(pts.start_season AS INT) ASC, CAST(pts.end_season AS INT) ASC
    `;
    
    const stintsResult = await client.query(stintsQuery, [playerName]);
    const rawStints = stintsResult.rows;

    // Apply the same merging logic as getSharedTeams to handle duplicate/overlapping stints
    const rangesByTeam = {};
    for (const stint of rawStints) {
      const team = stint.team_abbr;
      const startYear = parseInt(stint.start_season);
      const endYear = parseInt(stint.end_season);
      
      if (!rangesByTeam[team]) rangesByTeam[team] = [];
      rangesByTeam[team].push([startYear, endYear]);
    }

    // Merge overlapping or adjacent ranges per team
    const mergedStints = [];
    for (const team in rangesByTeam) {
      const ranges = rangesByTeam[team];
      ranges.sort((a, b) => a[0] - b[0]);

      let [curStart, curEnd] = ranges[0];
      for (let i = 1; i < ranges.length; i++) {
        const [nextStart, nextEnd] = ranges[i];
        if (nextStart <= curEnd + 1) {
          // Overlapping or adjacent
          curEnd = Math.max(curEnd, nextEnd);
        } else {
          mergedStints.push({
            team: team,
            startYear: curStart,
            endYear: curEnd
          });
          [curStart, curEnd] = [nextStart, nextEnd];
        }
      }
      // Push the final range
      mergedStints.push({
        team: team,
        startYear: curStart,
        endYear: curEnd
      });
    }

    // Sort by start year
    mergedStints.sort((a, b) => a.startYear - b.startYear);
    
    return {
      playerName: playerInfo.player_name,
      firstYear: playerInfo.first_year,
      lastYear: playerInfo.last_year,
      totalTeams: parseInt(playerInfo.total_teams),
      teamStints: mergedStints
    };
    
  } catch (error) {
    console.error('[getPlayerCareerDetails] Database error:', error);
    throw error;
  }
}






io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  


socket.on('findMatch', ({ username, userId, era = '2000-present' }) => {
  socket.data.username = username;
  socket.data.userId = userId;

  // ✅ Player must not already be in a game
  if (playersInGame.has(socket.id)) {
    console.log(`⚠️  ${username} (${socket.id}) tried to find match but is already in a game`);
    return;
  }

  // ✅ Remove stale/disconnected sockets from waiting queue
  while (waitingPlayers.length > 0 && !waitingPlayers[0].socket.connected) {
    const stale = waitingPlayers.shift();
    console.log(`⚠️ Removed stale socket ${stale.socket.id} from waitingPlayers`);
  }

  if (waitingPlayers.length > 0) {
    let opponentEntry = waitingPlayers.shift();

    // Skip if opponent socket is the same as current socket
    while (opponentEntry && opponentEntry.socket.id === socket.id) {
      console.log(`⚠️ Skipped matching socket with itself: ${socket.id}`);
      opponentEntry = waitingPlayers.shift();
    }

    if (!opponentEntry) {
      // No valid opponent found after skipping self, re-queue and wait
      if (!waitingPlayers.some(entry => entry.socket.id === socket.id)) {
        waitingPlayers.push({ socket });
      }
      socket.emit('waitingForMatch');
      return;
    }

    const opponentSocket = opponentEntry.socket;
    const opponentUsername = opponentSocket.data.username;

    // Defensive: ensure opponent is connected
    if (!opponentSocket.connected) {
      console.log(`⚠️ Opponent socket ${opponentSocket.id} disconnected after shift. Re-queueing ${username}`);
      if (!waitingPlayers.some(entry => entry.socket.id === socket.id)) {
        waitingPlayers.push({ socket });
      }
      socket.emit('waitingForMatch');
      return;
    }

    const roomId = `room-${socket.id}-${opponentSocket.id}`;
    console.log(`✅ Matched players ${username} (${socket.id}) and ${opponentUsername} (${opponentSocket.id}) in room ${roomId}`);

    if (!games[roomId]) games[roomId] = { 
      players: [], 
      userIds: {}, 
      usernames: {},
      playersReady: new Set(),
      selectedEra: era
    };

    games[roomId].players.push(socket.id, opponentSocket.id);
    games[roomId].userIds[socket.id] = userId;
    games[roomId].userIds[opponentSocket.id] = opponentSocket.data.userId;

    if (!userId || !opponentSocket.data.userId) {
      console.error('[MATCH] Missing userIds:', {
        currentUser: { socketId: socket.id, userId },
        opponent: { socketId: opponentSocket.id, userId: opponentSocket.data.userId }
      });

      // Re-queue both players for another match attempt
      waitingPlayers.push({ socket });
      if (opponentSocket.data.userId) {
        waitingPlayers.push({ socket: opponentSocket });
      }
      return;
    }

    // ✅ ENSURE SOCKET DATA IS SET
    socket.data.userId = userId;
    if (!opponentSocket.data.userId) {
      console.warn('[MATCH] Opponent missing userId, attempting to get from stored data');
      opponentSocket.data.userId = opponentSocket.data.userId || userId;
    }

    games[roomId].usernames[socket.id] = username;
    games[roomId].usernames[opponentSocket.id] = opponentUsername;

    // ✅ Track socket-room mapping
    socketRoomMap[socket.id] = roomId;
    socketRoomMap[opponentSocket.id] = roomId;

    // Store roomId on socket.data for both
    socket.data.roomId = roomId;
    opponentSocket.data.roomId = roomId;

    // Add players to the in-game set
    playersInGame.add(socket.id);
    playersInGame.add(opponentSocket.id);

    // ✅ SEND MATCHED EVENT (triggers countdown) - NO GAME START YET
    socket.emit('matched', { roomId, opponent: opponentUsername });
    opponentSocket.emit('matched', { roomId, opponent: username });
    
    console.log(`📱 Matched screen sent to both players in room ${roomId}`);

  } else {
    console.log(`🕐 No opponents. ${username} (${socket.id}) added to waiting queue`);

    // Avoid duplicates in waiting queue
    if (!waitingPlayers.some(entry => entry.socket.id === socket.id)) {
      waitingPlayers.push({ socket });
    }

    socket.emit('waitingForMatch');
  }
});


socket.on('readyToStart', ({ roomId }) => {
  const game = games[roomId];
  if (!game) {
    console.log(`❌ No game found for room ${roomId}`);
    return;
  }

  // Mark this player as ready
  game.playersReady.add(socket.id);
  
  console.log(`✅ Player ${socket.data.username} ready to start in room ${roomId}. Ready count: ${game.playersReady.size}/${game.players.length}`);

  // Start game when both players are ready
  if (game.playersReady.size === game.players.length && !game.leadoffPlayer) {
    console.log(`🚀 All players ready! Starting game in room ${roomId}`);
    startGame(roomId, game.selectedEra, game.timeLimit);
  }
});


socket.on('userSignedIn', ({ userId, username }) => {
  console.log('[SIGNIN] Setting socket data for user:', { userId, username });
  socket.data.userId = userId;
  socket.data.username = username;
});


socket.on('joinGame', async ({ roomId, username, userId, era, timeLimit }) => {
  await handleJoinGame(socket, roomId, username, userId, era, timeLimit);
});





// Diagnostic event to check current games from client on demand
socket.on('testGames', () => {
  console.log('[testGames] games keys:', Object.keys(games));
  socket.emit('testGamesResult', Object.keys(games));
});

function ensureLeadoffAtFront(game) {
  const leadoffName = typeof game.leadoffPlayer === 'string'
    ? game.leadoffPlayer
    : (typeof game.leadoffPlayer === 'object' && game.leadoffPlayer.player_name)
      ? game.leadoffPlayer.player_name
      : '';

  // Remove any previous leadoff entries
  game.successfulGuesses = game.successfulGuesses.filter(g => !g.isLeadoff);

  // Add the leadoff player at the front
  game.successfulGuesses.unshift({
    name: leadoffName,
    guesser: null, // Optional: use null instead of 'Leadoff'
    isLeadoff: true,
    sharedTeams: []
  });
}


  // Handle player guess
socket.on('playerGuess', async ({ guess }) => {
  const roomId = socketRoomMap[socket.id];
  if (!roomId) {
    socket.emit('message', 'You are not part of any active game room.');
    return;
  }

  const game = games[roomId];
  if (!game) {
    socket.emit('message', 'Game room not found.');
    return;
  }

  if (socket.id !== game.activePlayerSocketId) {
    socket.emit('message', "It's not your turn!");
    return;
  }

  const normalizedGuess = guess.trim().toLowerCase();

  if (!game.leadoffPlayer) {
    socket.emit('message', "Game hasn't started properly yet.");
    return;
  }

  // Defensive: leadoffPlayer may be an object or string
  const leadoffPlayerName = typeof game.leadoffPlayer === 'object' && game.leadoffPlayer.player_name
    ? game.leadoffPlayer.player_name.trim()
    : (typeof game.leadoffPlayer === 'string' ? game.leadoffPlayer.trim() : '');

  if (leadoffPlayerName && normalizedGuess === leadoffPlayerName.toLowerCase()) {
    socket.emit('message', `You can't guess the starting player: "${leadoffPlayerName}"`);
    return;
  }

  if (
    Array.isArray(game.successfulGuesses) &&
    game.successfulGuesses.some(
      g => g && typeof g.name === 'string' && g.name.toLowerCase() === normalizedGuess
    )
  ) {
    socket.emit('message', `"${guess}" has already been guessed.`);
    return;
  }

  const validGuess = game.teammates.some(t => t.toLowerCase() === normalizedGuess);

  if (validGuess) {
    console.log(`[SERVER] VALID guess "${guess}" by ${socket.data.username}. Advancing turn.`);

    clearInterval(game.timer);
    game.timer = null;

    game.turnCount++;

    const previousPlayer = game.currentPlayerName;

    const [career1, career2] = await Promise.all([
      getCareer(previousPlayer.trim()),
      getCareer(guess.trim())
    ]);

    const sharedTeams = getSharedTeams(career1, career2);

    game.successfulGuesses.push({
      guesser: game.usernames[socket.id],
      name: guess.trim(),
      sharedTeams
    });

    ensureLeadoffAtFront(game);

    game.currentTurn = (game.currentTurn + 1) % 2;
    game.currentPlayerName = guess.trim();
    game.activePlayerSocketId = game.players[game.currentTurn];

    game.teammates = await getTeammates(game.currentPlayerName);
    game.timeLeft = game.timeLimit || 30;

    // Normalize currentPlayerName for DB query
    const trimmedCurrentPlayerName = game.currentPlayerName.trim();
    const { headshot_url: currentPlayerHeadshotUrl } = await getPlayerByName(trimmedCurrentPlayerName);

    console.log('[SERVER] Emitting turnEnded with successfulGuesses:', JSON.stringify(game.successfulGuesses, null, 2));
    console.log('[SERVER] Emitting currentPlayerHeadshotUrl:', currentPlayerHeadshotUrl);

    io.to(roomId).emit('turnEnded', {
      successfulGuess: `Player ${game.usernames[socket.id]} guessed "${guess.trim()}" successfully!`,
      guessedByUsername: game.usernames[socket.id],
      nextPlayerId: game.activePlayerSocketId,
      nextPlayerUsername: game.usernames[game.activePlayerSocketId],
      currentPlayerName: trimmedCurrentPlayerName,           
      currentPlayerHeadshotUrl: currentPlayerHeadshotUrl || defaultPlayerImage,                             
      timeLeft: game.timeLeft,
      successfulGuesses: game.successfulGuesses,
    });

    startTurnTimer(roomId);
  } else {
    socket.emit('message', `Not a valid teammate`);
    
    const opponentSocketId = game.players.find(id => id !== socket.id);
    if (opponentSocketId) {
    const opponentSocket = io.sockets.sockets.get(opponentSocketId);
    if (opponentSocket && opponentSocket.connected) {
      opponentSocket.emit('opponentIncorrectGuess', {
        guesserName: game.usernames[socket.id],
        incorrectGuess: guess.trim(),
        currentPlayerName: game.currentPlayerName
      });
      }
      }
  }
});


socket.on('playerSkip', () => {
    const roomId = socketRoomMap[socket.id];
    const game = games[roomId];
    if (!game) {
        socket.emit('skipError', 'Game room not found');
        return;
    }

    const playerId = socket.id;
    
    // Validate skip usage
    if (game.skipsUsed && game.skipsUsed[playerId]) {
        socket.emit('skipError', 'You have already used your skip for this game');
        return;
    }

    // Validate it's player's turn
    if (game.activePlayerSocketId !== playerId) {
        socket.emit('skipError', 'It is not your turn');
        return;
    }

    // Initialize skipsUsed if it doesn't exist
    if (!game.skipsUsed) {
        game.skipsUsed = {};
    }

    // Mark skip as used
    game.skipsUsed[playerId] = true;

    // Clear the timer
    if (game.timer) {
        clearInterval(game.timer);
        game.timer = null;
    }

    // Switch to the other player (keep same NBA player and teammates)
    game.currentTurn = (game.currentTurn + 1) % 2;
    game.activePlayerSocketId = game.players[game.currentTurn];
    game.timeLeft = game.timeLimit || 30; 

    // Notify both players
    io.to(roomId).emit('turnSkipped', {
        skippedBy: playerId,
        skippedByUsername: game.usernames[playerId],
        newActivePlayer: game.activePlayerSocketId,
        newActivePlayerUsername: game.usernames[game.activePlayerSocketId],
        currentPlayerName: game.currentPlayerName, // Same NBA player
        timeLeft: game.timeLeft,
        skipsUsed: game.skipsUsed
    });

    // Start new turn timer
    startTurnTimer(roomId);
});









socket.on('requestRematch', ({ roomId }) => {
  console.log(`[requestRematch] roomId: "${roomId}"`);
  console.log('[requestRematch] games keys:', Object.keys(games));

  const game = games[roomId];
  if (!game) {
    console.log('[requestRematch] No game found for room:', roomId);
    return;
  }

  console.log('Current game.usernames object:', game.usernames);
  console.log('Looking up username for socket.id:', socket.id);

  const username = game.usernames[socket.id];
  if (!username) {
    console.log('No username found for socket.id:', socket.id);
    return;
  }

  if (!game.rematchVotes) {
    game.rematchVotes = new Set();
    console.log('Initialized rematchVotes Set for room:', roomId);
  }

  game.rematchVotes.add(username.toLowerCase());
  console.log('Current rematch votes:', Array.from(game.rematchVotes));

  // Notify other players in the room that this player requested rematch
  socket.to(roomId).emit('rematchRequested', {
    username,
    playersWaiting: game.rematchVotes.size + 1, // Include current player
    totalPlayers: Object.keys(game.usernames).length
  });
  console.log(`Emitted 'rematchRequested' to others in room ${roomId} for user ${username}`);

  const playersInRoom = Object.values(game.usernames).map(u => u.toLowerCase());
  console.log('Players currently in room:', playersInRoom);

  const allAgreed = playersInRoom.every(name => game.rematchVotes.has(name));
  console.log('Have all players agreed?', allAgreed);

  

  if (allAgreed) {
    console.log('All players agreed for rematch in room', roomId);
    game.rematchVotes.clear();
    console.log('Cleared rematchVotes for room:', roomId);

    const preservedUserIds = { ...game.userIds };
    console.log('[REMATCH] Preserving userIds:', preservedUserIds);

    // Reset game state for rematch
    game.leadoffPlayer = null;
    game.starting = false;
    game.gameEnded = false;
    game.currentPlayerName = null;
    game.teammates = [];
    game.successfulGuesses = [];
    game.currentTurn = 0;
    game.activePlayerSocketId = null;
    game.timeLeft = game.timeLimit;
    game.turnCount = 0;
    game.skipsUsed = {};

    // ✅ RESTORE userIds AFTER resetting
    game.userIds = preservedUserIds;
    console.log('[REMATCH] Restored userIds:', game.userIds);

    if (game.timer) {
      cleanupTimer(roomId);
      game.timer = null;
    }
   startGame(roomId, game.selectedEra, game.timeLimit);
    io.to(roomId).emit('rematchStarted'); // Notify clients explicitly
    console.log('Emitted rematchStarted to room:', roomId);
  }
});



socket.on('disconnect', async () => {
  const username = socket.data?.username || 'an unnamed player';
  const userId = socket.data?.userId;
  console.log(`User disconnected: ${socket.id} (${username})`);

  // Remove from waitingPlayers queue if waiting
  const waitingIndex = waitingPlayers.findIndex(wp => wp.socket.id === socket.id);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`Removed ${username} from waiting queue`);
  }

  playersInGame.delete(socket.id);

  // Find the room this player was in
  const roomId = socketRoomMap[socket.id];
  if (roomId && games[roomId]) {
    const game = games[roomId];
    const playerIndex = game.players.indexOf(socket.id);
    
    if (playerIndex !== -1) {
      // Check if this is an active game that should allow reconnection
      const isActiveGame = game.leadoffPlayer && game.teammates && game.teammates.length > 0;
      
      if (isActiveGame && userId) {
        console.log(`[DISCONNECT] Starting grace period for ${username} in active game`);
        
        // Store disconnection info for potential reconnection
        disconnectedPlayers.set(userId, {
          roomId,
          disconnectTime: Date.now(),
          socketId: socket.id,
          username,
          playerIndex
        });
        
        // Mark player as disconnected but keep in game
        game.disconnectedPlayers = game.disconnectedPlayers || new Set();
        game.disconnectedPlayers.add(socket.id);
        
        // Notify opponent about disconnection (but timer keeps running)
        const remainingSocketId = game.players.find(id => id !== socket.id);
        if (remainingSocketId) {
          const remainingSocket = io.sockets.sockets.get(remainingSocketId);
          if (remainingSocket && remainingSocket.connected) {
            remainingSocket.emit('opponentDisconnected', {
              message: `${username} lost connection. Game continues...`,
              graceTimeLeft: RECONNECTION_GRACE_PERIOD
            });
          }
        }
        
        // Set grace period timer
        setTimeout(() => {
          const disconnectInfo = disconnectedPlayers.get(userId);
          if (disconnectInfo && disconnectInfo.roomId === roomId) {
            console.log(`[GRACE_EXPIRED] ${username} did not reconnect in time`);
            disconnectedPlayers.delete(userId);
            handlePlayerDisconnectFinal(socket, roomId, username);
          }
        }, RECONNECTION_GRACE_PERIOD);
        
        // Clean up socket mapping but don't remove from game yet
        delete socketRoomMap[socket.id];
        return; // Don't process immediate disconnect
      }
    }
  }

  // Handle immediate disconnect for non-active games
  if (roomId) {
    cleanupTimer(roomId);
    delete socketRoomMap[socket.id];
    console.log(`Removed socket ${socket.id} from socketRoomMap for room ${roomId}`);
  }

  await handlePlayerDisconnect(socket);
});







socket.on('leaveGame', async (data = {}) => {
  const username = socket.data?.username || 'Unknown';
  const roomId = socketRoomMap[socket.id];
  
  console.log(`🚪 leaveGame: ${socket.id} (${username}) from room ${roomId}`);

  // Remove from waiting queue
  const waitingIndex = waitingPlayers.findIndex(wp => wp.socket.id === socket.id);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`Removed ${username} from waiting queue`);
  }

  // ✅ IMMEDIATE NOTIFICATION: Find and notify remaining player
  if (roomId && games[roomId]) {
    const game = games[roomId];
    const remainingSocketId = game.players.find(id => id !== socket.id);
    
    if (remainingSocketId) {
      const remainingSocket = io.sockets.sockets.get(remainingSocketId);
      if (remainingSocket && remainingSocket.connected) {
        const remainingUsername = game.usernames[remainingSocketId] || 'Player';
        
        console.log(`[LEAVE_GAME] Notifying ${remainingUsername} that ${username} left`);
        
        // Send both events to ensure coverage
        remainingSocket.emit('opponentLeft', {
          message: 'Your opponent left the game'
        });
        
        remainingSocket.emit('gameOver', {
          reason: 'opponent_left',
          message: `${username} left the game.`,
          winnerName: remainingUsername,
          loserName: username,
          role: 'winner',
          canRematch: false,
          turnCount: game.turnCount || 0
        });
      }
    }
  }

  // Handle disconnect logic
  await handlePlayerDisconnect(socket);
});





socket.on('playerSignedOut', async ({ roomId, username, reason }) => {
  console.log(`Player ${username} signed out from room ${roomId}, reason: ${reason}`);
  
  const game = games[roomId];
  if (!game) return;
  
  const disconnectedSocketId = socket.id;
  const disconnectedUsername = username || game.usernames[disconnectedSocketId] || 'Player';
  
  // Find remaining player and notify them
  const remainingPlayerSocketId = game.players.find(id => id !== disconnectedSocketId);
  
  if (remainingPlayerSocketId) {
    const remainingPlayerSocket = io.sockets.sockets.get(remainingPlayerSocketId);
    const remainingUsername = game.usernames[remainingPlayerSocketId] || 'Player';
    
    if (remainingPlayerSocket && remainingPlayerSocket.connected) {
      console.log(`[SIGNOUT] Notifying ${remainingUsername} that ${disconnectedUsername} signed out`);
      
      // Send both events immediately
      remainingPlayerSocket.emit('opponentLeft', {
        message: 'Your opponent left the game'
      });
      
      remainingPlayerSocket.emit('gameOver', {
        reason: 'opponent_signed_out',
        message: `${disconnectedUsername} signed out. You win!`,
        winnerName: remainingUsername,
        loserName: disconnectedUsername,
        role: 'winner',
        canRematch: false,
        turnCount: game.turnCount || 0
      });
      
      // Update stats
      const remainingUserId = game.userIds[remainingPlayerSocketId] || 
                             remainingPlayerSocket.data?.userId;
      const disconnectedUserId = game.userIds[disconnectedSocketId] || 
                                socket.data?.userId;
      
      if (remainingUserId && disconnectedUserId) {
        try {
          await updateUserStats(remainingUserId, 'win', game.selectedEra || '2000-present', game.turnCount || 0);
          await updateUserStats(disconnectedUserId, 'loss', game.selectedEra || '2000-present', game.turnCount || 0);
          console.log('[SIGNOUT] Stats updated successfully');
        } catch (err) {
          console.error('[SIGNOUT] Error updating stats:', err);
        }
      }
    }
  }
  
  // Clean up the game
  if (game.timer) {
    clearInterval(game.timer);
    delete game.timer;
  }
  
  game.players = [];
  game.usernames = {};
  game.userIds = {};
  game.currentTurn = 0;
  game.currentPlayerName = null;
  game.teammates = [];
  game.successfulGuesses = [];
  game.rematchVotes = new Set();
  
  delete socketRoomMap[disconnectedSocketId];
  playersInGame.delete(disconnectedSocketId);
  
  console.log(`Game in room ${roomId} ended due to ${disconnectedUsername} signing out`);
});







socket.on('getMatchStats', () => {
  const roomId = socketRoomMap[socket.id];
  if (!roomId || !games[roomId]) {
    socket.emit('matchStats', { player1Wins: 0, player2Wins: 0 });
    return;
  }
  socket.emit('matchStats', games[roomId].matchStats || { player1Wins: 0, player2Wins: 0 });
});


socket.on('requestTimerSync', ({ roomId }) => {
  const game = games[roomId];
  if (!game || !game.turnStartTime || game.gameEnded) {
    return;
  }

  const now = Date.now();
  const elapsed = now - game.turnStartTime;
  const remaining = Math.max(0, game.turnDuration - elapsed);

  socket.emit('timerSync', {
    turnStartTime: game.turnStartTime,
    turnDuration: game.turnDuration,
    currentPlayerName: game.currentPlayerName,
    timeLeft: Math.ceil(remaining / 1000),
    activePlayerSocketId: game.activePlayerSocketId
  });
});


// Add this after the existing socket handlers
socket.on('playerResign', ({ roomId }) => {
  const game = games[roomId];
  if (!game) return;
  
  const resigningSocketId = socket.id;
  const resigningUsername = game.usernames[resigningSocketId] || 'Player';
  const remainingSocketId = game.players.find(id => id !== resigningSocketId);
  const remainingUsername = game.usernames[remainingSocketId] || 'Player';
  
  console.log(`[RESIGN] ${resigningUsername} resigned from room ${roomId}`);
  
  // Clear timer
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
  
  if (activeTimers.has(roomId)) {
    clearTimeout(activeTimers.get(roomId));
    activeTimers.delete(roomId);
  }
  
  game.gameEnded = true;
  game.timerRunning = false;
  
  // Update stats
  const resigningUserId = game.userIds[resigningSocketId];
  const remainingUserId = game.userIds[remainingSocketId];
  
  if (resigningUserId && remainingUserId && !game.statsUpdated) {
    updateUserStats(resigningUserId, 'loss', game.selectedEra || '2000-present', game.turnCount || 0);
    updateUserStats(remainingUserId, 'win', game.selectedEra || '2000-present', game.turnCount || 0);
    game.statsUpdated = true;
    console.log(`[RESIGN] Updated stats: ${resigningUsername} loss, ${remainingUsername} win`);
  }
  
  // Send specific messages to each player
  const resigningSocket = io.sockets.sockets.get(resigningSocketId);
  const remainingSocket = io.sockets.sockets.get(remainingSocketId);
  
  if (resigningSocket) {
    resigningSocket.emit('gameOver', {
      reason: 'resigned',
      role: 'loser',
      message: 'You resigned from the game.',
      winnerName: remainingUsername,
      loserName: resigningUsername,
      turnCount: game.turnCount
    });
  }
  
  if (remainingSocket) {
    remainingSocket.emit('gameOver', {
      reason: 'opponent_resigned',
      role: 'winner', 
      message: `${resigningUsername} resigned. You win!`,
      winnerName: remainingUsername,
      loserName: resigningUsername,
      turnCount: game.turnCount
    });
  }
});





// Helper: get teammates of a player by player_name
async function getTeammates(playerName) {
  const query = `
    WITH player_stints AS (
      SELECT team_abbr, start_date, end_date
      FROM player_team_stints pts
      JOIN players p ON pts.player_id = p.player_id
      WHERE p.player_name = $1
    )
    SELECT DISTINCT p2.player_name
    FROM player_team_stints pts2
    JOIN players p2 ON pts2.player_id = p2.player_id
    JOIN player_stints ps ON pts2.team_abbr = ps.team_abbr
    WHERE p2.player_name != $1
      AND pts2.start_date <= ps.end_date
      AND pts2.end_date >= ps.start_date;
  `;

  try {
    const res = await client.query(query, [playerName]);
    return res.rows.map(r => r.player_name);
  } catch (err) {
    console.error('Error fetching teammates:', err);
    return [];
  }
}

function getSharedTeams(career1, career2) {
  const rangesByTeam = {};

  for (const stint1 of career1) {
    for (const stint2 of career2) {
      const team1 = stint1.team?.trim().toUpperCase();
      const team2 = stint2.team?.trim().toUpperCase();

      if (!team1 || !team2 || team1 !== team2) continue;

      const start = Math.max(stint1.startYear, stint2.startYear);
      const end = Math.min(stint1.endYear, stint2.endYear);

      if (start <= end) {
        if (!rangesByTeam[team1]) rangesByTeam[team1] = [];
        rangesByTeam[team1].push([start, end]);
      }
    }
  }

  // 🔁 Merge overlapping or adjacent ranges per team
  const shared = [];
  for (const team in rangesByTeam) {
    const ranges = rangesByTeam[team];
    ranges.sort((a, b) => a[0] - b[0]);

    let [curStart, curEnd] = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
      const [nextStart, nextEnd] = ranges[i];
      if (nextStart <= curEnd + 1) {
        // Overlapping or adjacent
        curEnd = Math.max(curEnd, nextEnd);
      } else {
        shared.push({
          team,
          startYear: curStart,
          endYear: curEnd,
          years: curStart === curEnd ? `${curStart}` : `${curStart}–${curEnd}`,
        });
        [curStart, curEnd] = [nextStart, nextEnd];
      }
    }
    // Push the final range
    shared.push({
      team,
      startYear: curStart,
      endYear: curEnd,
      years: curStart === curEnd ? `${curStart}` : `${curStart}–${curEnd}`,
    });
  }

  console.log('✅ Merged shared teams:', shared);
  return shared;
}




async function getCareer(playerName) {
  console.log('Incoming player name:', playerName);
  const query = `
    SELECT team_abbr AS team, 
           EXTRACT(YEAR FROM start_date::date) AS start_year, 
           EXTRACT(YEAR FROM end_date::date) AS end_year
    FROM player_team_stints pts
    JOIN players p ON pts.player_id = p.player_id
    WHERE LOWER(TRIM(p.player_name)) = LOWER(TRIM($1))
      AND start_date IS NOT NULL
      AND end_date IS NOT NULL
    ORDER BY start_date;
  `;

  try {
    const res = await client.query(query, [playerName]);
    console.log('[DEBUG] getCareer results for', playerName, res.rows);

    if (res.rows.length === 0) {
      console.warn(`[WARN] No career data found for "${playerName}"`);
    }

    return res.rows.map(row => ({
      team: row.team,
      startYear: parseInt(row.start_year, 10),
      endYear: parseInt(row.end_year, 10),
    }));
  } catch (err) {
    console.error('Error fetching career for', playerName, err);
    return [];
  }
}




// Starts the game in a room: picks random first player & teammates
async function startGame(roomId, selectedEra = '2000-present', timeLimit = 30) {
    const game = games[roomId];
  
  
  if (!game) {
    console.log(`❌ No game object found for room ${roomId}`);
    return;
  }

  // ✅ CRITICAL: Prevent duplicate game starts
  if (game.leadoffPlayer) {
    console.log(`⚠️ Game already started for room ${roomId}`);
    return;
  }
  
  // ✅ FIXED: Only block if ACTUALLY starting (not just flagged)
  if (game.starting && game.leadoffPlayer) {
    console.log(`⚠️ Game already starting for room ${roomId}`);
    return;
  }
  
  // ✅ Mark as starting immediately to prevent race conditions
  game.starting = true;
  
  console.log(`[STARTGAME] room ${roomId} starting with:`);

  try {
    // ✅ RESET STATS TRACKING FOR NEW GAME
    game.statsUpdated = false;
    game.turnCount = 0;
    console.log(`[GAME_START] Reset statsUpdated flag for room ${roomId}`);

    // Pick the leadoff player from DB (object with player_id, player_name, headshot_url)
     const leadoffPlayer = await getRandomPlayer(selectedEra);

     game.selectedEra = selectedEra;
    
    // ✅ Double-check that game wasn't started by another process while we were getting random player
    if (game.leadoffPlayer) {
      console.log(`⚠️ Game was started by another process while getting random player for room ${roomId}`);
      return;
    }
    
    game.leadoffPlayer = leadoffPlayer; // full object

    // Get teammates for the leadoff player (pass player_name)
    game.teammates = await getTeammates(leadoffPlayer.player_name);

    // Fully reset state for rematch, include headshot_url in the first guess entry
    game.successfulGuesses = [{
      name: leadoffPlayer.player_name,
      guesser: 'Leadoff',
      isLeadoff: true,
      sharedTeams: [],
      headshot_url: leadoffPlayer.headshot_url || defaultPlayerImage
    }];

    game.rematchVotes = new Set();
    if (game.timer) clearInterval(game.timer);
    game.timeLeft = timeLimit;

    // Pick first player to guess
    const startIndex = Math.floor(Math.random() * game.players.length);
    game.currentTurn = startIndex;
    game.activePlayerSocketId = game.players[game.currentTurn];

    // NBA player currently being guessed
    game.currentPlayerName = leadoffPlayer.player_name;

    // Username of the player whose turn it is
    game.currentGuesserUsername = game.usernames[game.activePlayerSocketId];

    // Map sockets to room again (for safety)
    game.players.forEach((socketId) => {
      socketRoomMap[socketId] = roomId;
    });

    // Logging for debug
    console.log(`→ leadoffPlayer: ${JSON.stringify(leadoffPlayer)}`);
    console.log(`→ teammates: ${JSON.stringify(game.teammates)}`);
    console.log(`→ players: ${game.players}`);
    console.log(`→ currentTurn: ${game.currentTurn}`);
    console.log(`→ activePlayerSocketId: ${game.activePlayerSocketId}`);
    console.log(`→ currentPlayerName (NBA player): ${game.currentPlayerName}`);
    console.log(`→ currentGuesserUsername: ${game.currentGuesserUsername}`);
    console.log(`→ statsUpdated: ${game.statsUpdated}`);

    // Notify each player individually
    game.players.forEach((socketId) => {
      const opponentSocketId = game.players.find(id => id !== socketId);
      const opponentUsername = game.usernames[opponentSocketId] || 'Opponent';

      io.to(socketId).emit('gameStarted', {
        firstPlayerId: game.activePlayerSocketId,
        currentPlayerName: game.currentPlayerName,
        currentPlayerUsername: game.currentGuesserUsername,
        currentPlayerHeadshotUrl: leadoffPlayer.headshot_url || defaultPlayerImage,
        timeLeft: game.timeLeft,
        leadoffPlayer: game.leadoffPlayer,
        opponentName: opponentUsername,
        selectedEra: game.selectedEra,
        timeLimit: game.timeLimit
      });
    });

    // Start turn timer
    startTurnTimer(roomId);
    
  } finally {
    // ✅ Always reset starting flag
    game.starting = false;
  }
}








async function getRandomPlayer(era = '2000-present') {
  let seasonFilter = '';
  let minSeasons = 10; // Default for modern era
  
  switch(era) {
    case '2000-present':
      seasonFilter = "WHERE start_season >= '2000'";
      minSeasons = 10;
      break;
    case '1980-1999':
      seasonFilter = "WHERE start_season >= '1980' AND start_season < '2000'";
      minSeasons = 10;
      break;
    case '1960-1979':
      seasonFilter = "WHERE start_season >= '1960' AND start_season < '1980'";
      minSeasons = 10;
      break;
    case 'pre-1960':
      seasonFilter = "WHERE start_season < '1960'";
      minSeasons = 8;
      break;
  }
  
  const query = `
    WITH player_seasons AS (
      SELECT
        player_id,
        generate_series(CAST(start_season AS INT), CAST(end_season AS INT)) AS season
      FROM player_team_stints
      ${seasonFilter}
    )
    SELECT 
      p.player_id,
      p.player_name,
      p.headshot_url
    FROM players p
    JOIN (
      SELECT player_id
      FROM player_seasons
      GROUP BY player_id
      HAVING COUNT(DISTINCT season) >= ${minSeasons}
    ) ps ON p.player_id = ps.player_id
    ORDER BY RANDOM()
    LIMIT 1;
  `;

  const res = await client.query(query);
  return res.rows[0] || null;
}



async function handleJoinGame(socket, roomId, username, userId, era = '2000-present', timeLimit = 30) {
  console.log(`[handleJoinGame] ${username} attempting to join room: ${roomId} with era: ${era}`);
  
  if (!userId || typeof userId !== 'string') {
    console.error('[handleJoinGame] Invalid userId:', userId, 'for user:', username);
    socket.emit('message', 'Authentication error. Please refresh and sign in again.');
    return;
  }
  
  if (!roomId) {
    console.error('[handleJoinGame] ERROR: roomId is null or undefined');
    return;
  }

  // Check for existing active session with same userId in ANY room
  for (const [existingRoomId, game] of Object.entries(games)) {
    if (game.userIds) {
      for (const [socketId, existingUserId] of Object.entries(game.userIds)) {
        if (existingUserId === userId && socketId !== socket.id) {
          console.log(`[RECONNECTION] Found existing session for ${username} in room ${existingRoomId}`);
          
          // Check if this is the same room they're trying to join
          if (existingRoomId === roomId) {
            // ✅ Check if game has already ended
            if (game.gameEnded) {
              console.log(`[RECONNECTION] Game in room ${roomId} has ended, allowing reconnection for ended game view`);
              
              // Update socket mapping for ended game
              socketRoomMap[socket.id] = roomId;
              socket.join(roomId);
              socket.data.userId = userId;
              socket.data.username = username;
              
              // Replace old socket with new one in game tracking
              const oldSocketIndex = game.players.indexOf(socketId);
              if (oldSocketIndex !== -1) {
                game.players[oldSocketIndex] = socket.id;
                game.usernames[socket.id] = username;
                delete game.usernames[socketId];
                delete socketRoomMap[socketId];
              }
              
              // ✅ FIXED: Better opponent username resolution
              const isWinner = game.winnerUserId === userId;
              let opponentUsername;
              
              if (isWinner) {
                // If this user won, opponent is the loser
                opponentUsername = game.loserName || 'Opponent';
              } else {
                // If this user lost, opponent is the winner
                opponentUsername = game.winnerName || 'Opponent';
              }
              
              // Send ended game state with complete gameOver information
              socket.emit('gameEndedReconnection', {
                message: 'This game has ended.',
                canRematch: true,
                gameEndReason: game.gameEndReason || 'timer_expired',
                successfulGuesses: game.successfulGuesses || [],
                leadoffPlayer: game.leadoffPlayer,
                selectedEra: game.selectedEra,
                opponentUsername: opponentUsername,
                role: isWinner ? 'winner' : 'loser',
                winnerName: isWinner ? username : opponentUsername,
                loserName: isWinner ? opponentUsername : username,
                turnCount: game.turnCount || 0,
                reason: game.gameEndReason || 'timer_expired',
                gameOverMessage: isWinner 
                  ? (game.gameEndReason === 'timer_expired' 
                      ? `${opponentUsername} ran out of time! You win!`
                      : 'You won!')
                  : (game.gameEndReason === 'timer_expired'
                      ? 'You ran out of time!'
                      : 'You lost!'),
                isReconnectionToEndedGame: true
              });
              
              console.log(`[RECONNECTION] Successfully reconnected ${username} to ended game ${roomId} as ${isWinner ? 'winner' : 'loser'}`);
              return;
            }
            
            console.log(`[RECONNECTION] ${username} reconnecting to same room with new socket`);
            
            // Replace old socket with new one
            const oldSocketIndex = game.players.indexOf(socketId);
            if (oldSocketIndex !== -1) {
              // Update players array
              game.players[oldSocketIndex] = socket.id;
              
              // Transfer user data
              game.usernames[socket.id] = username;
              game.userIds[socket.id] = userId;
              delete game.usernames[socketId];
              delete game.userIds[socketId];
              
              // Update socket mapping
              delete socketRoomMap[socketId];
              socketRoomMap[socket.id] = roomId;
              socket.join(roomId);
              socket.data.userId = userId;
              socket.data.username = username;
              
              // Remove from disconnected tracking if present
              if (game.disconnectedPlayers) {
                game.disconnectedPlayers.delete(socketId);
              }
              
              // Clean up any disconnection tracking
              disconnectedPlayers.delete(userId);
              
              // Update activePlayerSocketId if this was the active player
              if (game.activePlayerSocketId === socketId) {
                game.activePlayerSocketId = socket.id;
              }

              // Get current game state
              const currentPlayerHeadshotUrl = await getPlayerByName(game.currentPlayerName.trim());
              
              // Send current game state to reconnected player
              socket.emit('gameReconnected', {
                currentPlayerName: game.currentPlayerName,
                activePlayerSocketId: game.activePlayerSocketId,
                successfulGuesses: game.successfulGuesses,
                currentPlayerHeadshotUrl: currentPlayerHeadshotUrl?.headshot_url || defaultPlayerImage,
                isYourTurn: socket.id === game.activePlayerSocketId,
                canSkip: !(game.skipsUsed && game.skipsUsed[socket.id]),
                leadoffPlayer: game.leadoffPlayer,
                selectedEra: game.selectedEra,
                timeLimit: game.timeLimit,
                turnCount: game.turnCount,
                currentTurn: game.currentTurn,
                activePlayerUsername: game.usernames[game.activePlayerSocketId],
                opponentUsername: game.usernames[game.players.find(id => id !== socket.id)],
                timeLeft: game.timeLeft,
                skipsUsed: game.skipsUsed
              });              
              
              // Notify opponent of reconnection
              const opponentSocketId = game.players.find(id => id !== socket.id);
              if (opponentSocketId) {
                const opponentSocket = io.sockets.sockets.get(opponentSocketId);
                if (opponentSocket && opponentSocket.connected) {
                  opponentSocket.emit('opponentReconnected', {
                    message: `${username} reconnected`
                  });
                }
              }
              
              console.log(`[RECONNECTION] Successfully reconnected ${username} to room ${roomId}`);
              return;
            }
          } else {
            // User is trying to join a different room while in another game
            console.log(`[RECONNECTION] ${username} trying to join different room while in game`);
            socket.emit('message', 'You are already in another game. Please finish or leave that game first.');
            return;
          }
        }
      }
    }
  }

  // Check for reconnection opportunity from disconnected players
  if (userId && disconnectedPlayers.has(userId)) {
    const disconnectInfo = disconnectedPlayers.get(userId);
    
    if (disconnectInfo.roomId === roomId && games[roomId]) {
      const game = games[roomId];
      
      // ✅ Check if game has already ended
      if (game.gameEnded) {
        console.log(`[RECONNECTION] Game in room ${roomId} has ended, allowing reconnection for ended game view`);
        disconnectedPlayers.delete(userId); // Clean up tracking
        
        // Update socket mapping
        socketRoomMap[socket.id] = roomId;
        socket.join(roomId);
        socket.data.userId = userId;
        socket.data.username = username;
        
        // ✅ FIXED: Better opponent username resolution
        const isWinner = game.winnerUserId === userId;
        let opponentUsername;
        
        if (isWinner) {
          // If this user won, opponent is the loser
          opponentUsername = game.loserName || 'Opponent';
        } else {
          // If this user lost, opponent is the winner
          opponentUsername = game.winnerName || 'Opponent';
        }
        
        socket.emit('gameEndedReconnection', {
          message: 'This game has ended.',
          canRematch: true,
          gameEndReason: game.gameEndReason || 'timer_expired',
          successfulGuesses: game.successfulGuesses || [],
          leadoffPlayer: game.leadoffPlayer,
          selectedEra: game.selectedEra,
          opponentUsername: opponentUsername,
          role: isWinner ? 'winner' : 'loser',
          winnerName: isWinner ? username : opponentUsername,
          loserName: isWinner ? opponentUsername : username,
          turnCount: game.turnCount || 0,
          reason: game.gameEndReason || 'timer_expired',
          gameOverMessage: isWinner 
            ? (game.gameEndReason === 'timer_expired' 
                ? `${opponentUsername} ran out of time! You win!`
                : 'You won!')
            : (game.gameEndReason === 'timer_expired'
                ? 'You ran out of time!'
                : 'You lost!'),
          isReconnectionToEndedGame: true
        });
        
        console.log(`[RECONNECTION] Successfully reconnected ${username} to ended game ${roomId} as ${isWinner ? 'winner' : 'loser'}`);
        return;
      }
      
      console.log(`[RECONNECTION] ${username} reconnecting to active game from disconnected state`);
      
      // Replace old socket ID with new one
      const oldSocketIndex = game.players.indexOf(disconnectInfo.socketId);
      if (oldSocketIndex !== -1) {
        game.players[oldSocketIndex] = socket.id;
        game.usernames[socket.id] = username;
        delete game.usernames[disconnectInfo.socketId];
        
        // Remove from disconnected players tracking
        if (game.disconnectedPlayers) {
          game.disconnectedPlayers.delete(disconnectInfo.socketId);
        }
        
        // Update socket mapping
        socketRoomMap[socket.id] = roomId;
        socket.join(roomId);
        socket.data.userId = userId;
        socket.data.username = username;

        if (game.activePlayerSocketId === disconnectInfo.socketId) {
          game.activePlayerSocketId = socket.id;
        }
        
        // Get current game state for reconnection
        const currentPlayerHeadshotUrl = await getPlayerByName(game.currentPlayerName.trim());       
        
        // Send current game state to reconnected player
        socket.emit('gameReconnected', {
          currentPlayerName: game.currentPlayerName,
          activePlayerSocketId: game.activePlayerSocketId,
          successfulGuesses: game.successfulGuesses,
          currentPlayerHeadshotUrl: currentPlayerHeadshotUrl?.headshot_url || defaultPlayerImage,
          isYourTurn: socket.id === game.activePlayerSocketId,
          canSkip: !(game.skipsUsed && game.skipsUsed[socket.id]),
          leadoffPlayer: game.leadoffPlayer,
          selectedEra: game.selectedEra,
          timeLimit: game.timeLimit,
          turnCount: game.turnCount,
          currentTurn: game.currentTurn,
          activePlayerUsername: game.usernames[game.activePlayerSocketId],
          opponentUsername: game.usernames[game.players.find(id => id !== socket.id)],
          timeLeft: game.timeLeft,
          skipsUsed: game.skipsUsed
        });
        
        // Notify opponent of successful reconnection
        const opponentSocketId = game.players.find(id => id !== socket.id);
        if (opponentSocketId) {
          const opponentSocket = io.sockets.sockets.get(opponentSocketId);
          if (opponentSocket && opponentSocket.connected) {
            opponentSocket.emit('opponentReconnected', {
              message: `${username} reconnected`
            });
          }
        }
        
        // Clean up disconnection tracking
        disconnectedPlayers.delete(userId);
        
        console.log(`[RECONNECTION] Successfully reconnected ${username} to room ${roomId}`);
        return;
      }
    }
  }

  // Clean up ended games
  if (games[roomId] && games[roomId].gameEnded) {
    console.log(`Cleaning up ended game for room: ${roomId}`);
    delete games[roomId];
  }

  // ✅ CRITICAL: ALWAYS join the Socket.IO room first, regardless of game state
  socket.join(roomId);
  socketRoomMap[socket.id] = roomId;
  console.log(`[handleJoinGame] Socket ${socket.id} joined room ${roomId}`);

  // ✅ CRITICAL: Check if game already exists
  if (games[roomId]) {
    console.log(`[handleJoinGame] Game already exists for room ${roomId}`);
    
    const game = games[roomId];
    
    // ✅ Handle reconnection to ended games
    if (game.gameEnded) {
      console.log(`[handleJoinGame] Reconnecting ${username} to ended game ${roomId}`);
      
      // Check if this user was part of the original game
      const wasOriginalPlayer = Object.values(game.userIds || {}).includes(userId);
      
      if (wasOriginalPlayer) {
        // Update socket mapping for ended game
        socket.data.userId = userId;
        socket.data.username = username;
        
        // ✅ FIXED: Better opponent username resolution
        const isWinner = game.winnerUserId === userId;
        let opponentUsername;
        
        if (isWinner) {
          // If this user won, opponent is the loser
          opponentUsername = game.loserName || 'Opponent';
        } else {
          // If this user lost, opponent is the winner
          opponentUsername = game.winnerName || 'Opponent';
        }
        
        // Send ended game state
        socket.emit('gameEndedReconnection', {
          message: 'This game has ended.',
          canRematch: true,
          gameEndReason: game.gameEndReason || 'timer_expired',
          successfulGuesses: game.successfulGuesses || [],
          leadoffPlayer: game.leadoffPlayer,
          selectedEra: game.selectedEra,
          opponentUsername: opponentUsername,
          role: isWinner ? 'winner' : 'loser',
          winnerName: isWinner ? username : opponentUsername,
          loserName: isWinner ? opponentUsername : username,
          turnCount: game.turnCount || 0,
          reason: game.gameEndReason || 'timer_expired',
          gameOverMessage: isWinner 
            ? (game.gameEndReason === 'timer_expired' 
                ? `${opponentUsername} ran out of time! You win!`
                : 'You won!')
            : (game.gameEndReason === 'timer_expired'
                ? 'You ran out of time!'
                : 'You lost!'),
          isReconnectionToEndedGame: true
        });
        
        // Update the game's player tracking for potential rematch
        if (!game.players.includes(socket.id)) {
          // Replace old socket ID with new one
          const oldSocketId = Object.keys(game.userIds).find(key => game.userIds[key] === userId);
          if (oldSocketId && game.players.includes(oldSocketId)) {
            const oldIndex = game.players.indexOf(oldSocketId);
            game.players[oldIndex] = socket.id;
            delete game.usernames[oldSocketId];
            delete game.userIds[oldSocketId];
          } else {
            game.players.push(socket.id);
          }
          
          game.usernames[socket.id] = username;
          game.userIds[socket.id] = userId;
        }
        
        console.log(`[handleJoinGame] Successfully reconnected ${username} to ended game ${roomId} as ${isWinner ? 'winner' : 'loser'}`);
        return;
      } else {
        // Not an original player, reject
        socket.emit('message', 'This game has ended and you were not a participant.');
        return;
      }
    }
    
    if (!game.selectedEra) {
     game.selectedEra = era;
      }
    
    // Add player to existing game if not already in it
    if (!game.players.includes(socket.id)) {
      game.players.push(socket.id);
      
      const finalUsername = username || socket.username || socket.data?.username || 'Unknown';
      game.usernames[socket.id] = finalUsername;
      game.userIds = game.userIds || {};
      game.userIds[socket.id] = userId;
      
      socket.data.userId = userId;
      socket.username = finalUsername;
      
      if (!game.ready) game.ready = new Set();
      game.ready.add(socket.id);
      
      io.to(roomId).emit('playersUpdate', game.players.length);
      
      // Check if we now have enough players to start
      if (game.players.length === 2 && game.ready.size === 2 && !game.leadoffPlayer && !game.starting) {
        // ✅ CRITICAL: Check if game is already being created
        if (gameCreationLocks.has(roomId)) {
          console.log(`[handleJoinGame] Game creation already in progress for room ${roomId}`);
          return;
        }
        
        // Lock this room during game creation
        gameCreationLocks.add(roomId);
        
        console.log(`[handleJoinGame] Both players ready. Starting game for room ${roomId} with era ${era}`);
        
        // Start game with lock protection and era
        try {
          await startGame(roomId, game.selectedEra, timeLimit);
        } finally {
          // Always remove lock and reset starting flag
          gameCreationLocks.delete(roomId);
        }
      }
    } else {
      // Player already exists, just update their data
      const finalUsername = username || socket.username || socket.data?.username || 'Unknown';
      game.usernames[socket.id] = finalUsername;
      game.userIds[socket.id] = userId;
      if (!game.selectedEra) {
        game.selectedEra = era;
      }
      socket.data.userId = userId;
      socket.username = finalUsername;
      console.log(`[handleJoinGame] Updated existing player ${username} in room ${roomId} with era ${era}`);
    }
    return;
  }
  
  // ✅ CRITICAL: Check if someone else is already creating this game
  if (gameCreationLocks.has(roomId)) {
    console.log(`[handleJoinGame] Game creation already in progress for room ${roomId}, waiting...`);
    // Socket is already joined to room above, just wait and retry
    setTimeout(() => {
      handleJoinGame(socket, roomId, username, userId, era);
    }, 150);
    return;
  }
  
  // Create new game
  console.log(`[handleJoinGame] Creating game for room: ${roomId} with era: ${era}`);
  
  // ✅ Lock during creation
  gameCreationLocks.add(roomId);
  
  try {
    games[roomId] = {
      players: [socket.id],
      usernames: {},
      userIds: {},
      currentTurn: 0,
      currentPlayerName: null,
      timer: null,
      timeLeft: timeLimit,
      skipsUsed: {},
      teammates: [],
      successfulGuesses: [],
      rematchVotes: new Set(),
      leadoffPlayer: null,
      activePlayerSocketId: null,
      ready: new Set(),
      starting: false,
      turnCount: 0,
      selectedEra: era, 
      timeLimit: timeLimit,
      disconnectedPlayers: new Set(),
      gameEnded: false
    };

    const game = games[roomId];
    const finalUsername = username || socket.username || socket.data?.username || 'Unknown';
    
    game.usernames[socket.id] = finalUsername;
    game.userIds[socket.id] = userId;
    game.ready.add(socket.id);
    
    socket.data.userId = userId;
    socket.username = finalUsername;
    
    io.to(roomId).emit('playersUpdate', game.players.length);
    
    console.log(`[handleJoinGame] Successfully created game for room ${roomId} with era ${era}`);
  } finally {
    // ✅ Always remove creation lock
    gameCreationLocks.delete(roomId);
  }
}










async function handlePlayerDisconnect(socket) {
  const username = socket.data?.username || 'Unknown';
  console.log(`🛑 handlePlayerDisconnect: ${socket.id} (${username})`);

  // Remove from socketRoomMap
  const roomId = socketRoomMap[socket.id];
  if (roomId) {
    delete socketRoomMap[socket.id];
    console.log(`✅ Removed from socketRoomMap for room: ${roomId}`);
  }

  // Find and handle active game
  for (const [room, game] of Object.entries(games)) {
    const playerIndex = game.players.indexOf(socket.id);
    if (playerIndex !== -1) {
      console.log(`✅ Removed ${username} from active game in room ${room}`);
      
      // Check if game was active BEFORE clearing timer
      const wasActiveGame = game.teammates && game.teammates.length > 0 && !game.statsUpdated;
      console.log(`🔍 Game state check: teammates=${game.teammates?.length}, timer=${!!game.timer}, wasActiveGame=${wasActiveGame}`);
      
      // Remove player from game
      game.players.splice(playerIndex, 1);
      delete game.usernames[socket.id];

      playersInGame.delete(socket.id);
      console.log(`✅ Removed ${socket.id} from playersInGame Set`);
      
      // Clear any timers AFTER checking if game was active
      if (game.timer) {
        clearInterval(game.timer);
        delete game.timer;
      }

      if (wasActiveGame && game.userIds) {
        const leavingUserId = game.userIds[socket.id];
        
        if (leavingUserId) {
          console.log(`📊 Updating stats: ${username} (${leavingUserId}) gets a loss for leaving active game`);
          
          try {
            // Give the leaving player a loss
            const lossQuery = `
              UPDATE user_stats 
              SET losses = losses + 1, games_played = games_played + 1 
              WHERE user_id = $1
            `;
            await client.query(lossQuery, [leavingUserId]);
            console.log(`✅ Updated stats for leaving player ${username}`);

            // Give remaining player(s) a win
            for (const remainingSocketId of game.players) {
              const remainingUserId = game.userIds[remainingSocketId];
              if (remainingUserId) {
                const remainingUsername = game.usernames[remainingSocketId] || 'Unknown';
                console.log(`📊 Updating stats: ${remainingUsername} (${remainingUserId}) gets a win`);
                
                const winQuery = `
                  UPDATE user_stats 
                  SET wins = wins + 1, games_played = games_played + 1 
                  WHERE user_id = $1
                `;
                await client.query(winQuery, [remainingUserId]);
                console.log(`✅ Updated stats for remaining player ${remainingUsername}`);
              }
            }
          } catch (error) {
            console.error('❌ Error in stats update:', error);
          }
        }
      } else {
        console.log(`ℹ️ No stats update needed - game was not active (wasActiveGame: ${wasActiveGame})`);
      }

      // Notify remaining players
      game.players.forEach(playerSocketId => {
        const playerSocket = io.sockets.sockets.get(playerSocketId);
        if (playerSocket && playerSocket.connected) {
          const remainingUsername = game.usernames[playerSocketId] || 'Player';
          console.log(`ℹ️ Notifying ${remainingUsername} that ${username} left the match`);
          
          playerSocket.emit('gameOver', {
            reason: 'opponent_left',
            message: `${username} left the game.`,
            winnerName: remainingUsername,
            loserName: username,
            role: 'winner',
            canRematch: false,
          });
        }
      });

      // Clean up remaining players from playersInGame Set
      for (const remainingSocketId of game.players) {
        playersInGame.delete(remainingSocketId);
        console.log(`✅ Removed remaining player ${remainingSocketId} from playersInGame Set`);
      }
      
      // Completely delete the game instead of resetting it
      delete games[room];
      gameCreationLocks.delete(room);
      console.log(`🗑️ Completely deleted game for room ${room}`);

      break;
    }
  }
}


async function handlePlayerDisconnectFinal(socket, roomId, username) {
  console.log(`🛑 handlePlayerDisconnectFinal: ${socket.id} (${username})`);
  
  const game = games[roomId];
  if (!game) return;
  
  const playerIndex = game.players.indexOf(socket.id);
  if (playerIndex === -1) return;
  
  // ✅ KEY FIX: Don't delete ended games, just mark them and clean up active elements
  if (game.gameEnded) {
    console.log(`[DISCONNECT_FINAL] Game ${roomId} already ended, cleaning up player ${username} but preserving game state`);
    
    // Remove from disconnected tracking
    if (game.disconnectedPlayers) {
      game.disconnectedPlayers.delete(socket.id);
    }
    
    // Clean up any remaining timers
    if (game.timer) {
      clearInterval(game.timer);
      game.timer = null;
    }
    
    // Mark that this player disconnected after game ended
    if (!game.playersDisconnectedAfterEnd) {
      game.playersDisconnectedAfterEnd = new Set();
    }
    game.playersDisconnectedAfterEnd.add(socket.id);
    
    // Clean up socket mappings for this player only
    delete socketRoomMap[socket.id];
    playersInGame.delete(socket.id);
    
    console.log(`[DISCONNECT_FINAL] Preserved ended game ${roomId}, marked ${username} as disconnected after end`);
    return; // ✅ Don't delete the game!
  }
  
  // For active games, proceed with existing logic
  game.players.splice(playerIndex, 1);
  delete game.usernames[socket.id];
  playersInGame.delete(socket.id);
  
  // Clean up disconnected players tracking
  if (game.disconnectedPlayers) {
    game.disconnectedPlayers.delete(socket.id);
  }
  
  // Notify remaining players and update stats (existing logic)
  const remainingSocketId = game.players[0];
  if (remainingSocketId) {
    const remainingSocket = io.sockets.sockets.get(remainingSocketId);
    if (remainingSocket && remainingSocket.connected) {
      const remainingUsername = game.usernames[remainingSocketId] || 'Player';
      
      remainingSocket.emit('gameOver', {
        reason: 'opponent_left',
        message: `${username} left the game.`,
        winnerName: remainingUsername,
        loserName: username,
        role: 'winner',
        canRematch: false,
        turnCount: game.turnCount || 0
      });
      
      // Update stats for active game disconnection
      const remainingUserId = game.userIds[remainingSocketId];
      const leavingUserId = game.userIds[socket.id];
      
      if (remainingUserId && leavingUserId && !game.statsUpdated) {
        await updateUserStats(remainingUserId, 'win', game.selectedEra || '2000-present', game.turnCount || 0);
        await updateUserStats(leavingUserId, 'loss', game.selectedEra || '2000-present', game.turnCount || 0);
        game.statsUpdated = true;
      }
    }
  }
  
  // Only delete active games, not ended ones
  delete games[roomId];
  gameCreationLocks.delete(roomId);
}







function cleanupTimer(roomId) {
  const game = games[roomId];
  
  if (activeTimers.has(roomId)) {
    clearInterval(activeTimers.get(roomId));
    activeTimers.delete(roomId);
  }
  
  if (game && game.timer) {
    clearInterval(game.timer);
    game.timer = null;
    game.timerRunning = false;
  }
  
  console.log(`[CLEANUP] Timer cleaned up for room ${roomId}`);
}


function cleanupGameCreationLocks() {
  for (const roomId of gameCreationLocks) {
    // If a room has been locked for more than 10 seconds, something went wrong
    if (!games[roomId] || games[roomId].players.length < 2) {
      console.log(`[CLEANUP] Removing stale creation lock for room ${roomId}`);
      gameCreationLocks.delete(roomId);
    }
  }
}

// Run cleanup every 15 seconds
setInterval(cleanupGameCreationLocks, 15000);



async function updateUserStats(userId, result, era = '2000-present', turnCount = 0) {
  if (!userId || !['win', 'loss'].includes(result)) return;

  console.log('[DB] updateUserStats called with:', userId, result, era, turnCount);
  
  const winInc = result === 'win' ? 1 : 0;
  const lossInc = result === 'loss' ? 1 : 0;
  
  // Map era to column names
  const eraMapping = {
    '2000-present': 'modern_era',
    '1980-1999': 'golden_era', 
    '1960-1979': 'classic_era',
    'pre-1960': 'pioneer_era'
  };
  
  const eraPrefix = eraMapping[era] || 'modern_era';
  
  const query = `
    INSERT INTO user_stats (
      user_id, wins, losses, games_played, total_turns,
      ${eraPrefix}_wins, ${eraPrefix}_losses, created_at, updated_at
    )
    VALUES ($1, $2, $3, 1, $4, $2, $3, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET wins = user_stats.wins + $2,
          losses = user_stats.losses + $3,
          games_played = user_stats.games_played + 1,
          total_turns = user_stats.total_turns + $4,
          ${eraPrefix}_wins = user_stats.${eraPrefix}_wins + $2,
          ${eraPrefix}_losses = user_stats.${eraPrefix}_losses + $3,
          updated_at = NOW()
  `;
  
  try {
    const result = await client.query(query, [userId, winInc, lossInc, turnCount]);
    console.log('[DB] Stats updated successfully for user:', userId);
    return result;
  } catch (err) {
    console.error('[DB] Error updating user_stats:', err);
    throw err;
  }
}




async function startTurnTimer(roomId) {
  const game = games[roomId];
  if (!game) {
    console.warn(`[startTurnTimer] No game found for room ${roomId}`);
    return;
  }

  if (game.gameEnded) {
    console.warn(`[startTurnTimer] Game already ended for room ${roomId}`);
    return;
  }

  if (activeTimers.has(roomId)) {
    console.warn(`[startTurnTimer] Timer already active for room ${roomId}, clearing first`);
    const existingTimer = activeTimers.get(roomId);
    clearInterval(existingTimer);
    activeTimers.delete(roomId);
  }

  if (game.timer !== null) {
    console.warn(`[startTurnTimer] Clearing existing game timer in room ${roomId}`);
    clearInterval(game.timer);
    game.timer = null;
  }

  // NEW: Store turn start timestamp for background sync
  game.turnStartTime = Date.now();
  game.turnDuration = (game.timeLimit || 30) * 1000; // Convert to milliseconds
  game.timerRunning = true;
  game.timeLeft = game.timeLimit || 30;
  
  const socketId = game.players[game.currentTurn];
  game.activePlayerSocketId = socketId;

  // Fetch current player headshot
  const trimmedCurrentPlayerName = game.currentPlayerName.trim();
  const { headshot_url: currentPlayerHeadshotUrl } = await getPlayerByName(trimmedCurrentPlayerName);

  // Send turn started event with timestamp info
  const activeSocket = io.sockets.sockets.get(socketId);
  if (activeSocket) {
    activeSocket.emit('yourTurn', {
      currentPlayerName: game.currentPlayerName,
      canSkip: !(game.skipsUsed && game.skipsUsed[socketId]),
      currentPlayerHeadshotUrl: currentPlayerHeadshotUrl || defaultPlayerImage,
      timeLeft: game.timeLeft,
      turnStartTime: game.turnStartTime, // NEW: Add timestamp
      turnDuration: game.turnDuration    // NEW: Add duration
    });
  }

  game.players.forEach(playerId => {
    if (playerId !== socketId) {
      const opponentSocket = io.sockets.sockets.get(playerId);
      if (opponentSocket) {
        opponentSocket.emit('opponentTurn', {
          currentPlayerName: game.currentPlayerName,
          activePlayerName: game.usernames[socketId] || 'Player',
          currentPlayerHeadshotUrl: currentPlayerHeadshotUrl || defaultPlayerImage,
          turnStartTime: game.turnStartTime, // NEW: Add timestamp
          turnDuration: game.turnDuration    // NEW: Add duration
        });
      }
    }
  });

  // Server timer for timeout handling only
  const timerId = setTimeout(async () => {
    const currentGame = games[roomId];
    if (!currentGame || currentGame.gameEnded || !currentGame.timerRunning) {
      activeTimers.delete(roomId);
      return;
    }

    currentGame.gameEnded = true;
    currentGame.gameEndReason = 'timer_expired'; // ✅ Track why game ended
    currentGame.timerRunning = false;
    activeTimers.delete(roomId);
    
    console.log(`[TIMER] Room ${roomId} - timer expired`);

    const playerIds = currentGame.players || [];
    const loserSocketId = currentGame.activePlayerSocketId;
    const loserName = currentGame.usernames[loserSocketId];
    const winnerSocketId = playerIds.find(id => id && id !== loserSocketId);
    const winnerName = currentGame.usernames[winnerSocketId];

    // Check if the losing player is disconnected
    const loserIsDisconnected = currentGame.disconnectedPlayers && 
                                currentGame.disconnectedPlayers.has(loserSocketId);

    let loserUserId = currentGame.userIds[loserSocketId];
    let winnerUserId = currentGame.userIds[winnerSocketId];

    if (!loserUserId && loserIsDisconnected) {
      // Try to get userId from disconnected players tracking
      for (const [userId, disconnectInfo] of disconnectedPlayers.entries()) {
        if (disconnectInfo.socketId === loserSocketId) {
          loserUserId = userId;
          break;
        }
      }
    }

    // ✅ Store winner/loser info for reconnections
    currentGame.winnerUserId = winnerUserId;
    currentGame.loserUserId = loserUserId;
    currentGame.winnerName = winnerName;
    currentGame.loserName = loserName;

    if (!currentGame.statsUpdated && loserUserId && winnerUserId) {
      await updateUserStats(winnerUserId, 'win', currentGame.selectedEra || '2000-present', currentGame.turnCount || 0);
      await updateUserStats(loserUserId, 'loss', currentGame.selectedEra || '2000-present', currentGame.turnCount || 0);
      currentGame.statsUpdated = true;
    }

    // Send game over to connected players
    currentGame.players.forEach((playerId) => {
      const socket = io.sockets.sockets.get(playerId);
      if (!socket) return;

      if (playerId === winnerSocketId) {
        socket.emit('gameOver', {
          message: loserIsDisconnected ? 
            `${loserName} was disconnected and ran out of time! You win!` :
            `${loserName} ran out of time! You win!`,
          role: 'winner',
          reason: 'timer_expired',
          winnerName,
          loserName,
          turnCount: currentGame.turnCount
        });
      } else {
        socket.emit('gameOver', {
          message: `You ran out of time!`,
          role: 'loser',
          reason: 'timer_expired',
          winnerName,
          loserName,
          turnCount: currentGame.turnCount
        });
      }
    });

    // ✅ Don't clean up disconnected player tracking immediately - give them time to reconnect
    setTimeout(() => {
      console.log(`[CLEANUP] Cleaning disconnected player tracking for room ${roomId} (delayed)`);
      for (const [userId, disconnectInfo] of disconnectedPlayers.entries()) {
        if (disconnectInfo.roomId === roomId) {
          disconnectedPlayers.delete(userId);
          console.log(`[CLEANUP] Removed disconnected player tracking for ${userId}`);
        }
      }
      console.log(`[TIMER] Game ${roomId} ended, preserving for reconnections and rematches`);
    }, 30000); // ✅ Wait 30 seconds instead of 1 second

  }, game.turnDuration);

  game.timer = timerId;
  activeTimers.set(roomId, timerId);
  
  console.log(`[TIMER] Started new timer for room ${roomId} with ${game.turnDuration}ms duration`);
}





});