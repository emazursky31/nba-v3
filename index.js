require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path'); // ✅ Add this
const { Server } = require('socket.io');
const { Client } = require('pg');

const rooms = {};
const waitingPlayers = [];

const app = express();
const server = http.createServer(app);

const io = new Server(server);

const socketRoomMap = {};


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✅ Optional: serve other assets (like CSS or JS files) if needed
app.use(express.static(path.join(__dirname)));

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

// Add this to serve your frontend files in /public
app.use(express.static('public'));


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



// In-memory games state: roomId -> game data
const games = {};
console.log('Games object ID:', games);



io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  


socket.on('findMatch', (username) => {
  socket.data.username = username;

  if (waitingPlayers.length > 0) {
    const { socket: opponentSocket } = waitingPlayers.shift();
    const opponentUsername = opponentSocket.data.username;

    const roomId = `room-${socket.id}-${opponentSocket.id}`;
    console.log(`Matched players ${username} and ${opponentUsername} in room ${roomId}`);

    // Update socketRoomMap for both players
    socketRoomMap[socket.id] = roomId;
    socket.data.roomId = roomId;
    socketRoomMap[opponentSocket.id] = roomId;
    opponentSocket.data.roomId = roomId;

    // Initialize game state for the room — key fix
    games[roomId] = {
      players: [socket.id, opponentSocket.id],
      usernames: {
        [socket.id]: username,
        [opponentSocket.id]: opponentUsername,
      },
      rematchVotes: new Set(),
      successfulGuesses: [],
      timer: null,
      currentTurn: null,
      currentPlayerName: null,
      leadoffPlayer: null,
      teammates: null,
      activePlayerSocketId: null,
      timeLeft: null,
      // any other game properties your game uses
    };

    // Now call your existing join handlers
    handleJoinGame(socket, roomId, username);
    handleJoinGame(opponentSocket, roomId, opponentUsername);

    // Optionally start the game immediately or wait for both players ready
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

  if (normalizedGuess === game.leadoffPlayer.toLowerCase()) {
    socket.emit('message', `You can't guess the starting player: "${game.leadoffPlayer}"`);
    return;
  }

  if (game.successfulGuesses.some(name => name.toLowerCase() === normalizedGuess)) {
    socket.emit('message', `"${guess}" has already been guessed.`);
    return;
  }

  const validGuess = game.teammates.some(t => t.toLowerCase() === normalizedGuess);

  if (validGuess) {
    console.log(`[SERVER] VALID guess "${guess}" by ${socket.data.username}. Advancing turn.`);
    clearInterval(game.timer);

    game.successfulGuesses.push(guess);
    game.currentTurn = (game.currentTurn + 1) % 2;
    game.currentPlayerName = guess;
    game.activePlayerSocketId = game.players[game.currentTurn];
    
    game.teammates = await getTeammates(game.currentPlayerName);
    game.timeLeft = 15;

    io.to(roomId).emit('turnEnded', {
      successfulGuess: `Player ${game.usernames[socket.id]} guessed "${guess}" successfully!`,
      guessedByUsername: game.usernames[socket.id],
      nextPlayerId: game.activePlayerSocketId,
      nextPlayerUsername: game.usernames[game.activePlayerSocketId],
      currentPlayerName: game.currentPlayerName,
      timeLeft: game.timeLeft,
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

  // Remove from socketRoomMap
  const roomId = socketRoomMap[socket.id];
  if (roomId) {
    delete socketRoomMap[socket.id];
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
        if (game.timer) {
          clearInterval(game.timer);
          delete game.timer;
        }
        game.teammates = [];
        game.successfulGuesses = [];
        game.rematchVotes = new Set();

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


// Starts the game in a room: picks random first player & teammates
async function startGame(roomId) {
  const game = games[roomId];
  if (!game) {
    console.log('❌ No game object found');
    return;
  }

  game.rematchVotes = new Set();  // Reset rematch state
  if (game.timer) clearInterval(game.timer);
  game.successfulGuesses = [];
  game.timeLeft = 15;

  const startIndex = Math.floor(Math.random() * game.players.length);
  game.currentTurn = startIndex;

  // STEP 1: Pick a valid starting player name
  game.currentPlayerName = await getRandomPlayer(); // Your existing logic
  game.leadoffPlayer = game.currentPlayerName;
  game.teammates = await getTeammates(game.currentPlayerName);

  // STEP 2: Assign the active player's socket ID for turn validation
  game.activePlayerSocketId = game.players[game.currentTurn];

  // STEP 3: Update socketRoomMap for each player socket to this room
  // (Assuming socketRoomMap is a global object)
  game.players.forEach((socketId) => {
    socketRoomMap[socketId] = roomId;
  });

  // Log for debugging
  console.log(`[STARTGAME] room ${roomId} starting with:`);
  console.log(`→ currentPlayerName: ${game.currentPlayerName}`);
  console.log(`→ teammates: ${game.teammates}`);
  console.log(`→ players: ${game.players}`);
  console.log(`→ currentTurn: ${game.currentTurn}`);
  console.log(`→ activePlayerSocketId: ${game.activePlayerSocketId}`);

  // STEP 4: Emit game started event with current player info
  io.to(roomId).emit('gameStarted', {
    firstPlayerId: game.activePlayerSocketId,
    currentPlayerName: game.currentPlayerName,
    timeLeft: game.timeLeft,
    leadoffPlayer: game.leadoffPlayer,
  });

  // STEP 5: Start the turn timer
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
  if (!games[roomId]) {
    console.log(`[handleJoinGame] Creating game for room: ${roomId}`);
    games[roomId] = {
      players: [],
      usernames: {},
      currentTurn: 0,
      currentPlayerName: null,
      timer: null,
      timeLeft: 15,
      teammates: [],
      successfulGuesses: [],
      rematchVotes: new Set(),
      leadoffPlayer: null,
      activePlayerSocketId: null,
      ready: new Set(), // ✅ NEW: track readiness per player
    };
  } else {
    console.log(`[handleJoinGame] Game already exists for room ${roomId}`);
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

  // ✅ Mark this player as ready
  game.ready.add(socket.id);

  // ✅ Only start when both players are present and ready
  if (game.players.length === 2 && game.ready.size === 2 && !game.leadoffPlayer) {
    console.log(`[handleJoinGame] Both players ready. Starting game for room ${roomId}`);
    startGame(roomId);
  }
}





// Starts the 15-second countdown timer for a turn
function startTurnTimer(roomId) {
  const game = games[roomId];
  if (!game) return;

  const socketId = game.players[game.currentTurn];
  game.activePlayerSocketId = socketId;
  game.timeLeft = 15;

  const activeSocket = io.sockets.sockets.get(socketId);
  if (activeSocket) {
    activeSocket.emit('yourTurn', {
      currentPlayerName: game.currentPlayerName,
      timeLeft: game.timeLeft,
    });
  }

  // Notify the other player it's not their turn
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

  game.timer = setInterval(() => {
    game.timeLeft -= 1;

    // Broadcast tick to both players
    io.to(roomId).emit('timerTick', { timeLeft: game.timeLeft });

   if (game.timeLeft <= 0) {
  clearInterval(game.timer);
  game.timer = null;

  // Get the loser (the one whose turn it was)
  const loserSocketId = game.activePlayerSocketId;
  const loserSocket = io.sockets.sockets.get(loserSocketId);
  const loserName = game.usernames[loserSocketId];

  // Get the other player
  const winnerSocketId = game.players.find(id => id !== loserSocketId);
  const winnerSocket = io.sockets.sockets.get(winnerSocketId);

  // Notify both players
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

  // // Clean up game state if needed
  // delete games[roomId]; // or mark it inactive
}

  }, 1000);
}
});