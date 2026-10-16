// UI glue for the home page and live game screen.
// Runs after the main inline script, so it can use its top-level helpers
// (navigateTo, joinPublicGame, updateNavUserState, myUserId, ...).
(function () {
  const $ = (id) => document.getElementById(id);

  // ---- Analytics ------------------------------------------------------------
  // Anonymous, first-party: a random id per browser, no cookies, never blocks the page.
  function anonId() {
    try {
      let id = localStorage.getItem('anonId');
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
        localStorage.setItem('anonId', id);
      }
      return id;
    } catch (e) { return null; }
  }
  window.track = function track(name, props) {
    try {
      const body = JSON.stringify({
        name, props: props || {},
        anonId: anonId(),
        userId: (typeof myUserId !== 'undefined' && myUserId) || null
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
      }
    } catch (e) {}
  };

  (function trackVisit() {
    const q = new URLSearchParams(location.search);
    let ref = '';
    try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
    if (ref === location.hostname) ref = '';
    window.track('page_view', {
      path: location.pathname,
      ref,
      utm_source: q.get('utm_source') || undefined,
      utm_medium: q.get('utm_medium') || undefined,
      utm_campaign: q.get('utm_campaign') || undefined,
      mobile: window.matchMedia('(max-width: 720px)').matches
    });
    if (q.has('room')) window.track('invite_opened');
  })();

  // ---- Log in / sign up sheet -------------------------------------------
  function openAuth(tab) {
    document.body.classList.add('auth-open');
    const tabBtn = $(tab === 'signin' ? 'tab-signin' : 'tab-signup');
    if (tabBtn) tabBtn.click();
    const first = document.querySelector('#authPanel .auth-form.active input');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 50);
  }

  function closeAuth() {
    document.body.classList.remove('auth-open');
  }

  $('openAuthBtn')?.addEventListener('click', () => openAuth('signin'));
  $('closeAuthBtn')?.addEventListener('click', closeAuth);
  $('authPanel')?.addEventListener('click', (e) => {
    if (e.target === $('authPanel')) closeAuth();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('auth-open')) closeAuth();
  });

  // ---- Guest play ---------------------------------------------------------
  function setGuestError(message) {
    const el = $('guestError');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  async function playAsGuest() {
    const btn = $('playGuestBtn');
    if (!btn || btn.disabled) return;
    const label = btn.querySelector('.btn-play-label');
    const labelText = label ? label.textContent : '';
    btn.disabled = true;
    btn.classList.add('is-busy');
    if (label) label.textContent = 'Getting you in…';
    setGuestError('');

    try {
      let { data: { session } } = await supabase.auth.getSession();

      if (!session?.user) {
        const guestName = 'Guest' + Math.floor(1000 + Math.random() * 9000);
        const { data, error } = await supabase.auth.signInAnonymously({
          options: { data: { username: guestName } }
        });
        if (error) throw error;
        session = data.session;
        window.track('guest_signin');
      }

      const user = session.user;
      myUsername = user.user_metadata?.username || user.email;
      myUserId = user.id;
      if (!myUsername) throw new Error('Guest account has no username');
      localStorage.setItem('username', myUsername);
      localStorage.setItem('userId', myUserId);

      await updateNavUserState(session);

      if (socket && socket.connected) {
        socket.emit('userIdentified', { userId: myUserId, username: myUsername });
        socket.emit('userSignedIn', { userId: myUserId, username: myUsername });
      }

      // Same defaults as "Find Public Game"
      selectedEra = '2000-present';
      selectedTimeLimit = 30;
      localStorage.setItem('selectedEra', selectedEra);
      localStorage.setItem('selectedTimeLimit', selectedTimeLimit);
      gameTypeSelected = 'public';

      // Opened from a friend's invite link: join their room instead of the public queue
      const invite = localStorage.getItem('pendingRoomInvite');
      if (invite) {
        localStorage.removeItem('pendingRoomInvite');
        myRoomId = invite;
        roomId = invite;
        isPrivateGame = true;
        isLeavingGame = false;
        localStorage.setItem('privateRoomId', invite);
        localStorage.removeItem('isLeavingGame');
        socket.emit('joinGame', {
          roomId: invite,
          username: myUsername,
          userId: myUserId,
          era: selectedEra,
          timeLimit: selectedTimeLimit
        });
        await navigateTo('/waiting');
        return;
      }

      window.allowBotFill = true; // guests get a bot if no rival shows up
      await joinPublicGame();
    } catch (err) {
      console.error('[guest] Could not start a guest game:', err);
      const why = err && err.message ? ` (${err.message})` : '';
      setGuestError("Guest play isn't available right now. Log in or sign up to play." + why);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (label) label.textContent = labelText;
    }
  }

  // Show who invited you before you tap anything
  function refreshInviteBanner() {
    let invited = false;
    try { invited = !!localStorage.getItem('pendingRoomInvite') || new URLSearchParams(location.search).has('room'); } catch (e) {}
    const banner = $('inviteBanner');
    const hint = $('playGuestHint');
    if (banner) banner.hidden = !invited;
    if (hint) hint.textContent = invited ? 'Join as a guest. No signup.' : 'Jump in as a guest. No signup.';
  }
  refreshInviteBanner();
  setTimeout(refreshInviteBanner, 400);
  setTimeout(refreshInviteBanner, 1500);

  $('playGuestBtn')?.addEventListener('click', playAsGuest);

  // ---- Keep the game screen inside the visible area ----------------------
  // On phones the on-screen keyboard covers the bottom of the page. Track the
  // visible height so the guess box stays on screen and nothing needs scrolling.
  // Some phone browsers shrink the whole page when the keyboard opens instead
  // of only the visual viewport, so a focused guess box counts as keyboard-open.
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  let guessFocused = false;

  function syncViewport() {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', height + 'px');
    document.documentElement.style.setProperty('--app-top', (vv ? vv.offsetTop : 0) + 'px');
    const shrunk = !!vv && vv.height < window.innerHeight * 0.78;
    document.body.classList.toggle('kb-open', shrunk || (touch && guessFocused));
  }

  const guessBox = $('guessInput');
  if (guessBox) {
    guessBox.addEventListener('focus', () => { guessFocused = true; syncViewport(); });
    guessBox.addEventListener('blur', () => { guessFocused = false; setTimeout(syncViewport, 150); });
  }

  syncViewport();
  window.addEventListener('resize', syncViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }
})();

// Two-tap confirm that stays on the page: first tap arms the button for a few
// seconds, the second tap does the thing.
window.armConfirm = function armConfirm(btn, armedText, action) {
  if (btn.dataset.armed === '1') {
    clearTimeout(btn._armTimer);
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.label;
    btn.classList.remove('is-armed');
    action();
    return;
  }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = armedText;
  btn.classList.add('is-armed');
  btn._armTimer = setTimeout(() => {
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.label;
    btn.classList.remove('is-armed');
  }, 3500);
};
