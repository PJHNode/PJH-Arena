/* ============================================================
   arena.js — PJH Arena 대시보드 클라이언트 로직
   ============================================================ */
(function () {
  const ARENA_API = "https://arena.chaostatix.workers.dev";
  const FORUM_API = "https://forum.chaostatix.workers.dev";

  // 서버 RARITY_ORDER와 동일 순서(낮은 등급→높은 등급) — 봇 카드의 "대표 등급"을 고를 때만 씀.
  const RARITY_ORDER_CLIENT = ["common", "uncommon", "rare", "epic", "legendary", "mythic", "secret", "forbidden"];

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
  };
  // 서버 상수와 동일한 값(표시용) — 실제 검증/보상 롤은 항상 서버에서 다시 계산한다.
  const JOB_TIERS = {
    trivial:   { minLevel: 1,  energyCost: 5,  coinMin: 40,   coinMax: 60,   xp: 8 },
    low:       { minLevel: 1,  energyCost: 10, coinMin: 100,  coinMax: 150,  xp: 15 },
    guarded:   { minLevel: 3,  energyCost: 15, coinMin: 180,  coinMax: 250,  xp: 25 },
    medium:    { minLevel: 5,  energyCost: 20, coinMin: 250,  coinMax: 350,  xp: 35 },
    corporate: { minLevel: 8,  energyCost: 28, coinMin: 400,  coinMax: 550,  xp: 55 },
    high:      { minLevel: 10, energyCost: 35, coinMin: 500,  coinMax: 700,  xp: 70 },
    fortress:  { minLevel: 15, energyCost: 42, coinMin: 700,  coinMax: 950,  xp: 95 },
    master:    { minLevel: 20, energyCost: 50, coinMin: 900,  coinMax: 1300, xp: 120 },
    apex:      { minLevel: 28, energyCost: 50, coinMin: 1500, coinMax: 2000, xp: 180 },
    legendary: { minLevel: 35, energyCost: 50, coinMin: 2500, coinMax: 3400, xp: 260 },
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
    // PJH-Hub에서 산 아바타(있을 때만) — /state 응답에만 실려온다(다른 액션 응답엔 없음).
    if (state.avatarIcon) { $("avatarIcon").textContent = state.avatarIcon; $("avatarIcon").style.display = ""; }
    else if (state.avatarIcon === null) { $("avatarIcon").style.display = "none"; }
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

    // 완전 회복까지 남은 시간 — 서버가 매 /state마다 다시 계산해서 내려주는 ms를 절대 시각으로
    // 바꿔 저장해 두고, 1초마다 로컬에서 카운트다운만 갱신한다(그래야 폴링 사이에도 매끄럽게 줄어듦).
    const now = Date.now();
    hpFullAt = state.hpFullInMs == null ? null : (state.hpFullInMs <= 0 ? 0 : now + state.hpFullInMs);
    energyFullAt = state.energyFullInMs <= 0 ? 0 : now + state.energyFullInMs;
    staminaFullAt = state.staminaFullInMs <= 0 ? 0 : now + state.staminaFullInMs;
    renderResourceEtas();

    $("atkText").textContent = state.atk;
    $("defText").textContent = state.def;
    $("critText").textContent = state.crit;
    $("shieldTag").style.display = state.shielded ? "" : "none";

    // 환생 — 회당 ATK/DEF 영구 +1%(최대 10회), 레벨 100부터 버튼이 활성화된다.
    const rebirthTag = $("rebirthTag"), rebirthBtn = $("rebirthBtn");
    if (state.rebirthCount > 0) { rebirthTag.textContent = "🔄 환생 " + state.rebirthCount + "회 (전투력 +" + state.rebirthBonusPct.toFixed(0) + "%)"; rebirthTag.style.display = ""; }
    else rebirthTag.style.display = "none";
    if (state.rebirthReady) { rebirthBtn.style.display = ""; rebirthBtn.disabled = false; }
    else if (state.level >= state.rebirthLevelRequirement - 20) { rebirthBtn.style.display = ""; rebirthBtn.disabled = true; rebirthBtn.textContent = "🔄 환생 (Lv." + state.rebirthLevelRequirement + " 필요)"; }
    else rebirthBtn.style.display = "none";
    if (state.rebirthReady) rebirthBtn.textContent = "🔄 환생하기";

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
    research: renderResearchTab,
    trade: renderTradeTab,
    club: renderClubTab,
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
          toast("💰 +" + fmt(r.coinsGained) + " 코인 · EXP +" + r.xpGained + (r.leveledUp ? " · 🎉 LEVEL UP!" : ""));
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
          toast("출석 완료! +" + fmt(r.reward) + " 코인 (연속 " + r.streak + "일)");
          state.pocketCoins = r.pocketCoins; renderHeader(); renderDailyWidget();
        } catch (err) { toast(err.message, true); t.disabled = false; }
      } else if (t.dataset.questClaim) {
        t.disabled = true;
        try {
          const r = await api("/daily/quest-claim", { method: "POST", body: { quest: t.dataset.questClaim } });
          toast("미션 완료! +" + fmt(r.reward) + " 코인");
          state.pocketCoins = r.pocketCoins; renderHeader(); renderDailyWidget();
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
      const { targets } = await api("/arena/targets");
      if (!targets.length) { listEl.innerHTML = '<p class="dim">현재 공격 가능한 대상이 없습니다.</p>'; return; }
      listEl.innerHTML = targets.map((t) => {
        // 지금 당장 공격은 못 해도(보호막/다운/한도 초과) 목록에서 사라지진 않는다 — 이유만 표시.
        // 레벨 차이는 이제 공격을 막지 않는다 — ±10 넘으면 스태미나만 더 들어서 배지로만 알려준다.
        const statusNote = t.shielded ? '<span style="color:var(--cyan);"> 🛡️ 보호막 중</span>'
          : t.downed ? '<span style="color:var(--danger);"> 💀 다운 상태</span>'
          : t.levelGapHigh ? '<span style="color:var(--stamina);"> ⚠️ 레벨차 큼(스태미나 ↑)</span>' : "";
        const attackDisabled = state.stamina < t.staminaCost || !t.attackable;
        const attackLabel = t.shielded ? "보호막" : t.downed ? "다운" : t.attackCapped ? "한도 도달" : "ATTACK";
        return (
        '<div class="pvp-row">' +
        '<div class="pvp-name">' + escapeHtml(t.realName) + '<span class="dim"> Lv.' + t.level + "</span> " +
        (t.online ? '<span style="color:var(--energy);">● ONLINE</span>' : '<span class="dim">○ OFFLINE' + (t.offlinePendingCoins > 0 ? ' <span style="color:var(--stamina);">(+' + fmt(t.offlinePendingCoins) + ' 대기수익)</span>' : '') + "</span>") + statusNote + "</div>" +
        '<div class="pvp-stat">DEF ' + t.def + "</div>" +
        '<div class="pvp-stat">승률 ' + t.estimatedVictoryPct + "% <span class=\"dim\">(" + t.attacksUsedToday + "/" + t.attacksMaxPerDay + ")</span></div>" +
        '<div class="pvp-stat">⚡' + t.staminaCost + "</div>" +
        '<button class="btn-ghost" data-scan="' + t.userId + '">SCAN</button>' +
        '<button class="btn-danger" data-attack="' + t.userId + '"' + (attackDisabled ? " disabled" : "") + ">" + attackLabel + "</button>" +
        "</div>"
        );
      }).join("");
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
      state = r.state; renderHeader(); // 정찰도 이제 스태미나 1을 쓴다 — 헤더 수치 바로 반영
      $("scanModalBody").innerHTML =
        "<h3>🔎 PRACTICE SCAN — " + escapeHtml(r.realName) + " (Lv." + r.level + ")</h3>" +
        '<div class="scan-row">상태 <b>' + (r.online ? "🟢 온라인" : "⚪ 오프라인") + "</b></div>" +
        (r.online ? "" : '<div class="scan-row">대기 중인 Property 수익 <b style="color:var(--stamina);">+' + fmt(r.offlinePendingCoins) + "</b></div>") +
        '<div class="scan-row">최근 태세 <b>' + (r.lastStanceLabel || "정보 없음") + "</b></div>" +
        '<div class="scan-row">내 ATK <b>' + r.myAtk + "</b></div>" +
        '<div class="scan-row">상대 DEF <b>' + r.def + "</b></div>" +
        '<div class="scan-row">공격 시 소모 스태미나 <b' + (r.levelGapHigh ? ' style="color:var(--stamina);"' : '') + '>' + r.staminaCost + (r.levelGapHigh ? " (레벨차 큼)" : "") + "</b></div>" +
        '<div class="scan-row">오늘 공격 횟수 <b' + (r.attackCapped ? ' style="color:var(--danger);"' : '') + '>' + r.attacksUsedToday + " / " + r.attacksMaxPerDay + "</b></div>" +
        '<div class="scan-winrate">예상 승률<br><span>' + r.estimatedVictoryPct + "%</span></div>" +
        '<p class="dim" style="text-align:center;margin-top:8px;">(정찰 비용: 스태미나 ' + r.scanStaminaCost + ')</p>';
      $("scanModal").style.display = "flex";
    } catch (e) { toast(e.message, true); }
  }

  // ── Galaxy Map — 48개 야생 행성을 한 화면에 다 쏟아내면 뭘 해야 할지 알기 어렵다는 피드백이
  //    있어서, "내 제국"(홈 + 이미 정복한 행성)과 "정복 대상"을 아예 다른 섹션으로 나누고,
  //    정복 대상 쪽엔 난이도/유형 필터 + 처음엔 12개만 보여주는 "더 보기"를 둬서 한눈에 훑을
  //    수 있게 했다. 필터/더보기는 이미 받아온 목록을 다시 그리기만 할 뿐 서버를 다시 호출하지
  //    않는다 — 캐시가 없을 때만(최초 진입, 공격 후) 네트워크를 탄다. ──
  let galaxyCache = null;
  let galaxyExpeditionUnlocked = false;
  let galaxyTierFilter = "all", galaxyTypeFilter = "all", galaxyShowCount = 12;
  const GALAXY_PAGE_SIZE = 12;
  const TIER_ORDER_CLIENT = ["weak", "medium", "strong", "elite", "nightmare", "apex"];

  async function renderGalaxyTab() {
    if (!state) return;
    if (!galaxyCache) {
      const grid = document.querySelector("#panel-galaxy .planet-grid");
      grid.innerHTML = '<p class="dim">은하 지도 스캔 중...</p>';
      try {
        const [planetsData, researchData] = await Promise.all([api("/planets"), api("/research").catch(() => null)]);
        galaxyCache = planetsData;
        galaxyExpeditionUnlocked = !!(researchData && researchData.expeditionUnlocked);
      } catch (e) {
        grid.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>";
        return;
      }
    }
    renderGalaxyContent();
  }

  function renderGalaxyContent() {
    const data = galaxyCache;
    if (!data) return;
    const panel = $("panel-galaxy");
    const empireGrid = panel.querySelector(".galaxy-empire-grid");
    const grid = panel.querySelector(".planet-grid");
    const moreBtn = $("galaxyShowMoreBtn");

    $("galaxyOwnedCount").textContent = data.myOwnedWild;
    $("galaxyMaxOwned").textContent = data.maxOwnedWild == null ? "무제한" : data.maxOwnedWild;
    galaxyNextRerollAt = data.nextRerollAt;
    const empire = data.planets.filter((p) => p.isHome || p.mine);
    const pendingTotal = empire.reduce((sum, p) => sum + (p.pendingCoins || 0), 0);
    $("galaxyPending").textContent = fmt(pendingTotal);

    // 난이도별 등장 확률 + 다음 리롤까지 남은 시간 — 필터 바로 위에 작은 범례로 보여준다.
    const legendEl = $("galaxyTierLegend");
    if (legendEl && data.tierMeta) {
      legendEl.innerHTML = TIER_ORDER_CLIENT.map((key) => {
        const t = data.tierMeta[key];
        return '<span class="galaxy-tier-chip">' + t.label + " " + Math.round(t.weight * 100) + "%</span>";
      }).join("");
    }

    function statLine(p) {
      if (!p.combatStats) return "";
      const s = p.combatStats;
      return '<div class="planet-card-combat">⚔️' + s.atk + " 🛡️" + s.def + " 💥" + s.crit + "%</div>";
    }

    function planetCard(p, withButton) {
      const cls = p.isHome ? "home" : p.mine ? "mine" : "";
      const ownerLine = p.isHome ? "🏠 홈 행성" : p.mine ? "내 소유" : p.ownerUserId ? "소유: " + escapeHtml(p.ownerName) : "🤖 무주인 (PVE)";
      const tierLine = p.botTier ? '<div class="planet-card-tier">🤖 ' + p.botTierLabel + "</div>" : "";
      const rateLine = !p.isHome ? '<div class="planet-card-rate">💰 ' + fmt(p.coinsPerHour) + "/hr" + (p.mine && p.pendingCoins > 0 ? " · 대기 " + fmt(p.pendingCoins) : "") + "</div>" : "<div class=\"planet-card-rate\">&nbsp;</div>";
      const attackBtn = !withButton ? "" : p.attackable
        ? '<button class="btn-danger" data-planet="' + p.id + '"' + (state.stamina < 2 ? " disabled" : "") + ">ATTACK (⚡2)</button>"
        : '<button class="btn-ghost" disabled>' + (p.isHome ? "홈 행성" : "내 행성") + "</button>";
      const expeditionBtn = withButton && p.expeditionEligible && galaxyExpeditionUnlocked
        ? '<button class="btn-ghost" data-expedition="' + p.id + '" style="margin-top:6px;width:100%;"' + (state.stamina < 2 ? " disabled" : "") + ">🛰️ 원정 보내기 (⚡2)</button>"
        : "";
      // 내 제국 칸에서만 — 홈 행성 제외, 내가 정복해 둔 야생 행성은 포기할 수 있다.
      const abandonBtn = !withButton && p.mine && !p.isHome
        ? '<button class="btn-ghost" data-abandon="' + p.id + '" style="margin-top:6px;width:100%;">포기하기</button>'
        : "";
      return (
        '<div class="planet-card ' + cls + '">' +
        '<div class="planet-card-name">' + escapeHtml(p.name) + "</div>" +
        '<div class="planet-card-owner">' + ownerLine + "</div>" +
        tierLine + statLine(p) + rateLine + attackBtn + expeditionBtn + abandonBtn +
        "</div>"
      );
    }

    // 내 제국 — 항상 전부 보여준다(최대 1 홈 + 3 야생이라 얼마 안 됨).
    empireGrid.innerHTML = empire.length
      ? empire.map((p) => planetCard(p, false)).join("")
      : '<p class="galaxy-empire-empty">아직 정복한 행성이 없습니다. 아래에서 첫 행성을 노려보세요.</p>';

    // 정복 대상 — 필터 적용 후 GALAXY_PAGE_SIZE만큼만 우선 노출. 이제 남의 홈 행성도
    // 공격 대상에 포함된다(내 것만 "내 제국" 쪽으로 빠지고 여기선 제외).
    const targets = data.planets.filter((p) => {
      if (p.mine) return false;
      // 정복된 행성은 원래의 봇 난이도 정보가 사라지므로(bot_tier가 NULL이 됨), 난이도 필터는
      // 아직 봇이 지키고 있는 행성에만 적용된다 — 유저 소유 행성은 난이도 필터와 무관하게 남는다.
      if (galaxyTierFilter !== "all" && p.botTier && p.botTier !== galaxyTierFilter) return false;
      if (galaxyTypeFilter === "bot" && p.ownerUserId) return false;
      if (galaxyTypeFilter === "player" && !p.ownerUserId) return false;
      return true;
    });
    const visible = targets.slice(0, galaxyShowCount);
    grid.innerHTML = visible.length
      ? visible.map((p) => planetCard(p, true)).join("")
      : '<p class="dim">조건에 맞는 행성이 없습니다.</p>';
    moreBtn.style.display = targets.length > visible.length ? "" : "none";

    grid.querySelectorAll("button[data-planet]").forEach((btn) => {
      const planet = data.planets.find((p) => String(p.id) === btn.dataset.planet);
      btn.addEventListener("click", () => openPlanetAttackSequence(planet));
    });
    grid.querySelectorAll("button[data-expedition]").forEach((btn) => {
      btn.addEventListener("click", () => sendExpedition(btn.dataset.expedition, btn));
    });
    empireGrid.querySelectorAll("button[data-abandon]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("이 행성을 포기하시겠습니까? 대기 수익은 먼저 정산됩니다.")) return;
        btn.disabled = true;
        try {
          const r = await api("/planets/abandon", { method: "POST", body: { planetId: btn.dataset.abandon } });
          toast(r.collected > 0 ? "+" + fmt(r.collected) + " 코인 정산 후 포기 완료" : "포기 완료");
          state.pocketCoins = r.pocketCoins; renderHeader();
          galaxyCache = null; renderGalaxyTab();
        } catch (e) { toast(e.message, true); btn.disabled = false; }
      });
    });
  }

  // ── 원정(오프라인 자동 전투) — 태세/타이밍 미니게임 없이 즉시 서버 판정. 결과는 토스트로
  //    바로 보여주되, Hack Log에도 남으니 나중에 로그 탭에서 다시 확인할 수 있다. ──
  async function sendExpedition(planetId, btn) {
    btn.disabled = true;
    try {
      const r = await api("/planets/expedition", { method: "POST", body: { planetId } });
      toast((r.attackerWins ? "🛰️ 원정 성공! " + r.planetName + " (" + r.tierLabel + ") 정복" + (r.captured ? "" : "(한도 초과, 약탈만)") + " +" + fmt(r.lootCoins) + " 코인" : "🛰️ 원정 실패... " + r.planetName), !r.attackerWins);
      state = r.state; renderHeader();
      galaxyCache = null; renderGalaxyTab();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
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

  function initGalaxyFilters() {
    document.querySelectorAll(".galaxy-filter-btn[data-tier]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".galaxy-filter-btn[data-tier]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        galaxyTierFilter = btn.dataset.tier;
        galaxyShowCount = GALAXY_PAGE_SIZE;
        renderGalaxyContent();
      });
    });
    document.querySelectorAll(".galaxy-filter-btn[data-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".galaxy-filter-btn[data-type]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        galaxyTypeFilter = btn.dataset.type;
        galaxyShowCount = GALAXY_PAGE_SIZE;
        renderGalaxyContent();
      });
    });
    const moreBtn = $("galaxyShowMoreBtn");
    if (moreBtn) moreBtn.addEventListener("click", () => { galaxyShowCount += GALAXY_PAGE_SIZE; renderGalaxyContent(); });
  }

  function initGalaxyButtons() {
    initGalaxyFilters();
    const btn = $("galaxyCollectBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await api("/planets/collect", { method: "POST" });
        toast(r.collected > 0 ? "+" + fmt(r.collected) + " 코인 수거" : "수거할 대기 수익이 없습니다.");
        state.pocketCoins = r.pocketCoins; renderHeader(); galaxyCache = null; renderGalaxyTab();
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
  //    첫 화면을 위해 정찰을 한 번 호출해 상대의 평소 태세를 보여준다 — 정찰도 스태미나 1을 쓴다. ──
  async function openAttackSequence(targetUserId) {
    $("attackModal").style.display = "flex";
    $("attackModalBody").innerHTML = '<p class="dim">정보 조회 중...</p>';
    try {
      const scan = await api("/arena/scan", { method: "POST", body: { targetUserId } });
      state = scan.state; renderHeader();
      const stanceHint = (scan.lastStanceLabel ? "상대는 최근 <b>[" + scan.lastStanceLabel + "]</b>으로 싸웠습니다 — 상성을 노려보세요." : "상대의 전투 패턴 정보가 없습니다.")
        + (scan.levelGapHigh ? '<br><span style="color:var(--stamina);">⚠️ 레벨 차이가 커서 스태미나를 더 씁니다(' + scan.staminaCost + ').</span>' : "");
      renderStanceStep({ mode: "pvp", targetUserId: targetUserId }, scan.realName, stanceHint);
    } catch (e) {
      $("attackModalBody").innerHTML = '<p class="dim">' + escapeHtml(e.message) + '</p><button class="attack-close-btn" id="attackResultCloseBtn">닫기</button>';
      const closeBtn = $("attackResultCloseBtn");
      if (closeBtn) closeBtn.addEventListener("click", closeAttackModal);
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

  // ── HP/Energy/Stamina 완전 회복까지 남은 시간 표시 — renderHeader가 절대 시각을 세팅해두면
  // 1초마다 그 시각까지 남은 시간만 다시 계산해서 보여준다(다음 /state 폴링을 기다릴 필요 없음). ──
  let hpFullAt = 0, energyFullAt = 0, staminaFullAt = 0;
  function renderResourceEtas() {
    const now = Date.now();
    const hpEl = $("hpEta"), energyEl = $("energyEta"), staminaEl = $("staminaEta");
    if (hpEl) hpEl.textContent = hpFullAt == null ? "회복 불가(아이템 필요)" : hpFullAt > now ? "완충 " + fmtCountdown(hpFullAt - now) : "";
    if (energyEl) energyEl.textContent = energyFullAt > now ? "완충 " + fmtCountdown(energyFullAt - now) : "";
    if (staminaEl) staminaEl.textContent = staminaFullAt > now ? "완충 " + fmtCountdown(staminaFullAt - now) : "";
  }
  setInterval(renderResourceEtas, 1000);

  let shopNextRotationAt = 0;
  // ── ③ Hardware Shop — 장비(무장/방어/코어)는 여러 개 살 수 있다(플레이어+봇에 나눠 장착).
  //    상점은 4분마다 통째로 리롤되는 공용 로테이션이라, 카운트다운이 0이 되면 자동으로 다시 그린다. ──
  async function renderShopTab() {
    if (!state) return;
    const panel = $("panel-shop");
    const grid = panel.querySelector(".shop-grid");
    grid.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const { items, nextRotationAt, diamonds, diamondExchangeCost, rerollCost } = await api("/shop");
      shopNextRotationAt = nextRotationAt;
      $("shopDiamondBalance").textContent = "💎 " + fmt(diamonds);
      $("shopExchangeCost").textContent = fmt(diamondExchangeCost);
      $("shopRerollCost").textContent = fmt(rerollCost);
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

  function initShopButtons() {
    const btn = $("exchangeDiamondBtn");
    if (btn) btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const r = await api("/shop/exchange-diamond", { method: "POST", body: { qty: 1 } });
        toast("💎 다이아 1개 교환 완료!");
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
      const [data, catalog] = await Promise.all([api("/bots"), getShopCatalog()]);
      botsTabLoadedOnce = true;

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

      // 봇의 "성능 등급" — 장착된 3개 중 가장 희귀한 등급을 그 봇의 대표 색/이펙트로 쓴다.
      function bestRarityOf(weaponId, armorId, coreId) {
        let best = null, bestIdx = -1;
        [weaponId, armorId, coreId].forEach((id) => {
          const it = id ? catalog[id] : null;
          if (!it) return;
          const idx = RARITY_ORDER_CLIENT.indexOf(it.rarity);
          if (idx > bestIdx) { bestIdx = idx; best = it; }
        });
        return best; // { rarity, rarityLabel, rarityColor } 또는 null(3슬롯 다 비어있음)
      }
      function botCardStyleAttrs(rarityInfo) {
        if (!rarityInfo) return { style: "", cls: "", tag: "" };
        const glow = ["legendary", "mythic", "secret", "forbidden"].indexOf(rarityInfo.rarity) !== -1;
        return {
          style: 'style="border-color:' + rarityInfo.rarityColor + ';--glow-color:' + rarityInfo.rarityColor + ';"',
          cls: glow ? " glow-pulse" : "",
          tag: '<div class="bot-card-rarity-tag" style="color:' + rarityInfo.rarityColor + ';">' + rarityInfo.rarityLabel + " GRADE</div>",
        };
      }
      function gachaRow(botId) {
        return '<div class="bot-gacha-row">' + Object.keys(BOT_GACHA_META).map((tier) => {
          const m = BOT_GACHA_META[tier];
          return '<button class="bot-gacha-btn" data-gacha="' + botId + '" data-tier="' + tier + '"' + (state.pocketCoins < m.price ? " disabled" : "") + ">" + m.label + "<br>💰" + fmt(m.price) + "</button>";
        }).join("") + "</div>";
      }
      function statLine(stats) {
        return '<div class="bot-stat-line"><span>⚔️ ATK <b>' + stats.atk + '</b></span><span>🛡️ DEF <b>' + stats.def + '</b></span><span>💥 CRIT <b>' + stats.crit + '%</b></span></div>';
      }

      let html = '<div class="bot-card player"><div class="bot-card-title">🧑‍💻 YOU</div>' +
        statLine(data.player.stats) +
        slotRow("player", "weapon", "무장", data.player.equippedWeapon) +
        slotRow("player", "armor", "방어", data.player.equippedArmor) +
        slotRow("player", "core", "코어", data.player.equippedCore) +
        "</div>";

      data.bots.forEach((b, i) => {
        const rarityInfo = bestRarityOf(b.equipped_weapon, b.equipped_armor, b.equipped_core);
        const attrs = botCardStyleAttrs(rarityInfo);
        const sellRefund = Math.floor((b.recruit_cost || 2000) * (data.botSellRate || 0.5));
        html += '<div class="bot-card' + attrs.cls + '" ' + attrs.style + '>' +
          '<div class="bot-card-title">🤖 BOT #' + (i + 1) + '<button class="bot-sell-btn" data-sell="' + b.id + '" title="봇 되팔기">되팔기 💰' + fmt(sellRefund) + "</button></div>" +
          attrs.tag +
          statLine(b.stats) +
          slotRow(String(b.id), "weapon", "무장", b.equipped_weapon) +
          slotRow(String(b.id), "armor", "방어", b.equipped_armor) +
          slotRow(String(b.id), "core", "코어", b.equipped_core) +
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
      el.querySelectorAll("button[data-gacha]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/bots/gacha", { method: "POST", body: { botId: btn.dataset.gacha, tier: btn.dataset.tier } });
            toast("🎰 가챠 결과: [" + r.rarityLabel + "] 등급!");
            state.pocketCoins = r.pocketCoins; renderHeader(); renderBotsTab();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
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

  // ── Research — 다이아로 상점 행운/원정(오프라인 자동 전투) 연구를 진행한다. ──
  async function renderResearchTab() {
    const panel = $("panel-research");
    try {
      const r = await api("/research");
      $("researchDiamonds").textContent = "💎 " + fmt(r.diamonds);
      $("researchShopLevelTag").textContent = "Lv." + r.shopLevel;
      $("researchShopCost").textContent = fmt(r.shopUpgradeCost);
      const upBtn = $("researchShopUpgradeBtn");
      upBtn.disabled = r.diamonds < r.shopUpgradeCost;
      $("researchRarityTable").innerHTML = RARITY_ORDER_CLIENT.map((rarity) => (
        '<div class="research-rarity-row" style="color:' + r.rarityColors[rarity] + ';">' + r.rarityLabels[rarity] +
        "<b>" + Math.round(r.rarityChances[rarity] * 1000) / 10 + "%</b></div>"
      )).join("");

      $("researchExpeditionCost").textContent = fmt(r.expeditionUnlockCost);
      const expBtn = $("researchExpeditionUnlockBtn");
      if (r.expeditionUnlocked) {
        $("researchExpeditionTag").textContent = "해금됨";
        expBtn.disabled = true;
        expBtn.textContent = "이미 해금됨";
      } else {
        $("researchExpeditionTag").textContent = "미해금";
        expBtn.disabled = r.diamonds < r.expeditionUnlockCost;
        expBtn.innerHTML = "해금하기 (💎 <span id=\"researchExpeditionCost\">" + fmt(r.expeditionUnlockCost) + "</span>)";
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
    const expBtn = $("researchExpeditionUnlockBtn");
    if (expBtn) expBtn.addEventListener("click", async () => {
      expBtn.disabled = true;
      try {
        const r = await api("/research/expedition-unlock", { method: "POST" });
        toast("🛰️ 원정 연구 해금 완료!");
        renderResearchTab();
      } catch (e) { toast(e.message, true); expBtn.disabled = false; }
    });
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

  async function renderClubTab() {
    const el = $("clubContent");
    try {
      const data = await api("/club");
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
          : "");
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
      }
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "clubChatInput") $("clubChatSendBtn").click();
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
        else if (l.kind === "planet_attack") { icon = attackWon ? "🌍" : "🛡️"; desc = (attackWon ? "행성 정복: " : "행성 공격 실패: ") + escapeHtml(l.opponent_name || "알 수 없음"); }
        else if (l.kind === "planet_lost") { icon = "💥"; desc = "행성을 빼앗김: " + escapeHtml(l.opponent_name || "알 수 없음"); }
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
    $("scanModalClose").addEventListener("click", () => { $("scanModal").style.display = "none"; });
    $("scanModal").addEventListener("click", (e) => { if (e.target.id === "scanModal") $("scanModal").style.display = "none"; });
    $("attackModalClose").addEventListener("click", closeAttackModal);
    $("attackModal").addEventListener("click", (e) => { if (e.target.id === "attackModal") closeAttackModal(); });
    // 로그인 전 화면의 큰 CTA 버튼 — auth-widget.js가 실제로 리스닝하는 loginNavBtn 클릭을 그대로 위임한다.
    const cta = $("loggedOutCta");
    if (cta) cta.addEventListener("click", () => $("loginNavBtn").click());
    $("rebirthBtn").addEventListener("click", async () => {
      if (!state || !state.rebirthReady) return;
      if (!confirm("환생하시겠습니까?\n레벨/경험치/스탯 포인트(HP·에너지·스태미나 최대치 포함)가 전부 초기화됩니다.\n코인·다이아·장비·봇·행성·클럽은 그대로 유지되고, ATK/DEF에 영구 +1%가 붙습니다.")) return;
      const btn = $("rebirthBtn");
      btn.disabled = true;
      try {
        const r = await api("/rebirth", { method: "POST" });
        toast("🔄 환생 완료! (" + r.rebirthCount + "회, ATK/DEF 영구 +" + r.state.rebirthBonusPct.toFixed(0) + "%)");
        state = r.state; renderHeader();
        renderTab(currentTab);
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
    });
    watchLogin();
    if (session()) startDashboard();
  });
})();
