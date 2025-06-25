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

  if (playersInGame.has(socket.id)) {
    console.log(`⚠️  ${username} (${socket.id}) tried to find match but is already in a game`);
    return;
  }

  if (waitingPlayers.length > 0) {
    const { socket: opponentSocket } = waitingPlayers.shift();
    const opponentUsername = opponentSocket.data.username;

    const roomId = `room-${socket.id}-${opponentSocket.id}`;
    console.log(`✅ Matched players ${username} and ${opponentUsername} in room ${roomId}`);

    socketRoomMap[socket.id] = roomId;
    socket.data.roomId = roomId;
    socketRoomMap[opponentSocket.id] = roomId;
    opponentSocket.data.roomId = roomId;

    // Don't initialize game here, do it inside handleJoinGame instead
    // games[roomId] = {...}

    playersInGame.add(socket.id);
    playersInGame.add(opponentSocket.id);

    handleJoinGame(socket, roomId, username);
    handleJoinGame(opponentSocket, roomId, opponentUsername);

    startGame(roomId);

    socket.emit('matched', { roomId, opponent: opponentUsername });
    opponentSocket.emit('matched', { roomId, opponent: username });
  } else {
    waitingPlayers.push({ socket });
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

  // Prevent guessing the leadoff player
  if (normalizedGuess === game.leadoffPlayer.toLowerCase()) {
    socket.emit('message', `You can't guess the starting player: "${game.leadoffPlayer}"`);
    return;
  }

  // Prevent duplicate guesses (case-insensitive)
  if (game.successfulGuesses.some(g => g.name.toLowerCase() === normalizedGuess)) {
    socket.emit('message', `"${guess}" has already been guessed.`);
    return;
  }

  const validGuess = game.teammates.some(t => t.toLowerCase() === normalizedGuess);

  if (validGuess) {
    console.log(`[SERVER] VALID guess "${guess}" by ${socket.data.username}. Advancing turn.`);

    clearInterval(game.timer);
    game.timer = null;

    // Save previous player before updating currentPlayerName
    const previousPlayer = game.currentPlayerName;

    // Fetch shared teams between previous player and current guess
    const sharedTeams = previousPlayer
      ? await getSharedTeams(previousPlayer, guess)
      : [];

    // Add guess to history with sharedTeams info
    game.successfulGuesses.push({
      guesser: game.usernames[socket.id],
      name: guess,
      sharedTeams // array of { team, years }
    });

    // Update current turn and player info
    game.currentTurn = (game.currentTurn + 1) % 2;
    game.currentPlayerName = guess;
    game.activePlayerSocketId = game.players[game.currentTurn];

    // Update teammates list for the new current player
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
  successfulGuesses: game.successfulGuesses,  // <-- Add this line!
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
  console.log(`User disconnected: ${socket.id}`);

  // Remove from waitingPlayers queue if waiting
  const waitingIndex = waitingPlayers.findIndex(wp => wp.socket.id === socket.id);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`Removed ${socket.data.username || 'an unnamed player'} from waiting queue`);
  }

  // Clean up from playersInGame
  playersInGame.delete(socket.id); // ✅ new

  // Remove from socketRoomMap
  const roomId = socketRoomMap[socket.id];
  if (roomId) {
    delete socketRoomMap[socket.id]; // ✅ already good
    console.log(`Removed socket ${socket.id} from socketRoomMap`);
  }

  // Remove from games and handle game cleanup
  for (const [room, game] of Object.entries(games)) {
    const idx = game.players.indexOf(socket.id);
    if (idx !== -1) {
      const disconnectedUsername = game.usernames[socket.id];

      // Remove player
      game.players.splice(idx, 1);
      delete game.usernames[socket.id];
      playersInGame.delete(socket.id); // ✅ again, just to be safe
      delete socketRoomMap[socket.id]; // ✅ again, just to be safe
      io.to(room).emit('playersUpdate', game.players.length);
      console.log(`${disconnectedUsername || socket.id} removed from game in room ${room}`);

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
        io.to(room).emit('gameOver', 'Not enough players. Game ended.');

        // Reset game but keep object intact
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
      if (stint1.team === stint2.team) {
        const start = Math.max(stint1.startYear, stint2.startYear);
        const end = Math.min(stint1.endYear, stint2.endYear);
        if (start <= end) {
          shared.push({
            team: stint1.team,
            years: start === end ? `${start}` : `${start}–${end}`
          });
        }
      }
    }
  }

  return shared;
}


async function getCareer(playerName) {
  const query = `
    SELECT team_abbr AS team, 
           EXTRACT(YEAR FROM start_date) AS start_year, 
           EXTRACT(YEAR FROM end_date) AS end_year
    FROM player_team_stints pts
    JOIN players p ON pts.player_id = p.player_id
    WHERE p.player_name = $1
    ORDER BY start_date;
  `;

  try {
    const res = await client.query(query, [playerName]);
    return res.rows.map(row => ({
      team: row.team,
      startYear: parseInt(row.start_year),
      endYear: parseInt(row.end_year)
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
  game.successfulGuesses = [];
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

  // ✅ Notify clients
  io.to(roomId).emit('gameStarted', {
    firstPlayerId: game.activePlayerSocketId,
    currentPlayerName: game.currentPlayerName,
    timeLeft: game.timeLeft,
    leadoffPlayer: game.leadoffPlayer,
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

  socket.join(roomId);
  socketRoomMap[socket.id] = roomId;

  io.to(roomId).emit('playersUpdate', game.players.length);

  game.ready.add(socket.id);

  if (game.players.length === 2 && game.ready.size === 2 && !game.leadoffPlayer) {
    console.log(`[handleJoinGame] Both players ready. Starting game for room ${roomId}`);
    startGame(roomId);
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

    // Defensive logging
    console.log(`[TIMER] Room ${roomId} - timeLeft: ${game.timeLeft}`);

    io.to(roomId).emit('timerTick', { timeLeft: game.timeLeft });

    if (game.timeLeft <= 0) {
      clearInterval(game.timer);
      game.timer = null;
      console.log(`[TIMER] Room ${roomId} - timer expired`);

      const loserSocketId = game.activePlayerSocketId;
      const loserSocket = io.sockets.sockets.get(loserSocketId);
      const loserName = game.usernames[loserSocketId];
      const winnerSocketId = game.players.find(id => id !== loserSocketId);
      const winnerSocket = io.sockets.sockets.get(winnerSocketId);

      if (loserSocket) {
        loserSocket.emit('gameOver', {
          message: `You ran out of time!`,
          role: 'loser',
        });
      }

      if (winnerSocket) {
        winnerSocket.emit('gameOver', {
          message: `${loserName} ran out of time! You win!`,
          role: 'winner',
        });
      }
    }
  }, 1000);
}


});