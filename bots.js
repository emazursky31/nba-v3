// Bot opponents. A bot is an ordinary socket.io client that connects back to
// this server, so it goes through the same matchmaking and turn code as a
// person. It only fills in when a guest has waited a few seconds for a rival.
const { io: connect } = require('socket.io-client');
const crypto = require('crypto');

const BOT_ID_PREFIX = 'bot-';
const WAIT_BEFORE_BOT_MS = 6000;
const BOT_NAMES = [
  'hoopsdad23', 'Marcus_T', 'courtvision', 'SkyhookSam', 'dimeDropper',
  'ChrisFromJersey', 'baseline_bob', 'TheGlassEater', 'jumpshot_jay',
  'ZoneDefense', 'Ant_Eater', 'bucketsbyron', 'LateGameLou', 'PickAndRolo'
];

const isBotUserId = (id) => typeof id === 'string' && id.startsWith(BOT_ID_PREFIX);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const between = (lo, hi) => lo + Math.random() * (hi - lo);

function createBots({ port, waitingPlayers }) {
  let getTeammates = async () => [];
  // Ask for a bot on behalf of a waiting human. No-op if they were matched.
  function scheduleFill(humanSocket, era) {
    setTimeout(() => {
      const stillWaiting = waitingPlayers.some((w) => w.socket.id === humanSocket.id);
      if (humanSocket.connected && stillWaiting) spawnBot(era);
    }, WAIT_BEFORE_BOT_MS);
  }

  function spawnBot(era) {
    const name = pick(BOT_NAMES) + (Math.random() < 0.5 ? Math.floor(between(2, 99)) : '');
    const userId = BOT_ID_PREFIX + crypto.randomUUID();
    const sock = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'] });

    let roomId = null;
    let used = new Set();
    let botTurns = 0;
    let answering = false;

    const leave = () => setTimeout(() => sock.disconnect(), 1500);

    sock.on('connect', () => {
      sock.emit('userIdentified', { userId, username: name });
      sock.emit('findMatch', { username: name, userId, era });
      // If nobody took the bot within 10s the human already left or got matched.
      setTimeout(() => { if (!roomId) sock.disconnect(); }, 10000);
    });

    sock.on('matched', ({ roomId: id }) => {
      roomId = id;
      // The person's screen runs a 5s countdown; join around the same time.
      setTimeout(() => {
        sock.emit('joinGame', { roomId, username: name, userId, era, timeLimit: 30 });
        sock.emit('readyToStart', { roomId });
      }, between(1500, 3500));
    });

    sock.on('turnEnded', (d) => {
      (d.successfulGuesses || []).forEach((g) => used.add(String(g.name).toLowerCase()));
    });

    sock.on('yourTurn', async (d) => {
      if (answering) return;
      answering = true;
      botTurns++;
      used.add(String(d.currentPlayerName).toLowerCase());
      try {
        const options = (await getTeammates(d.currentPlayerName))
          .filter((n) => !used.has(n.toLowerCase()));
        // Gets less sure of itself the longer the chain runs, and gives up
        // when it has nothing left. Roughly a coin flip against a decent player.
        const blank = options.length === 0 || Math.random() < Math.min(0.55, 0.06 + 0.05 * botTurns);
        const delay = Math.min(25000, between(2500, 8000) + botTurns * 250);
        if (blank) return; // let the clock run out
        const answer = pick(options);
        setTimeout(() => {
          sock.emit('playerGuess', { guess: answer });
        }, delay);
      } finally {
        setTimeout(() => { answering = false; }, 1000);
      }
    });

    sock.on('gameOver', leave);
    sock.on('gameEnded', leave);
    sock.on('disconnect', () => { used = new Set(); });
  }

  return { scheduleFill, isBotUserId, useTeammateLookup: (fn) => { getTeammates = fn; } };
}

module.exports = { createBots, isBotUserId };
