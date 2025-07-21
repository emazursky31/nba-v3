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

const io = new Server(server);

const socketRoomMap = {};
const playersInGame = new Set(); // socket.id values
const activeTimers = new Map();

const defaultPlayerImage = 
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAAvklEQVRoge3XsQ2AIBBF0ZLpDoBuwHFHqK8cQvMrIo3FLPHom/b2mX9rcNqZmZmZmZmZmZmdFz5ec3m6F3+v4PYs3PmR7DbiDD1N9g5IuT16CWYExozP7G9Czzxq/cE8ksYbFxExk2RcMUfYHNk0RMYPhk0QcMbJHUYyNsi9h5YDyYFSNqLD6c+5h3tGn+MO9ZftHJz5nz/rq3ZTzRzqkIxuYwAAAABJRU5ErkJggg==';


// Serve static files first - make sure this points to your frontend build folder
app.use(express.static(path.join(__dirname, 'public')));

// Your API and other routes can go here (if any)...



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


app.get('/players', async (req, res) => {
  const input = (req.query.q || '').trim();

  if (!input) {
    return res.json([]);
  }

  const names = input.split(/\s+/);

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
        p.player_name ILIKE $1 || '%'  
        OR p.player_name ILIKE '% ' || $1 || '%'  
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
        p.player_name ILIKE $1 || '%'  
        AND p.player_name ILIKE '% ' || $2 || '%'  
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

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory games state: roomId -> game data
const games = {};
console.log('Games object ID:', games);



io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  


socket.on('findMatch', ({ username, userId }) => {
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

    if (!games[roomId]) games[roomId] = { players: [], userIds: {}, usernames: {} };

    games[roomId].players.push(socket.id, opponentSocket.id);

    games[roomId].userIds[socket.id] = userId;
    games[roomId].userIds[opponentSocket.id] = opponentSocket.data.userId;

    games[roomId].usernames[socket.id] = username;
    games[roomId].usernames[opponentSocket.id] = opponentUsername;

    // ✅ Track socket-room mapping (single map)
    socketRoomMap[socket.id] = roomId;
    socketRoomMap[opponentSocket.id] = roomId;

    // Store roomId on socket.data for both
    socket.data.roomId = roomId;
    opponentSocket.data.roomId = roomId;

    // Add players to the in-game set
    playersInGame.add(socket.id);
    playersInGame.add(opponentSocket.id);

    // // Handle joining game for both players
    // handleJoinGame(socket, roomId, username, socket.data.userId);
    // handleJoinGame(opponentSocket, roomId, opponentUsername, opponentSocket.data.userId);


    // Check if game ready to start
    if (!(games[roomId]?.players?.length >= 2)) {
      console.log(`⚠️ Not enough players to start game in ${roomId}`);
      return;
    }

    // Start the game
    startGame(roomId);

    // Notify clients
    socket.emit('matched', { roomId, opponent: opponentUsername });
    opponentSocket.emit('matched', { roomId, opponent: username });

  } else {
    console.log(`🕐 No opponents. ${username} (${socket.id}) added to waiting queue`);

    // Avoid duplicates in waiting queue
    if (!waitingPlayers.some(entry => entry.socket.id === socket.id)) {
      waitingPlayers.push({ socket });
    }

    socket.emit('waitingForMatch');
  }
});





socket.on('joinGame', async ({ roomId, username, userId }) => {
    await handleJoinGame(socket, roomId, username, userId);
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
    game.timeLeft = 30;

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
    socket.emit('message', `Incorrect guess: "${guess}"`);
  }
});



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
  socket.to(roomId).emit('rematchRequested', { username });
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

    // Reset game state for rematch
    game.leadoffPlayer = null;
    game.starting = false;
    game.gameEnded = false;
    game.currentPlayerName = null;
    game.teammates = [];
    game.successfulGuesses = [];
    game.currentTurn = 0;
    game.activePlayerSocketId = null;
    game.timeLeft = 30;
    game.userIds = preservedUserIds;
    if (game.timer) {
      cleanupTimer(roomId);
      game.timer = null;
    }
    startGame(roomId);
    io.to(roomId).emit('rematchStarted'); // Notify clients explicitly
    console.log('Emitted rematchStarted to room:', roomId);
  }
});



// Disconnect cleanup
socket.on('disconnect', () => {
  const username = socket.data?.username || 'an unnamed player';
  console.log(`User disconnected: ${socket.id} (${username})`);

  // Remove from waitingPlayers queue if waiting
  const waitingIndex = waitingPlayers.findIndex(wp => wp.socket.id === socket.id);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`Removed ${username} from waiting queue`);
  }

  playersInGame.delete(socket.id);

  // Remove from socketRoomMap (once)
  const roomId = socketRoomMap[socket.id];
  if (roomId) {
    cleanupTimer(roomId);
    delete socketRoomMap[socket.id];
    console.log(`Removed socket ${socket.id} from socketRoomMap`);
  }

  

  for (const [room, game] of Object.entries(games)) {
    const idx = game.players.indexOf(socket.id);
    if (idx !== -1) {
      const disconnectedUsername = game.usernames[socket.id] || username;

      // Remove player from game
      game.players.splice(idx, 1);
      delete game.usernames[socket.id];
      playersInGame.delete(socket.id);

      io.to(room).emit('playersUpdate', game.players.length);
      console.log(`${disconnectedUsername} removed from game in room ${room}`);

      if (game.timer) {
        clearInterval(game.timer);
        delete game.timer;
      }

      if (game.rematchVotes) {
        game.rematchVotes.delete(disconnectedUsername);
        if (game.rematchVotes.size === 0) {
          game.rematchVotes = new Set();
        }
      }

      if (game.players.length < 2) {
        // Notify remaining players
        game.players.forEach(playerSocketId => {
          const playerSocket = io.sockets.sockets.get(playerSocketId);
          if (playerSocket && playerSocket.connected) {
            playerSocket.emit('gameOver', {
              reason: 'opponent_left',
              message: `${disconnectedUsername} left the game.`,
              winnerName: game.usernames[playerSocketId] || 'Player',
              loserName: disconnectedUsername,
              role: 'winner',
              canRematch: false,
            });
          }
        });

        const preservedUserIds = { ...game.userIds };

        // Reset game state
        game.players = [];
        game.usernames = {};
        game.currentTurn = 0;
        game.currentPlayerName = null;
        game.teammates = [];
        game.successfulGuesses = [];
        game.rematchVotes = new Set();
        game.userIds = preservedUserIds;

        if (game.timer) {
          clearInterval(game.timer);
          delete game.timer;
        }

        console.log(`Game in room ${room} reset due to insufficient players`);
      }

      break;
    }
  }
});



socket.on('leaveGame', () => {
  console.log(`🚪 leaveGame: ${socket.id}`);

  // Remove from waiting queue if in it
  const waitingIndex = waitingPlayers.findIndex(wp => wp.socket.id === socket.id);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`Removed ${socket.data.username} from waiting queue`);
  }

  // Handle disconnect logic too
  handlePlayerDisconnect(socket);
});


socket.on('playerSignedOut', async ({ roomId, username, reason }) => {
  console.log(`Player ${username} signed out from room ${roomId}, reason: ${reason}`);
  
  const game = games[roomId];
  if (!game) return;
  
  const disconnectedSocketId = socket.id;
  const disconnectedUsername = username || game.usernames[disconnectedSocketId] || 'Player';
  
  // Find remaining player
  const remainingPlayerSocketId = game.players.find(id => id !== disconnectedSocketId);
  
  if (remainingPlayerSocketId) {
    const remainingPlayerSocket = io.sockets.sockets.get(remainingPlayerSocketId);
    const remainingUsername = game.usernames[remainingPlayerSocketId] || 'Player';
    
    if (remainingPlayerSocket && remainingPlayerSocket.connected) {
      // ✅ UPDATE STATS with hardened userID lookup
      const remainingUserId = game.userIds[remainingPlayerSocketId] || 
                             remainingPlayerSocket.data?.userId;
      const disconnectedUserId = game.userIds[disconnectedSocketId] || 
                                socket.data?.userId;
      
      console.log('[SIGNOUT] Updating stats:', { remainingUserId, disconnectedUserId });
      
      if (remainingUserId && disconnectedUserId) {
        try {
          await updateUserStats(remainingUserId, 'win');
          await updateUserStats(disconnectedUserId, 'loss');
          console.log('[SIGNOUT] Stats updated successfully');
        } catch (err) {
          console.error('[SIGNOUT] Error updating stats:', err);
        }
      } else {
        console.warn('[SIGNOUT] Missing userIds, skipping stats update:', { remainingUserId, disconnectedUserId });
      }
      
      // Notify remaining player
      remainingPlayerSocket.emit('gameOver', {
        reason: 'opponent_signed_out',
        message: `${disconnectedUsername} signed out. You win!`,
        winnerName: remainingUsername,
        loserName: disconnectedUsername,
        role: 'winner',
        canRematch: false,
      });
    }
  }
  
  // Clean up the game immediately
  if (game.timer) {
    clearInterval(game.timer);
    delete game.timer;
  }
  
  // Reset game state
  game.players = [];
  game.usernames = {};
  game.userIds = {}; // ✅ Clear userIds too
  game.currentTurn = 0;
  game.currentPlayerName = null;
  game.teammates = [];
  game.successfulGuesses = [];
  game.rematchVotes = new Set();
  
  // Clean up socket mappings
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
  const shared = [];

  for (const stint1 of career1) {
    for (const stint2 of career2) {
      const team1 = stint1.team?.trim().toUpperCase();
      const team2 = stint2.team?.trim().toUpperCase();

      if (!team1 || !team2) {
        console.warn('⚠️ Missing team info:', { team1, team2, stint1, stint2 });
        continue;
      }

      if (team1 === team2) {
        const start = Math.max(stint1.startYear, stint2.startYear);
        const end = Math.min(stint1.endYear, stint2.endYear);

        console.log(`🟡 Match on team ${team1}, overlap years: ${start}–${end}`);

        if (start <= end) {
          shared.push({
            team: team1,
            startYear: start,
            endYear: end,
            years: start === end ? `${start}` : `${start}–${end}`
          });
        } else {
          console.log(`🔸 No overlap: ${team1}, ${stint1.startYear}–${stint1.endYear} vs ${stint2.startYear}–${stint2.endYear}`);
        }
      } else {
        console.log(`🔹 No match: ${team1} vs ${team2}`);
      }
    }
  }

  console.log('✅ Final shared teams:', shared);
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
async function startGame(roomId) {
  const game = games[roomId];
  if (!game) {
    console.log('❌ No game object found');
    return;
  }

  // // ✅ Additional safety check
  // if (game.starting || game.leadoffPlayer) {
  //   console.log(`⚠️ Game already starting or started for room ${roomId}`);
  //   return;
  // }


  if (game.leadoffPlayer) {
    console.log(`⚠️ Game already started for room ${roomId}`);
    return;
  }

  // Pick the leadoff player from DB (object with player_id, player_name, headshot_url)
  const leadoffPlayer = await getRandomPlayer();
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
  game.timeLeft = 30;

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
  console.log(`[STARTGAME] room ${roomId} starting with:`);
  console.log(`→ leadoffPlayer: ${JSON.stringify(leadoffPlayer)}`);
  console.log(`→ teammates: ${JSON.stringify(game.teammates)}`);
  console.log(`→ players: ${game.players}`);
  console.log(`→ currentTurn: ${game.currentTurn}`);
  console.log(`→ activePlayerSocketId: ${game.activePlayerSocketId}`);
  console.log(`→ currentPlayerName (NBA player): ${game.currentPlayerName}`);
  console.log(`→ currentGuesserUsername: ${game.currentGuesserUsername}`);

  // Notify each player individually
  game.players.forEach((socketId) => {
    const opponentSocketId = game.players.find(id => id !== socketId);
    const opponentUsername = game.usernames[opponentSocketId] || 'Opponent';

    io.to(socketId).emit('gameStarted', {
      firstPlayerId: game.activePlayerSocketId,

      // NBA player to guess
      currentPlayerName: game.currentPlayerName,

      // User whose turn it is
      currentPlayerUsername: game.currentGuesserUsername,

      // NBA player headshot URL (fallback if missing)
      currentPlayerHeadshotUrl: leadoffPlayer.headshot_url || defaultPlayerImage,

      timeLeft: game.timeLeft,

      // Full leadoffPlayer object (player_name, headshot_url)
      leadoffPlayer: game.leadoffPlayer,

      opponentName: opponentUsername
    });
  });

  // Start turn timer
  startTurnTimer(roomId);
}







async function getRandomPlayer() {
  const query = `
    WITH player_seasons AS (
      SELECT
        player_id,
        generate_series(CAST(start_season AS INT), CAST(end_season AS INT)) AS season
      FROM player_team_stints
      WHERE start_season >= '2000'
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
      HAVING COUNT(DISTINCT season) >= 10
    ) ps ON p.player_id = ps.player_id
    ORDER BY RANDOM()
    LIMIT 1;
  `;

  const res = await client.query(query);
  return res.rows[0] || null;
}


async function handleJoinGame(socket, roomId, username, userId) {
  if (!roomId) {
    console.error('[handleJoinGame] ERROR: roomId is null or undefined');
    return;
  }

  if (!games[roomId]) {
    console.log(`[handleJoinGame] Creating game for room: ${roomId}`);
    games[roomId] = {
      players: [],
      usernames: {},
      currentTurn: 0,
      currentPlayerName: null,
      timer: null,
      timeLeft: 30,
      teammates: [],
      successfulGuesses: [],
      rematchVotes: new Set(),
      leadoffPlayer: null,
      activePlayerSocketId: null,
      ready: new Set(),
    };
  } else {
    console.log(`[handleJoinGame] Game already exists for room ${roomId}`);
    if (!games[roomId].ready) {
      games[roomId].ready = new Set();
    }
  }

  const game = games[roomId];

  if (!game.players.includes(socket.id)) {
    game.players.push(socket.id);
  }

  const finalUsername = username || socket.username || socket.data?.username || 'Unknown';
  game.usernames[socket.id] = finalUsername;
  game.userIds = game.userIds || {};
  game.userIds[socket.id] = userId;

  socket.data.userId = userId;

  socket.username = finalUsername;

  socket.join(roomId);
  socketRoomMap[socket.id] = roomId;

  io.to(roomId).emit('playersUpdate', game.players.length);

  game.ready.add(socket.id);

  if (game.players.length === 2 && game.ready.size === 2 && !game.leadoffPlayer && !game.starting) {
  console.log(`[handleJoinGame] Both players ready. Starting game for room ${roomId}`);
  game.starting = true; // Prevent duplicate starts
  await startGame(roomId);
  game.starting = false; // Reset after start
}
}


function handlePlayerDisconnect(socket) {
  console.log(`🛑 handlePlayerDisconnect: ${socket.id} (${socket.data.username || 'unknown user'})`);

  // 1️⃣ Remove from waiting queue if present
  const waitingIndex = waitingPlayers.findIndex(wp => wp.socket.id === socket.id);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`✅ Removed from waitingPlayers: ${socket.data.username || 'unnamed player'}`);
  }

  // 2️⃣ Always clean up maps
  playersInGame.delete(socket.id);

  const roomId = socketRoomMap[socket.id];
  if (roomId) {
    delete socketRoomMap[socket.id];
    console.log(`✅ Removed from socketRoomMap for room: ${roomId}`);
  }

  // 3️⃣ Remove from any active game
  for (const [room, game] of Object.entries(games)) {
    const idx = game.players.indexOf(socket.id);
    if (idx === -1) continue;

    const disconnectedUsername = game.usernames[socket.id] || `Socket ${socket.id}`;

    // Remove player
    game.players.splice(idx, 1);
    delete game.usernames[socket.id];
    if (game.userIds) {
      delete game.userIds[socket.id];
    }
    playersInGame.delete(socket.id);
    delete socketRoomMap[socket.id];

    console.log(`✅ Removed ${disconnectedUsername} from active game in room ${room}`);
    io.to(room).emit('playersUpdate', game.players.length);

    // 4️⃣ If exactly one player remains, notify them
    if (game.players.length === 1) {
      const remainingId = game.players[0];
      const remainingUsername = game.usernames[remainingId] || `Socket ${remainingId}`;

      console.log(`ℹ️ Notifying ${remainingUsername} that ${disconnectedUsername} left the match`);

      io.to(remainingId).emit('gameOver', {
        reason: 'opponent_left',
        message: `${disconnectedUsername} left the match.`,
        winnerName: remainingUsername,
        loserName: disconnectedUsername,
        role: 'winner',
        canRematch: false
      });
    }

    // 5️⃣ If no players left, or after notifying remaining player, fully reset the game object
    if (game.players.length < 2) {
      console.log(`🧹 Deleting game in room ${room} due to insufficient players`);

      // Clear any remaining timer
      if (game.timer) {
        cleanupTimer(room);
      }

      // Completely delete the game object instead of resetting it
      delete games[room];

      console.log(`✅ Game in room ${room} completely deleted`);
    }

    break; // Stop looping once we handled this socket
  }
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


async function updateUserStats(userId, result) {
  if (!userId || !['win', 'loss'].includes(result)) return;

  console.log('[DB] updateUserStats called with:', userId, result);
  
  const winInc = result === 'win' ? 1 : 0;
  const lossInc = result === 'loss' ? 1 : 0;
  
  console.log('[DB] Will increment:', { winInc, lossInc, gamesInc: 1 });

  const query = `
    INSERT INTO user_stats (user_id, wins, losses, games_played, created_at, updated_at)
    VALUES ($1, $2, $3, 1, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET wins = user_stats.wins + $2,
          losses = user_stats.losses + $3,
          games_played = user_stats.games_played + 1,
          updated_at = NOW()
  `;
  
  try {
    const result = await client.query(query, [userId, winInc, lossInc]);
    console.log('[DB] Stats updated successfully for user:', userId);
    return result;
  } catch (err) {
    console.error('[DB] Error updating user_stats:', err);
    throw err;
  }
}


// Starts the 30-second countdown timer for a turn
async function startTurnTimer(roomId) {
  const game = games[roomId];
  if (!game) {
    console.warn(`[startTurnTimer] No game found for room ${roomId}`);
    return;
  }

  // ✅ Check if game has already ended
  if (game.gameEnded) {
    console.warn(`[startTurnTimer] Game already ended for room ${roomId}`);
    return;
  }

  // ✅ NEW: Prevent duplicate timers for the same room
  if (activeTimers.has(roomId)) {
    console.warn(`[startTurnTimer] Timer already active for room ${roomId}, clearing first`);
    const existingTimer = activeTimers.get(roomId);
    clearInterval(existingTimer);
    activeTimers.delete(roomId);
  }

  // ✅ Clear any existing timer on game object
  if (game.timer !== null) {
    console.warn(`[startTurnTimer] Clearing existing game timer in room ${roomId}`);
    clearInterval(game.timer);
    game.timer = null;
  }

  // ✅ NEW: Add timer state tracking
  game.timerRunning = true;
  game.timeLeft = 30;
  const socketId = game.players[game.currentTurn];
  game.activePlayerSocketId = socketId;

  // Fetch current player headshot
  const trimmedCurrentPlayerName = game.currentPlayerName.trim();
  const { headshot_url: currentPlayerHeadshotUrl } = await getPlayerByName(trimmedCurrentPlayerName);

  const activeSocket = io.sockets.sockets.get(socketId);
  if (activeSocket) {
    activeSocket.emit('yourTurn', {
      currentPlayerName: game.currentPlayerName,
      currentPlayerHeadshotUrl: currentPlayerHeadshotUrl || defaultPlayerImage,
      timeLeft: game.timeLeft,
    });
  }

  game.players.forEach(playerId => {
    if (playerId !== socketId) {
      const opponentSocket = io.sockets.sockets.get(playerId);
      if (opponentSocket) {
        opponentSocket.emit('opponentTurn', {
          currentPlayerName: game.currentPlayerName,
          currentPlayerHeadshotUrl: currentPlayerHeadshotUrl || defaultPlayerImage,
        });
      }
    }
  });

  // ✅ Start clean interval with enhanced safety
  const timerId = setInterval(async () => {
    // ✅ Multiple safety checks
    const currentGame = games[roomId];
    if (!currentGame || currentGame.gameEnded || !currentGame.timerRunning) {
      console.log(`[TIMER] Stopping timer for room ${roomId} - game ended or missing`);
      clearInterval(timerId);
      activeTimers.delete(roomId);
      if (currentGame) {
        currentGame.timer = null;
        currentGame.timerRunning = false;
      }
      return;
    }

    currentGame.timeLeft--;
    console.log(`[TIMER] Room ${roomId} - timeLeft: ${currentGame.timeLeft}`);
    io.to(roomId).emit('timerTick', { timeLeft: currentGame.timeLeft });

    if (currentGame.timeLeft <= 0) {
      // ✅ Immediately stop timer and cleanup
      clearInterval(timerId);
      activeTimers.delete(roomId);
      currentGame.timer = null;
      currentGame.timerRunning = false;
      currentGame.gameEnded = true;
      
      console.log(`[TIMER] Room ${roomId} - timer expired`);

      // Rest of your timeout logic...
      const loserSocketId = currentGame.activePlayerSocketId;
      const loserName = currentGame.usernames[loserSocketId];
      const winnerSocketId = currentGame.players.find(id => id !== loserSocketId);
      const winnerName = currentGame.usernames[winnerSocketId];

      // Your existing timeout handling code...
      if (!currentGame.matchStats) {
        currentGame.matchStats = {};
      }

      const loserUserId = currentGame.userIds[loserSocketId] ||
        io.sockets.sockets.get(loserSocketId)?.data?.userId;
      const winnerUserId = currentGame.userIds[winnerSocketId] ||
        io.sockets.sockets.get(winnerSocketId)?.data?.userId;

      console.log('[TIMER] About to update stats for:', {
        loserUserId,
        winnerUserId,
        statsUpdated: currentGame.statsUpdated,
        // ✅ Debug info
        gameUserIds: currentGame.userIds,
        socketUserIds: {
          loser: io.sockets.sockets.get(loserSocketId)?.data?.userId,
          winner: io.sockets.sockets.get(winnerSocketId)?.data?.userId
        }
      });   

      if (!currentGame.statsUpdated && loserUserId && winnerUserId) {
        await updateUserStats(winnerUserId, 'win');
        await updateUserStats(loserUserId, 'loss');
        currentGame.statsUpdated = true;
      } else {
        console.log('[TIMER] Skipping stats update:', { statsUpdated: currentGame.statsUpdated, loserUserId, winnerUserId });
      }

      if (!currentGame.matchStats[loserName]) currentGame.matchStats[loserName] = { wins: 0, losses: 0 };
      if (!currentGame.matchStats[winnerName]) currentGame.matchStats[winnerName] = { wins: 0, losses: 0 };
      currentGame.matchStats[winnerName].wins += 1;
      currentGame.matchStats[loserName].losses += 1;

      io.to(roomId).emit('matchStats', {
        [winnerName]: { wins: currentGame.matchStats[winnerName] },
        [loserName]: { wins: currentGame.matchStats[loserName] || 0 },
      });

      currentGame.players.forEach((playerId) => {
        const socket = io.sockets.sockets.get(playerId);
        if (!socket) return;

        if (playerId === winnerSocketId) {
          socket.emit('gameOver', {
            message: `${loserName} ran out of time! You win!`,
            role: 'winner',
            winnerName,
            loserName,
          });
        } else {
          socket.emit('gameOver', {
            message: `You ran out of time!`,
            role: 'loser',
            winnerName,
            loserName,
          });
        }
      });

      return;
    }
  }, 1000);

  // ✅ Store timer references
  game.timer = timerId;
  activeTimers.set(roomId, timerId);
  
  console.log(`[TIMER] Started new timer for room ${roomId}`);
}



});