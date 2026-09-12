/* ============================================================
   arena.js — PJH Arena 대시보드 클라이언트 로직
   ============================================================ */
(function () {
  const ARENA_API = "https://arena.chaostatix.workers.dev";
  const FORUM_API = "https://forum.chaostatix.workers.dev";

  // 서버 RARITY_ORDER와 동일 순서(낮은 등급→높은 등급) — 봇 카드의 "대표 등급"을 고를 때만 씀.
  const RARITY_ORDER_CLIENT = ["common", "uncommon", "rare", "epic", "legendary", "mythic", "secret", "forbidden", "abyssal"];

  const JOB_META = {
    trivial:   { label: "TRIVIAL",   icon: "📶" },
    low:       { label: "LOW",       icon: "📡" },
    guarded:   { label: "GUARDED",   icon: "🔒" },
    medium:    { label: "MEDIUM",    icon: "🛰️" },
    corporate: { label: "CORPORATE", icon: "🏢" },
    high:      { label: "HIGH",      icon: "🖥️" },
    fortress:  { label: "FORTRESS",  icon: "🏰" },
    master:    { label: "MASTER",    icon: "🧠" },
    apex:      { label: "APEX",      icon: "🌐" },
    legendary: { label: "LEGENDARY", icon: "👑" },
    mythic:    { label: "MYTHIC",    icon: "🧬" },
    secret:    { label: "SECRET",    icon: "🗝️" },
    forbidden: { label: "FORBIDDEN", icon: "☠️" },
    abyssal:   { label: "ABYSSAL",   icon: "🕳️" },
    voidwalker:  { label: "VOIDWALKER",  icon: "🌌" },
    singularity: { label: "SINGULARITY", icon: "🌀" },
    omega:       { label: "OMEGA",       icon: "🌑" },
    genesis:     { label: "GENESIS",     icon: "🌠" },
  };
  // 서버 상수와 동일한 값(표시용) — 실제 검증/보상 롤은 항상 서버에서 다시 계산한다.
  // energyCost는 "그 작업의 필요 레벨까지 누적 스탯 포인트의 1/6"로 재계산됨(요청 반영).
  const JOB_TIERS = {
    trivial:   { minLevel: 1,  energyCost: 1,    coinMin: 600,   coinMax: 900,   xp: 8 },
    low:       { minLevel: 1,  energyCost: 1,    coinMin: 1500,  coinMax: 2250,  xp: 15 },
    guarded:   { minLevel: 3,  energyCost: 3,    coinMin: 2700,  coinMax: 3750,  xp: 25 },
    medium:    { minLevel: 5,  energyCost: 4,    coinMin: 3750,  coinMax: 5250,  xp: 35 },
    corporate: { minLevel: 8,  energyCost: 7,    coinMin: 6000,  coinMax: 8250,  xp: 55 },
    high:      { minLevel: 10, energyCost: 8,    coinMin: 7500,  coinMax: 10500, xp: 70 },
    fortress:  { minLevel: 15, energyCost: 14,   coinMin: 10500, coinMax: 14250, xp: 95 },
    master:    { minLevel: 20, energyCost: 20,   coinMin: 13500, coinMax: 19500, xp: 120 },
    apex:      { minLevel: 28, energyCost: 32,   coinMin: 22500, coinMax: 30000, xp: 180 },
    legendary: { minLevel: 35, energyCost: 44,   coinMin: 37500,  coinMax: 51000,  xp: 260 },
    mythic:    { minLevel: 45,  energyCost: 64,  coinMin: 60000,  coinMax: 82500,  xp: 380 },
    secret:    { minLevel: 60,  energyCost: 100, coinMin: 108000, coinMax: 150000, xp: 610 },
    forbidden: { minLevel: 75,  energyCost: 144, coinMin: 200000, coinMax: 275000, xp: 1000 },
    abyssal:   { minLevel: 100, energyCost: 233, coinMin: 395000, coinMax: 545000, xp: 1850 },
    voidwalker:  { minLevel: 150, energyCost: 475,  coinMin: 830000,  coinMax: 1165000, xp: 3950 },
    singularity: { minLevel: 200, energyCost: 800,  coinMin: 1650000, coinMax: 2285000, xp: 7750 },
    omega:       { minLevel: 250, energyCost: 1208, coinMin: 3055000, coinMax: 4230000, xp: 14400 },
    genesis:     { minLevel: 300, energyCost: 1700, coinMin: 5445000, coinMax: 7530000, xp: 25600 },
  };

  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function $(id) { return document.getElementById(id); }

  function session() { return window.PJHAuth ? window.PJHAuth.getSession() : null; }
  function authHeaders() {
    const s = session();
    return s ? { Authorization: "Bearer " + s.token } : {};
  }

  async function api(path, opts) {
    const res = await fetch(ARENA_API + path, {
      method: (opts && opts.method) || "GET",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
    return data;
  }

  let state = null;
  let dashboardStarted = false;

  function toast(message, isError) {
    const el = document.createElement("div");
    el.className = "arena-toast" + (isError ? " err" : "");
    el.textContent = message;
    $("toastLayer").appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 3200);
  }

  // ── 대시보드 진입점 — 로그인 상태 변화를 감시하다가 로그인되면 시작 ──
  function watchLogin() {
    setInterval(() => {
      const s = session();
      if (s && !dashboardStarted) startDashboard();
      if (!s && dashboardStarted) stopDashboard();
    }, 800);
  }

  function stopDashboard() {
    dashboardStarted = false;
    state = null;
    firstStateLoaded = false;
    $("appShell").style.display = "none";
    $("loggedOutHint").style.display = "";
  }

  async function startDashboard() {
    dashboardStarted = true;
    $("appShell").style.display = "flex"; // appShell은 CSS 기본값이 없어 ""로는 인라인 display:none이 안 지워짐
    $("loggedOutHint").style.display = "none";
    await refreshState();
    refreshWidgetBar();
    renderTab(currentTab);
    checkActivitySummary();
    if (!startDashboard._timer) {
      startDashboard._timer = setInterval(refreshState, 15000);
      setInterval(refreshWidgetBar, 60000);
    }
  }

  // ── 오프라인 활동 요약 — 세션당(대시보드 진입마다) 한 번만 확인한다. 서버가 조회 즉시
  // "확인 처리"(last_activity_summary_at 갱신)까지 같이 하므로, 여기서 또 ack할 필요가 없다.
  // 아무 일도 없었으면(hasActivity: false) 조용히 넘어가고 모달을 안 띄운다.
  async function checkActivitySummary() {
    try {
      const r = await api("/activity-summary");
      if (!r.hasActivity) return;
      const rows = [];
      if (r.pvpDefendLossCount > 0) rows.push('<div class="activity-row"><span>⚔️ PvP로 당함 ' + r.pvpDefendLossCount + "회</span><span>-" + fmt(r.pvpCoinsLost) + " 코인</span></div>");
      if (r.planetLostCount > 0) rows.push('<div class="activity-row"><span>🌍 행성 침투당함 ' + r.planetLostCount + "회</span><span>-" + fmt(r.planetCoinsLost) + " 코인</span></div>");
      $("activityModalBody").innerHTML = rows.join("") +
        '<div class="activity-row" style="border-bottom:none;font-weight:bold;"><span>총 손실</span><span>-' + fmt(r.totalCoinsLost) + " 코인</span></div>";
      $("activityModal").style.display = "flex";
    } catch (e) { /* 조용히 무시 — 다음 로그인 때 다시 시도 */ }
  }

  let firstStateLoaded = false;
  async function refreshState() {
    try {
      state = await api("/state");
      renderHeader();
      // 최초 로드가 실패했다가 나중 폴링에서 성공한 경우를 대비 — 탭 내용이 계속 빈 채로
      // 남지 않도록, state가 처음 채워진 시점에 한 번 더 현재 탭을 그려준다.
      if (!firstStateLoaded) { firstStateLoaded = true; renderTab(currentTab); }
    } catch (e) { /* 세션 만료 등 — 다음 틱에서 자동 로그아웃 처리됨 */ }
  }

  function renderHeader() {
    if (!state) return;
    // PJH-Hub에서 산 아바타(있을 때만) — /state 응답에만 실려온다(다른 액션 응답엔 없음).
    if (state.avatarIcon) { $("avatarIcon").textContent = state.avatarIcon; $("avatarIcon").style.display = ""; }
    else if (state.avatarIcon === null) { $("avatarIcon").style.display = "none"; }
    $("levelBadge").textContent = state.level;
    $("expBar").style.width = Math.min(100, (state.xp / state.nextExp) * 100) + "%";
    $("expText").textContent = fmt(state.xp) + " / " + fmt(state.nextExp) + (state.expBoosterMult > 1 ? " (🧪x" + state.expBoosterMult + ")" : "");
    $("pocketCoinsHead").textContent = fmt(state.pocketCoins);

    $("hpBar").style.width = (state.hp / state.maxHp) * 100 + "%";
    $("hpText").textContent = state.hp + " / " + state.maxHp;
    $("energyBar").style.width = (state.energy / state.maxEnergy) * 100 + "%";
    $("energyText").textContent = state.energy + " / " + state.maxEnergy;
    $("staminaBar").style.width = (state.stamina / state.maxStamina) * 100 + "%";
    $("staminaText").textContent = state.stamina + " / " + state.maxStamina;

    // 완전 회복까지 남은 시간 — 서버가 매 /state마다 다시 계산해서 내려주는 ms를 절대 시각으로
    // 바꿔 저장해 두고, 1초마다 로컬에서 카운트다운만 갱신한다(그래야 폴링 사이에도 매끄럽게 줄어듦).
    const now = Date.now();
    hpFullAt = state.hpFullInMs <= 0 ? 0 : now + state.hpFullInMs; // HP도 이제 다운 상태에서 자연 회복됨
    energyFullAt = state.energyFullInMs <= 0 ? 0 : now + state.energyFullInMs;
    staminaFullAt = state.staminaFullInMs <= 0 ? 0 : now + state.staminaFullInMs;
    renderResourceEtas();

    $("atkText").textContent = state.atk;
    $("defText").textContent = state.def;
    $("critText").textContent = state.crit;
    $("shieldTag").style.display = state.shielded ? "" : "none";

    // 칭호 — 업적을 청구하면 골라 장착할 수 있다(Achievements 탭). 등급별 색/아우라는
    // 리더보드·PvP와 같은 titleBadgeHtml을 재사용(요청 반영: 전부 통일된 효과).
    const titleTag = $("titleTag");
    if (state.equippedTitle) {
      titleTag.innerHTML = "🏷️ " + titleBadgeHtml(state.equippedTitle, state.equippedTitleColor, state.equippedTitleRarity);
      titleTag.style.display = "";
    } else titleTag.style.display = "none";

    // 환생 — 회당 ATK/DEF 영구 +1%(최대 10회), 레벨 100부터 버튼이 활성화된다. 등급(브론즈~
    // 무지개)은 tier-N 클래스로 표시색을 바꾼다(rebirthTier 참고, 서버와 동일한 계단식).
    const rebirthTag = $("rebirthTag"), rebirthBtn = $("rebirthBtn");
    if (state.rebirthCount > 0) {
      const tierName = REBIRTH_TIER_NAMES[state.rebirthTier] || "";
      rebirthTag.textContent = "🔄 환생 " + toRoman(state.rebirthCount) + (tierName ? " · " + tierName : "") + " (전투력 +" + state.rebirthBonusPct.toFixed(0) + "%)";
      rebirthTag.className = "rebirth-tag tier-" + state.rebirthTier;
      rebirthTag.style.display = "";
    } else rebirthTag.style.display = "none";
    if (state.rebirthReady) { rebirthBtn.style.display = ""; rebirthBtn.disabled = false; }
    else if (state.level >= state.rebirthLevelRequirement - 20) { rebirthBtn.style.display = ""; rebirthBtn.disabled = true; rebirthBtn.textContent = "🔄 환생 (Lv." + state.rebirthLevelRequirement + " 필요)"; }
    else rebirthBtn.style.display = "none";
    if (state.rebirthReady) rebirthBtn.textContent = "🔄 환생하기";

    // 환생 마스터(10회) 전용 사이트 테마 — 본인이 프로필 탭에서 끄지 않은 이상 자동 적용.
    document.body.classList.toggle("theme-ascended", !!(state.maxThemeUnlocked && state.maxThemeEnabled));

    // 관리자 테스트 계정에게만 Admin 탭을 보여준다.
    $("adminTabBtn").style.display = state.isAdmin ? "" : "none";

    // 코인/XP 2배 부스트 — 환생 직후 30분, 출석+오늘의 미션 전부 완료 20분. 둘 다 같은
    // 배지 하나를 공유하고(둘 중 더 늦게 끝나는 시각 기준), 남은 시간은 renderResourceEtas의
    // 1초 타이머가 갱신한다.
    boostUntilAt = Math.max(state.rebirthBoostActive ? state.rebirthBoostUntil : 0, state.dailyBoostActive ? state.dailyBoostUntil : 0);
    // 전역 이벤트(GM이 켠 기간 한정 코인·EXP 2배) — 개인 부스트와 별개의 상단 배너, 며칠 단위라
    // 남은 시간 표기도 fmtLongCountdown(일/시간 단위)을 따로 쓴다.
    globalEventEndAt = state.globalEventActive ? state.globalEventEndAt : 0;
    // 주의: #globalEventBanner의 CSS 기본값이 display:none이라 ""로 지우면 그 기본값으로
    // 되돌아갈 뿐 안 보인다(.tab-panel/downedBanner와 똑같은 함정) — 반드시 "block"으로 명시.
    $("globalEventBanner").style.display = state.globalEventActive ? "block" : "none";
    // 긴급 정지 배너 — 관리자가 켜면 모두에게(관리자 본인 포함) 즉시 보인다. 같은 함정이라 "block" 명시.
    $("economyFrozenBanner").style.display = state.economyFrozen ? "block" : "none";
    renderResourceEtas();

    $("statPointsText").textContent = state.statPoints;
    $("statPointsTag").style.display = state.statPoints > 0 ? "" : "none";
    $("upgradeHpBtn").disabled = state.statPoints <= 0;
    $("upgradeEnergyBtn").disabled = state.statPoints <= 0;
    $("upgradeStaminaBtn").disabled = state.statPoints <= 0;

    if (state.hp <= 0) $("downedBanner").style.display = "block"; // .tab-panel과 동일한 함정: ""는 CSS의 display:none으로 되돌아감
    else $("downedBanner").style.display = "none";
  }

  // ── 스탯 강화 — 헤더의 + 버튼을 누르면 바로 강화하는 대신, 세 스탯 전부의 "현재값 → 강화 시
  //    얼마나 느는지 → 필요 포인트"를 한눈에 보여주는 모달을 띄운다. 정확한 비용은 서버가 항상
  //    다시 계산해서 검증하므로, 여기 클라이언트 쪽 계산은 어디까지나 "미리보기"용이다. ──
  const STAT_DEFS = [
    { key: "hp",      label: "HP",      current: (s) => s.maxHp,      increment: 20, base: 100 },
    { key: "energy",  label: "ENERGY",  current: (s) => s.maxEnergy,  increment: 10, base: 50 },
    { key: "stamina", label: "STAMINA", current: (s) => s.maxStamina, increment: 2,  base: 10 },
  ];
  // 서버 statUpgradeCost와 동일한 공식(상한 없이 계속 증가) — 예전엔 5에서 상한이 걸려서
  // 5배를 넘긴 뒤로는 여기서도 계속 "5P"라고만 떴었다(요청 반영: 그 표기 수정).
  function statUpgradeCostPreview(base, current) {
    return Math.max(2, Math.floor(current / base));
  }

  function renderStatModal() {
    if (!state) return;
    const body = $("statModalBody");
    body.innerHTML =
      '<p class="stat-points-avail">보유 포인트: <b style="color:var(--stamina);font-size:14px;">' + state.statPoints + "</b></p>" +
      STAT_DEFS.map((d) => {
        const current = d.current(state);
        const cost = statUpgradeCostPreview(d.base, current);
        const canAfford = state.statPoints >= cost;
        // 일괄 강화 — "+50 이렇게 일괄로도 할 수 있게" 요청 반영. +1/+10/+50/MAX 버튼을
        // 나란히 두고, 실제 몇 회가 적용됐는지는 서버가 돌려주는 applied로 정확히 알려준다
        // (포인트가 중간에 떨어지면 그만큼만 적용되고 나머지는 자동으로 무시됨).
        const qtyButtons = [1, 10, 50].map((n) =>
          '<button data-upgrade-stat="' + d.key + '" data-qty="' + n + '"' + (canAfford ? "" : " disabled") + ">+" + n + "</button>"
        ).join("") + '<button data-upgrade-stat="' + d.key + '" data-qty="max"' + (canAfford ? "" : " disabled") + ">MAX</button>";
        return (
          '<div class="stat-upgrade-row">' +
          '<span class="stat-upgrade-label">' + d.label + "</span>" +
          '<span class="stat-upgrade-value">' + current + " → <b>" + (current + d.increment) + "</b> (+" + d.increment + ")</span>" +
          '<span class="stat-upgrade-cost">' + cost + "P</span>" +
          '<div class="stat-upgrade-qty-row">' + qtyButtons + "</div>" +
          "</div>"
        );
      }).join("");
    body.querySelectorAll("button[data-upgrade-stat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const qty = btn.dataset.qty === "max" ? 1000 : parseInt(btn.dataset.qty, 10);
        try {
          const r = await api("/stats/upgrade", { method: "POST", body: { stat: btn.dataset.upgradeStat, qty: qty } });
          toast("스탯 강화 완료! (" + r.applied + "회, -" + r.cost + " 포인트)");
          state = r.state; renderHeader(); renderStatModal();
        } catch (e) { toast(e.message, true); btn.disabled = false; }
      });
    });
  }

  function openStatModal() {
    renderStatModal();
    $("statModal").style.display = "flex";
  }

  function initStatButtons() {
    $("upgradeHpBtn").addEventListener("click", openStatModal);
    $("upgradeEnergyBtn").addEventListener("click", openStatModal);
    $("upgradeStaminaBtn").addEventListener("click", openStatModal);
    $("statModalClose").addEventListener("click", () => { $("statModal").style.display = "none"; });
    $("statModal").addEventListener("click", (e) => { if (e.target.id === "statModal") $("statModal").style.display = "none"; });
  }

  // ── 상단 통합 위젯 바 — 게임/사이트 관련 지표만(시세 위젯은 제외). PJH-Hub의 공개 프로필 API를
  //    프론트에서 직접 호출한다(백엔드 경유 없음). ──
  async function refreshWidgetBar() {
    const s = session();
    if (!s) return;
    try {
      const res = await fetch(FORUM_API + "/profile/" + encodeURIComponent(s.userId));
      if (res.ok) {
        const p = await res.json();
        $("wXp").textContent = fmt(p.xp);
        $("wCoins").textContent = fmt(p.coins);
        $("wStreak").textContent = p.attendanceStreak + "일";
      }
    } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════
  //  탭 전환
  // ══════════════════════════════════════════════════════════
  let currentTab = "jobs";
  const TAB_RENDERERS = {
    jobs: renderJobsTab,
    galaxy: renderGalaxyTab,
    pvp: renderPvpTab,
    shop: renderShopTab,
    bots: renderBotsTab,
    inventory: renderInventoryTab,
    property: renderPropertyTab,
    bank: renderBankTab,
    research: renderResearchTab,
    enchant: renderEnchantTab,
    rebirthshop: renderRebirthShopTab,
    bounty: renderBountyTab,
    trade: renderTradeTab,
    club: renderClubTab,
    profile: renderProfileTab,
    admin: renderAdminTab,
    achievements: renderAchievementsTab,
    leaderboard: renderLeaderboardTab,
    logs: renderLogsTab,
  };

  function initTabs() {
    document.querySelectorAll(".side-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".side-tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentTab = btn.dataset.tab;
        renderTab(currentTab);
      });
    });
  }

  function renderTab(tab) {
    if (!dashboardStarted) return;
    document.querySelectorAll(".tab-panel").forEach((p) => { p.style.display = "none"; });
    const panel = $("panel-" + tab);
    // .tab-panel의 CSS 기본값이 display:none이라, 인라인 스타일을 ""로 지우면 그 기본값으로
    // "되돌아갈 뿐"이라 계속 숨겨진 채로 남는다(실제로 겪은 버그) — 반드시 명시적으로 "block".
    if (panel) panel.style.display = "block";
    const fn = TAB_RENDERERS[tab];
    if (fn) fn();
  }

  // ── ① Hacking Jobs ──
  function renderJobsTab() {
    if (!state) return; // /state 조회가 아직 안 끝났거나 실패한 경우 — 다음 refreshState 성공 시 재호출됨
    renderDailyWidget();
    const panel = $("panel-jobs");
    const cards = Object.keys(JOB_TIERS).map((tier) => {
      const t = JOB_TIERS[tier], meta = JOB_META[tier];
      const locked = state.level < t.minLevel;
      const noEnergy = state.energy < t.energyCost;
      return (
        '<div class="job-card' + (locked ? " locked" : "") + '">' +
        '<div class="job-card-icon">' + meta.icon + "</div>" +
        '<div class="job-card-title">' + meta.label + "</div>" +
        '<div class="job-card-sub">필요 Lv.' + t.minLevel + " · 에너지 " + t.energyCost + "</div>" +
        '<div class="job-card-reward">💰 ' + fmt(t.coinMin) + " ~ " + fmt(t.coinMax) + '</div>' +
        '<div class="job-card-reward">⚡ EXP +' + t.xp + "</div>" +
        '<button class="btn-primary" data-tier="' + tier + '"' + (locked || noEnergy ? " disabled" : "") + ">" +
        (locked ? "LV." + t.minLevel + " 필요" : noEnergy ? "에너지 부족" : "실행") +
        "</button></div>"
      );
    }).join("");
    panel.querySelector(".job-grid").innerHTML = cards;
    panel.querySelectorAll("button[data-tier]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const r = await api("/hack-job", { method: "POST", body: { tier: btn.dataset.tier } });
          toast((r.boosted ? "🔥 " : "") + "💰 +" + fmt(r.coinsGained) + " 코인 · EXP +" + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : ""));
          state = r.state; renderHeader(); renderJobsTab(); renderMiningGraph();
        } catch (e) { toast(e.message, true); }
        finally { btn.disabled = false; }
      });
    });
    renderMiningGraph();
  }

  // ── 오늘의 출석/미션 — Hacking Jobs 탭 맨 위에 둬서(가장 먼저 보는 탭) 매일 들어올 이유를
  // 만든다. 출석/미션 수령 버튼은 위젯 자체에 위임(#dailyWidget)해서 매번 새로 그려도 리스너가
  // 중복으로 안 쌓이게 했다. ──
  async function renderDailyWidget() {
    const el = $("dailyWidget");
    if (!el) return;
    try {
      const d = await api("/daily");
      const attendBtn = d.attendedToday
        ? '<button class="btn-ghost" disabled>오늘 출석 완료</button>'
        : '<button class="btn-primary" id="dailyAttendBtn">출석하기 (💰' + fmt(d.nextReward) + ")</button>";
      el.innerHTML =
        '<div class="daily-widget-row"><span>📅 연속 출석 <b style="color:var(--stamina);">' + d.streak + "일</b></span>" + attendBtn + "</div>" +
        Object.keys(d.quests).map((key) => {
          const q = d.quests[key];
          const btn = q.claimed
            ? '<span class="dim">수령 완료</span>'
            : q.ready
            ? '<button class="btn-primary" data-quest-claim="' + key + '">받기 (💰' + fmt(q.reward) + ")</button>"
            : '<span class="daily-quest-progress">' + q.done + " / " + q.goal + "</span>";
          return '<div class="daily-quest-row"><span>' + escapeHtml(q.label) + "</span>" + btn + "</div>";
        }).join("");
    } catch (e) { el.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  function initDailyButtons() {
    const el = $("dailyWidget");
    if (!el) return;
    el.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.id === "dailyAttendBtn") {
        t.disabled = true;
        try {
          const r = await api("/daily/attendance", { method: "POST" });
          toast("출석 완료! +" + fmt(r.reward) + " 코인 · EXP +" + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : "") + " (연속 " + r.streak + "일)");
          if (r.dailyBoostGranted) {
            toast("🔥 출석 + 오늘의 미션 전부 완료! 20분간 코인·XP 2배!");
          }
          await refreshState(); renderDailyWidget();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.dataset.questClaim) {
        t.disabled = true;
        try {
          const r = await api("/daily/quest-claim", { method: "POST", body: { quest: t.dataset.questClaim } });
          toast("미션 완료! +" + fmt(r.reward) + " 코인 · EXP +" + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : ""));
          if (r.dailyBoostGranted) {
            toast("🔥 출석 + 오늘의 미션 전부 완료! 20분간 코인·XP 2배!");
          }
          await refreshState(); renderDailyWidget();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      }
    });
  }

  async function renderMiningGraph() {
    try {
      const { logs } = await api("/logs?kind=job");
      const canvas = $("miningCanvas");
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const points = logs.slice(0, 12).reverse().map((l) => l.coins_delta);
      if (!points.length) return;
      const max = Math.max(...points, 1);
      ctx.strokeStyle = "#00ff9d"; ctx.lineWidth = 2; ctx.beginPath();
      points.forEach((v, i) => {
        const x = (i / Math.max(1, points.length - 1)) * (w - 10) + 5;
        const y = h - 5 - (v / max) * (h - 15);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      points.forEach((v, i) => {
        const x = (i / Math.max(1, points.length - 1)) * (w - 10) + 5;
        const y = h - 5 - (v / max) * (h - 15);
        ctx.fillStyle = "#00ff9d"; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      });
    } catch (e) {}
  }

  // ── ② Arena P2P ──
  async function renderPvpTab() {
    if (!state) return;
    const panel = $("panel-pvp");
    const listEl = panel.querySelector(".pvp-list");
    listEl.innerHTML = '<p class="dim">타겟 스캔 중...</p>';
    try {
      const { targets, shieldBreakerUnlocked, shieldBreakerReadyAt } = await api("/arena/targets");
      if (!targets.length) { listEl.innerHTML = '<p class="dim">현재 공격 가능한 대상이 없습니다.</p>'; return; }
      const breakerReady = shieldBreakerUnlocked && shieldBreakerReadyAt <= Date.now();
      listEl.innerHTML = targets.map((t) => {
        // 지금 당장 공격은 못 해도(보호막/다운/한도 초과) 목록에서 사라지진 않는다 — 이유만 표시.
        // 레벨 차이는 이제 공격을 막지 않는다 — ±10 넘으면 스태미나만 더 들어서 배지로만 알려준다.
        const statusNote = t.shielded ? '<span style="color:var(--cyan);"> 🛡️ 보호막 중</span>'
          : t.downed ? '<span style="color:var(--danger);"> 💀 다운 상태</span>'
          : t.levelGapHigh ? '<span style="color:var(--stamina);"> ⚠️ 레벨차 큼(스태미나 ↑)</span>' : "";
        const attackDisabled = state.stamina < t.staminaCost || !t.attackable;
        const attackLabel = t.shielded ? "보호막" : t.downed ? "다운" : t.attackCapped ? "한도 도달" : "ATTACK";
        // 보호막 파쇄기(연구 해금 시) — 지금 보호막 중인 상대에게만 노출된다. 파쇄기 자체
        // 쿨타임(24시간) 중이면 버튼은 보이되 비활성화된다.
        const breakerBtn = (t.shielded && shieldBreakerUnlocked)
          ? '<button class="btn-ghost" data-break="' + t.userId + '"' + (breakerReady ? "" : " disabled") + ' title="10분간 상대의 보호막 재사용을 막습니다(파쇄기 쿨타임 24시간)">' + (breakerReady ? "💥 파쇄" : "💥 대기중") + "</button>"
          : "";
        // 이름 주변 아우라/파티클 — 레벨/환생 횟수/장착 무기 등급 중 가장 높은 걸로 서버가
        // 판정한 auraTier를 그대로 시각화(요청 반영). 평범한 상대는 기존과 완전히 동일.
        // 칭호 배지/환생 표기는 리더보드와 완전히 같은 함수(titleBadgeHtml/rebirthBadgeHtml)를
        // 써서 통일했다(요청 반영: "리더보드랑 P2P 이름 효과 통일해줘").
        const nameHtml = window.auraNameHtml ? auraNameHtml(escapeHtml(t.realName), t.auraColor, t.auraTier) : escapeHtml(t.realName);
        const titleHtml = titleBadgeHtml(t.title, t.titleColor, t.titleRarity);
        const rebirthNote = rebirthBadgeHtml(t.rebirthCount);
        return (
        '<div class="pvp-row">' +
        '<div class="pvp-name">' + titleHtml + nameHtml + rebirthNote + '<span class="dim"> Lv.' + t.level + "</span> " +
        (t.online ? '<span style="color:var(--energy);">● ONLINE</span>' : '<span class="dim">○ OFFLINE' + (t.offlinePendingCoins > 0 ? ' <span style="color:var(--stamina);">(+' + fmt(t.offlinePendingCoins) + ' 대기수익)</span>' : '') + "</span>") + statusNote + "</div>" +
        '<div class="pvp-stat">DEF ' + t.def + "</div>" +
        '<div class="pvp-stat">승률 ' + t.estimatedVictoryPct + "% <span class=\"dim\">(" + t.attacksUsedToday + "/" + t.attacksMaxPerDay + ")</span></div>" +
        '<div class="pvp-stat">⚡' + t.staminaCost + "</div>" +
        '<button class="btn-ghost" data-scan="' + t.userId + '">SCAN</button>' +
        breakerBtn +
        '<button class="btn-danger" data-attack="' + t.userId + '"' + (attackDisabled ? " disabled" : "") + ">" + attackLabel + "</button>" +
        "</div>"
        );
      }).join("");
      listEl.querySelectorAll("button[data-scan]").forEach((btn) => {
        btn.addEventListener("click", () => openScanModal(btn.dataset.scan));
      });
      listEl.querySelectorAll("button[data-attack]").forEach((btn) => {
        const t = targets.find((x) => x.userId === btn.dataset.attack);
        btn.addEventListener("click", () => openAttackSequence(t));
      });
      listEl.querySelectorAll("button[data-break]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/arena/shield-breaker", { method: "POST", body: { targetUserId: btn.dataset.break } });
            toast("💥 " + r.targetName + "의 보호막을 파쇄했습니다! (10분간 재사용 불가)");
            renderPvpTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { listEl.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  async function openScanModal(targetUserId) {
    try {
      const r = await api("/arena/scan", { method: "POST", body: { targetUserId } });
      state = r.state; renderHeader(); // 정찰도 이제 스태미나 1을 쓴다 — 헤더 수치 바로 반영
      const scanNameHtml = window.auraNameHtml ? auraNameHtml(escapeHtml(r.realName), r.auraColor, r.auraTier) : escapeHtml(r.realName);
      const scanTitleHtml = titleBadgeHtml(r.title, r.titleColor, r.titleRarity);
      $("scanModalBody").innerHTML =
        "<h3>🔎 PRACTICE SCAN — " + scanTitleHtml + scanNameHtml + " (Lv." + r.level + ")" + rebirthBadgeHtml(r.rebirthCount) + "</h3>" +
        '<div class="scan-row">상태 <b>' + (r.online ? "🟢 온라인" : "⚪ 오프라인") + "</b></div>" +
        (r.online ? "" : '<div class="scan-row">대기 중인 Property 수익 <b style="color:var(--stamina);">+' + fmt(r.offlinePendingCoins) + "</b></div>") +
        '<div class="scan-row">최근 태세 <b>' + (r.lastStanceLabel || "정보 없음") + "</b></div>" +
        '<div class="scan-row">내 ATK <b>' + r.myAtk + "</b></div>" +
        '<div class="scan-row">상대 DEF <b>' + r.def + "</b></div>" +
        '<div class="scan-row">공격 시 소모 스태미나 <b' + (r.levelGapHigh ? ' style="color:var(--stamina);"' : '') + '>' + r.staminaCost + (r.levelGapHigh ? " (레벨차 큼)" : "") + "</b></div>" +
        '<div class="scan-row">공격 횟수(최근 8시간 내) <b' + (r.attackCapped ? ' style="color:var(--danger);"' : '') + '>' + r.attacksUsedToday + " / " + r.attacksMaxPerDay + "</b></div>" +
        '<div class="scan-winrate">예상 승률<br><span>' + r.estimatedVictoryPct + "%</span></div>" +
        '<p class="dim" style="text-align:center;margin-top:8px;">(정찰 비용: 스태미나 ' + r.scanStaminaCost + ')</p>' +
        (r.shielded && r.shieldBreakerUnlocked
          ? '<button class="btn-primary" id="scanBreakShieldBtn" style="width:100%;margin-top:8px;"' + (r.shieldBreakerReadyAt > Date.now() ? " disabled" : "") + '>' +
            (r.shieldBreakerReadyAt > Date.now() ? "💥 보호막 파쇄기 쿨타임 중" : "💥 보호막 파쇄") + "</button>"
          : "");
      $("scanModal").style.display = "flex";
      const breakBtn = $("scanBreakShieldBtn");
      if (breakBtn) breakBtn.addEventListener("click", async () => {
        breakBtn.disabled = true;
        try {
          const br = await api("/arena/shield-breaker", { method: "POST", body: { targetUserId } });
          toast("💥 " + br.targetName + "의 보호막을 파쇄했습니다! (10분간 재사용 불가)");
          $("scanModal").style.display = "none";
          renderPvpTab();
        } catch (e) { toast(e.message, true); breakBtn.disabled = false; }
      });
    } catch (e) { toast(e.message, true); }
  }

  // ── Galaxy Map — 48개 야생 행성을 한 화면에 다 쏟아내면 뭘 해야 할지 알기 어렵다는 피드백이
  //    있어서, "내 제국"(홈 + 이미 정복한 행성)과 "정복 대상"을 아예 다른 섹션으로 나누고,
  //    정복 대상 쪽엔 난이도/유형 필터 + 처음엔 12개만 보여주는 "더 보기"를 둬서 한눈에 훑을
  //    수 있게 했다. 필터/더보기는 이미 받아온 목록을 다시 그리기만 할 뿐 서버를 다시 호출하지
  //    않는다 — 캐시가 없을 때만(최초 진입, 공격 후) 네트워크를 탄다. ──
  let galaxyCache = null;
  const PLANET_TIER_LABELS = { weak: "약함", medium: "보통", strong: "강함", elite: "정예", nightmare: "악몽", apex: "극한", transcendent: "초월" };

  async function renderGalaxyTab() {
    if (!state) return;
    if (!galaxyCache) {
      const wrap = document.querySelector("#panel-galaxy .galaxy-starmap-wrap");
      if (wrap) wrap.insertAdjacentHTML("afterbegin", '<p class="dim" id="galaxyStarmapStatus">은하 지도 스캔 중...</p>');
      try {
        const [planetsData, targetsData] = await Promise.all([
          api("/planets"), api("/planets/targets").catch(() => null),
        ]);
        galaxyCache = planetsData;
        galaxyTargetsCache = targetsData ? targetsData.targets : [];
        const status = $("galaxyStarmapStatus");
        if (status) status.remove();
      } catch (e) {
        const status = $("galaxyStarmapStatus");
        if (status) status.textContent = e.message;
        return;
      }
    }
    renderGalaxyContent();
  }

  // 사람 구역 정찰 결과 — 서버를 다시 안 불러도 되게 세션 동안만 들고 있는다(탭 재진입/필터
  // 조작으로 다시 그릴 때도 유지되도록 galaxyCache와 별도로 둔다).
  let galaxyScoutResult = null;
  // 정찰할 아이디를 몰라도 되도록 보여주는 "정찰 후보" 플레이어 목록(요청 반영).
  let galaxyTargetsCache = null;
  // 정찰 탐사선 — 도착 시각(진행 중일 때만 0이 아님)과 지금까지 찾아온 결과(세션 동안만 유지).
  let galaxyProbeReadyAt = 0;
  let galaxyProbeResults = [];

  function renderGalaxyContent() {
    const data = galaxyCache;
    if (!data) return;

    galaxyNextRerollAt = data.nextRerollAt;
    setText("galaxyNearbyRadius", data.nearbyRadius);

    // 난이도별 확률/개수 범례는 완전히 없앴다(요청 반영: "위에 뜨는 확률들 싹다 없애줘") —
    // 대신 아래 은하 지도 시각화(renderStarmap)에서 등급을 색으로 바로 구분해서 보여준다.
    renderStarmap(data);

    function statLine(p) {
      if (!p.combatStats) return "";
      const s = p.combatStats;
      return '<div class="planet-card-combat">⚔️' + s.atk + " 🛡️" + s.def + " 💥" + s.crit + "%</div>";
    }

    function planetCard(p, withButton) {
      const cls = p.isHome ? "home" : p.mine ? "mine" : "";
      const ownerLine = p.isHome
        ? (p.mine ? "🏠 내 홈 행성" : "🏠 " + escapeHtml(p.ownerName) + "의 홈 행성") + (!p.mine && p.homeInvulnerable ? " · 🛡️ 무적" : "")
        : "🤖 무주인 (PVE)";
      const tierLine = p.botTier ? '<div class="planet-card-tier">🤖 ' + p.botTierLabel + "</div>" : "";
      const rateLine = !p.isHome ? '<div class="planet-card-rate">💰 보상 ' + fmt(p.rewardCoins) + " 코인</div>" : "<div class=\"planet-card-rate\">&nbsp;</div>";
      const attackBtn = !withButton ? "" : p.attackable
        ? '<button class="btn-danger" data-planet="' + p.id + '"' + (state.stamina < 2 ? " disabled" : "") + ">ATTACK (⚡2)</button>"
        : '<button class="btn-ghost" disabled>' + (p.homeInvulnerable ? "🛡️ 무적 (Lv." + (data.homeInvulnerableLevel || 20) + " 미만)" : p.isHome ? "내 홈 행성" : "내 행성") + "</button>";
      return (
        '<div class="planet-card ' + cls + '">' +
        '<div class="planet-card-name">' + escapeHtml(p.name) + "</div>" +
        '<div class="planet-card-owner">' + ownerLine + "</div>" +
        tierLine + statLine(p) + rateLine + attackBtn +
        "</div>"
      );
    }

    // 사람 구역 — 아이디/닉네임을 몰라도 고를 수 있게 정찰 후보 목록을 칩으로 나열한다.
    const targetListEl = $("galaxyTargetList");
    if (targetListEl) {
      const list = galaxyTargetsCache || [];
      targetListEl.innerHTML = list.length
        ? list.map((t) =>
            '<button type="button" class="galaxy-target-chip" data-target="' + escapeHtml(t.user_id) + '">' +
            escapeHtml(t.real_name) + " (Lv." + t.level + ")</button>"
          ).join("")
        : '<p class="galaxy-empire-empty">정찰할 수 있는 다른 플레이어가 아직 없습니다.</p>';
      targetListEl.querySelectorAll("button[data-target]").forEach((btn) => {
        btn.addEventListener("click", () => scoutTarget(btn.dataset.target));
      });
    }

    // 사람 구역 — 정찰 결과가 있을 때만 카드 하나를 보여준다(정찰 안 하면 아무도 안 보임).
    const scoutGrid = $("galaxyScoutResult");
    if (scoutGrid) {
      scoutGrid.innerHTML = galaxyScoutResult
        ? planetCard(galaxyScoutResult, true)
        : '<p class="galaxy-empire-empty">정찰한 대상이 없습니다. 위에서 아이디를 입력해 정찰하세요.</p>';
      scoutGrid.querySelectorAll("button[data-planet]").forEach((btn) => {
        btn.addEventListener("click", () => openPlanetAttackSequence(galaxyScoutResult));
      });
    }

    // ── 정찰 탐사선 — 홈 근처가 아닌 먼 행성을 등급 지정해서 찾아온다(요청 반영: "정찰
    // 탐사선을 만들어서 얘가 찾아내는거야 사용자가 원하는거를"). 진행 중인 탐사선이 있으면
    // 카운트다운(도착하면 수령 버튼)을, 없으면 등급 선택 + 발사 폼을 보여준다. ──
    const probe = data.probe || {};
    galaxyProbeReadyAt = probe.targetTier ? probe.readyAt : 0;
    const probeIdleEl = $("galaxyProbeIdle"), probeFlightEl = $("galaxyProbeInFlight");
    if (probe.targetTier) {
      if (probeIdleEl) probeIdleEl.style.display = "none";
      if (probeFlightEl) probeFlightEl.style.display = "block";
      setText("galaxyProbeTargetLabel", probe.targetTierLabel || probe.targetTier);
    } else {
      if (probeIdleEl) probeIdleEl.style.display = "block";
      if (probeFlightEl) probeFlightEl.style.display = "none";
      const tierSelect = $("galaxyProbeTierSelect");
      const costNote = $("galaxyProbeCostNote");
      if (tierSelect) {
        const unlocked = probe.unlockedTiers || ["weak"];
        tierSelect.innerHTML = unlocked.map((key) => '<option value="' + key + '">' + PLANET_TIER_LABELS[key] + "</option>").join("");
        const updateCostNote = () => {
          const cost = (probe.launchCosts || {})[tierSelect.value];
          if (costNote && cost) costNote.textContent = "비용: 💰" + fmt(cost.coins) + " · ⚡" + cost.energy + " · 도착까지 " + fmtCountdown(probe.waitMs) + " · 결과 " + probe.resultCount + "개";
        };
        tierSelect.onchange = updateCostNote;
        updateCostNote();
      }
    }
    // 탐사선 결과 — 세션 동안만 들고 있는다(정찰 결과와 같은 방식).
    const probeResultEl = $("galaxyProbeResult");
    if (probeResultEl) {
      probeResultEl.innerHTML = galaxyProbeResults.length
        ? galaxyProbeResults.map((p) => planetCard(p, true)).join("")
        : '<p class="galaxy-empire-empty">아직 탐사선으로 찾은 행성이 없습니다.</p>';
      probeResultEl.querySelectorAll("button[data-planet]").forEach((btn) => {
        const planet = galaxyProbeResults.find((p) => String(p.id) === btn.dataset.planet);
        if (planet) btn.addEventListener("click", () => openPlanetAttackSequence(planet));
      });
    }

    // 봇 구역은 이제 카드 목록/난이도 필터 없이 은하 지도(위 renderStarmap)만으로 보여준다
    // (요청 반영: "아래 탭에 있는 전체난이도는 빼고 그냥 그래픽만 남기자") — 지도의 점을
    // 클릭하면 renderStarmap 안에서 바로 openPlanetAttackSequence가 열린다.
  }

  // 등급별 크기/색/이펙트 — "난이도가 높아짐에 따라 확실하게 시각적으로 매우 차이가
  // 나게, 아우라·파티클·크기로" 요청 반영. 반지름이 약함(2.2)→초월(9.5)까지 4배 넘게
  // 벌어지고, 정예부터 발광이, 정예~극한부터 궤도 파티클이, 극한 이상부터 회전하는 고리가
  // 붙는다 — 초월은 그 위에 은은하게 숨쉬듯 커졌다 작아지기까지 한다(아이템 파티클/아우라
  // 이펙트에서 썼던 "등급이 오를수록 화려해지는" 감각을 은하 지도용으로 다시 구현한 것).
  const STARMAP_TIER_FX = {
    weak:         { color: "#6d8590", r: 2.2, glow: 0,   particles: 0, ring: false, breathe: false },
    medium:       { color: "#00e07a", r: 2.6, glow: 0,   particles: 0, ring: false, breathe: false },
    strong:       { color: "#00d4ff", r: 3.4, glow: 1.2, particles: 0, ring: false, breathe: false },
    elite:        { color: "#b060e8", r: 4.4, glow: 1.6, particles: 3, ring: false, breathe: false },
    nightmare:    { color: "#ff3d9e", r: 5.6, glow: 2.0, particles: 5, ring: false, breathe: false },
    apex:         { color: "#ff1744", r: 7.2, glow: 2.6, particles: 7, ring: true,  breathe: false },
    transcendent: { color: "#e100ff", r: 9.5, glow: 3.2, particles: 9, ring: true,  breathe: true },
  };
  // ── 은하 지도 시각화 — 내 홈 행성을 중심(150,150)에 두고, 실제 (x,y) 좌표를 지도 반경
  // 130px 안으로 축소해서 근처 행성들을 점으로 흩뿌린다(요청 반영: "시각적으로 주변
  // 행성들이 보이면 좋겠는데"). 점을 클릭하면 바로 공격 시퀀스가 열린다. 탐사선이 출발해
  // 있으면 궤도를 도는 작은 신호를, 도착했으면 경계선 위에서 펄스로 보여준다(요청 반영:
  // "탐사선이 출발한것과 도착하는것 역시 시각화"). ──
  function renderStarmap(data) {
    const svg = $("galaxyStarmap");
    if (!svg) return;
    const home = data.myHome || { x: 500, y: 500 };
    const radius = data.nearbyRadius || 250;
    const scale = 130 / radius;
    const cx = 150, cy = 150;

    const bodies = (data.planets || []).filter((p) => !p.isHome).map((p) => {
      const fx = STARMAP_TIER_FX[p.botTier] || STARMAP_TIER_FX.weak;
      const px = (cx + ((p.x || 0) - home.x) * scale).toFixed(1);
      const py = (cy + ((p.y || 0) - home.y) * scale).toFixed(1);
      let inner = "";
      // 아우라(발광) — 정예 이상부터, 등급이 오를수록 더 크고 흐릿하고 진해진다.
      if (fx.glow > 0) {
        inner += '<circle r="' + (fx.r * (1.6 + fx.glow)).toFixed(1) + '" fill="' + fx.color + '" opacity="0.25" ' +
          'style="filter:blur(' + (1 + fx.glow).toFixed(1) + 'px)"/>';
      }
      // 회전하는 고리 — 극한 이상 전용, "이건 진짜 위험하다"는 신호.
      if (fx.ring) {
        inner += '<g class="starmap-ring" style="animation-duration:' + (fx.breathe ? 3 : 4) + 's;">' +
          '<circle r="' + (fx.r + 4.5) + '" fill="none" stroke="' + fx.color + '" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.85"/></g>';
      }
      // 파티클 — 정예부터 개수가 계속 늘어나며 궤도를 돈다(같은 애니메이션을 delay만 다르게
      // 줘서 고르게 퍼뜨린다 — 정적 회전값과 animation의 transform이 서로 안 부딪히게 하는 트릭).
      const dur = Math.max(1.2, 2.6 - fx.particles * 0.12);
      for (let i = 0; i < fx.particles; i++) {
        const delay = (-(dur * i) / fx.particles).toFixed(2);
        inner += '<g class="starmap-particle-orbit" style="animation-duration:' + dur.toFixed(2) + 's;animation-delay:' + delay + 's;">' +
          '<circle cx="' + (fx.r + 4.5).toFixed(1) + '" cy="0" r="1.1" fill="' + fx.color + '"/></g>';
      }
      const dotCls = "starmap-dot" + (fx.breathe ? " starmap-breathe" : "");
      inner += '<circle class="' + dotCls + '" data-planet="' + p.id + '" r="' + fx.r + '" fill="' + fx.color +
        '"><title>' + escapeHtml(p.name) + " (" + (p.botTierLabel || "") + ")</title></circle>";
      return '<g transform="translate(' + px + "," + py + ')">' + inner + "</g>";
    }).join("");

    // 홈 행성 — "더 명확하게" 요청 반영: 점 하나가 아니라 후광+점선 고리+속이 빈 중심점+
    // "HOME" 글자까지 붙여서 다른 어떤 행성과도 헷갈릴 수 없게 만들었다.
    const homeMarker =
      '<g transform="translate(' + cx + "," + cy + ')">' +
      '<circle r="15" fill="var(--accent)" opacity="0.15"/>' +
      '<g class="starmap-ring" style="animation-duration:6s;"><circle r="11" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="2 2"/></g>' +
      '<circle r="7" fill="var(--accent)" style="filter:drop-shadow(0 0 5px var(--accent))"/>' +
      '<circle r="2.6" fill="var(--bg)"/>' +
      '<text y="25" text-anchor="middle" font-size="9" font-weight="bold" fill="var(--accent)" style="font-family:var(--font-mono);">HOME</text>' +
      "</g>";

    let probeHtml = "";
    const probe = data.probe;
    if (probe && probe.targetTier) {
      const ready = probe.readyAt && Date.now() >= probe.readyAt;
      probeHtml = ready
        ? '<circle class="starmap-probe-ready" cx="' + cx + '" cy="' + (cy - 130) + '" r="6" fill="none" stroke="var(--stamina)" stroke-width="2"/>'
        : '<g class="starmap-probe-ship" style="animation-duration:' + Math.max(4, Math.min(20, Math.round((probe.waitMs || 900000) / 60000))) + 's;">' +
          '<circle cx="' + cx + '" cy="' + (cy - 130) + '" r="4" fill="var(--stamina)"><title>🛸 ' + escapeHtml(probe.targetTierLabel || "") + " 등급 탐사 중</title></circle></g>";
    }

    svg.innerHTML =
      '<circle class="starmap-radius" cx="' + cx + '" cy="' + cy + '" r="130"/>' + bodies + homeMarker +
      (probeHtml ? '<g class="starmap-probe">' + probeHtml + "</g>" : "");

    svg.querySelectorAll(".starmap-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        const planet = (galaxyCache.planets || []).find((p) => String(p.id) === dot.dataset.planet);
        if (planet) openPlanetAttackSequence(planet);
      });
    });
  }

  let galaxyNextRerollAt = 0;
  setInterval(() => {
    const el = $("galaxyRerollCountdown");
    if (!el || !galaxyNextRerollAt) return;
    const remain = galaxyNextRerollAt - Date.now();
    if (remain <= 0) {
      el.textContent = "리롤 중...";
      if (currentTab === "galaxy") { galaxyCache = null; renderGalaxyTab(); }
      return;
    }
    el.textContent = "다음 난이도 리롤까지 " + fmtCountdown(remain);
  }, 1000);

  // 정찰 탐사선 도착 카운트다운 — 도착하면 카운트다운 자리에 "수령하기" 버튼을 보여주고,
  // 은하 지도의 궤도 신호도 그 순간 한 번만 "도착" 펄스로 바꿔준다(요청 반영: 도착 시각화).
  let galaxyProbeStarmapFlipped = false;
  setInterval(() => {
    if (!galaxyProbeReadyAt) { galaxyProbeStarmapFlipped = false; return; }
    const el = $("galaxyProbeCountdown"), btn = $("galaxyProbeCollectBtn");
    if (!el) return;
    const remain = galaxyProbeReadyAt - Date.now();
    if (remain <= 0) {
      el.textContent = "도착!";
      if (btn) btn.style.display = "block";
      if (!galaxyProbeStarmapFlipped && galaxyCache) { galaxyProbeStarmapFlipped = true; renderStarmap(galaxyCache); }
    } else {
      el.textContent = fmtCountdown(remain);
      if (btn) btn.style.display = "none";
    }
  }, 1000);

  // ── 사람 구역 정찰 — /arena/scan(PvP 정찰)과 똑같은 발상. 정찰해야만 그 순간 상대 홈
  //    행성 정보(전투력/무적 여부/planetId)가 드러나고 공격 버튼이 뜬다. targetUserId 자리엔
  //    아이디뿐 아니라 닉네임도 넣을 수 있고(서버가 부분 일치까지 처리), 목록에서 후보를
  //    클릭해도 같은 함수를 탄다. ──
  async function scoutTarget(query) {
    if (!query) return toast("정찰할 아이디나 닉네임을 입력하세요.", true);
    const btn = $("galaxyScoutBtn");
    if (btn) btn.disabled = true;
    try {
      const r = await api("/planets/scout", { method: "POST", body: { targetUserId: query } });
      galaxyScoutResult = {
        id: r.planetId, name: r.planetName, isHome: true, mine: false,
        ownerUserId: r.ownerUserId, ownerName: r.ownerName,
        combatStats: r.combatStats, homeInvulnerable: r.homeInvulnerable, attackable: r.attackable,
        botTier: null, botTierLabel: null, rewardCoins: 0,
      };
      state = r.state; renderHeader();
      renderGalaxyContent();
    } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
  }

  function initGalaxyScout() {
    const btn = $("galaxyScoutBtn");
    if (!btn) return;
    btn.addEventListener("click", () => scoutTarget($("galaxyScoutInput").value.trim()));
  }

  // ── 정찰 탐사선 발사/수령 — 코인+에너지를 내고 보내면 일정 시간 뒤 지정한 등급의 먼
  //    행성을 찾아온다(요청 반영). 결과는 GET /planets를 다시 안 불러도 되게 세션 캐시에
  //    쌓아서 보여준다(정찰 결과와 같은 방식). ──
  function initGalaxyProbe() {
    const launchBtn = $("galaxyProbeLaunchBtn");
    if (launchBtn) launchBtn.addEventListener("click", async () => {
      const targetTier = $("galaxyProbeTierSelect").value;
      if (!targetTier) return;
      launchBtn.disabled = true;
      try {
        const r = await api("/planets/probe/launch", { method: "POST", body: { targetTier } });
        toast("🛸 " + (r.targetTierLabel || targetTier) + " 등급을 찾아 탐사선을 발사했습니다.");
        state = r.state; renderHeader();
        galaxyCache = null; renderGalaxyTab();
      } catch (e) { toast(e.message, true); launchBtn.disabled = false; }
    });
    const collectBtn = $("galaxyProbeCollectBtn");
    if (collectBtn) collectBtn.addEventListener("click", async () => {
      collectBtn.disabled = true;
      try {
        const r = await api("/planets/probe/collect", { method: "POST" });
        if (r.refunded || !r.planets.length) {
          toast("🛸 탐사선이 " + (r.foundTierLabel || "") + " 등급을 못 찾고 돌아왔습니다 — 비용은 환불됐습니다.", true);
        } else {
          galaxyProbeResults = r.planets.concat(galaxyProbeResults);
          toast("🛸 " + (r.foundTierLabel || "") + " 등급 행성 " + r.planets.length + "개를 찾았습니다!");
        }
        state = r.state; renderHeader();
        galaxyCache = null; renderGalaxyTab();
      } catch (e) { toast(e.message, true); collectBtn.disabled = false; }
    });
  }

  function initGalaxyButtons() {
    initGalaxyScout();
    initGalaxyProbe();
  }

  // ── 전투 태세(가위바위보) — 서버 STANCES와 동일한 배율/상성을 표시용으로 복제한 것.
  //    실제 검증/계산은 항상 서버가 다시 한다. ──
  const STANCE_META = {
    aggressive: { label: "공격형", icon: "⚔️", hint: "ATK+25% / DEF-15%" },
    defensive:  { label: "방어형", icon: "🛡️", hint: "ATK-15% / DEF+25%" },
    ambush:     { label: "기습형", icon: "🗡️", hint: "치명타 +10%" },
  };

  let attackAnimId = null;
  function stopAttackAnimation() { if (attackAnimId) { cancelAnimationFrame(attackAnimId); attackAnimId = null; } }
  function closeAttackModal() { stopAttackAnimation(); $("attackModal").style.display = "none"; }

  // ── 공격 시퀀스 진입점 — 태세 선택 → 3라운드 타이밍 미니게임 → 결과, 순서로 진행한다.
  //    PvP(상대 유저)와 Galaxy Map(행성 정복) 둘 다 같은 시퀀스를 쓴다 — ctx.mode로 어느 쪽인지
  //    구분해서 마지막에 다른 엔드포인트(/arena/attack vs /planets/attack)를 호출한다.
  //    첫 화면을 위해 정찰을 한 번 호출해 상대의 평소 태세를 보여준다 — 정찰도 스태미나 1을 쓴다. ──
  // 예전엔 여기서 /arena/scan을 한 번 더 호출해서 정보를 새로 받아왔는데, 그 호출이 스태미나
  // 1을 쓰게 되면서 "스태미나 1 남았을 때 공격을 누르면 정보 조회에서 그걸 다 써버리고 정작
  // 공격은 스태미나 부족으로 실패하는" 버그가 됐다. Arena P2P 목록(/arena/targets)은 애초에
  // 무료라서, 이미 받아온 그 데이터를 그대로 쓰면 된다 — 행성 공격 모달과 같은 방식.
  function openAttackSequence(target) {
    $("attackModal").style.display = "flex";
    const stanceHint = (target.lastStanceLabel ? "상대는 최근 <b>[" + escapeHtml(target.lastStanceLabel) + "]</b>으로 싸웠습니다 — 상성을 노려보세요." : "상대의 전투 패턴 정보가 없습니다.")
      + (target.levelGapHigh ? '<br><span style="color:var(--stamina);">⚠️ 레벨 차이가 커서 스태미나를 더 씁니다(' + target.staminaCost + ').</span>' : "");
    renderStanceStep({ mode: "pvp", targetUserId: target.userId }, target.realName, stanceHint);
  }

  function openPlanetAttackSequence(planet) {
    $("attackModal").style.display = "flex";
    const hint = planet.botTier
      ? "PVE 봇(" + planet.botTierLabel + ")이 지키고 있습니다. 이겨도 소유권은 안 넘어가고 그 자리에서 약탈만 합니다."
      : "현재 소유자: <b>" + escapeHtml(planet.ownerName || "?") + "</b>의 홈 행성 — 공격력/방어력이 실전의 1.1배인 요새입니다. 뚫으면 포켓 코인 20%를 몰수합니다(행성은 뺏지 않음).";
    renderStanceStep({ mode: "planet", planetId: planet.id, planetName: planet.name }, planet.name, hint);
  }

  function renderStanceStep(ctx, displayName, hint) {
    const body = $("attackModalBody");
    body.innerHTML =
      "<h3>⚔️ ATTACK SEQUENCE — " + escapeHtml(displayName) + "</h3>" +
      '<p class="stance-hint">' + hint + "</p>" +
      '<div class="stance-grid">' +
      Object.keys(STANCE_META).map((id) => {
        const m = STANCE_META[id];
        return '<button class="stance-btn" data-stance="' + id + '"><span class="stance-icon">' + m.icon + "</span>" + m.label + '<span class="stance-mult">' + m.hint + "</span></button>";
      }).join("") +
      "</div>";
    body.querySelectorAll("button[data-stance]").forEach((btn) => {
      btn.addEventListener("click", () => startTimingRounds(ctx, btn.dataset.stance));
    });
  }

  // ── 3라운드 타이밍 미니게임 — 좌우로 왕복하는 마커를 초록 구간(스윗스팟)에서 멈춰야 정확도가
  //    높다. 정확도는 서버에서 ±15% 배율로만 반영되므로(bounded), 스탯 차이를 완전히 뒤집진
  //    못하지만 비슷한 상대끼리는 이 한 방으로 승부가 갈릴 수 있다. ──
  function startTimingRounds(ctx, stance) {
    const timingScores = [];
    function runRound(roundIndex) {
      const body = $("attackModalBody");
      const sweetStart = 30 + Math.random() * 40; // 30~70% 구간 어딘가에 스윗스팟 시작
      const sweetWidth = 16;
      body.innerHTML =
        '<div class="timing-wrap">' +
        '<div class="round-dots">' + [0, 1, 2].map((i) => '<div class="round-dot' + (i === roundIndex ? " active" : "") + '">' + (i + 1) + "</div>").join("") + "</div>" +
        '<div class="timing-round-label">라운드 ' + (roundIndex + 1) + ' / 3 — 초록 구간에서 STOP!</div>' +
        '<div class="timing-track"><div class="timing-sweetspot" style="left:' + sweetStart + '%; width:' + sweetWidth + '%;"></div><div class="timing-marker" id="timingMarker" style="left:0%;"></div></div>' +
        '<button class="timing-stop-btn" id="timingStopBtn">STOP</button>' +
        "</div>";

      const marker = $("timingMarker");
      const stopBtn = $("timingStopBtn");
      const startTime = performance.now();
      const periodMs = 1100;
      function tick(now) {
        const t = ((now - startTime) % periodMs) / periodMs;
        const pos = t < 0.5 ? t * 2 : (1 - t) * 2; // 0→1→0 삼각파 왕복
        marker.style.left = (pos * 100) + "%";
        attackAnimId = requestAnimationFrame(tick);
      }
      attackAnimId = requestAnimationFrame(tick);

      stopBtn.addEventListener("click", () => {
        stopAttackAnimation();
        const markerPct = parseFloat(marker.style.left);
        const sweetCenter = sweetStart + sweetWidth / 2;
        const dist = Math.abs(markerPct - sweetCenter);
        const accuracy = Math.max(0, Math.round(100 - dist * 2.2));
        timingScores.push(accuracy);

        marker.style.background = accuracy >= 70 ? "var(--energy)" : accuracy >= 40 ? "var(--stamina)" : "var(--danger)";
        stopBtn.disabled = true;
        stopBtn.textContent = accuracy + "점!";

        setTimeout(() => {
          if (roundIndex < 2) runRound(roundIndex + 1);
          else finishAttack(ctx, stance, timingScores);
        }, 550);
      }, { once: true });
    }
    runRound(0);
  }

  async function finishAttack(ctx, stance, timingScores) {
    const body = $("attackModalBody");
    body.innerHTML = '<p class="dim" style="text-align:center;">침투 시퀀스 분석 중...</p>';
    try {
      const isPlanet = ctx.mode === "planet";
      const endpoint = isPlanet ? "/planets/attack" : "/arena/attack";
      const payload = isPlanet
        ? { planetId: ctx.planetId, stance: stance, timingScores: timingScores }
        : { targetUserId: ctx.targetUserId, stance: stance, timingScores: timingScores };
      const r = await api(endpoint, { method: "POST", body: payload });
      const rpsNote = r.rpsMod > 0 ? " · 상성 우위 +" + Math.round(r.rpsMod * 100) + "%" : r.rpsMod < 0 ? " · 상성 열세 " + Math.round(r.rpsMod * 100) + "%" : "";
      // 전투 진행 수치 — 라운드별 내 공격력 vs 상대 방어력, 타이밍 정확도를 그대로 보여준다.
      const roundDetailHtml =
        '<div class="round-detail-list">' +
        r.rounds.map((rd) =>
          '<div class="round-detail-row ' + (rd.win ? "win" : "lose") + '">' +
          '<span class="rd-num">R' + rd.round + "</span>" +
          '<span class="rd-power">' + fmt(rd.atkPower) + " ATK vs " + fmt(rd.defPower) + " DEF</span>" +
          '<span class="rd-timing">타이밍 ' + rd.timingScore + "점 (x" + rd.timingMult + ")</span>" +
          '<span class="rd-outcome">' + (rd.win ? "승" : "패") + "</span>" +
          "</div>"
        ).join("") +
        "</div>";
      let resultDetail;
      if (isPlanet) {
        // 봇 구역/사람 구역 둘 다 소유권이 절대 안 넘어간다 — 이겨도 그 자리에서 약탈(홈 행성은
        // 포켓 코인 몰수, 봇 구역은 시세 약탈)만 받고, 행성 자체는 원래 상태 그대로 남는다.
        if (r.attackerWins) {
          resultDetail = r.isHome
            ? "🏠 홈 행성 침투 성공! 포켓 코인 20% 몰수 +" + fmt(r.lootCoins) + " 코인"
            : "🤖 침투 성공! +" + fmt(r.lootCoins) + " 코인 약탈";
        } else {
          resultDetail = "침투 실패";
        }
      } else {
        const bonusNote = r.offlineBonusCollected > 0 ? "Property 대기수익 " + fmt(r.offlineBonusCollected) + " 포함 정산됨" : "";
        resultDetail = (r.attackerWins ? "약탈 +" + fmt(r.coinsDelta) + " 코인" : "약탈 실패") + (bonusNote ? "<br>" + bonusNote : "");
      }
      // 이겨도 져도 소량이나마 경험치가 붙는다(요청: "경험치 얻을 수단이 너무 적다") — 결과
      // 상세 아래에 항상 한 줄 더 붙인다.
      resultDetail += '<br><span class="dim">EXP +' + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : "") + "</span>";
      body.innerHTML =
        '<div class="round-dots">' + r.rounds.map((rd) => '<div class="round-dot ' + (rd.win ? "win" : "lose") + '">' + (rd.win ? "✓" : "✗") + "</div>").join("") + "</div>" +
        '<div class="attack-stat-line">내 ATK ' + fmt(r.myAtk) + " (" + escapeHtml(r.stanceLabel) + ")" + rpsNote + " · 상대 DEF " + fmt(r.theirDef) + "</div>" +
        roundDetailHtml +
        '<div class="attack-result-title ' + (r.attackerWins ? "win" : "lose") + '">' +
        (r.attackerWins ? (r.sweep ? "🏆 완벽한 승리!" : "✅ 침투 성공") + (r.isCrit ? " · CRITICAL!" : "") : "❌ 침투 실패") +
        "</div>" +
        '<div class="attack-result-detail">' + resultDetail + "</div>" +
        '<button class="attack-close-btn" id="attackResultCloseBtn">확인</button>';
      state = r.state; renderHeader();
      if (!isPlanet && currentTab === "pvp") renderPvpTab();
      if (isPlanet) { galaxyCache = null; if (currentTab === "galaxy") renderGalaxyTab(); }
      $("attackResultCloseBtn").addEventListener("click", closeAttackModal);
    } catch (e) {
      body.innerHTML = '<p class="dim">' + escapeHtml(e.message) + '</p><button class="attack-close-btn" id="attackResultCloseBtn">닫기</button>';
      $("attackResultCloseBtn").addEventListener("click", closeAttackModal);
    }
  }

  // 아이템 하나의 능력치 표시 문구 — 상점/봇/인벤토리에서 공용으로 쓴다.
  function itemStatLabel(it) {
    if (it.type === "weapon") return "ATK +" + it.value;
    if (it.type === "armor") return "DEF +" + it.value;
    if (it.type === "core") return "치명타 +" + it.value + "%";
    if (it.type === "box") return "개봉 시 무기/방어/코어 중 하나 획득 (75%/20%/5% 확률로 등급 결정)";
    if (it.effect === "stamina") return "Stamina +" + it.value;
    if (it.effect === "energy") return "Energy +" + it.value;
    if (it.effect === "heal_flat") return "HP +" + it.value;
    if (it.effect === "heal_and_energy") return "HP +" + it.value + " · Energy +" + it.value2;
    if (it.effect === "self_shield") return Math.round(it.value / 3600000) + "시간 자가 보호막";
    return "";
  }

  // 남은 시간을 "3분 12초" 식으로 — 상점 로테이션 카운트다운에 쓴다.
  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? m + "분 " + (s % 60) + "초" : s + "초";
  }

  // 며칠 단위로 남는 전역 이벤트용 — "2880분 12초" 식은 안 읽히니 일/시간/분 단위로 접는다.
  function fmtLongCountdown(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return days + "일 " + hours + "시간";
    if (hours > 0) return hours + "시간 " + mins + "분";
    return mins + "분 " + (totalSec % 60) + "초";
  }

  // ── HP/Energy/Stamina 완전 회복까지 남은 시간 표시 — renderHeader가 절대 시각을 세팅해두면
  // 1초마다 그 시각까지 남은 시간만 다시 계산해서 보여준다(다음 /state 폴링을 기다릴 필요 없음). ──
  let hpFullAt = 0, energyFullAt = 0, staminaFullAt = 0, boostUntilAt = 0, globalEventEndAt = 0;
  function renderResourceEtas() {
    const now = Date.now();
    const hpEl = $("hpEta"), energyEl = $("energyEta"), staminaEl = $("staminaEta");
    if (hpEl) hpEl.textContent = hpFullAt > now ? "완충 " + fmtCountdown(hpFullAt - now) : "";
    if (energyEl) energyEl.textContent = energyFullAt > now ? "완충 " + fmtCountdown(energyFullAt - now) : "";
    if (staminaEl) staminaEl.textContent = staminaFullAt > now ? "완충 " + fmtCountdown(staminaFullAt - now) : "";

    // 코인/XP 2배 부스트(환생 직후 30분 또는 출석+오늘의 미션 전부 완료 20분) 남은 시간.
    const boostTag = $("boostTag");
    if (boostTag) {
      if (boostUntilAt > now) { boostTag.textContent = "🔥 부스트 2배 " + fmtCountdown(boostUntilAt - now); boostTag.style.display = ""; }
      else boostTag.style.display = "none";
    }

    // 전역 이벤트(GM이 켠 기간 한정 코인·EXP 2배) 배너 카운트다운.
    const eventCountdownEl = $("globalEventCountdown");
    if (eventCountdownEl) {
      eventCountdownEl.textContent = globalEventEndAt > now ? fmtLongCountdown(globalEventEndAt - now) : "종료";
    }

    // 현상금 게시판 다음 갱신까지 남은 시간(8시간마다) — Bounty 탭이 열려있을 때만 있는 요소.
    const bountyCountdownEl = $("bountyRefreshCountdown");
    if (bountyCountdownEl) {
      bountyCountdownEl.textContent = bountyRefreshAt > now ? fmtLongCountdown(bountyRefreshAt - now) : "갱신 중...";
    }
  }
  setInterval(renderResourceEtas, 1000);

  let shopNextRotationAt = 0;
  let shopDiamondExchangeCost = 0;
  // ── ③ Hardware Shop — 장비(무장/방어/코어)는 여러 개 살 수 있다(플레이어+봇에 나눠 장착).
  //    상점은 4분마다 통째로 리롤되는 공용 로테이션이라, 카운트다운이 0이 되면 자동으로 다시 그린다. ──
  async function renderShopTab() {
    if (!state) return;
    const panel = $("panel-shop");
    const grid = panel.querySelector(".shop-grid");
    grid.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const [{ items, nextRotationAt, diamonds, diamondExchangeCost, rerollCost }, research] = await Promise.all([api("/shop"), api("/research")]);
      shopNextRotationAt = nextRotationAt;
      shopDiamondExchangeCost = diamondExchangeCost;
      $("shopDiamondBalance").textContent = "💎 " + fmt(diamonds);
      $("shopExchangeCost").textContent = fmt(diamondExchangeCost);
      $("shopRerollCost").textContent = fmt(rerollCost);
      updateExchangeTotalCost();

      // 자동 리롤(연구 해금 시에만 노출) — 원하는 등급의 아이템이 뜰 때까지 다이아를 계속
      // 써서 서버가 알아서 반복 리롤한다.
      const autoCard = $("shopAutoRerollCard");
      if (autoCard) {
        autoCard.style.display = research.autoRollUnlocked ? "" : "none";
        if (research.autoRollUnlocked) {
          const raritySel = $("shopAutoRerollRarity");
          if (raritySel && !raritySel.dataset.filled) {
            raritySel.innerHTML = RARITY_ORDER_CLIENT.map((rr) => '<option value="' + rr + '">' + research.rarityLabels[rr] + "</option>").join("");
            raritySel.dataset.filled = "1";
          }
        }
      }
      grid.innerHTML = items.map((it) => {
        const capped = it.maxOwned && it.owned >= it.maxOwned;
        const soldOut = it.totalStock != null && it.remainingStock <= 0;
        const disabled = capped || soldOut || state.pocketCoins < it.price;
        const btnLabel = soldOut ? "품절" : capped ? "보유 한도" : "구매";
        const stockLine = it.totalStock != null ? '<div class="shop-card-type" style="color:' + (soldOut ? "var(--danger)" : "var(--sub)") + ';">재고 ' + it.remainingStock + " / " + it.totalStock + "</div>" : "";
        return (
        '<div class="shop-card" style="border-left-color:' + it.typeColor + '">' +
        '<div class="shop-card-icon">' + itemIconHtml(it.id, it.rarityColor, 30, it.rarity) + "</div>" +
        '<div class="shop-card-name">' + escapeHtml(it.name) + "</div>" +
        '<div class="shop-card-type" style="color:' + it.typeColor + '">' + (it.typeLabel || it.type.toUpperCase()) + (it.owned ? " · 보유 " + it.owned + (it.maxOwned ? "/" + it.maxOwned : "") : (it.maxOwned ? " · 최대 " + it.maxOwned + "개" : "")) + "</div>" +
        stockLine +
        '<div class="rarity-badge" style="color:' + it.rarityColor + '">' + it.rarityLabel + "</div>" +
        '<div class="shop-card-stat">' + itemStatLabel(it) + "</div>" +
        '<div class="shop-card-price">💰 ' + fmt(it.price) + "</div>" +
        '<button class="btn-primary" data-buy="' + it.id + '"' + (disabled ? " disabled" : "") + ">" + btnLabel + "</button></div>"
        );
      }).join("");
      grid.querySelectorAll("button[data-buy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/shop/buy", { method: "POST", body: { itemId: btn.dataset.buy } });
            toast("구매 완료!");
            state.pocketCoins = r.pocketCoins; renderHeader(); renderShopTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // 교환 개수 입력칸 값이 바뀔 때마다 "총 코인" 표시를 즉시 갱신한다(실제 검증은 서버가 다시 함).
  function updateExchangeTotalCost() {
    const totalEl = $("exchangeDiamondTotalCost");
    const qtyInput = $("exchangeDiamondQty");
    if (!totalEl || !qtyInput) return;
    const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    totalEl.textContent = fmt(shopDiamondExchangeCost * qty);
  }

  function initShopButtons() {
    const qtyInput = $("exchangeDiamondQty");
    if (qtyInput) qtyInput.addEventListener("input", updateExchangeTotalCost);
    const maxBtn = $("exchangeDiamondMaxBtn");
    if (maxBtn) maxBtn.addEventListener("click", () => {
      if (!shopDiamondExchangeCost || !state) return;
      qtyInput.value = Math.max(1, Math.floor(state.pocketCoins / shopDiamondExchangeCost));
      updateExchangeTotalCost();
    });
    const btn = $("exchangeDiamondBtn");
    if (btn) btn.addEventListener("click", async () => {
      const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
      btn.disabled = true;
      try {
        const r = await api("/shop/exchange-diamond", { method: "POST", body: { qty: qty } });
        toast("💎 다이아 " + qty + "개 교환 완료!");
        state.pocketCoins = r.pocketCoins; renderHeader(); renderShopTab();
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    const rerollBtn = $("rerollShopBtn");
    if (rerollBtn) rerollBtn.addEventListener("click", async () => {
      rerollBtn.disabled = true;
      try {
        const r = await api("/shop/reroll", { method: "POST" });
        toast("🎲 상점 리롤 완료!");
        renderShopTab();
      } catch (e) { toast(e.message, true); }
      rerollBtn.disabled = false;
    });
    const autoRerollBtn = $("shopAutoRerollBtn");
    if (autoRerollBtn) autoRerollBtn.addEventListener("click", async () => {
      const raritySel = $("shopAutoRerollRarity");
      autoRerollBtn.disabled = true;
      const original = autoRerollBtn.textContent;
      autoRerollBtn.textContent = "자동 리롤 중...";
      try {
        const r = await api("/shop/reroll-auto", { method: "POST", body: { targetRarity: raritySel.value } });
        if (r.found) toast("🎯 자동 리롤 성공! " + fmt(r.attempts) + "회 만에 목표 등급을 찾았습니다.");
        else toast("자동 리롤 " + fmt(r.attempts) + "회 시도했지만 목표 등급을 못 찾았습니다(다이아 부족 또는 시도 한도 도달) — 다이아를 모아 다시 시도하세요.", true);
        renderShopTab();
      } catch (e) { toast(e.message, true); }
      autoRerollBtn.disabled = false;
      autoRerollBtn.textContent = original;
    });
  }

  // 1초마다 카운트다운 갱신, 0이 되면(로테이션이 바뀌면) 상점 탭이 보이는 동안만 자동 재조회.
  setInterval(() => {
    const el = $("shopCountdown");
    if (!el || !shopNextRotationAt) return;
    const remain = shopNextRotationAt - Date.now();
    if (remain <= 0) {
      if (currentTab === "shop") renderShopTab();
      return;
    }
    el.textContent = "다음 로테이션까지 " + fmtCountdown(remain);
  }, 1000);

  // ── ④ Digital Inventory — 소비재 사용 전용(장비 장착은 Bots 탭) ──
  async function renderInventoryTab() {
    const panel = $("panel-inventory");
    const list = panel.querySelector(".inv-list");
    list.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const inv = await api("/inventory");
      const usableItems = inv.items.filter((it) => it.type === "consumable" || it.type === "box");
      if (!usableItems.length) { list.innerHTML = '<p class="dim">보유한 소비재/상자가 없습니다. Hardware Shop에서 구매하세요.</p>'; return; }
      list.innerHTML = usableItems.map((it) => (
        '<div class="inv-row" style="border-left-color:' + it.rarityColor + '">' +
        '<div class="inv-name">' + itemIconHtml(it.id, it.rarityColor, 18, it.rarity) + " " + escapeHtml(it.name) + (it.qty > 1 ? " ×" + it.qty : "") + '<span class="rarity-badge" style="color:' + it.rarityColor + ';margin-left:6px;">' + it.rarityLabel + "</span></div>" +
        '<div class="dim">' + itemStatLabel(it) + "</div>" +
        '<button class="btn-ghost" data-use="' + it.id + '">' + (it.type === "box" ? "개봉" : "사용") + "</button>" +
        "</div>"
      )).join("");
      list.querySelectorAll("button[data-use]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            const r = await api("/inventory/use", { method: "POST", body: { itemId: btn.dataset.use } });
            if (r.boxOpened) {
              toast("🎁 상자 개봉! [" + r.wonRarityLabel + "] " + r.wonItemName + " 획득!");
              refreshState();
            } else {
              toast("사용 완료"); state = r.state; renderHeader();
            }
            renderInventoryTab();
          } catch (e) { toast(e.message, true); }
        });
      });
    } catch (e) { list.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // 전체 아이템 카탈로그(아이템 이름/등급 조회용, 로테이션과 무관) — 한 번 받아오면 캐시.
  // 이미 장착된 아이템은 지금 상점 로테이션에 없을 수도 있어서, /shop이 아니라 /items(전체
  // 카탈로그)에서 가져와야 한다.
  let shopCatalogCache = null;
  async function getShopCatalog() {
    if (!shopCatalogCache) {
      const { items } = await api("/items");
      shopCatalogCache = {};
      items.forEach((it) => { shopCatalogCache[it.id] = it; });
    }
    return shopCatalogCache;
  }

  // ── Bots ──
  // 봇 가챠 — 봇 칸을 모집한 뒤 이 3등급 중 하나를 사면 무장/방어/코어 3슬롯이 한 번에 랜덤으로
  // 채워진다(값/확률표는 서버와 동일, 표시용). 등급이 오를수록 값이 100배씩 뛰는 대신 높은
  // 희귀도가 나올 확률도 크게 좋아진다.
  const BOT_GACHA_META = {
    basic:    { label: "Basic",    price: 1000 },
    advanced: { label: "Advanced", price: 100000 },
    premium:  { label: "Premium",  price: 10000000 },
  };
  let botsTabLoadedOnce = false;
  async function renderBotsTab() {
    const panel = $("panel-bots");
    const el = panel.querySelector(".bot-roster");
    // 최초 진입 때만 로딩 문구를 보여준다 — 장착/가챠 후 다시 그릴 때 여기서 매번 잠깐 비웠다가
    // 다시 채우면 화면이 통째로 리셋되는 것처럼 느껴진다(실제로 그런 피드백을 받음). 갱신 시엔
    // 기존 화면을 그대로 둔 채 새 데이터가 준비되면 한 번에 갈아끼운다.
    if (!botsTabLoadedOnce) el.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const [data, catalog, research] = await Promise.all([api("/bots"), getShopCatalog(), api("/research")]);
      botsTabLoadedOnce = true;

      // gachaFallback({label,color})는 지금 안 쓴다 — 한때 "실제 장착 없음" 슬롯 라벨 옆에
      // "[EPIC 가챠 등급]" 식으로 덧붙였는데, 드롭다운은 여전히 "비어있음"이라 "분명히
      // 비어있는데 왜 등급이 떠 있냐"는 혼란만 줬다(요청 반영: 그 표시 제거). 봇 카드 맨
      // 위의 "LEGENDARY GRADE" 배지 하나로 등급은 이미 충분히 보이고, 여기 슬롯 줄은
      // "지금 실제로 뭐가 꽂혀 있는지"만 있는 그대로 보여주는 게 맞다. 호출부 인자는 남겨
      // 뒀지만(하위 호환) 여기선 무시한다.
      function slotRow(target, slotType, label, equippedId) {
        // data.availableItems는 서버 sortedShopEntries가 등급 오름차순(약한 것부터)으로 내려주는데,
        // 봇 장착 드롭다운에서는 제일 좋은 장비를 훑어보기 편하게 반대로(강한 것부터) 보여준다
        // — 다른 탭(상점/인챈트)에서 쓰는 공용 정렬 함수 자체는 안 건드리고 여기서만 뒤집는다.
        const options = data.availableItems.filter((it) => it.type === slotType).reverse();
        const currentItem = equippedId ? catalog[equippedId] : null;
        // 장착 중인 아이템 아이콘을 라벨 옆에 보여준다(빈 슬롯이면 자리만 차지하는 빈 칸으로
        // 대체해서 아이콘 유무와 상관없이 라벨/드롭다운 위치가 흔들리지 않게 한다).
        const icon = currentItem
          ? itemIconHtml(equippedId, currentItem.rarityColor, 20, currentItem.rarity)
          : '<span class="item-icon" style="width:20px;height:20px;"></span>';
        let optionsHtml = '<option value="">— 비어있음 —</option>';
        if (equippedId) optionsHtml += '<option value="' + equippedId + '" selected>[' + (currentItem ? currentItem.rarityLabel : "") + "] " + escapeHtml(currentItem ? currentItem.name : equippedId) + " (장착중)</option>";
        options.forEach((it) => { optionsHtml += '<option value="' + it.id + '">[' + it.rarityLabel + "] " + escapeHtml(it.name) + " (+" + it.available + ")</option>"; });
        return (
          '<div class="bot-slot slot-' + slotType + '">' + icon + '<span>' + label + '</span><select data-target="' + target + '" data-slot="' + slotType + '">' + optionsHtml + "</select></div>"
        );
      }

      // 봇의 "등급"은 가챠 결과(gacha_rarity)로만 정해진다 — 예전엔 지금 장착된 3개 중 가장
      // 희귀한 걸로 매번 다시 계산했는데, 그러면 가챠를 한 번도 안 돌리고 그냥 인벤토리에 있던
      // 아이템을 수동으로 꽂기만 해도 등급이 바뀌어버려서 "등급 = 가챠 실력/운"이라는 의미가
      // 없어졌다. 실제 전투 스탯(statLine)은 지금 장착된 것 그대로 정확히 반영하되, 등급
      // 배지/발광 효과만 별도로 "가장 최근 가챠 결과"를 기준으로 삼는다.
      function gachaRarityInfo(b) {
        if (!b.gacha_rarity) return null;
        return { rarity: b.gacha_rarity, rarityLabel: b.gachaRarityLabel, rarityColor: b.gachaRarityColor };
      }
      function botCardStyleAttrs(rarityInfo) {
        if (!rarityInfo) return { style: "", cls: "", tag: "" };
        const glow = ["legendary", "mythic", "secret", "forbidden", "abyssal"].indexOf(rarityInfo.rarity) !== -1;
        return {
          style: 'style="border-color:' + rarityInfo.rarityColor + ';--glow-color:' + rarityInfo.rarityColor + ';"',
          cls: glow ? " glow-pulse" : "",
          tag: '<div class="bot-card-rarity-tag" style="color:' + rarityInfo.rarityColor + ';">' + rarityInfo.rarityLabel + " GRADE</div>",
        };
      }
      function gachaRow(botId) {
        let html = '<div class="bot-gacha-row">' + Object.keys(BOT_GACHA_META).map((tier) => {
          const m = BOT_GACHA_META[tier];
          return '<button class="bot-gacha-btn" data-gacha="' + botId + '" data-tier="' + tier + '"' + (state.pocketCoins < m.price ? " disabled" : "") + ">" + m.label + "<br>💰" + fmt(m.price) + "</button>";
        }).join("") + "</div>";
        // 자동 뽑기(연구 해금 시에만 노출) — 가챠 등급 + 목표 등급을 골라 그 등급이 나올
        // 때까지 서버가 알아서 반복한다. 실제 장착 아이템(equipped_*)은 여전히 안 건드린다.
        if (research.autoRollUnlocked) {
          const tierOptions = Object.keys(BOT_GACHA_META).map((tier) => '<option value="' + tier + '">' + BOT_GACHA_META[tier].label + "</option>").join("");
          const rarityOptions = RARITY_ORDER_CLIENT.map((rr) => '<option value="' + rr + '">' + research.rarityLabels[rr] + "</option>").join("");
          html += '<div class="bot-gacha-auto-row">' +
            '<select data-auto-tier="' + botId + '">' + tierOptions + "</select>" +
            '<select data-auto-rarity="' + botId + '">' + rarityOptions + "</select>" +
            '<button class="bot-gacha-auto-btn" data-auto-gacha="' + botId + '">🎯 목표까지 자동</button>' +
            "</div>";
        }
        return html;
      }
      function statLine(stats) {
        return '<div class="bot-stat-line"><span>⚔️ ATK <b>' + stats.atk + '</b></span><span>🛡️ DEF <b>' + stats.def + '</b></span><span>💥 CRIT <b>' + stats.crit + '%</b></span></div>';
      }
      // 경비병 배치 — "나와 함께"(개인 전투력에 합산, 기본값) 또는 내가 정복한 야생 행성(홈
      // 제외) 중 하나. 배치하면 그 순간부터 이 봇 스탯은 위 statLine에 안 잡히고(개인 전투력
      // 계산에서 서버가 빼버림) 그 행성 하나의 방어에만 들어간다.
      function stationRow(bot) {
        const opts = data.stationOptions || [];
        // 봇 구역/사람 구역 개편으로 야생 행성을 아예 소유할 수 없어져서(항상 봇 소유) 배치
        // 대상이 없다 — 옵션이 하나도 없으면 "나와 함께"만 있는 무의미한 드롭다운을 아예 숨긴다.
        if (!opts.length) return "";
        const max = data.garrisonMax || 3;
        let html = '<option value=""' + (!bot.stationed_planet_id ? " selected" : "") + ">🧑‍💻 나와 함께 (개인 전투력)</option>";
        opts.forEach((p) => {
          const isCurrent = bot.stationed_planet_id === p.id;
          const full = !isCurrent && p.garrisonCount >= max;
          html += '<option value="' + p.id + '"' + (isCurrent ? " selected" : "") + (full ? " disabled" : "") + ">🪐 " + escapeHtml(p.name) + " (경비병 " + p.garrisonCount + "/" + max + ")</option>";
        });
        return '<div class="bot-slot slot-station"><span>배치</span><select data-station="' + bot.id + '">' + html + "</select></div>";
      }

      let html = '<div class="bot-card player"><div class="bot-card-title">🧑‍💻 YOU</div>' +
        statLine(data.player.stats) +
        slotRow("player", "weapon", "무장", data.player.equippedWeapon) +
        slotRow("player", "armor", "방어", data.player.equippedArmor) +
        slotRow("player", "core", "코어", data.player.equippedCore) +
        "</div>";

      data.bots.forEach((b, i) => {
        const rarityInfo = gachaRarityInfo(b);
        const attrs = botCardStyleAttrs(rarityInfo);
        const sellRefund = Math.floor((b.recruit_cost || 2000) * (data.botSellRate || 0.5));
        const stationedPlanet = b.stationed_planet_id ? (data.stationOptions || []).find((p) => p.id === b.stationed_planet_id) : null;
        const stationedNote = stationedPlanet
          ? '<div class="dim" style="font-size:10px;margin-bottom:6px;">🪐 ' + escapeHtml(stationedPlanet.name) + '에 경비병으로 배치됨 — 개인 전투력엔 반영 안 됨</div>'
          : "";
        // 봇 아이콘도 이모티콘 하나로 퉁치지 않고 등급(gacha_rarity)에 따라 도안 자체가
        // 달라진다(요청 반영) — 아직 가챠를 한 번도 안 돌린 봇은 회색 common 도안으로 표시.
        const botIcon = botIconHtml(rarityInfo ? rarityInfo.rarity : "common", rarityInfo ? rarityInfo.rarityColor : "var(--sub)", 20);
        html += '<div class="bot-card' + attrs.cls + '" ' + attrs.style + '>' +
          '<div class="bot-card-title"><span class="bot-card-title-name">' + botIcon + " BOT #" + (i + 1) + "</span>" +
          '<button class="bot-sell-btn" data-sell="' + b.id + '" title="봇 되팔기">되팔기 💰' + fmt(sellRefund) + "</button></div>" +
          attrs.tag +
          statLine(b.stats) +
          stationedNote +
          slotRow(String(b.id), "weapon", "무장", b.equipped_weapon) +
          slotRow(String(b.id), "armor", "방어", b.equipped_armor) +
          slotRow(String(b.id), "core", "코어", b.equipped_core) +
          stationRow(b) +
          gachaRow(b.id) +
          "</div>";
      });

      html += '<div class="bot-recruit-card">' +
        (data.nextBotCost != null
          ? '<p>다음 봇 모집 비용</p><p class="accent-text" style="font-size:16px;">💰 ' + fmt(data.nextBotCost) + '</p><button class="btn-primary" id="recruitBotBtn">모집하기</button>'
          : '<p>최대 봇 수(' + data.maxBots + '기)에 도달했습니다.</p>') +
        "</div>";

      el.innerHTML = html;

      el.querySelectorAll("select[data-target]").forEach((sel) => {
        sel.addEventListener("change", async () => {
          const target = sel.dataset.target, slot = sel.dataset.slot, itemId = sel.value;
          try {
            if (!itemId) await api("/bots/unequip", { method: "POST", body: { target, slot } });
            else await api("/bots/equip", { method: "POST", body: { target, slot, itemId } });
            toast("장착 정보가 갱신됐습니다.");
            await refreshState(); renderBotsTab();
          } catch (e) { toast(e.message, true); renderBotsTab(); }
        });
      });
      el.querySelectorAll("select[data-station]").forEach((sel) => {
        sel.addEventListener("change", async () => {
          const botId = sel.dataset.station, planetId = sel.value || null;
          try {
            const r = await api("/bots/station", { method: "POST", body: { botId, planetId } });
            toast(r.stationedPlanetId ? "🛡️ " + r.planetName + "에 경비병으로 배치했습니다." : "배치를 해제했습니다 — 다시 개인 전투력에 합산됩니다.");
            await refreshState(); renderBotsTab();
          } catch (e) { toast(e.message, true); renderBotsTab(); }
        });
      });
      el.querySelectorAll("button[data-gacha]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/bots/gacha", { method: "POST", body: { botId: btn.dataset.gacha, tier: btn.dataset.tier } });
            // 가챠는 이제 순수 랜덤 — 기존 결과가 뭐였든 상관없이 무장/방어/코어 3슬롯의
            // "가상 등급"이 전부 새로 뽑힌 걸로 교체된다(예전엔 기존 것보다 안 좋으면
            // 유지했는데, 그 로직이 "어비샬을 달고 있으면 가챠가 영원히 어비샬만 나오는
            // 것처럼 보이는" 버그였음). 실제 장착 아이템(equipped_*)은 절대 안 바뀐다 —
            // 가챠는 그 봇의 등급만 올려줄 뿐 물리적으로 꽂힌 장비는 그대로다.
            toast("🎰 가챠 결과: [" + r.rarityLabel + "] 등급! (실제 장착 장비는 그대로, 등급 보너스만 갱신됨)");
            state.pocketCoins = r.pocketCoins; renderHeader(); renderBotsTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      el.querySelectorAll("button[data-auto-gacha]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const botId = btn.dataset.autoGacha;
          const tierSel = el.querySelector('select[data-auto-tier="' + botId + '"]');
          const raritySel = el.querySelector('select[data-auto-rarity="' + botId + '"]');
          btn.disabled = true;
          const original = btn.textContent;
          btn.textContent = "자동 뽑는 중...";
          try {
            const r = await api("/bots/gacha", { method: "POST", body: { botId: botId, tier: tierSel.value, autoTarget: raritySel.value } });
            if (r.autoFound) {
              toast("🎯 자동 뽑기 성공! " + fmt(r.attempts) + "회 만에 [" + r.rarityLabel + "] 등급 획득 (실제 장착 장비는 그대로)");
            } else {
              toast("자동 뽑기 " + fmt(r.attempts) + "회 시도했지만 목표 등급을 못 얻었습니다(코인 부족 또는 시도 한도 도달) — 코인을 모아 다시 시도하세요.", true);
            }
            state.pocketCoins = r.pocketCoins; renderHeader(); renderBotsTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = original; }
        });
      });
      el.querySelectorAll("button[data-sell]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/bots/sell", { method: "POST", body: { botId: btn.dataset.sell } });
            toast("+" + fmt(r.refund) + " 코인 환불, 봇을 되팔았습니다.");
            state.pocketCoins = r.pocketCoins; renderHeader(); renderBotsTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      const recruitBtn = el.querySelector("#recruitBotBtn");
      if (recruitBtn) recruitBtn.addEventListener("click", async () => {
        recruitBtn.disabled = true;
        try { const r = await api("/bots/recruit", { method: "POST" }); toast("봇을 모집했습니다!"); state.pocketCoins = r.pocketCoins; renderHeader(); renderBotsTab(); }
        catch (e) { toast(e.message, true); recruitBtn.disabled = false; }
      });
    } catch (e) { el.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // ── Property ──
  async function renderPropertyTab() {
    const panel = $("panel-property");
    const grid = panel.querySelector(".property-grid");
    grid.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const data = await api("/property");
      $("propertyRate").textContent = fmt(data.ratePerHour) + " / hr";
      $("propertyPending").textContent = fmt(data.pendingCoins);
      const atCap = data.totalOwned >= data.maxDevices;
      grid.innerHTML =
        '<p class="dim" style="grid-column:1/-1;margin-bottom:4px;">보유 기기 ' + data.totalOwned + " / " + data.maxDevices + "</p>" +
        data.devices.map((d) => (
          '<div class="property-card" style="border-left-color:' + d.tierColor + ';">' +
          '<div>' + propertyIconHtml(d.id, d.tierColor, 28) + "</div>" +
          '<div class="property-card-name">' + escapeHtml(d.name) + "</div>" +
          '<div class="property-card-rate">💾 ' + fmt(d.coinsPerHour) + " 코인/시간</div>" +
          '<div class="property-card-owned">보유 ' + d.owned + "대</div>" +
          '<div class="property-card-price">💰 ' + fmt(d.price) + "</div>" +
          '<button class="btn-primary" data-buydevice="' + d.id + '"' + (atCap || state.pocketCoins < d.price ? " disabled" : "") + ">" +
          (atCap ? "한도 도달" : "구매") + "</button>" +
          (d.owned > 0 ? '<button class="btn-ghost" data-selldevice="' + d.id + '" style="margin-top:6px;">되팔기 (💰' + fmt(Math.floor(d.price * 0.5)) + ")</button>" : "") +
          "</div>"
        )).join("");
      grid.querySelectorAll("button[data-buydevice]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/property/buy", { method: "POST", body: { deviceId: btn.dataset.buydevice } });
            toast("기기 구매 완료!"); state.pocketCoins = r.pocketCoins; renderHeader(); renderPropertyTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      grid.querySelectorAll("button[data-selldevice]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/property/sell", { method: "POST", body: { deviceId: btn.dataset.selldevice } });
            toast("+" + fmt(r.refund) + " 코인 환불"); state.pocketCoins = r.pocketCoins; renderHeader(); renderPropertyTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // COLLECT 버튼이 실제로는 아무 리스너도 안 달려 있어서 눌러도 아무 일도 안 일어났던
  // 버그 — "대기 중 수익"은 화면에 계속 쌓이는 게 보이는데 실제 코인은 절대 안 들어오는
  // 것처럼 느껴졌던 원인이 이거였다. 버튼 자체는 .property-grid 밖의 고정 마크업이라
  // renderPropertyTab이 다시 그릴 때마다 새로 만들어지지 않으므로, 리스너는 한 번만 건다.
  function initPropertyButtons() {
    const btn = $("propertyCollectBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await api("/property/collect", { method: "POST" });
        toast(r.collected > 0 ? "+" + fmt(r.collected) + " 코인 수거 완료!" : "수거할 대기 수익이 없습니다.");
        state = r.state; renderHeader(); renderPropertyTab();
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
  }

  // ── ⑤ Secure Bank ──
  function renderBankTab() {
    if (!state) return;
    $("bankPocket").textContent = fmt(state.pocketCoins);
    $("bankVault").textContent = fmt(state.bankCoins);
  }

  // ── Research — 다이아로 상점 행운/정찰 탐사선 등 여러 연구를 진행한다(원정 연구는
  //    삭제됨 — 요청 반영: "원정 연구를 없애줘"). ──
  // $(id)가 null이어도 조용히 무시한다 — 이 탭의 여러 버튼이 "한 번 해금/맥스가 되면
  // 그 안의 <span>을 통째로 textContent로 갈아치우는" 패턴을 쓰는데(예: "이미 해금됨"),
  // 그러면 그 <span>이 영구히 사라지므로 이후 렌더에서 그 span을 다시 찾으려 하면 null이라
  // "Cannot set properties of null" 에러가 났었다(실제 버그였음 — /research/expedition-cost
  // span이 원정 연구를 이미 해금한 계정에서 매번 렌더할 때마다 이 오류를 냈다). 이제 그런
  // 조건부 텍스트는 항상 "그 상태일 때만" 건드리도록 순서를 맞췄고, 혹시 모를 케이스를
  // 대비해 조회 자체도 이 헬퍼로 감쌌다.
  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  async function renderResearchTab() {
    const panel = $("panel-research");
    try {
      const r = await api("/research");
      setText("researchDiamonds", "💎 " + fmt(r.diamonds));
      setText("researchShopLevelTag", "Lv." + r.shopLevel);
      setText("researchShopCost", fmt(r.shopUpgradeCost));
      const upBtn = $("researchShopUpgradeBtn");
      upBtn.disabled = r.diamonds < r.shopUpgradeCost;
      $("researchRarityTable").innerHTML = RARITY_ORDER_CLIENT.map((rarity) => (
        '<div class="research-rarity-row" style="color:' + r.rarityColors[rarity] + ';">' + r.rarityLabels[rarity] +
        "<b>" + Math.round(r.rarityChances[rarity] * 1000) / 10 + "%</b></div>"
      )).join("");

      setText("researchSlotsLevelTag", "Lv." + r.slotsLevel);
      setText("researchSlotsCurrent", r.slotsCurrentMin);
      const slotsBtn = $("researchSlotsUpgradeBtn");
      if (r.slotsUpgradeCost == null) {
        slotsBtn.disabled = true;
        slotsBtn.textContent = "최대 레벨 (진열 " + r.slotsCurrentMin + "개)";
      } else {
        slotsBtn.innerHTML = "연구하기 (💎 <span id=\"researchSlotsCost\">" + fmt(r.slotsUpgradeCost) + "</span>)";
        slotsBtn.disabled = r.diamonds < r.slotsUpgradeCost;
      }

      // 영구 EXP 부스터 — 딱 3레벨, 다이아 500/750/1000으로 x1.2/x1.5/x2(환생과 무관하게 처음부터 가능).
      setText("researchExpBoosterLevelTag", "Lv." + r.expBoosterLevel);
      setText("researchExpBoosterCurrent", "x" + r.expBoosterMult);
      const expBoosterBtn = $("researchExpBoosterUpgradeBtn");
      if (r.expBoosterUpgradeCost == null) {
        expBoosterBtn.disabled = true;
        expBoosterBtn.textContent = "최대 레벨 (x" + r.expBoosterMult + ")";
      } else {
        expBoosterBtn.innerHTML = "연구하기 → x" + r.expBoosterNextMult + " (💎 <span>" + fmt(r.expBoosterUpgradeCost) + "</span>)";
        expBoosterBtn.disabled = r.diamonds < r.expBoosterUpgradeCost;
      }

      // 정찰 탐사선 — 레벨이 오를수록 노릴 수 있는 최고 등급이 풀리고 도착 시간이 짧아지며
      // 최고 레벨에서 결과 개수가 2개로 늘어난다.
      setText("researchProbeLevelTag", "Lv." + r.probeLevel);
      const unlockedTiers = r.probeUnlockedTiers || [];
      setText("researchProbeUnlockedTier", PLANET_TIER_LABELS[unlockedTiers[unlockedTiers.length - 1]] || "약함");
      setText("researchProbeResultCount", r.probeCurrentResultCount);
      const probeBtn = $("researchProbeUpgradeBtn");
      if (r.probeUpgradeCost == null) {
        probeBtn.disabled = true;
        probeBtn.textContent = "최대 레벨 (" + PLANET_TIER_LABELS[unlockedTiers[unlockedTiers.length - 1]] + "까지 · 결과 " + r.probeCurrentResultCount + "개)";
      } else {
        probeBtn.innerHTML = "연구하기 → " + escapeHtml(r.probeNextTier || "") + " 해금 (💎 <span>" + fmt(r.probeUpgradeCost) + "</span>)";
        probeBtn.disabled = r.diamonds < r.probeUpgradeCost;
      }

      // Property 슬롯 확장 — 딱 3레벨, 다이아 1000/2000/4000으로 최대 보유 기기 +1개씩.
      setText("researchPropertySlotsLevelTag", "Lv." + r.propertySlotsLevel);
      setText("researchPropertySlotsCurrent", r.propertySlotsCurrentMax);
      const propSlotsBtn = $("researchPropertySlotsUpgradeBtn");
      if (r.propertySlotsUpgradeCost == null) {
        propSlotsBtn.disabled = true;
        propSlotsBtn.textContent = "최대 레벨 (최대 " + r.propertySlotsCurrentMax + "개)";
      } else {
        propSlotsBtn.innerHTML = "연구하기 (💎 <span>" + fmt(r.propertySlotsUpgradeCost) + "</span>)";
        propSlotsBtn.disabled = r.diamonds < r.propertySlotsUpgradeCost;
      }

      // 자동 뽑기 — 다이아 5000개 1회성 해금.
      const autoRollBtn = $("researchAutoRollUnlockBtn");
      if (r.autoRollUnlocked) {
        setText("researchAutoRollLevelTag", "해금됨");
        autoRollBtn.disabled = true;
        autoRollBtn.textContent = "해금 완료";
      } else {
        setText("researchAutoRollLevelTag", "미해금");
        autoRollBtn.innerHTML = "해금하기 (💎 <span>" + fmt(r.autoRollUnlockCost) + "</span>)";
        autoRollBtn.disabled = r.diamonds < r.autoRollUnlockCost;
      }

      // 보호막 파쇄기 — 다이아 10000개 1회성 해금.
      const shieldBreakerBtn = $("researchShieldBreakerUnlockBtn");
      if (r.shieldBreakerUnlocked) {
        setText("researchShieldBreakerLevelTag", "해금됨");
        shieldBreakerBtn.disabled = true;
        shieldBreakerBtn.textContent = "해금 완료";
      } else {
        setText("researchShieldBreakerLevelTag", "미해금");
        shieldBreakerBtn.innerHTML = "해금하기 (💎 <span>" + fmt(r.shieldBreakerUnlockCost) + "</span>)";
        shieldBreakerBtn.disabled = r.diamonds < r.shieldBreakerUnlockCost;
      }
    } catch (e) { panel.querySelector(".research-node").insertAdjacentHTML("afterend", '<p class="dim">' + escapeHtml(e.message) + "</p>"); }
  }

  function initResearchButtons() {
    const upBtn = $("researchShopUpgradeBtn");
    if (upBtn) upBtn.addEventListener("click", async () => {
      upBtn.disabled = true;
      try {
        const r = await api("/research/shop-upgrade", { method: "POST" });
        toast("상점 행운 연구 Lv." + r.shopLevel + " 달성!");
        renderResearchTab();
      } catch (e) { toast(e.message, true); upBtn.disabled = false; }
    });
    const slotsBtn = $("researchSlotsUpgradeBtn");
    if (slotsBtn) slotsBtn.addEventListener("click", async () => {
      slotsBtn.disabled = true;
      try {
        const r = await api("/research/slots-upgrade", { method: "POST" });
        toast("🗄️ 상점 진열대 확장 Lv." + r.slotsLevel + " 달성! (최소 " + r.slotsCurrentMin + "개)");
        renderResearchTab();
      } catch (e) { toast(e.message, true); slotsBtn.disabled = false; }
    });
    const expBoosterBtn = $("researchExpBoosterUpgradeBtn");
    if (expBoosterBtn) expBoosterBtn.addEventListener("click", async () => {
      expBoosterBtn.disabled = true;
      try {
        const r = await api("/research/exp-booster-upgrade", { method: "POST" });
        toast("🧪 영구 EXP 부스터 Lv." + r.expBoosterLevel + " 달성! (모든 경험치 x" + r.expBoosterMult + ")");
        renderResearchTab();
      } catch (e) { toast(e.message, true); expBoosterBtn.disabled = false; }
    });
    const probeBtn = $("researchProbeUpgradeBtn");
    if (probeBtn) probeBtn.addEventListener("click", async () => {
      probeBtn.disabled = true;
      try {
        const r = await api("/research/probe-upgrade", { method: "POST" });
        toast("🛸 정찰 탐사선 Lv." + r.probeLevel + " 달성!");
        renderResearchTab();
      } catch (e) { toast(e.message, true); probeBtn.disabled = false; }
    });
    const propSlotsBtn = $("researchPropertySlotsUpgradeBtn");
    if (propSlotsBtn) propSlotsBtn.addEventListener("click", async () => {
      propSlotsBtn.disabled = true;
      try {
        const r = await api("/research/property-slots-upgrade", { method: "POST" });
        toast("🏭 Property 슬롯 확장 Lv." + r.propertySlotsLevel + " 달성! (최대 " + r.propertySlotsCurrentMax + "개)");
        renderResearchTab();
      } catch (e) { toast(e.message, true); propSlotsBtn.disabled = false; }
    });
    const autoRollBtn = $("researchAutoRollUnlockBtn");
    if (autoRollBtn) autoRollBtn.addEventListener("click", async () => {
      autoRollBtn.disabled = true;
      try {
        await api("/research/auto-roll-unlock", { method: "POST" });
        toast("🎯 자동 뽑기를 해금했습니다! BOT 탭/Hardware Shop에서 사용할 수 있습니다.");
        renderResearchTab();
      } catch (e) { toast(e.message, true); autoRollBtn.disabled = false; }
    });
    const shieldBreakerBtn = $("researchShieldBreakerUnlockBtn");
    if (shieldBreakerBtn) shieldBreakerBtn.addEventListener("click", async () => {
      shieldBreakerBtn.disabled = true;
      try {
        await api("/research/shield-breaker-unlock", { method: "POST" });
        toast("💥 보호막 파쇄기를 해금했습니다! PvP 탭에서 사용할 수 있습니다.");
        renderResearchTab();
      } catch (e) { toast(e.message, true); shieldBreakerBtn.disabled = false; }
    });
  }

  // ── Enchant — 무기/방어/코어 전체 카탈로그를 보여주고, 보유한(qty>0) 것만 강화 버튼이
  //    활성화된다. 서버가 이미 다음 레벨 비용까지 계산해서 내려주므로 프론트는 그대로 표시만. ──
  async function renderEnchantTab() {
    const grid = $("enchantGrid");
    try {
      const { items } = await api("/enchants");
      if (!items.length) { grid.innerHTML = '<p class="dim">아직 강화할 수 있는 장비가 없습니다 — 상점에서 무기/방어/코어를 하나라도 구해오면 여기 나타납니다.</p>'; return; }
      grid.innerHTML = items.map((it) => {
        const pct = Math.min(100, (it.level / it.maxLevel) * 100);
        const maxed = it.level >= it.maxLevel;
        const canAfford = it.nextCost != null && state.pocketCoins >= it.nextCost;
        const disabled = it.owned <= 0 || maxed || !canAfford;
        const btnLabel = maxed ? "최대 레벨" : it.owned <= 0 ? "미보유" : "강화 (💰 " + fmt(it.nextCost) + ")";
        return (
          '<div class="enchant-card" style="border-left-color:' + it.typeColor + '">' +
          '<div>' + itemIconHtml(it.id, it.rarityColor, 30, it.rarity) + "</div>" +
          '<div class="enchant-card-name">' + escapeHtml(it.name) + "</div>" +
          '<div class="rarity-badge" style="color:' + it.rarityColor + '">' + it.rarityLabel + "</div>" +
          '<div class="dim" style="font-size:10px;">보유 ' + it.owned + "개 · +" + it.bonusPct.toFixed(0) + "% 적용 중</div>" +
          '<div class="enchant-level-track"><div class="enchant-level-fill" style="width:' + pct + '%;"></div></div>' +
          '<div class="enchant-level-text">Lv.' + it.level + " / " + it.maxLevel + "</div>" +
          '<button class="btn-primary" data-enchant="' + it.id + '"' + (disabled ? " disabled" : "") + ">" + btnLabel + "</button>" +
          "</div>"
        );
      }).join("");
      grid.querySelectorAll("button[data-enchant]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/enchants/upgrade", { method: "POST", body: { itemId: btn.dataset.enchant } });
            toast("🧬 Lv." + r.level + " 강화 완료! (+" + r.bonusPct.toFixed(0) + "%)");
            state.pocketCoins = r.pocketCoins; renderHeader(); renderEnchantTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // ── 환생 상점 — 환생석(환생할 때만 얻는 전용 화폐)으로 사는 1회성 소장품. 업적 카드와
  //    똑같은 그리드/카드 마크업을 재사용한다(디자인 일관성 + 새 CSS 불필요). ──
  async function renderRebirthShopTab() {
    const grid = $("rebirthShopGrid");
    try {
      const { stones, items, equippedTitleId } = await api("/rebirth-shop");
      $("rebirthShopStones").textContent = "💠 " + stones;
      const typeIcon = { frame: "🖼️ ", title: "🏷️ ", stat_boost: "⚡ ", diamond_grant: "💎 " };
      grid.innerHTML = items.map((it) => {
        const canAfford = stones >= it.cost;
        const isTitle = it.type === "title";
        const isGrant = it.type === "diamond_grant";
        const equipped = isTitle && equippedTitleId === it.id;
        let btnHtml;
        if (it.owned && isTitle) {
          btnHtml = equipped
            ? '<button class="btn-ghost" data-unequip-title="1" disabled>장착 중</button>'
            : '<button class="btn-primary" data-equip-title="' + it.id + '">칭호 장착</button>';
        } else if (it.owned) {
          btnHtml = '<button class="btn-ghost" disabled>' + (isGrant ? "수령 완료" : "보유 중") + '</button>';
        } else {
          btnHtml = '<button class="btn-primary" data-buy-rebirth-item="' + it.id + '"' + (canAfford ? "" : " disabled") + '>' + (isGrant ? "수령" : "구매") + ' (💠' + it.cost + ")</button>";
        }
        return (
          '<div class="achievement-card" style="border-left-color:' + (it.owned ? "var(--accent)" : "var(--border)") + '">' +
          '<div style="font-weight:bold;margin-bottom:4px;">' + (typeIcon[it.type] || "✨ ") + escapeHtml(it.name) + "</div>" +
          '<div class="dim" style="margin-bottom:10px;">' + escapeHtml(it.desc) + "</div>" +
          btnHtml +
          "</div>"
        );
      }).join("") || '<p class="dim">준비된 아이템이 없습니다.</p>';

      grid.querySelectorAll("button[data-buy-rebirth-item]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/rebirth-shop/buy", { method: "POST", body: { itemId: btn.dataset.buyRebirthItem } });
            const boughtItem = items.find((i) => i.id === r.itemId);
            toast("✨ " + (boughtItem && boughtItem.type === "diamond_grant" ? "다이아 💎" + boughtItem.diamonds + " 수령!" : "구매 완료!"));
            renderRebirthShopTab();
            refreshState();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      grid.querySelectorAll("button[data-equip-title]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await api("/achievements/set-title", { method: "POST", body: { id: btn.dataset.equipTitle } });
            toast("🏷️ 칭호를 장착했습니다.");
            renderRebirthShopTab();
            refreshState();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // ── 현상금 게시판(Bounty Board) — 8시간마다 통째로 새로 뽑히는 개인별 현상금 5개.
  //    진행도/목표는 서버가 계산해서 내려주고, 프론트는 그대로 표시만 한다(enchant/rebirth
  //    shop 탭과 동일 패턴 — achievement-card 그리드 재사용). ──
  let bountyRefreshAt = 0;
  async function renderBountyTab() {
    const grid = $("bountyGrid");
    try {
      const { items, refreshAt } = await api("/bounties");
      bountyRefreshAt = refreshAt;
      grid.innerHTML = items.map((b) => {
        const pct = Math.min(100, (b.progress / b.goal) * 100);
        let btnHtml;
        if (b.claimed) btnHtml = '<button class="btn-ghost" disabled>청구 완료</button>';
        else if (b.ready) btnHtml = '<button class="btn-primary" data-claim-bounty="' + b.id + '">청구하기</button>';
        else btnHtml = '<button class="btn-ghost" disabled>진행 중 (' + b.progress + "/" + b.goal + ")</button>";
        return (
          '<div class="achievement-card" style="border-left-color:' + (b.claimed ? "var(--accent)" : b.ready ? "var(--stamina)" : "var(--border)") + '">' +
          '<div style="font-weight:bold;margin-bottom:4px;">' + escapeHtml(b.label) + "</div>" +
          '<div class="enchant-level-track" style="margin-bottom:6px;"><div class="enchant-level-fill" style="width:' + pct + '%;"></div></div>' +
          '<div class="dim" style="margin-bottom:10px;">진행 ' + b.progress + " / " + b.goal + " · 보상 💰" + fmt(b.coin) + "</div>" +
          btnHtml +
          "</div>"
        );
      }).join("") || '<p class="dim">지금 뜬 현상금이 없습니다.</p>';
      grid.querySelectorAll("button[data-claim-bounty]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/bounties/claim", { method: "POST", body: { id: btn.dataset.claimBounty } });
            toast("📋 현상금 완료! +" + fmt(r.reward) + " 코인 · EXP +" + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : ""));
            renderBountyTab();
            refreshState();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // ── Trade — 유저 간 코인+아이템 거래. "내가 줄 것"은 내 인벤토리(장착 중인 건 빼고 남는
  //    수량)에서 고르고, "내가 받을 것"은 상대 인벤토리를 볼 수 없으니 전체 카탈로그에서
  //    고른다(상대가 실제로 갖고 있는지는 승낙 시점에 서버가 검증). ──
  let tradeOfferItems = [];
  let tradeRequestItems = [];

  function itemSelectOptions(items, showAvailable) {
    return items.map((it) => (
      '<option value="' + it.id + '">[' + it.rarityLabel + "] " + escapeHtml(it.name) + (showAvailable ? " (보유 " + it.available + ")" : "") + "</option>"
    )).join("");
  }

  function renderTradeItemLists() {
    function chip(it, idx, side) {
      return '<div class="trade-item-chip"><span>' + escapeHtml(it.name) + " x" + it.qty + '</span><button data-remove="' + side + ":" + idx + '">×</button></div>';
    }
    $("tradeOfferItemList").innerHTML = tradeOfferItems.map((it, i) => chip(it, i, "offer")).join("");
    $("tradeRequestItemList").innerHTML = tradeRequestItems.map((it, i) => chip(it, i, "request")).join("");
    document.querySelectorAll("#panel-trade button[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [side, idxStr] = btn.dataset.remove.split(":");
        const idx = parseInt(idxStr, 10);
        if (side === "offer") tradeOfferItems.splice(idx, 1); else tradeRequestItems.splice(idx, 1);
        renderTradeItemLists();
      });
    });
  }

  async function renderTradeTab() {
    const panel = $("panel-trade");
    try {
      const [inv, catalog, data] = await Promise.all([api("/inventory"), getShopCatalog(), api("/trade")]);
      $("tradeCoinCap").textContent = fmt(data.coinCap);

      const ownable = inv.items.filter((it) => it.available > 0);
      $("tradeOfferItemSelect").innerHTML = '<option value="">아이템 선택...</option>' + itemSelectOptions(ownable, true);
      $("tradeRequestItemSelect").innerHTML = '<option value="">아이템 선택...</option>' + itemSelectOptions(Object.values(catalog), false);
      renderTradeItemLists();

      function itemsLabel(items) {
        return items.map((it) => { const c = catalog[it.itemId]; return escapeHtml(c ? c.name : it.itemId) + " x" + it.qty; }).join(", ");
      }
      function sideLine(coins, items) {
        const parts = [];
        if (coins > 0) parts.push("💰" + fmt(coins));
        const il = itemsLabel(items);
        if (il) parts.push(il);
        return parts.length ? parts.join(" + ") : "(없음)";
      }

      $("tradeIncomingList").innerHTML = data.incoming.length ? data.incoming.map((t) => (
        '<div class="trade-row incoming">' +
        '<div class="trade-row-parties">' + escapeHtml(t.fromName) + " → 나</div>" +
        '<div class="trade-row-side">상대가 줌: ' + sideLine(t.offerCoins, t.offerItems) + "</div>" +
        '<div class="trade-row-side">내가 줘야 함: ' + sideLine(t.requestCoins, t.requestItems) + "</div>" +
        '<div class="trade-row-actions"><button class="btn-primary" data-accept="' + t.id + '">승낙</button><button class="btn-ghost" data-decline="' + t.id + '">거절</button></div>' +
        "</div>"
      )).join("") : '<p class="dim">받은 요청이 없습니다.</p>';

      $("tradeOutgoingList").innerHTML = data.outgoing.length ? data.outgoing.map((t) => (
        '<div class="trade-row outgoing">' +
        '<div class="trade-row-parties">나 → ' + escapeHtml(t.toName) + "</div>" +
        '<div class="trade-row-side">내가 줌: ' + sideLine(t.offerCoins, t.offerItems) + "</div>" +
        '<div class="trade-row-side">상대가 줘야 함: ' + sideLine(t.requestCoins, t.requestItems) + "</div>" +
        '<div class="trade-row-actions"><button class="btn-ghost" data-cancel="' + t.id + '">취소</button></div>' +
        "</div>"
      )).join("") : '<p class="dim">보낸 요청이 없습니다.</p>';

      $("tradeHistoryList").innerHTML = data.history.length ? data.history.map((t) => {
        const statusLabel = t.status === "accepted" ? '<span style="color:var(--energy);">✅ 성사</span>' : t.status === "declined" ? '<span style="color:var(--danger);">❌ 거절됨</span>' : '<span class="dim">🚫 취소됨</span>';
        return '<div class="trade-row"><div class="trade-row-parties">' + escapeHtml(t.fromName) + " ↔ " + escapeHtml(t.toName) + " · " + statusLabel + "</div></div>";
      }).join("") : '<p class="dim">거래 내역이 없습니다.</p>';

      panel.querySelectorAll("button[data-accept]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/trade/accept", { method: "POST", body: { tradeId: btn.dataset.accept } });
            toast("거래 성사!"); state = r.state; renderHeader(); renderTradeTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      panel.querySelectorAll("button[data-decline]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try { await api("/trade/decline", { method: "POST", body: { tradeId: btn.dataset.decline } }); toast("거절했습니다."); renderTradeTab(); }
          catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      panel.querySelectorAll("button[data-cancel]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try { await api("/trade/cancel", { method: "POST", body: { tradeId: btn.dataset.cancel } }); toast("취소했습니다."); renderTradeTab(); }
          catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { $("tradeIncomingList").innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  function initTradeButtons() {
    const addOffer = $("tradeOfferItemAddBtn");
    if (addOffer) addOffer.addEventListener("click", async () => {
      const sel = $("tradeOfferItemSelect");
      const itemId = sel.value;
      if (!itemId) return;
      const qty = Math.max(1, parseInt($("tradeOfferItemQty").value, 10) || 1);
      const catalog = await getShopCatalog();
      const inv = await api("/inventory");
      const owned = inv.items.find((it) => it.id === itemId);
      if (!owned || qty > owned.available) return toast("보유 수량을 초과했습니다.", true);
      tradeOfferItems.push({ itemId: itemId, qty: qty, name: catalog[itemId] ? catalog[itemId].name : itemId });
      renderTradeItemLists();
    });
    const addRequest = $("tradeRequestItemAddBtn");
    if (addRequest) addRequest.addEventListener("click", async () => {
      const sel = $("tradeRequestItemSelect");
      const itemId = sel.value;
      if (!itemId) return;
      const qty = Math.max(1, parseInt($("tradeRequestItemQty").value, 10) || 1);
      const catalog = await getShopCatalog();
      tradeRequestItems.push({ itemId: itemId, qty: qty, name: catalog[itemId] ? catalog[itemId].name : itemId });
      renderTradeItemLists();
    });
    const sendBtn = $("tradeSendBtn");
    if (sendBtn) sendBtn.addEventListener("click", async () => {
      const toUserId = $("tradeToUserId").value.trim();
      if (!toUserId) return toast("상대 아이디를 입력하세요.", true);
      const offerCoins = parseInt($("tradeOfferCoins").value, 10) || 0;
      const requestCoins = parseInt($("tradeRequestCoins").value, 10) || 0;
      sendBtn.disabled = true;
      try {
        await api("/trade/request", {
          method: "POST",
          body: { toUserId: toUserId, offerCoins: offerCoins, offerItems: tradeOfferItems, requestCoins: requestCoins, requestItems: tradeRequestItems },
        });
        toast("거래 요청을 보냈습니다!");
        tradeOfferItems = []; tradeRequestItems = [];
        $("tradeToUserId").value = ""; $("tradeOfferCoins").value = ""; $("tradeRequestCoins").value = "";
        renderTradeTab();
      } catch (e) { toast(e.message, true); }
      sendBtn.disabled = false;
    });
  }

  // ── Club — 안 속해 있으면 생성/가입 화면, 속해 있으면 관리 화면. 내용이 완전히 갈려서
  // 그때그때 #clubContent를 통째로 새로 그린다(다른 탭들처럼 고정 마크업 + innerHTML 부분
  // 교체가 아니라). 버튼도 매번 새로 그려지므로 이벤트는 컨테이너에 위임해서 한 번만 건다. ──
  const RELATION_LABEL = { hostile: "⚔️ 적대", allied: "🤝 동맹", neutral: "· 중립", friendly: "🤝 우호 선언" };

  // 레이드 보스 초상화 — 이미지 생성 도구가 없는 환경이라 대신 SVG로 직접 그린 "컴퓨터
  // 그래픽" 일러스트. 보스 이름별로 색 테마만 다르게 입혀서(같은 형태, 다른 색) 최소한의
  // 구분감을 준다. HP가 깎일수록 흰색 균열 오버레이가 진해져서 데미지가 시각적으로도 쌓이는
  // 걸 보여준다.
  const RAID_BOSS_THEMES = {
    "제로데이 리바이어던": { c1: "#00e0ff", c2: "#0a4a5c" },
    "블랙아이스 콜로서스": { c1: "#8fd9ff", c2: "#1a2733" },
    "고스트 프로토콜 AI": { c1: "#c46bff", c2: "#2a0e4a" },
    "옵시디언 방화벽 수호자": { c1: "#ff8a3d", c2: "#4a2408" },
    "심연의 루트킷": { c1: "#ff3d68", c2: "#3a0a1a" },
  };
  function raidBossSvgHtml(bossName, hpPct) {
    const theme = RAID_BOSS_THEMES[bossName] || { c1: "#ff3d68", c2: "#3a0a1a" };
    const crackOpacity = (Math.max(0, Math.min(1, 1 - hpPct)) * 0.85).toFixed(2);
    return (
      '<svg viewBox="0 0 200 200" width="140" height="140" style="display:block;margin:0 auto 10px;">' +
      '<defs><radialGradient id="bossGlow" cx="50%" cy="45%" r="60%">' +
      '<stop offset="0%" stop-color="' + theme.c1 + '" stop-opacity="0.9"/>' +
      '<stop offset="60%" stop-color="' + theme.c2 + '" stop-opacity="0.6"/>' +
      '<stop offset="100%" stop-color="#05070a" stop-opacity="0"/>' +
      "</radialGradient></defs>" +
      '<circle cx="100" cy="100" r="95" fill="url(#bossGlow)"/>' +
      '<polygon points="100,20 165,55 165,145 100,180 35,145 35,55" fill="none" stroke="' + theme.c1 + '" stroke-width="3" opacity="0.7"/>' +
      '<polygon points="100,45 145,68 145,132 100,155 55,132 55,68" fill="#0d1117" stroke="' + theme.c1 + '" stroke-width="2"/>' +
      '<path d="M35,55 L10,40 M35,145 L10,160 M165,55 L190,40 M165,145 L190,160" stroke="#00ff9d" stroke-width="2" opacity="0.5"/>' +
      '<circle cx="10" cy="40" r="4" fill="#00ff9d"/><circle cx="10" cy="160" r="4" fill="#00ff9d"/>' +
      '<circle cx="190" cy="40" r="4" fill="#00ff9d"/><circle cx="190" cy="160" r="4" fill="#00ff9d"/>' +
      '<ellipse cx="80" cy="95" rx="12" ry="18" fill="' + theme.c1 + '"/>' +
      '<ellipse cx="120" cy="95" rx="12" ry="18" fill="' + theme.c1 + '"/>' +
      '<ellipse cx="80" cy="95" rx="5" ry="8" fill="#fff"/>' +
      '<ellipse cx="120" cy="95" rx="5" ry="8" fill="#fff"/>' +
      '<path d="M70,125 L80,145 L90,125 M110,125 L120,145 L130,125" stroke="' + theme.c1 + '" stroke-width="3" fill="none"/>' +
      '<path d="M60,70 L140,70" stroke="' + theme.c1 + '" stroke-width="2" opacity="0.5"/>' +
      '<g stroke="#ffffff" stroke-width="1.5" fill="none" opacity="' + crackOpacity + '">' +
      '<path d="M70,50 L85,80 L65,90"/><path d="M130,55 L118,85 L138,95"/><path d="M100,150 L95,170 M100,150 L108,168"/>' +
      "</g>" +
      "</svg>"
    );
  }

  // 클럽 레이드 섹션 — 진행 중이면 보스 HP바 + 공격 버튼 + 상위 기여자, 아니면 재도전
  // 대기시간 또는 소환 버튼. fmtLongCountdown을 쓰는 이유는 대기시간이 최대 20시간이라
  // "1200분"처럼 안 읽히는 표기를 피하기 위해서(현상금 게시판 카운트다운과 동일 이유).
  function raidSectionHtml(raid, raidCooldownLeftMs, myUserId) {
    if (raid) {
      const pct = Math.max(0, Math.min(100, (raid.hp / raid.maxHp) * 100));
      const topHtml = raid.topContributors.length
        ? raid.topContributors.map((c, i) => (
            '<div class="club-member-row"><span>' + (i + 1) + "위 " + escapeHtml(c.userName) + (c.userId === myUserId ? " (나)" : "") + "</span><span>" + fmt(c.damage) + " 데미지 (" + c.hits + "회)</span></div>"
          )).join("")
        : '<p class="dim">아직 공격한 사람이 없습니다.</p>';
      return (
        '<div class="club-section-title">👹 클럽 레이드 — ' + escapeHtml(raid.bossName) + "</div>" +
        raidBossSvgHtml(raid.bossName, raid.hp / raid.maxHp) +
        '<div class="exp-track" style="height:16px;"><div class="exp-fill" style="width:' + pct + '%;background:var(--danger);"></div></div>' +
        '<p class="dim" style="margin:6px 0 10px;">HP ' + fmt(raid.hp) + " / " + fmt(raid.maxHp) + "</p>" +
        '<button class="btn-danger" id="clubRaidAttackBtn" style="width:100%;margin-bottom:10px;">⚔️ 공격(스태미나 2)</button>' +
        topHtml
      );
    }
    if (raidCooldownLeftMs > 0) {
      return '<div class="club-section-title">👹 클럽 레이드</div><p class="dim">다음 레이드까지 ' + fmtLongCountdown(raidCooldownLeftMs) + " 남았습니다.</p>";
    }
    return (
      '<div class="club-section-title">👹 클럽 레이드</div>' +
      '<p class="dim">클럽원 전체가 힘을 합쳐 보스를 같이 공격하세요 — 처치하면 기여 데미지 비율만큼 코인·EXP를 나눠 받고, 클럽 경험치도 오릅니다.</p>' +
      '<button class="btn-primary" id="clubRaidStartBtn" style="width:100%;">보스 소환하기</button>'
    );
  }

  // 클럽 전쟁 시즌 섹션 — war-season 조회가 실패해도(클럽 API 자체 문제 등) 클럽 탭 전체가
  // 죽으면 안 되므로 조용히 빈 문자열로 넘어간다.
  function warSeasonSectionHtml(ws) {
    if (!ws) return "";
    const remain = Math.max(0, ws.seasonEndsAt - Date.now());
    const rankLine = ws.myClubRank
      ? "이번 시즌 순위 <b>#" + ws.myClubRank + "</b> (점수 " + fmt(ws.myClubScore) + ")"
      : "이번 시즌 아직 전적이 없습니다.";
    const standingsHtml = ws.standings.length
      ? ws.standings.slice(0, 10).map((s, i) => (
          '<div class="club-relation-row"><span>' + (i + 1) + "위 " + escapeHtml(s.name) + "</span><span>" + fmt(s.score) + "점</span></div>"
        )).join("")
      : '<p class="dim">아직 이번 시즌 전적이 있는 클럽이 없습니다.</p>';
    const claimHtml = ws.previousSeasonReward
      ? '<div class="club-contribute-form"><span>직전 시즌 ' + ws.previousSeasonReward.rank + "위 보상 💰" + fmt(ws.previousSeasonReward.coins) + '</span><button class="btn-primary" id="clubWarClaimBtn">받기</button></div>'
      : "";
    return (
      '<div class="club-section-title">⚔️ 클럽 전쟁 시즌 (남은 시간 ' + fmtCountdown(remain) + ")</div>" +
      '<p class="dim">' + rankLine + " 적대 클럽 소속을 상대로 이기면(PvP·행성 침투 불문) 올라갑니다.</p>" +
      standingsHtml + claimHtml
    );
  }

  async function renderClubTab() {
    const el = $("clubContent");
    try {
      const [data, warSeason] = await Promise.all([api("/club"), api("/club/war-season").catch(() => null)]);
      if (!data.myClub) {
        el.innerHTML =
          '<div class="club-create-card">' +
          '<div class="club-section-title" style="margin-top:0;">새 클럽 만들기 (💰 ' + fmt(data.createCost) + ")</div>" +
          '<input id="clubCreateName" type="text" placeholder="클럽 이름" maxlength="20" />' +
          '<textarea id="clubCreateDesc" placeholder="클럽 소개(선택)" rows="2" maxlength="200"></textarea>' +
          '<button class="btn-primary" id="clubCreateBtn" style="width:100%;">만들기</button>' +
          "</div>" +
          '<div class="club-section-title">가입 가능한 클럽</div>' +
          (data.clubs.length ? data.clubs.map((c) => (
            '<div class="club-browse-card">' +
            '<div><div class="club-browse-name">Lv.' + c.level + " " + escapeHtml(c.name) + "</div>" +
            '<div class="club-browse-meta">리더 ' + escapeHtml(c.leaderName) + " · 멤버 " + c.memberCount + "/" + data.maxMembers + " · 전적 " + c.warScore + (c.description ? " · " + escapeHtml(c.description) : "") + "</div></div>" +
            '<button class="btn-primary" data-join="' + c.id + '"' + (c.memberCount >= data.maxMembers ? " disabled" : "") + ">가입</button>" +
            "</div>"
          )).join("") : '<p class="dim">아직 생성된 클럽이 없습니다.</p>');
        return;
      }

      const club = data.myClub;
      const xpPct = Math.min(100, (club.xpIntoLevel / club.nextLevelXp) * 100);
      el.innerHTML =
        '<div class="club-header">' +
        '<div class="club-header-title">🛡️ Lv.' + club.level + " " + escapeHtml(club.name) + "</div>" +
        '<div class="club-header-meta">리더 ' + escapeHtml(club.leaderName) + " · 멤버 " + club.members.length + "/" + data.maxMembers + " · 전적(전쟁 승수) " + club.warScore + (club.description ? "<br>" + escapeHtml(club.description) : "") + "</div>" +
        '<div class="club-xp-track"><div class="club-xp-fill" style="width:' + xpPct + '%;"></div></div>' +
        '<div class="club-header-meta">클럽 XP ' + fmt(club.xpIntoLevel) + " / " + fmt(club.nextLevelXp) + " · 클럽 창고 💰" + fmt(club.bankCoins) +
        " · 전 멤버 코인 보너스 +" + club.coinBonusPct.toFixed(0) + "% (해킹 작업/PvP 약탈)</div>" +
        '<div class="club-contribute-form"><input id="clubContributeAmount" type="number" placeholder="기부할 코인" /><button class="btn-primary" id="clubContributeBtn">기부</button></div>' +
        '<div class="club-header-actions" style="margin-top:10px;">' +
        (club.isLeader ? '<button class="btn-ghost" id="clubDisbandBtn">클럽 해체</button>' : '<button class="btn-ghost" id="clubLeaveBtn">클럽 탈퇴</button>') +
        "</div></div>" +

        raidSectionHtml(club.raid, club.raidCooldownLeftMs, state.userId) +

        '<div class="club-section-title">💬 클럽 채팅</div>' +
        '<div class="club-chat-box"><div class="club-chat-messages" id="clubChatMessages"><p class="dim">불러오는 중...</p></div>' +
        '<div class="club-chat-form"><input id="clubChatInput" type="text" placeholder="메시지 입력..." maxlength="300" /><button class="btn-primary" id="clubChatSendBtn">전송</button></div></div>' +

        '<div class="club-section-title">👥 멤버 (' + club.members.length + ")</div>" +
        club.members.map((m) => (
          '<div class="club-member-row"><span>' + (m.role === "leader" ? "👑 " : "") + escapeHtml(m.userName) + "</span>" +
          (club.isLeader && m.role !== "leader" ? '<button class="btn-ghost" data-kick="' + m.userId + '">추방</button>' : "") +
          "</div>"
        )).join("") +

        '<div class="club-section-title">🌐 관계</div>' +
        (club.relations.length ? club.relations.map((r) => (
          '<div class="club-relation-row"><span>' + escapeHtml(r.clubName) + " (전적 " + r.warScore + ")</span>" +
          '<span class="club-relation-tag ' + r.effective + '">' + (RELATION_LABEL[r.effective] || r.effective) + "</span></div>"
        )).join("") : '<p class="dim">아직 다른 클럽과 관계가 없습니다.</p>') +
        (club.isLeader ?
          '<div class="club-relation-form">' +
          '<select id="clubRelationClubId">' + (data.otherClubs || []).map((c) => '<option value="' + c.id + '">' + escapeHtml(c.name) + " (#" + c.id + ")</option>").join("") + "</select>" +
          '<select id="clubRelationStatus"><option value="hostile">적대 선언</option><option value="friendly">우호 선언</option><option value="neutral">중립으로</option></select>' +
          '<button class="btn-primary" id="clubRelationSetBtn">설정</button>' +
          "</div><p class=\"dim\" style=\"margin-top:6px;\">적대는 한쪽만 선언해도 전쟁, 동맹은 서로 선언해야 성립합니다.</p>"
          : "") +
        warSeasonSectionHtml(warSeason);
      renderClubChat();
      startClubChatPolling();
    } catch (e) { el.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // 클럽 채팅 — 탭이 열려 있는 동안만 몇 초마다 새로 불러온다(다른 탭으로 넘어가면 자동 정지).
  let clubChatPollId = null;
  async function renderClubChat() {
    const box = $("clubChatMessages");
    if (!box) return;
    try {
      const { messages } = await api("/club/chat");
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
      box.innerHTML = messages.length
        ? messages.map((m) => '<div class="club-chat-msg"><span class="who' + (m.userId === state.userId ? " me" : "") + '">' + escapeHtml(m.userName) + "</span>" + escapeHtml(m.message) + "</div>").join("")
        : '<p class="dim">아직 대화가 없습니다.</p>';
      if (atBottom) box.scrollTop = box.scrollHeight;
    } catch (e) { /* 조용히 무시 — 다음 폴링에서 다시 시도 */ }
  }
  function startClubChatPolling() {
    stopClubChatPolling();
    clubChatPollId = setInterval(() => { if (currentTab === "club") renderClubChat(); else stopClubChatPolling(); }, 4000);
  }
  function stopClubChatPolling() {
    if (clubChatPollId) { clearInterval(clubChatPollId); clubChatPollId = null; }
  }

  function initClubButtons() {
    const el = $("clubContent");
    if (!el) return;
    el.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.id === "clubCreateBtn") {
        const name = $("clubCreateName").value.trim();
        const description = $("clubCreateDesc").value.trim();
        if (!name) return toast("클럽 이름을 입력하세요.", true);
        t.disabled = true;
        try {
          const r = await api("/club/create", { method: "POST", body: { name, description } });
          toast("클럽을 만들었습니다!"); state.pocketCoins = r.pocketCoins; renderHeader(); renderClubTab();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.dataset.join) {
        t.disabled = true;
        try { await api("/club/join", { method: "POST", body: { clubId: t.dataset.join } }); toast("클럽에 가입했습니다!"); renderClubTab(); }
        catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.id === "clubLeaveBtn") {
        if (!confirm("클럽을 탈퇴하시겠습니까?")) return;
        t.disabled = true;
        try { await api("/club/leave", { method: "POST" }); toast("탈퇴했습니다."); renderClubTab(); }
        catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.id === "clubDisbandBtn") {
        if (!confirm("클럽을 해체하시겠습니까? 모든 멤버가 해제되고 되돌릴 수 없습니다.")) return;
        t.disabled = true;
        try { await api("/club/disband", { method: "POST" }); toast("클럽을 해체했습니다."); renderClubTab(); }
        catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.dataset.kick) {
        if (!confirm("이 멤버를 추방하시겠습니까?")) return;
        t.disabled = true;
        try { await api("/club/kick", { method: "POST", body: { userId: t.dataset.kick } }); toast("추방했습니다."); renderClubTab(); }
        catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.id === "clubRaidStartBtn") {
        t.disabled = true;
        try {
          const r = await api("/club/raid/start", { method: "POST" });
          toast("👹 " + r.bossName + " 등장! (HP " + fmt(r.maxHp) + ")");
          renderClubTab();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.id === "clubRaidAttackBtn") {
        t.disabled = true;
        try {
          const r = await api("/club/raid/attack", { method: "POST" });
          if (r.defeated) {
            const mine = r.rewards.participants.find((p) => p.userId === state.userId);
            toast("🎉 " + r.bossName + " 처치! " + (mine ? "내 몫 +" + fmt(mine.coinReward) + " 코인 · EXP +" + mine.xpGained + (mine.leveledUp ? " · 🎉 LEVEL UP!" : "") : "보상 분배 완료"));
          } else {
            toast("⚔️ " + fmt(r.damage) + " 데미지! (보스 HP " + fmt(r.raidHp) + " / " + fmt(r.raidMaxHp) + ")");
          }
          refreshState();
          renderClubTab();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.id === "clubRelationSetBtn") {
        const toClubId = $("clubRelationClubId").value;
        const status = $("clubRelationStatus").value;
        if (!toClubId) return toast("상대 클럽 ID를 입력하세요.", true);
        t.disabled = true;
        try { await api("/club/relation", { method: "POST", body: { toClubId, status } }); toast("관계를 설정했습니다."); renderClubTab(); }
        catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.id === "clubContributeBtn") {
        const amount = parseInt($("clubContributeAmount").value, 10);
        if (!amount || amount <= 0) return toast("금액을 입력하세요.", true);
        t.disabled = true;
        try {
          const r = await api("/club/contribute", { method: "POST", body: { amount } });
          toast(r.leveledUp ? "🎉 기부 완료! 클럽이 Lv." + r.newLevel + "로 레벨업했습니다!" : "기부 완료!");
          state.pocketCoins = r.pocketCoins; renderHeader(); renderClubTab();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.id === "clubChatSendBtn") {
        const input = $("clubChatInput");
        const message = input.value.trim();
        if (!message) return;
        t.disabled = true;
        try { await api("/club/chat/send", { method: "POST", body: { message } }); input.value = ""; renderClubChat(); }
        catch (err) { toast(err.message, true); }
        t.disabled = false;
      } else if (t.id === "clubWarClaimBtn") {
        t.disabled = true;
        try {
          const r = await api("/club/war-season/claim", { method: "POST" });
          toast("⚔️ " + r.rank + "위 시즌 보상 +" + fmt(r.coins) + " 코인!");
          state.pocketCoins = r.pocketCoins; renderHeader(); renderClubTab();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      }
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "clubChatInput") $("clubChatSendBtn").click();
    });
  }

  // ── Admin — 서버가 isAdmin으로 이미 막아주니 프론트는 그냥 UI만 조건부로 보여준다
  // (renderHeader에서 탭 자체를 숨김/표시). 아이템 지급용 드롭다운은 전체 카탈로그를 쓴다. ──
  async function renderAdminTab() {
    const sel = $("adminItemSelect");
    if (sel && !sel.dataset.loaded) {
      try {
        const catalog = await getShopCatalog();
        sel.innerHTML = itemSelectOptions(Object.values(catalog), false);
        sel.dataset.loaded = "1";
      } catch (e) {}
    }
    // 긴급 정지 상태 — state는 15초마다 갱신되니 그동안의 값을 그대로 반영(별도 API 호출 불필요).
    const statusEl = $("adminFreezeStatus"), toggleBtn = $("adminFreezeToggleBtn");
    if (statusEl && toggleBtn && state) {
      const frozen = !!state.economyFrozen;
      statusEl.textContent = frozen ? "🚨 정지됨" : "🟢 정상 운영 중";
      statusEl.style.color = frozen ? "var(--danger)" : "var(--energy)";
      toggleBtn.textContent = frozen ? "긴급 정지 해제하기" : "긴급 정지 켜기";
      toggleBtn.className = frozen ? "btn-primary" : "btn-danger";
    }
  }

  function initAdminButtons() {
    async function run(btn, endpoint, body, successMsg) {
      btn.disabled = true;
      try {
        const r = await api(endpoint, { method: "POST", body: body });
        toast(successMsg);
        if (r.state) { state = r.state; renderHeader(); }
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    }
    const xpBtn = $("adminXpBtn");
    if (xpBtn) xpBtn.addEventListener("click", () => {
      const amount = parseInt($("adminXpAmount").value, 10);
      if (!amount) return toast("XP를 입력하세요.", true);
      run(xpBtn, "/admin/add-xp", { amount }, "XP +" + fmt(amount) + " 추가 완료");
    });
    const levelBtn = $("adminLevelBtn");
    if (levelBtn) levelBtn.addEventListener("click", () => {
      const level = parseInt($("adminLevelValue").value, 10);
      if (!level || level < 1) return toast("레벨을 입력하세요.", true);
      run(levelBtn, "/admin/set-level", { level }, "레벨 " + level + "로 설정 완료");
    });
    const coinsBtn = $("adminCoinsBtn");
    if (coinsBtn) coinsBtn.addEventListener("click", () => {
      const amount = parseInt($("adminCoinsAmount").value, 10);
      if (!amount) return toast("코인 수를 입력하세요.", true);
      run(coinsBtn, "/admin/add-coins", { amount }, "코인 " + fmt(amount) + " 조정 완료");
    });
    const diamondsBtn = $("adminDiamondsBtn");
    if (diamondsBtn) diamondsBtn.addEventListener("click", () => {
      const amount = parseInt($("adminDiamondsAmount").value, 10);
      if (!amount) return toast("다이아 수를 입력하세요.", true);
      run(diamondsBtn, "/admin/add-diamonds", { amount }, "다이아 " + fmt(amount) + " 조정 완료");
    });
    const itemBtn = $("adminItemBtn");
    if (itemBtn) itemBtn.addEventListener("click", async () => {
      const itemId = $("adminItemSelect").value;
      const qty = Math.max(1, parseInt($("adminItemQty").value, 10) || 1);
      const targetUserId = $("adminItemTarget").value.trim();
      if (!itemId) return toast("아이템을 선택하세요.", true);
      itemBtn.disabled = true;
      try {
        const r = await api("/admin/give-item", { method: "POST", body: { itemId, qty, targetUserId: targetUserId || undefined } });
        toast((targetUserId ? r.targetUserId + "에게 " : "나에게 ") + "아이템 지급 완료!");
      } catch (e) { toast(e.message, true); }
      itemBtn.disabled = false;
    });
    const refillBtn = $("adminRefillBtn");
    if (refillBtn) refillBtn.addEventListener("click", () => run(refillBtn, "/admin/refill", {}, "전체 회복 완료"));

    // ── 긴급 정지 토글 — 켜기 전엔 한 번 더 확인(되돌릴 순 있지만 그동안 모두의 플레이가
    //    막히는 영향이 크므로), 끌 때는 바로 반영한다. ──
    const freezeBtn = $("adminFreezeToggleBtn");
    if (freezeBtn) freezeBtn.addEventListener("click", async () => {
      const turningOn = !state.economyFrozen;
      if (turningOn && !confirm("긴급 정지를 켜면 관리자 본인을 제외한 모든 유저의 재화·상점 관련 액션이 즉시 막힙니다. 계속할까요?")) return;
      freezeBtn.disabled = true;
      try {
        const r = await api("/admin/freeze", { method: "POST", body: { frozen: turningOn } });
        state.economyFrozen = r.frozen;
        renderHeader(); renderAdminTab();
        toast(r.frozen ? "🚨 긴급 정지를 켰습니다." : "🟢 긴급 정지를 해제했습니다.");
      } catch (e) { toast(e.message, true); }
      freezeBtn.disabled = false;
    });
  }

  // ── Profile — 누구나 조회 가능(다른 유저 아이디로 조회), 내 프로필일 때만 편집 폼이 뜬다.
  // 진열대 슬롯 하나짜리 <select>에 "item:id" / "bot:id" 값을 인코딩해서 넣는 방식으로
  // 타입+값 두 단계 드롭다운 없이 한 번에 고르게 했다. ──
  let profileViewingUserId = null;

  // ── Achievements — 목록 전체를 보여주고 카드마다 상태에 맞는 버튼 하나(청구하기/장착하기/
  //    장착 해제하기)만 활성화한다. 미달성인데 이미 청구된 경우는 없으므로(서버가 조건을
  //    다시 검사) 신경 쓸 상태 조합이 적다. ──
  async function renderAchievementsTab() {
    const grid = $("achievementGrid");
    try {
      const { items, equippedTitleId } = await api("/achievements");
      grid.innerHTML = items.map((a) => {
        const equipped = a.id === equippedTitleId;
        const cls = equipped ? "equipped" : a.completed ? "done" : "";
        let actionHtml;
        if (equipped) actionHtml = '<button class="btn-ghost" data-untitle="1">칭호 해제</button>';
        else if (a.claimed) actionHtml = '<button class="btn-primary" data-equip="' + a.id + '">칭호 장착</button>';
        else if (a.completed) actionHtml = '<button class="btn-primary" data-claim="' + a.id + '">받기 (💰 ' + fmt(a.reward) + ")</button>";
        else actionHtml = '<button class="btn-ghost" disabled>미달성</button>';
        return (
          '<div class="achievement-card ' + cls + '">' +
          '<div class="achievement-name">' + (equipped ? "🏷️ " : a.claimed ? "✅ " : "") + escapeHtml(a.name) + "</div>" +
          '<div class="achievement-desc">' + escapeHtml(a.desc) + "</div>" +
          '<div class="achievement-reward">칭호: [' + escapeHtml(a.title) + "] · 보상 💰" + fmt(a.reward) + "</div>" +
          '<div class="achievement-actions">' + actionHtml + "</div>" +
          "</div>"
        );
      }).join("");
      grid.querySelectorAll("button[data-claim]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/achievements/claim", { method: "POST", body: { id: btn.dataset.claim } });
            toast("🏆 업적 달성! +" + fmt(r.reward) + " 코인 · EXP +" + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : "") + ", 칭호 [" + r.title + "] 획득");
            await refreshState(); renderAchievementsTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      grid.querySelectorAll("button[data-equip]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/achievements/set-title", { method: "POST", body: { id: btn.dataset.equip } });
            toast("🏷️ 칭호 [" + r.equippedTitle + "] 장착");
            state.equippedTitle = r.equippedTitle; state.equippedTitleRarity = r.equippedTitleRarity; state.equippedTitleColor = r.equippedTitleColor;
            renderHeader(); renderAchievementsTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
      grid.querySelectorAll("button[data-untitle]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await api("/achievements/set-title", { method: "POST", body: { id: null } });
            toast("칭호를 해제했습니다.");
            state.equippedTitle = null; state.equippedTitleRarity = null; state.equippedTitleColor = null;
            renderHeader(); renderAchievementsTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  async function renderProfileTab() {
    await loadAndRenderProfile(profileViewingUserId || (state && state.userId));
  }

  async function loadAndRenderProfile(userId) {
    if (!userId) return;
    const cardArea = $("profileCardArea");
    const editArea = $("profileEditArea");
    cardArea.innerHTML = '<p class="dim">불러오는 중...</p>';
    editArea.innerHTML = "";
    try {
      const p = await api("/profile?userId=" + encodeURIComponent(userId));
      profileViewingUserId = p.userId;
      renderProfileCard(p);
      if (p.isSelf) await renderProfileEditForm(p);
    } catch (e) { cardArea.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // 칭호 배지 — 리더보드/PvP 목록/정찰/프로필/헤더가 전부 이 함수 하나로 통일해서 쓴다
  // (요청 반영: "리더보드랑 P2P 이름이랑 통일해서 효과 만들어줘"). 색은 항상 등급별로
  // 다르고(titleColor), 파티클/아우라는 legendary 이상 칭호에만 auraNameHtml이 알아서 붙인다.
  function titleBadgeHtml(text, color, rarity) {
    if (!text) return "";
    const bracket = "[" + escapeHtml(text) + "]";
    const wrapped = window.auraNameHtml ? auraNameHtml(bracket, color, rarity) : bracket;
    return '<span class="title-badge">' + wrapped + "</span> ";
  }

  // 리더보드 모달/프로필 탭이 똑같은 카드 마크업을 쓰므로 한 함수로 통일했다.
  function profileCardHtml(p) {
    const tier = rebirthTier(p.rebirthCount || 0);
    const glowCls = p.rebirthEffectEnabled ? " rebirth-glow tier-" + tier : "";
    const frameCls = p.auroraFrameOwned ? " frame-aurora" : "";
    const rebirthBadge = p.rebirthCount > 0 ? '<span class="rebirth-badge tier-' + tier + '"> - ' + toRoman(p.rebirthCount) + "</span>" : "";
    const titleBadge = titleBadgeHtml(p.title, p.titleColor, p.titleRarity);
    const slots = [0, 1, 2].map((i) => {
      const s = p.showcase[i];
      if (!s) return '<div class="profile-slot empty">비어있음</div>';
      if (s.type === "item") {
        return '<div class="profile-slot" style="border-left-color:' + s.typeColor + ';">' +
          '<div>' + itemIconHtml(s.id, s.rarityColor, 26, s.rarity) + "</div>" +
          '<div class="profile-slot-name" style="color:' + s.rarityColor + ';">' + escapeHtml(s.name) + "</div>" +
          '<div class="profile-slot-stat">' + (s.typeLabel || "") + " · " + s.rarityLabel + "</div></div>";
      }
      return '<div class="profile-slot" style="border-left-color:' + s.rarityColor + ';">' +
        '<div>' + botIconHtml(s.rarity, s.rarityColor, 26) + "</div>" +
        '<div class="profile-slot-name" style="color:' + s.rarityColor + ';">봇 (' + s.rarityLabel + ")</div>" +
        '<div class="profile-slot-stat">⚔️' + s.atk + " 🛡️" + s.def + " 💥" + s.crit + "%</div></div>";
    }).join("");
    return (
      '<div class="profile-card' + glowCls + frameCls + '">' +
      '<div class="profile-card-name">Lv.' + p.level + " " + titleBadge + escapeHtml(p.realName) + rebirthBadge + "</div>" +
      '<div class="profile-card-meta">' + (p.clubName ? "🛡️ " + escapeHtml(p.clubName) + " · " : "") + "약탈 승리 " + p.plunderWins + "회</div>" +
      '<div class="profile-card-status">' + (p.statusMessage ? escapeHtml(p.statusMessage) : '<span class="dim">상태메시지 없음</span>') + "</div>" +
      '<div class="profile-showcase">' + slots + "</div>" +
      "</div>"
    );
  }
  function renderProfileCard(p) {
    $("profileCardArea").innerHTML = profileCardHtml(p);
  }

  // ── 리더보드/거래 등 다른 탭에서 이름을 클릭했을 때 뜨는 프로필 팝업. ──
  async function openProfileModal(userId) {
    $("profileModal").style.display = "flex";
    $("profileModalBody").innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const p = await api("/profile?userId=" + encodeURIComponent(userId));
      $("profileModalBody").innerHTML = profileCardHtml(p);
    } catch (e) { $("profileModalBody").innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }
  function closeProfileModal() { $("profileModal").style.display = "none"; }

  async function renderProfileEditForm(p) {
    const editArea = $("profileEditArea");
    editArea.innerHTML = '<p class="dim">편집 폼 불러오는 중...</p>';
    try {
      const [inv, botsData] = await Promise.all([api("/inventory"), api("/bots")]);
      function botRarityLabel(b) {
        // 봇 등급은 가챠 결과 기준(장착된 아이템으로 매번 다시 계산하지 않음) — Bots 탭과 동일.
        return b.gachaRarityLabel ? "[" + b.gachaRarityLabel + "]" : "(미배정)";
      }
      let optionsHtml = '<option value="">비어있음</option>';
      inv.items.forEach((it) => { optionsHtml += '<option value="item:' + it.id + '">🎒 [' + it.rarityLabel + "] " + escapeHtml(it.name) + "</option>"; });
      botsData.bots.forEach((b, idx) => { optionsHtml += '<option value="bot:' + b.id + '">🤖 BOT #' + (idx + 1) + " " + botRarityLabel(b) + "</option>"; });

      function currentValue(i) {
        const s = p.showcase[i];
        if (!s) return "";
        return s.type === "item" ? "item:" + s.id : "bot:" + s.id;
      }

      editArea.innerHTML =
        '<div class="profile-edit">' +
        '<div class="profile-edit-title">내 프로필 편집</div>' +
        '<input id="profileStatusInput" type="text" maxlength="60" placeholder="상태메시지 (최대 60자)" value="' + escapeHtml(p.statusMessage || "") + '" />' +
        '<div class="profile-slot-editors">' +
        [0, 1, 2].map((i) => '<div class="profile-slot-editor"><span class="dim">진열대 ' + (i + 1) + '</span><select id="profileSlot' + i + '">' + optionsHtml + "</select></div>").join("") +
        "</div>" +
        (p.rebirthCount > 0
          ? '<label class="profile-edit-toggle"><input type="checkbox" id="profileRebirthToggle"' + (p.rebirthEffectEnabled ? " checked" : "") + " /> 환생 이팩트 표시(카드 테두리 반짝임)</label>"
          : "") +
        (p.maxThemeUnlocked
          ? '<label class="profile-edit-toggle"><input type="checkbox" id="profileThemeToggle"' + (p.maxThemeEnabled ? " checked" : "") + " /> 🌌 환생 마스터 전용 테마 적용(사이트 전체 색상 변경)</label>"
          : "") +
        '<button class="btn-primary" id="profileSaveBtn" style="width:100%;">저장</button>' +
        "</div>";
      [0, 1, 2].forEach((i) => { const sel = $("profileSlot" + i); if (sel) sel.value = currentValue(i); });
    } catch (e) { editArea.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  function initProfileButtons() {
    const lookupBtn = $("profileLookupBtn");
    if (lookupBtn) lookupBtn.addEventListener("click", () => {
      const id = $("profileLookupInput").value.trim();
      if (!id) return toast("아이디를 입력하세요.", true);
      loadAndRenderProfile(id);
    });
    const myOwnBtn = $("profileMyOwnBtn");
    if (myOwnBtn) myOwnBtn.addEventListener("click", () => { $("profileLookupInput").value = ""; loadAndRenderProfile(state.userId); });
    const editArea = $("profileEditArea");
    if (editArea) editArea.addEventListener("click", async (e) => {
      if (e.target.id !== "profileSaveBtn") return;
      const btn = e.target;
      btn.disabled = true;
      const showcase = [0, 1, 2].map((i) => {
        const val = $("profileSlot" + i).value;
        if (!val) return null;
        const [type, id] = val.split(":");
        return type === "item" ? { type: "item", itemId: id } : { type: "bot", botId: id };
      }).filter((x) => x);
      const statusMessage = $("profileStatusInput").value;
      const toggle = $("profileRebirthToggle");
      const rebirthEffectEnabled = toggle ? toggle.checked : true;
      const themeToggle = $("profileThemeToggle");
      const body = { statusMessage, showcase, rebirthEffectEnabled };
      if (themeToggle) body.maxThemeEnabled = themeToggle.checked;
      try {
        await api("/profile/update", { method: "POST", body });
        toast("프로필을 저장했습니다.");
        loadAndRenderProfile(state.userId);
        refreshState();
      } catch (err) { toast(err.message, true); }
      btn.disabled = false;
    });
  }

  function initBankForm() {
    async function deposit(inputId) {
      const amount = parseInt($(inputId).value, 10);
      if (!amount || amount <= 0) return toast("금액을 입력하세요.", true);
      try {
        const r = await api("/bank/deposit", { method: "POST", body: { amount } });
        state = r.state; renderHeader(); renderBankTab(); $(inputId).value = "";
        toast("입금 완료 (세금 -" + fmt(r.tax) + " · 실입금 " + fmt(r.credited) + ")");
      } catch (e) { toast(e.message, true); }
    }
    async function withdraw(inputId) {
      const amount = parseInt($(inputId).value, 10);
      if (!amount || amount <= 0) return toast("금액을 입력하세요.", true);
      try { const r = await api("/bank/withdraw", { method: "POST", body: { amount } }); state = r.state; renderHeader(); renderBankTab(); $(inputId).value = ""; toast("출금 완료"); }
      catch (e) { toast(e.message, true); }
    }
    $("depositBtn").addEventListener("click", () => deposit("depositInput"));
    $("withdrawBtn").addEventListener("click", () => withdraw("withdrawInput"));
    $("depositAllBtn").addEventListener("click", () => { $("depositInput").value = state.pocketCoins; deposit("depositInput"); });
    $("withdrawAllBtn").addEventListener("click", () => { $("withdrawInput").value = state.bankCoins; withdraw("withdrawInput"); });
  }

  // ── ⑥ Leaderboard ──
  let lbType = "level";
  async function renderLeaderboardTab() {
    const panel = $("panel-leaderboard");
    const list = panel.querySelector(".lb-list");
    list.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const { rows } = await api("/leaderboard?type=" + lbType);
      list.innerHTML = rows.map((r, i) => {
        const valueLabel = lbType === "level" ? "Lv." + r.level :
          lbType === "assets" ? fmt(r.pocket_coins + r.bank_coins) + " 코인" :
          r.plunder_wins + "승";
        const titleHtml = titleBadgeHtml(r.title, r.titleColor, r.titleRarity);
        return '<div class="lb-row"><span class="lb-rank">#' + (i + 1) + '</span><span class="lb-name-link" data-profile="' + escapeHtml(r.user_id) + '">' + titleHtml + escapeHtml(r.real_name) + rebirthBadgeHtml(r.rebirth_count) + '</span><span class="lb-value">' + valueLabel + "</span></div>";
      }).join("") || '<p class="dim">기록이 없습니다.</p>';
      list.querySelectorAll("[data-profile]").forEach((el) => {
        el.addEventListener("click", () => openProfileModal(el.dataset.profile));
      });
    } catch (e) { list.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  function initLeaderboardTabs() {
    document.querySelectorAll(".lb-type-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".lb-type-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        lbType = btn.dataset.lb;
        renderLeaderboardTab();
      });
    });
  }

  // ── ⑦ Hack Log ──
  async function renderLogsTab() {
    const panel = $("panel-logs");
    const list = panel.querySelector(".log-list");
    list.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const { logs } = await api("/logs");
      if (!logs.length) { list.innerHTML = '<p class="dim">기록이 없습니다.</p>'; return; }
      list.innerHTML = logs.map((l) => {
        const time = new Date(l.created_at).toLocaleString("ko-KR");
        let icon = "📡", desc = "";
        const attackWon = l.result === "win" || l.result === "crit";
        if (l.kind === "job") { icon = "💾"; desc = (l.opponent_name || "") + " 작업 완료"; }
        else if (l.kind === "pvp_attack") { icon = l.result === "crit" ? "💥" : attackWon ? "⚔️" : "🛡️"; desc = (l.result === "crit" ? "크리티컬 침투 성공: " : attackWon ? "침투 성공: " : "침투 실패: ") + escapeHtml(l.opponent_name || "알 수 없음"); }
        else if (l.kind === "pvp_defend") { icon = l.result === "win" ? "🛡️" : "💥"; desc = (l.result === "win" ? "방어 성공: " : "피격당함: ") + escapeHtml(l.opponent_name || "알 수 없음"); }
        else if (l.kind === "planet_attack") { icon = attackWon ? "🌍" : "🛡️"; desc = (attackWon ? "행성 침투 성공: " : "행성 공격 실패: ") + escapeHtml(l.opponent_name || "알 수 없음"); }
        else if (l.kind === "home_breached") { icon = "💥"; desc = "홈 행성 피습당함: " + escapeHtml(l.opponent_name || "알 수 없음"); }
        else if (l.kind === "planet_expedition") { icon = attackWon ? "🛰️" : "🛰️"; desc = (attackWon ? "원정 성공: " : "원정 실패: ") + escapeHtml(l.opponent_name || "알 수 없음"); }
        else if (l.kind === "trade") { icon = "🤝"; desc = "거래 완료: " + escapeHtml(l.opponent_name || "알 수 없음"); }
        const coinCls = l.coins_delta > 0 ? "pos" : l.coins_delta < 0 ? "neg" : "";
        return (
          '<div class="log-row"><span>' + icon + "</span><span>" + desc + '</span><span class="' + coinCls + '">' +
          (l.coins_delta ? (l.coins_delta > 0 ? "+" : "") + fmt(l.coins_delta) : "") + '</span><span class="dim">' + time + "</span></div>"
        );
      }).join("");
    } catch (e) { list.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // 환생 횟수 표시용 로마 숫자 변환 — "환생 3회"보다 "환생 III"가 더 그 느낌이 산다는 요청.
  function toRoman(n) {
    const table = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let num = Math.max(1, Math.floor(n)), out = "";
    for (const [value, sym] of table) { while (num >= value) { out += sym; num -= value; } }
    return out;
  }
  // 환생 등급(0~4, 브론즈/실버/골드/무지개) — 서버(arena-worker.js의 rebirthTier)와 완전히
  // 동일한 계단식. 서버 응답에 이미 rebirthTier가 실려오지만(자기 자신), 리더보드/다른 사람
  // 프로필처럼 rebirthCount만 오는 곳도 있어서 클라이언트에서도 똑같이 계산할 수 있게 둔다.
  const REBIRTH_TIER_NAMES = ["", "브론즈", "실버", "골드", "무지개"];
  function rebirthTier(count) {
    const c = count || 0;
    if (c >= 10) return 4;
    if (c >= 5) return 3;
    if (c >= 3) return 2;
    if (c >= 1) return 1;
    return 0;
  }
  // 닉네임 옆에 붙이는 환생 뱃지 — 헤더/프로필/리더보드 전부 이 한 함수로 통일.
  // 환생 횟수는 이모티콘 대신 로마숫자로만 표시한다(요청 반영: "- I 처럼 로마숫자로").
  function rebirthBadgeHtml(count) {
    return count > 0 ? ' <span class="rebirth-name-badge tier-' + rebirthTier(count) + '"> - ' + toRoman(count) + "</span>" : "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initBankForm();
    initLeaderboardTabs();
    initStatButtons();
    initGalaxyButtons();
    initShopButtons();
    initResearchButtons();
    initTradeButtons();
    initClubButtons();
    initDailyButtons();
    initAdminButtons();
    initProfileButtons();
    initPropertyButtons();
    $("scanModalClose").addEventListener("click", () => { $("scanModal").style.display = "none"; });
    $("scanModal").addEventListener("click", (e) => { if (e.target.id === "scanModal") $("scanModal").style.display = "none"; });
    $("attackModalClose").addEventListener("click", closeAttackModal);
    $("attackModal").addEventListener("click", (e) => { if (e.target.id === "attackModal") closeAttackModal(); });
    $("profileModalClose").addEventListener("click", closeProfileModal);
    $("profileModal").addEventListener("click", (e) => { if (e.target.id === "profileModal") closeProfileModal(); });
    const closeActivityModal = () => { $("activityModal").style.display = "none"; };
    $("activityModalClose").addEventListener("click", closeActivityModal);
    $("activityModalOkBtn").addEventListener("click", closeActivityModal);
    $("activityModal").addEventListener("click", (e) => { if (e.target.id === "activityModal") closeActivityModal(); });
    // 로그인 전 화면의 큰 CTA 버튼 — auth-widget.js가 실제로 리스닝하는 loginNavBtn 클릭을 그대로 위임한다.
    const cta = $("loggedOutCta");
    if (cta) cta.addEventListener("click", () => $("loginNavBtn").click());
    $("rebirthBtn").addEventListener("click", async () => {
      if (!state || !state.rebirthReady) return;
      if (!confirm("환생하시겠습니까?\n레벨/경험치/스탯 포인트(HP·에너지·스태미나 최대치 포함)가 전부 초기화됩니다.\n코인·다이아·장비·봇·행성·클럽은 그대로 유지되고, ATK/DEF에 영구 +1%가 붙습니다.\n또한 환생 직후 30분간 해킹 작업/PvP/행성 약탈의 XP·코인이 2배가 됩니다.")) return;
      const btn = $("rebirthBtn");
      btn.disabled = true;
      try {
        const r = await api("/rebirth", { method: "POST" });
        toast("🔄 환생 완료! (" + r.rebirthCount + "회, ATK/DEF 영구 +" + r.state.rebirthBonusPct.toFixed(0) + "%) · 💠 환생석 +" + r.rebirthStonesGained);
        state = r.state; renderHeader();
        renderTab(currentTab);
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    watchLogin();
    if (session()) startDashboard();
  });
})();
