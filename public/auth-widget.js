/* ============================================================
   auth-widget.js (PJH Arena)
   ------------------------------------------------------------
   PJH-hub와 계정 저장소(pjh-auth Worker)를 공유하는 로그인/가입 UI.
   pjh-hub의 auth-widget.js와 같은 계정 API를 쓰므로 같은 아이디/비밀번호로
   로그인할 수 있지만, 세션(localStorage)은 도메인마다 따로 저장되므로
   pjh-hub에 로그인돼 있다고 Arena에도 자동 로그인되지는 않는다 — 계정만 공유,
   로그인 상태 자체는 사이트별로 별개(진짜 SSO는 아님).

   pjh-hub의 heartbeat/출석체크/친구초대 등은 pjh-hub 자체 게임화 시스템
   (forum Worker)에 속하는 기능이라 여기서는 일부러 가져오지 않았다 — Arena가
   그 기능들도 필요해지면 그때 논의해서 추가할 것.

   사용법: <script src="./auth-widget.js"></script>
   ============================================================ */

(function () {
  const AUTH_API = "https://pjh-auth.chaostatix.workers.dev";
  const SESSION_KEY = "pjh_session"; // { token, userId, realName } — pjh-hub와 같은 키 이름(도메인이 달라 공유는 안 되지만 이름은 맞춰둠)

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  // 세션 유효성 주기 검증 — 정지/만료된 세션 자동 로그아웃
  async function validateSession() {
    const session = getSession();
    if (!session || !session.token) return;
    try {
      const res = await fetch(AUTH_API + "/me", {
        headers: { Authorization: "Bearer " + session.token },
      });
      if (res.status === 401 || res.status === 403) {
        clearSession();
        updateAuthUI();
      }
    } catch (e) {}
  }

  window.PJHAuth = {
    getSession,
    setSession,
    clearSession,
    validateSession,
    API: AUTH_API,
  };

  // 백그라운드 탭에서는 건너뛰어 유휴 탭이 많아져도 pjh-auth Worker 부하가 쌓이지 않게 한다.
  setInterval(function () {
    if (document.visibilityState === "visible") validateSession();
  }, 30000);
  validateSession();

  // ── 아래는 로그인/가입 UI가 있는 페이지에서만 동작. DOM에 해당 요소가 없으면 조용히 종료. ──
  const loginNavBtn = document.getElementById("loginNavBtn");
  if (!loginNavBtn) return;

  const els = {
    loginNavBtn: document.getElementById("loginNavBtn"),
    logoutNavBtn: document.getElementById("logoutNavBtn"),
    authSection: document.getElementById("authSection"),
    authCloseBtn: document.getElementById("authCloseBtn"),
    authTabLogin: document.getElementById("authTabLogin"),
    authTabRegister: document.getElementById("authTabRegister"),
    authLoginForm: document.getElementById("authLoginForm"),
    authRegisterForm: document.getElementById("authRegisterForm"),
    loginId: document.getElementById("loginId"),
    loginPw: document.getElementById("loginPw"),
    loginErr: document.getElementById("loginErr"),
    loginBtn: document.getElementById("loginBtn"),
    regId: document.getElementById("regId"),
    regName: document.getElementById("regName"),
    regPw: document.getElementById("regPw"),
    regErr: document.getElementById("regErr"),
    registerBtn: document.getElementById("registerBtn"),
    userLabel: document.getElementById("userLabel"),
  };

  function updateAuthUI() {
    const session = getSession();
    if (session) {
      els.logoutNavBtn.style.display = "";
      els.loginNavBtn.style.display = "none";
      if (els.userLabel) { els.userLabel.textContent = session.realName || session.userId; els.userLabel.style.display = ""; }
      closeAuth();
    } else {
      els.logoutNavBtn.style.display = "none";
      els.loginNavBtn.style.display = "";
      if (els.userLabel) els.userLabel.style.display = "none";
    }
  }

  function openAuth() {
    els.authSection.style.display = "flex";
    document.body.style.overflow = "hidden";
  }
  function closeAuth() {
    els.authSection.style.display = "none";
    document.body.style.overflow = "";
  }

  els.loginNavBtn.addEventListener("click", function () {
    if (els.authSection.style.display === "flex") closeAuth();
    else openAuth();
  });
  if (els.authCloseBtn) els.authCloseBtn.addEventListener("click", closeAuth);
  els.authSection.addEventListener("click", function (e) {
    if (e.target === els.authSection) closeAuth();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && els.authSection.style.display === "flex") closeAuth();
  });

  els.authTabLogin.addEventListener("click", function () {
    els.authTabLogin.classList.add("active");
    els.authTabRegister.classList.remove("active");
    els.authLoginForm.style.display = "";
    els.authRegisterForm.style.display = "none";
  });
  els.authTabRegister.addEventListener("click", function () {
    els.authTabRegister.classList.add("active");
    els.authTabLogin.classList.remove("active");
    els.authRegisterForm.style.display = "";
    els.authLoginForm.style.display = "none";
  });

  // ── 로그인 실패 횟수 제한(클라이언트 측 UX 안전장치, 진짜 방어는 pjh-auth Worker 쪽) ──
  const LOGIN_RATE_KEY = "pjh_login_rate";
  const LOGIN_MAX_ATTEMPTS = 6;
  const LOGIN_LOCKOUT_MS = 60 * 1000;

  function getLoginRateState() {
    try {
      const raw = localStorage.getItem(LOGIN_RATE_KEY);
      return raw ? JSON.parse(raw) : { fails: 0, lockedUntil: 0 };
    } catch (e) {
      return { fails: 0, lockedUntil: 0 };
    }
  }
  function setLoginRateState(state) {
    try { localStorage.setItem(LOGIN_RATE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function clearLoginRateState() {
    try { localStorage.removeItem(LOGIN_RATE_KEY); } catch (e) {}
  }

  els.loginBtn.addEventListener("click", async function () {
    const userId = els.loginId.value.trim();
    const password = els.loginPw.value;
    els.loginErr.textContent = "";

    if (!userId || !password) {
      els.loginErr.textContent = "아이디와 비밀번호를 입력하세요.";
      return;
    }

    const rateState = getLoginRateState();
    const now = Date.now();
    if (rateState.lockedUntil && now < rateState.lockedUntil) {
      const secs = Math.ceil((rateState.lockedUntil - now) / 1000);
      els.loginErr.textContent = "로그인 시도가 너무 많습니다. " + secs + "초 후 다시 시도하세요.";
      return;
    }
    if (rateState.lockedUntil && now >= rateState.lockedUntil) {
      rateState.fails = 0;
      rateState.lockedUntil = 0;
    }

    els.loginBtn.disabled = true;
    els.loginBtn.textContent = "로그인 중...";

    try {
      const res = await fetch(AUTH_API + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        rateState.fails = (rateState.fails || 0) + 1;
        if (rateState.fails >= LOGIN_MAX_ATTEMPTS) {
          rateState.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
          rateState.fails = 0;
          els.loginErr.textContent = "로그인 실패가 너무 많습니다. 1분 후 다시 시도하세요.";
        } else {
          els.loginErr.textContent = data.error || "로그인에 실패했습니다.";
        }
        setLoginRateState(rateState);
        return;
      }
      clearLoginRateState();
      setSession({ token: data.token, userId: data.userId, realName: data.realName });
      els.loginId.value = "";
      els.loginPw.value = "";
      updateAuthUI();
    } catch (e) {
      els.loginErr.textContent = "네트워크 오류가 발생했습니다.";
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = "로그인";
    }
  });

  // ── 가입 Rate Limiting (localStorage 기반) ──
  const REG_RATE_KEY = "pjh_reg_rate";
  const REG_COOLDOWN_MS = 60 * 1000;
  const REG_MAX_PER_HOUR = 6;

  function checkRegRate() {
    try {
      const raw = localStorage.getItem(REG_RATE_KEY);
      const data = raw ? JSON.parse(raw) : { attempts: [], last: 0 };
      const now = Date.now();
      data.attempts = (data.attempts || []).filter(function (t) { return now - t < 3600000; });

      if (data.last && now - data.last < REG_COOLDOWN_MS) {
        const secs = Math.ceil((REG_COOLDOWN_MS - (now - data.last)) / 1000);
        return { ok: false, msg: secs + "초 후에 다시 시도하세요." };
      }
      if (data.attempts.length >= REG_MAX_PER_HOUR) {
        return { ok: false, msg: "1시간에 최대 " + REG_MAX_PER_HOUR + "번만 가입을 시도할 수 있습니다." };
      }
      return { ok: true, data };
    } catch (e) {
      return { ok: true, data: { attempts: [], last: 0 } };
    }
  }

  function recordRegAttempt(data) {
    try {
      const now = Date.now();
      data.attempts.push(now);
      data.last = now;
      localStorage.setItem(REG_RATE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  els.registerBtn.addEventListener("click", async function () {
    const userId = els.regId.value.trim();
    const realName = els.regName.value.trim();
    const password = els.regPw.value;
    els.regErr.style.color = "";
    els.regErr.textContent = "";

    if (!userId || !realName || !password) {
      els.regErr.textContent = "모든 항목을 입력하세요.";
      return;
    }

    const rateCheck = checkRegRate();
    if (!rateCheck.ok) {
      els.regErr.textContent = rateCheck.msg;
      return;
    }

    els.registerBtn.disabled = true;
    els.registerBtn.textContent = "가입 중...";
    recordRegAttempt(rateCheck.data);

    try {
      const res = await fetch(AUTH_API + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, realName, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        els.regErr.textContent = data.error || "가입에 실패했습니다.";
        return;
      }
      els.regErr.style.color = "#6c6";
      els.regErr.textContent = "가입 완료! 로그인해주세요.";
      els.loginId.value = userId;
      els.authTabLogin.click();
    } catch (e) {
      els.regErr.textContent = "네트워크 오류가 발생했습니다.";
    } finally {
      els.registerBtn.disabled = false;
      els.registerBtn.textContent = "가입하기";
    }
  });

  els.logoutNavBtn.addEventListener("click", async function () {
    const session = getSession();
    if (session) {
      try {
        await fetch(AUTH_API + "/logout", {
          method: "POST",
          headers: { Authorization: "Bearer " + session.token },
        });
      } catch (e) {}
    }
    clearSession();
    updateAuthUI();
  });

  updateAuthUI();
})();
