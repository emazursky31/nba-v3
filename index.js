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
  


socket.on('findMatch', (username) => {
  socket.data.username = username;

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

    // ✅ Track socket-room mapping (single map)
    socketRoomMap[socket.id] = roomId;
    socketRoomMap[opponentSocket.id] = roomId;

    // Store roomId on socket.data for both
    socket.data.roomId = roomId;
    opponentSocket.data.roomId = roomId;

    // Add players to the in-game set
    playersInGame.add(socket.id);
    playersInGame.add(opponentSocket.id);

    // Handle joining game for both players
    handleJoinGame(socket, roomId, username);
    handleJoinGame(opponentSocket, roomId, opponentUsername);

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





socket.on('joinGame', ({ roomId, username }) => {
  handleJoinGame(socket, roomId, username);
});


// Diagnostic event to check current games from client on demand
socket.on('testGames', () => {
  console.log('[testGames] games keys:', Object.keys(games));
  socket.emit('testGamesResult', Object.keys(games));
});

function ensureLeadoffAtFront(game) {
  if (!game.successfulGuesses.length || game.successfulGuesses[0].name !== game.leadoffPlayer) {
    // Remove any previous leadoff entries
    game.successfulGuesses = game.successfulGuesses.filter(g => !g.isLeadoff);
    // Add the leadoff player at the front
    game.successfulGuesses.unshift({
      name: game.leadoffPlayer,
      guesser: 'Leadoff',
      isLeadoff: true,
      sharedTeams: []
    });
  }
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

  if (normalizedGuess === game.leadoffPlayer.toLowerCase()) {
    socket.emit('message', `You can't guess the starting player: "${game.leadoffPlayer}"`);
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
      getCareer(previousPlayer),
      getCareer(guess)
    ]);

    const sharedTeams = getSharedTeams(career1, career2);

    game.successfulGuesses.push({
      guesser: game.usernames[socket.id],
      name: guess,
      sharedTeams
    });

    // Ensure leadoff player is always at the front of successfulGuesses
    ensureLeadoffAtFront(game);

    game.currentTurn = (game.currentTurn + 1) % 2;
    game.currentPlayerName = guess;
    game.activePlayerSocketId = game.players[game.currentTurn];

    game.teammates = await getTeammates(game.currentPlayerName);
    game.timeLeft = 30;

    console.log('[SERVER] Emitting turnEnded with successfulGuesses:', JSON.stringify(game.successfulGuesses, null, 2));

    io.to(roomId).emit('turnEnded', {
      successfulGuess: `Player ${game.usernames[socket.id]} guessed "${guess}" successfully!`,
      guessedByUsername: game.usernames[socket.id],
      nextPlayerId: game.activePlayerSocketId,
      nextPlayerUsername: game.usernames[game.activePlayerSocketId],
      currentPlayerName: game.currentPlayerName,
      timeLeft: game.timeLeft,
      successfulGuesses: game.successfulGuesses,
    });

    startTurnTimer(roomId);
  } else {
    socket.emit('message', `Incorrect guess: "${guess}"`);
  }
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

        // Reset game state
        game.players = [];
        game.usernames = {};
        game.currentTurn = 0;
        game.currentPlayerName = null;
        game.teammates = [];
        game.successfulGuesses = [];
        game.rematchVotes = new Set();

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

  // ✅ Fully reset state for rematch
  game.successfulGuesses = [{
    name: game.leadoffPlayer,
    guesser: 'Leadoff',
    isLeadoff: true,
    sharedTeams: []
  }];
  game.rematchVotes = new Set();
  if (game.timer) clearInterval(game.timer);
  game.timeLeft = 30;

  const startIndex = Math.floor(Math.random() * game.players.length);
  game.currentTurn = startIndex;

  // ✅ Select leadoff player & their teammates
  game.currentPlayerName = await getRandomPlayer();
  game.leadoffPlayer = game.currentPlayerName;
  game.teammates = await getTeammates(game.currentPlayerName);

  // ✅ Set initial turn ownership
  game.activePlayerSocketId = game.players[game.currentTurn];

  // ✅ Map sockets to room again
  game.players.forEach((socketId) => {
    socketRoomMap[socketId] = roomId;
  });

  // ✅ Logging
  console.log(`[STARTGAME] room ${roomId} starting with:`);
  console.log(`→ currentPlayerName: ${game.currentPlayerName}`);
  console.log(`→ teammates: ${game.teammates}`);
  console.log(`→ players: ${game.players}`);
  console.log(`→ currentTurn: ${game.currentTurn}`);
  console.log(`→ activePlayerSocketId: ${game.activePlayerSocketId}`);

  // ✅ Notify each player INDIVIDUALLY with their opponent’s name from game.usernames
  game.players.forEach((socketId) => {
    const opponentSocketId = game.players.find(id => id !== socketId);
    const opponentUsername = game.usernames[opponentSocketId] || 'Opponent';

    io.to(socketId).emit('gameStarted', {
      firstPlayerId: game.activePlayerSocketId,
      currentPlayerName: game.currentPlayerName,
      timeLeft: game.timeLeft,
      leadoffPlayer: game.leadoffPlayer,
      opponentName: opponentUsername
    });
  });

  // ✅ Start timer
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
    SELECT p.player_name
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
  return res.rows[0]?.player_name || null;
}


function handleJoinGame(socket, roomId, username) {
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

  socket.username = finalUsername;

  socket.join(roomId);
  socketRoomMap[socket.id] = roomId;

  io.to(roomId).emit('playersUpdate', game.players.length);

  game.ready.add(socket.id);

  if (game.players.length === 2 && game.ready.size === 2 && !game.leadoffPlayer) {
    console.log(`[handleJoinGame] Both players ready. Starting game for room ${roomId}`);
    startGame(roomId);
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
      console.log(`🧹 Resetting game in room ${room} due to insufficient players`);

      game.players = [];
      game.usernames = {};
      game.currentTurn = 0;
      game.currentPlayerName = null;
      game.teammates = [];
      game.successfulGuesses = [];
      game.rematchVotes = new Set();

      if (game.timer) {
        clearInterval(game.timer);
        delete game.timer;
      }

      console.log(`✅ Game in room ${room} fully reset`);
    }

    break; // Stop looping once we handled this socket
  }
}







// Starts the 30-second countdown timer for a turn
function startTurnTimer(roomId) {
  const game = games[roomId];
  if (!game) return;

  if (game.timer !== null) {
    console.warn(`[SERVER] Clearing existing timer before starting new one in room ${roomId}`);
    clearInterval(game.timer);
    game.timer = null;
  }

  game.timeLeft = 30;
  const socketId = game.players[game.currentTurn];
  game.activePlayerSocketId = socketId;

  const activeSocket = io.sockets.sockets.get(socketId);
  if (activeSocket) {
    activeSocket.emit('yourTurn', {
      currentPlayerName: game.currentPlayerName,
      timeLeft: game.timeLeft,
    });
  }

  game.players.forEach(playerId => {
    if (playerId !== socketId) {
      const opponentSocket = io.sockets.sockets.get(playerId);
      if (opponentSocket) {
        opponentSocket.emit('opponentTurn', {
          currentPlayerName: game.currentPlayerName,
        });
      }
    }
  });

  // ✅ Start clean interval
  game.timer = setInterval(() => {
    game.timeLeft--;

    console.log(`[TIMER] Room ${roomId} - timeLeft: ${game.timeLeft}`);
    io.to(roomId).emit('timerTick', { timeLeft: game.timeLeft });

    if (game.timeLeft <= 0) {
      clearInterval(game.timer);
      game.timer = null;
      console.log(`[TIMER] Room ${roomId} - timer expired`);

      const loserSocketId = game.activePlayerSocketId;
      const loserName = game.usernames[loserSocketId];
      const winnerSocketId = game.players.find(id => id !== loserSocketId);
      const winnerName = game.usernames[winnerSocketId];

      // ✅ Initialize matchStats if missing
      if (!game.matchStats) {
        game.matchStats = {};
      }

      // ✅ Increment winner’s count
      if (!game.matchStats[winnerName]) game.matchStats[winnerName] = { wins: 0 };
      game.matchStats[winnerName].wins += 1;

      console.log(`[SCOREBOARD] Room ${roomId} - Updated stats:`, game.matchStats);

      // ✅ Emit updated stats to both players
      io.to(roomId).emit('matchStats', {
        [winnerName]: { wins: game.matchStats[winnerName] },
        [loserName]: { wins: game.matchStats[loserName] || 0 },
      });


      // ✅ Emit game over event to both players
      game.players.forEach((playerId) => {
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
    }
  }, 1000);
}



});