// UI glue for the home page and live game screen.
// Runs after the main inline script, so it can use its top-level helpers
// (navigateTo, joinPublicGame, updateNavUserState, myUserId, ...).
(function () {
  const $ = (id) => document.getElementById(id);

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

      window.allowBotFill = true; // guests get a bot if no rival shows up
      await joinPublicGame();
    } catch (err) {
      console.error('[guest] Could not start a guest game:', err);
      setGuestError("Guest play isn't available right now. Log in or sign up to play.");
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (label) label.textContent = labelText;
    }
  }

  $('playGuestBtn')?.addEventListener('click', playAsGuest);

  // ---- Keep the game screen inside the visible area ----------------------
  // On phones the on-screen keyboard covers the bottom of the page. Track the
  // visible height so the guess box stays on screen and nothing needs scrolling.
  function syncViewport() {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', height + 'px');
    document.documentElement.style.setProperty('--app-top', (vv ? vv.offsetTop : 0) + 'px');
    document.body.classList.toggle('kb-open', !!vv && vv.height < window.innerHeight * 0.78);
  }

  syncViewport();
  window.addEventListener('resize', syncViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }
})();
