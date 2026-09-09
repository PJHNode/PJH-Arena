/* ============================================================
   arena.js — PJH Arena 대시보드 클라이언트 로직
   ============================================================ */
(function () {
  const ARENA_API = "https://arena.chaostatix.workers.dev";
  const FORUM_API = "https://forum.chaostatix.workers.dev";

  const JOB_META = {
    low:    { label: "LOW",    icon: "📡" },
    medium: { label: "MEDIUM", icon: "🛰️" },
    high:   { label: "HIGH",   icon: "🖥️" },
    master: { label: "MASTER", icon: "🧠" },
  };
  // 서버 상수와 동일한 값(표시용) — 실제 검증/보상 롤은 항상 서버에서 다시 계산한다.
  const JOB_TIERS = {
    low:    { minLevel: 1,  energyCost: 10, coinMin: 100, coinMax: 150,  xp: 15 },
    medium: { minLevel: 5,  energyCost: 20, coinMin: 250, coinMax: 350,  xp: 35 },
    high:   { minLevel: 10, energyCost: 35, coinMin: 500, coinMax: 700,  xp: 70 },
    master: { minLevel: 20, energyCost: 50, coinMin: 900, coinMax: 1300, xp: 120 },
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
    if (!startDashboard._timer) {
      startDashboard._timer = setInterval(refreshState, 15000);
      setInterval(refreshWidgetBar, 60000);
    }
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
    $("levelBadge").textContent = state.level;
    $("expBar").style.width = Math.min(100, (state.xp / state.nextExp) * 100) + "%";
    $("expText").textContent = fmt(state.xp) + " / " + fmt(state.nextExp);
    $("pocketCoinsHead").textContent = fmt(state.pocketCoins);

    $("hpBar").style.width = (state.hp / state.maxHp) * 100 + "%";
    $("hpText").textContent = state.hp + " / " + state.maxHp;
    $("energyBar").style.width = (state.energy / state.maxEnergy) * 100 + "%";
    $("energyText").textContent = state.energy + " / " + state.maxEnergy;
    $("staminaBar").style.width = (state.stamina / state.maxStamina) * 100 + "%";
    $("staminaText").textContent = state.stamina + " / " + state.maxStamina;

    $("atkText").textContent = state.atk;
    $("defText").textContent = state.def;
    $("critText").textContent = state.crit;
    $("shieldTag").style.display = state.shielded ? "" : "none";

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
  function statUpgradeCostPreview(base, current) {
    if (current >= base * 5) return 5;
    if (current >= base * 4) return 4;
    if (current >= base * 3) return 3;
    return 2;
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
        return (
          '<div class="stat-upgrade-row">' +
          '<span class="stat-upgrade-label">' + d.label + "</span>" +
          '<span class="stat-upgrade-value">' + current + " → <b>" + (current + d.increment) + "</b> (+" + d.increment + ")</span>" +
          '<span class="stat-upgrade-cost">' + cost + "P</span>" +
          '<button data-upgrade-stat="' + d.key + '"' + (canAfford ? "" : " disabled") + ">강화</button>" +
          "</div>"
        );
      }).join("");
    body.querySelectorAll("button[data-upgrade-stat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const r = await api("/stats/upgrade", { method: "POST", body: { stat: btn.dataset.upgradeStat } });
          toast("스탯 강화 완료! (-" + r.cost + " 포인트)");
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
          toast("💰 +" + fmt(r.coinsGained) + " 코인 · EXP +" + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : ""));
          state = r.state; renderHeader(); renderJobsTab(); renderMiningGraph();
        } catch (e) { toast(e.message, true); }
        finally { btn.disabled = false; }
      });
    });
    renderMiningGraph();
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
      const { targets } = await api("/arena/targets");
      if (!targets.length) { listEl.innerHTML = '<p class="dim">현재 공격 가능한 대상이 없습니다.</p>'; return; }
      listEl.innerHTML = targets.map((t) => (
        '<div class="pvp-row">' +
        '<div class="pvp-name">' + escapeHtml(t.realName) + '<span class="dim"> Lv.' + t.level + "</span> " +
        (t.online ? '<span style="color:var(--energy);">● ONLINE</span>' : '<span class="dim">○ OFFLINE' + (t.offlinePendingCoins > 0 ? ' <span style="color:var(--stamina);">(+' + fmt(t.offlinePendingCoins) + ' 대기수익)</span>' : '') + "</span>") + "</div>" +
        '<div class="pvp-stat">DEF ' + t.def + "</div>" +
        '<div class="pvp-stat">승률 ' + t.estimatedVictoryPct + "% <span class=\"dim\">(" + t.attacksUsedToday + "/" + t.attacksMaxPerDay + ")</span></div>" +
        '<div class="pvp-stat">⚡' + t.staminaCost + "</div>" +
        '<button class="btn-ghost" data-scan="' + t.userId + '">SCAN</button>' +
        '<button class="btn-danger" data-attack="' + t.userId + '"' + (state.stamina < t.staminaCost || t.attackCapped ? " disabled" : "") + ">" + (t.attackCapped ? "한도 도달" : "ATTACK") + "</button>" +
        "</div>"
      )).join("");
      listEl.querySelectorAll("button[data-scan]").forEach((btn) => {
        btn.addEventListener("click", () => openScanModal(btn.dataset.scan));
      });
      listEl.querySelectorAll("button[data-attack]").forEach((btn) => {
        btn.addEventListener("click", () => openAttackSequence(btn.dataset.attack));
      });
    } catch (e) { listEl.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  async function openScanModal(targetUserId) {
    try {
      const r = await api("/arena/scan", { method: "POST", body: { targetUserId } });
      $("scanModalBody").innerHTML =
        "<h3>🔎 PRACTICE SCAN — " + escapeHtml(r.realName) + " (Lv." + r.level + ")</h3>" +
        '<div class="scan-row">상태 <b>' + (r.online ? "🟢 온라인" : "⚪ 오프라인") + "</b></div>" +
        (r.online ? "" : '<div class="scan-row">대기 중인 Property 수익 <b style="color:var(--stamina);">+' + fmt(r.offlinePendingCoins) + "</b></div>") +
        '<div class="scan-row">최근 태세 <b>' + (r.lastStanceLabel || "정보 없음") + "</b></div>" +
        '<div class="scan-row">내 ATK <b>' + r.myAtk + "</b></div>" +
        '<div class="scan-row">상대 DEF <b>' + r.def + "</b></div>" +
        '<div class="scan-row">소모 스태미나 <b>' + r.staminaCost + "</b></div>" +
        '<div class="scan-row">오늘 공격 횟수 <b' + (r.attackCapped ? ' style="color:var(--danger);"' : '') + '>' + r.attacksUsedToday + " / " + r.attacksMaxPerDay + "</b></div>" +
        '<div class="scan-winrate">예상 승률<br><span>' + r.estimatedVictoryPct + "%</span></div>";
      $("scanModal").style.display = "flex";
    } catch (e) { toast(e.message, true); }
  }

  // ── Galaxy Map — 각자의 홈 행성(공격 불가) + 야생 행성(PVE 봇 또는 다른 유저가 정복해 둔 것)
  //    목록. 야생 행성 공격은 PvP와 똑같은 태세+타이밍 시퀀스를 그대로 재사용한다. ──
  async function renderGalaxyTab() {
    if (!state) return;
    const panel = $("panel-galaxy");
    const grid = panel.querySelector(".planet-grid");
    grid.innerHTML = '<p class="dim">은하 지도 스캔 중...</p>';
    try {
      const { planets, myOwnedWild, maxOwnedWild } = await api("/planets");
      $("galaxyOwnedCount").textContent = myOwnedWild;
      $("galaxyMaxOwned").textContent = maxOwnedWild;
      $("galaxyMaxOwned2").textContent = maxOwnedWild;
      const pendingTotal = planets.reduce((sum, p) => sum + (p.pendingCoins || 0), 0);
      $("galaxyPending").textContent = fmt(pendingTotal);
      grid.innerHTML = planets.map((p) => {
        const cls = p.isHome ? "home" : p.mine ? "mine" : "";
        const ownerLine = p.isHome ? "🏠 홈 행성" : p.mine ? "내 소유" : p.ownerUserId ? "소유: " + escapeHtml(p.ownerName) : "";
        const tierLine = p.botTier ? '<div class="planet-card-tier">🤖 ' + p.botTierLabel + "</div>" : "";
        const rateLine = !p.isHome ? '<div class="planet-card-rate">💰 ' + fmt(p.coinsPerHour) + "/hr" + (p.mine && p.pendingCoins > 0 ? " · 대기 " + fmt(p.pendingCoins) : "") + "</div>" : "<div class=\"planet-card-rate\">&nbsp;</div>";
        const btn = p.attackable
          ? '<button class="btn-danger" data-planet="' + p.id + '"' + (state.stamina < 2 ? " disabled" : "") + ">ATTACK (⚡2)</button>"
          : '<button class="btn-ghost" disabled>' + (p.isHome ? "홈 행성" : "내 행성") + "</button>";
        return (
          '<div class="planet-card ' + cls + '">' +
          '<div class="planet-card-name">' + escapeHtml(p.name) + "</div>" +
          '<div class="planet-card-owner">' + ownerLine + "</div>" +
          tierLine + rateLine + btn +
          "</div>"
        );
      }).join("");
      grid.querySelectorAll("button[data-planet]").forEach((btn) => {
        const planet = planets.find((p) => String(p.id) === btn.dataset.planet);
        btn.addEventListener("click", () => openPlanetAttackSequence(planet));
      });
    } catch (e) { grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  function initGalaxyButtons() {
    const btn = $("galaxyCollectBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await api("/planets/collect", { method: "POST" });
        toast(r.collected > 0 ? "+" + fmt(r.collected) + " 코인 수거" : "수거할 대기 수익이 없습니다.");
        state.pocketCoins = r.pocketCoins; renderHeader(); renderGalaxyTab();
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
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
  //    첫 화면을 위해 정찰(스태미나 소모 없음)을 한 번 조용히 호출해 상대의 평소 태세를 보여준다. ──
  async function openAttackSequence(targetUserId) {
    $("attackModal").style.display = "flex";
    $("attackModalBody").innerHTML = '<p class="dim">정보 조회 중...</p>';
    try {
      const scan = await api("/arena/scan", { method: "POST", body: { targetUserId } });
      renderStanceStep({ mode: "pvp", targetUserId: targetUserId }, scan.realName,
        scan.lastStanceLabel ? "상대는 최근 <b>[" + scan.lastStanceLabel + "]</b>으로 싸웠습니다 — 상성을 노려보세요." : "상대의 전투 패턴 정보가 없습니다.");
    } catch (e) {
      $("attackModalBody").innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>";
    }
  }

  function openPlanetAttackSequence(planet) {
    $("attackModal").style.display = "flex";
    const hint = planet.botTier
      ? "PVE 봇(" + planet.botTierLabel + ")이 지키고 있습니다."
      : "현재 소유자: <b>" + escapeHtml(planet.ownerName || "?") + "</b> — 정복하면 그동안 쌓인 수익을 약탈합니다.";
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
        resultDetail = r.attackerWins
          ? (r.captured ? "🌍 행성 정복! " : "(정복 한도 초과 — 약탈만) ") + "+" + fmt(r.lootCoins) + " 코인 약탈"
          : "정복 실패";
      } else {
        const bonusNote = r.offlineBonusCollected > 0 ? "Property 대기수익 " + fmt(r.offlineBonusCollected) + " 포함 정산됨" : "";
        resultDetail = (r.attackerWins ? "약탈 +" + fmt(r.coinsDelta) + " 코인" : "약탈 실패") + (bonusNote ? "<br>" + bonusNote : "");
      }
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
      if (isPlanet && currentTab === "galaxy") renderGalaxyTab();
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

  let shopNextRotationAt = 0;
  // ── ③ Hardware Shop — 장비(무장/방어/코어)는 여러 개 살 수 있다(플레이어+봇에 나눠 장착).
  //    상점은 4분마다 통째로 리롤되는 공용 로테이션이라, 카운트다운이 0이 되면 자동으로 다시 그린다. ──
  async function renderShopTab() {
    if (!state) return;
    const panel = $("panel-shop");
    const grid = panel.querySelector(".shop-grid");
    grid.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const { items, nextRotationAt } = await api("/shop");
      shopNextRotationAt = nextRotationAt;
      grid.innerHTML = items.map((it) => {
        const capped = it.maxOwned && it.owned >= it.maxOwned;
        const soldOut = it.totalStock != null && it.remainingStock <= 0;
        const disabled = capped || soldOut || state.pocketCoins < it.price;
        const btnLabel = soldOut ? "품절" : capped ? "보유 한도" : "구매";
        const stockLine = it.totalStock != null ? '<div class="shop-card-type" style="color:' + (soldOut ? "var(--danger)" : "var(--sub)") + ';">재고 ' + it.remainingStock + " / " + it.totalStock + "</div>" : "";
        return (
        '<div class="shop-card" style="border-left-color:' + it.typeColor + '">' +
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
      const consumables = inv.items.filter((it) => it.type === "consumable");
      if (!consumables.length) { list.innerHTML = '<p class="dim">보유한 소비재가 없습니다. Hardware Shop에서 구매하세요.</p>'; return; }
      list.innerHTML = consumables.map((it) => (
        '<div class="inv-row" style="border-left-color:' + it.rarityColor + '">' +
        '<div class="inv-name">' + escapeHtml(it.name) + (it.qty > 1 ? " ×" + it.qty : "") + '<span class="rarity-badge" style="color:' + it.rarityColor + ';margin-left:6px;">' + it.rarityLabel + "</span></div>" +
        '<div class="dim">' + itemStatLabel(it) + "</div>" +
        '<button class="btn-ghost" data-use="' + it.id + '">사용</button>' +
        "</div>"
      )).join("");
      list.querySelectorAll("button[data-use]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try { const r = await api("/inventory/use", { method: "POST", body: { itemId: btn.dataset.use } }); toast("사용 완료"); state = r.state; renderHeader(); renderInventoryTab(); }
          catch (e) { toast(e.message, true); }
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
  async function renderBotsTab() {
    const panel = $("panel-bots");
    const el = panel.querySelector(".bot-roster");
    el.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const [data, catalog] = await Promise.all([api("/bots"), getShopCatalog()]);

      function slotRow(target, slotType, label, equippedId) {
        const options = data.availableItems.filter((it) => it.type === slotType);
        const currentItem = equippedId ? catalog[equippedId] : null;
        let optionsHtml = '<option value="">— 비어있음 —</option>';
        if (equippedId) optionsHtml += '<option value="' + equippedId + '" selected>[' + (currentItem ? currentItem.rarityLabel : "") + "] " + escapeHtml(currentItem ? currentItem.name : equippedId) + " (장착중)</option>";
        options.forEach((it) => { optionsHtml += '<option value="' + it.id + '">[' + it.rarityLabel + "] " + escapeHtml(it.name) + " (+" + it.available + ")</option>"; });
        return (
          '<div class="bot-slot slot-' + slotType + '"><span>' + label + '</span><select data-target="' + target + '" data-slot="' + slotType + '">' + optionsHtml + "</select></div>"
        );
      }

      let html = '<div class="bot-card player"><div class="bot-card-title">🧑‍💻 YOU</div>' +
        slotRow("player", "weapon", "무장", data.player.equippedWeapon) +
        slotRow("player", "armor", "방어", data.player.equippedArmor) +
        slotRow("player", "core", "코어", data.player.equippedCore) +
        "</div>";

      data.bots.forEach((b, i) => {
        html += '<div class="bot-card"><div class="bot-card-title">🤖 BOT #' + (i + 1) + '</div>' +
          slotRow(String(b.id), "weapon", "무장", b.equipped_weapon) +
          slotRow(String(b.id), "armor", "방어", b.equipped_armor) +
          slotRow(String(b.id), "core", "코어", b.equipped_core) +
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
          '<div class="property-card">' +
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

  // ── ⑤ Secure Bank ──
  function renderBankTab() {
    if (!state) return;
    $("bankPocket").textContent = fmt(state.pocketCoins);
    $("bankVault").textContent = fmt(state.bankCoins);
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
        return '<div class="lb-row"><span class="lb-rank">#' + (i + 1) + "</span><span>" + escapeHtml(r.real_name) + "</span><span class=\"lb-value\">" + valueLabel + "</span></div>";
      }).join("") || '<p class="dim">기록이 없습니다.</p>';
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
        const coinCls = l.coins_delta > 0 ? "pos" : l.coins_delta < 0 ? "neg" : "";
        return (
          '<div class="log-row"><span>' + icon + "</span><span>" + desc + '</span><span class="' + coinCls + '">' +
          (l.coins_delta ? (l.coins_delta > 0 ? "+" : "") + fmt(l.coins_delta) : "") + '</span><span class="dim">' + time + "</span></div>"
        );
      }).join("");
    } catch (e) { list.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initBankForm();
    initLeaderboardTabs();
    initStatButtons();
    initGalaxyButtons();
    $("scanModalClose").addEventListener("click", () => { $("scanModal").style.display = "none"; });
    $("scanModal").addEventListener("click", (e) => { if (e.target.id === "scanModal") $("scanModal").style.display = "none"; });
    $("attackModalClose").addEventListener("click", closeAttackModal);
    $("attackModal").addEventListener("click", (e) => { if (e.target.id === "attackModal") closeAttackModal(); });
    // 로그인 전 화면의 큰 CTA 버튼 — auth-widget.js가 실제로 리스닝하는 loginNavBtn 클릭을 그대로 위임한다.
    const cta = $("loggedOutCta");
    if (cta) cta.addEventListener("click", () => $("loginNavBtn").click());
    watchLogin();
    if (session()) startDashboard();
  });
})();
