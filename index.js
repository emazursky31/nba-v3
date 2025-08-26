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
const gameCreationLocks = new Set();

const defaultPlayerImage = 
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAAvklEQVRoge3XsQ2AIBBF0ZLpDoBuwHFHqK8cQvMrIo3FLPHom/b2mX9rcNqZmZmZmZmZmZmdFz5ec3m6F3+v4PYs3PmR7DbiDD1N9g5IuT16CWYExozP7G9Czzxq/cE8ksYbFxExk2RcMUfYHNk0RMYPhk0QcMbJHUYyNsi9h5YDyYFSNqLD6c+5h3tGn+MO9ZftHJz5nz/rq3ZTzRzqkIxuYwAAAABJRU5ErkJggg==';


// Serve static files first
app.use(express.static(path.join(__dirname, 'public')));





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
    
    return {
      playerName: playerInfo.player_name,
      firstYear: playerInfo.first_year,
      lastYear: playerInfo.last_year,
      totalTeams: parseInt(playerInfo.total_teams),
      teamStints: stintsResult.rows.map(stint => ({
        team: stint.team_abbr,
        startYear: parseInt(stint.start_season),
        endYear: parseInt(stint.end_season)
      }))
    };
    
  } catch (error) {
    console.error('[getPlayerCareerDetails] Database error:', error);
    throw error;
  }
}





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
    startGame(roomId);
  }
});


socket.on('userSignedIn', ({ userId, username }) => {
  console.log('[SIGNIN] Setting socket data for user:', { userId, username });
  socket.data.userId = userId;
  socket.data.username = username;
});


socket.on('joinGame', async ({ roomId, username, userId, era }) => {
  await handleJoinGame(socket, roomId, username, userId, era);
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
    game.timeLeft = 30; // Reset timer to full 30 seconds

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
    game.timeLeft = 30;
    game.turnCount = 0;
    game.skipsUsed = {};

    // ✅ RESTORE userIds AFTER resetting
    game.userIds = preservedUserIds;
    console.log('[REMATCH] Restored userIds:', game.userIds);

    if (game.timer) {
      cleanupTimer(roomId);
      game.timer = null;
    }
    startGame(roomId);
    io.to(roomId).emit('rematchStarted'); // Notify clients explicitly
    console.log('Emitted rematchStarted to room:', roomId);
  }
});



socket.on('disconnect', async () => {
  const username = socket.data?.username || 'an unnamed player';
  console.log(`User disconnected: ${socket.id} (${username})`);

  // Remove from waitingPlayers queue if waiting
  const waitingIndex = waitingPlayers.findIndex(wp => wp.socket.id === socket.id);
  if (waitingIndex !== -1) {
    waitingPlayers.splice(waitingIndex, 1);
    console.log(`Removed ${username} from waiting queue`);
  }

  playersInGame.delete(socket.id);

  // Remove from socketRoomMap
  const roomId = socketRoomMap[socket.id];
  if (roomId) {
    cleanupTimer(roomId);
    delete socketRoomMap[socket.id];
    console.log(`Removed socket ${socket.id} from socketRoomMap for room ${roomId}`);
  }

  for (const [room, game] of Object.entries(games)) {
    const idx = game.players.indexOf(socket.id);
    if (idx !== -1) {
      const disconnectedUsername = game.usernames[socket.id] || username;
      console.log(`[DISCONNECT] Processing disconnect for ${disconnectedUsername} in room ${room}`);

      // ✅ Notify remaining players BEFORE removing the disconnected player
      if (game.players.length === 2) {
        const remainingSocketId = game.players.find(id => id !== socket.id);
        const remainingSocket = io.sockets.sockets.get(remainingSocketId);
        
        if (remainingSocket && remainingSocket.connected) {
          console.log(`[DISCONNECT] Notifying ${game.usernames[remainingSocketId]} that ${disconnectedUsername} left`);
          
          // Simple, consistent message for all scenarios
          remainingSocket.emit('opponentLeft', {
            message: 'Your opponent left the game'
          });
        } else {
          console.log(`[DISCONNECT] Remaining socket not found or not connected`);
        }
      }

      // Remove player from game
      game.players.splice(idx, 1);
      delete game.usernames[socket.id];
      playersInGame.delete(socket.id);

      io.to(room).emit('playersUpdate', game.players.length);
      console.log(`${disconnectedUsername} removed from game in room ${room}`);

      // Rest of disconnect logic remains the same...
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
        // Notify remaining players with gameOver event
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
              turnCount: game.turnCount || 0
            });
          }
          playersInGame.delete(playerSocketId);
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
          await updateUserStats(remainingUserId, 'win');
          await updateUserStats(disconnectedUserId, 'loss');
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
async function startGame(roomId, selectedEra = '2000-present') {
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
        opponentName: opponentUsername
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



async function handleJoinGame(socket, roomId, username, userId, era = '2000-present') {
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
    
    // Store/update era in existing game
    game.selectedEra = era;
    
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
          await startGame(roomId, era);
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
      game.selectedEra = era; // Update era
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
      timeLeft: 30,
      skipsUsed: {},
      teammates: [],
      successfulGuesses: [],
      rematchVotes: new Set(),
      leadoffPlayer: null,
      activePlayerSocketId: null,
      ready: new Set(),
      starting: false,
      turnCount: 0,
      selectedEra: era, // ✅ Store era in new game
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
      canSkip: !(game.skipsUsed && game.skipsUsed[socketId]),
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
          activePlayerName: socket.username || 'Player',
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
      const playerIds = currentGame.players || [];
      const loserSocketId = currentGame.activePlayerSocketId;
      const loserName = currentGame.usernames[loserSocketId];
      const winnerSocketId = playerIds.find(id => id && id !== loserSocketId);
      const winnerName = currentGame.usernames[winnerSocketId];
      if (!winnerSocketId || !loserSocketId) {
        console.warn(`[TIMER] Could not determine winner/loser socket IDs. Skipping stats update.`);
      }

      // Your existing timeout handling code...
      if (!currentGame.matchStats) {
        currentGame.matchStats = {};
      }

      let loserUserId = currentGame.userIds[loserSocketId];
      let winnerUserId = currentGame.userIds[winnerSocketId];

      // ✅ ADD: Fallback userId lookup if missing
      if (!loserUserId) {
        console.warn('[TIMER] Missing loserUserId, attempting fallback lookup');
        const loserSocket = io.sockets.sockets.get(loserSocketId);
        loserUserId = loserSocket?.data?.userId;
      }

      if (!winnerUserId) {
        console.warn('[TIMER] Missing winnerUserId, attempting fallback lookup');
        const winnerSocket = io.sockets.sockets.get(winnerSocketId);
        winnerUserId = winnerSocket?.data?.userId;
      }

      // Enhanced logging
      console.log('[TIMER] Final userIds after fallback:', { loserUserId, winnerUserId });


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
            turnCount: currentGame.turnCount
          });
        } else {
          socket.emit('gameOver', {
            message: `You ran out of time!`,
            role: 'loser',
            winnerName,
            loserName,
            turnCount: currentGame.turnCount
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