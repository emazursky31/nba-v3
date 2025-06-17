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
  if (waitingPlayers.length > 0) {
    const { socket: opponentSocket, username: opponentUsername } = waitingPlayers.shift();
    const roomId = `room-${socket.id}-${opponentSocket.id}`;

    socket.username = username;
    opponentSocket.username = opponentUsername;

    socket.join(roomId);
    opponentSocket.join(roomId);

    console.log(`Matched players ${username} and ${opponentUsername} in room ${roomId}`);

    socket.emit('matched', { roomId, opponent: opponentUsername });
    opponentSocket.emit('matched', { roomId, opponent: username });

    handleJoinGame(socket, roomId, username);
    handleJoinGame(opponentSocket, roomId, opponentUsername);
  } else {
    socket.username = username;
    waitingPlayers.push({ socket, username });
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
 socket.on('playerGuess', async ({ roomId, guess }) => {
  const game = games[roomId];
  if (!game) return;

  // ⛔ Only allow guesses from active player
  if (socket.id !== game.activePlayerSocketId) {
    socket.emit('message', "It's not your turn!");
    return;
  }

  const normalizedGuess = guess.trim().toLowerCase();

  // 🚫 Game hasn't started yet
  if (!game.leadoffPlayer) {
    socket.emit('message', "Game hasn't started properly yet.");
    return;
  }

  // 🚫 Reject guessing leadoff player
  if (normalizedGuess === game.leadoffPlayer.toLowerCase()) {
    socket.emit('message', `You can't guess the starting player: "${game.leadoffPlayer}"`);
    return;
  }

  // 🚫 Already guessed
  const alreadyGuessed = game.successfulGuesses.some(name => name.toLowerCase() === normalizedGuess);
  if (alreadyGuessed) {
    socket.emit('message', `"${guess}" has already been guessed.`);
    return;
  }

  // ✅ Valid teammate
  const validGuess = game.teammates.some(t => t.toLowerCase() === normalizedGuess);

  if (validGuess) {
    clearInterval(game.timer);

    game.successfulGuesses.push(guess);
    game.currentTurn = (game.currentTurn + 1) % 2;
    game.currentPlayerName = guess;
    game.teammates = await getTeammates(game.currentPlayerName);
    game.timeLeft = 15;

    io.to(roomId).emit('turnEnded', {
      successfulGuess: `Player ${game.usernames[socket.id]} guessed "${guess}" successfully!`,
      guessedByUsername: game.usernames[socket.id],
      nextPlayerId: game.players[game.currentTurn],
      nextPlayerUsername: game.usernames[game.players[game.currentTurn]],
      currentPlayerName: game.currentPlayerName,
      timeLeft: game.timeLeft,
    });

    startTurnTimer(roomId);
  } else {
    socket.emit('message', `Incorrect guess: "${guess}"`);
    // ❗ Do NOT change turn or timer here — the same player keeps guessing until time runs out
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

  // Remove from waitingPlayers queue if they were waiting for a match
  const waitingIndex = waitingPlayers.indexOf(socket);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`Removed ${socket.username || 'an unnamed player'} from waiting queue`);
  }

  // Check all games to see if this player was in one
  for (const [roomId, game] of Object.entries(games)) {
    const idx = game.players.indexOf(socket.id);
    if (idx !== -1) {
      const disconnectedUsername = game.usernames[socket.id];

      // Remove player from game state
      game.players.splice(idx, 1);
      delete game.usernames[socket.id];
      io.to(roomId).emit('playersUpdate', game.players.length);
      console.log(`${disconnectedUsername || socket.id} removed from game in room ${roomId}`);

      // Clear interval if it exists
      if (game.timer) {
        clearInterval(game.timer);
        delete game.timer;
      }

      // Clean up rematch votes
      if (game.rematchVotes) {
        game.rematchVotes.delete(disconnectedUsername);
        if (game.rematchVotes.size === 0) {
          game.rematchVotes = new Set(); // reset to empty set
        }
      }

      // Optional: End the game if there are no players left
      if (game.players.length < 2) {
        io.to(roomId).emit('gameOver', 'Not enough players. Game ended.');
        delete games[roomId];
        console.log(`Game in room ${roomId} ended due to disconnect`);
      }

      break; // Player found and handled
    }
  }

  // Optional: delete from any players registry if you have one
  // delete players[socket.id];
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

  // STEP 1: Pick a valid starting player
  game.currentPlayerName = await getRandomPlayer(); // You will update this function
  game.leadoffPlayer = game.currentPlayerName;
  game.teammates = await getTeammates(game.currentPlayerName);

  // STEP 2: Check if teammates exist
  // if (!game.teammates || game.teammates.length === 0) {
  //   io.to(roomId).emit('gameOver', {
  //     message: `No teammates found for ${game.currentPlayerName}. Game cannot proceed.`,
  //   });
  //   delete games[roomId];
  //   return;
  // }

  // Log for debugging
  console.log(`[STARTGAME] room ${roomId} starting with:`);
  console.log(`→ currentPlayerName: ${game.currentPlayerName}`);
  console.log(`→ teammates: ${game.teammates}`);
  console.log(`→ players: ${game.players}`);
  console.log(`→ currentTurn: ${game.currentTurn}`);

  // STEP 3: Emit and start game
  io.to(roomId).emit('gameStarted', {
    firstPlayerId: game.players[startIndex],
    currentPlayerName: game.currentPlayerName,
    timeLeft: game.timeLeft,
    leadoffPlayer: game.leadoffPlayer,
  });

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
  // ✅ Create game if it doesn't exist yet
  if (!games[roomId]) {
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
    };
    console.log(`Game created for room: ${roomId}`);
  }

  const game = games[roomId];

  // ✅ Add player if not already in
  if (!game.players.includes(socket.id)) {
    game.players.push(socket.id);
    console.log(`Player ${username} added to game in room ${roomId}`);
  }

  // ✅ Set username
  game.usernames[socket.id] = username;

  console.log(`User ${username} (${socket.id}) joined room ${roomId}`);

  socket.join(roomId);

  // ✅ Notify room of updated player count
  io.to(roomId).emit('playersUpdate', game.players.length);
  console.log(`Players in room ${roomId}: ${game.players.length}`);

   // ✅ Start game once both players have joined
  if (game.players.length === 2 && !game.leadoffPlayer) {
    startGame(roomId);
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