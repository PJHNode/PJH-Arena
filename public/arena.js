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
    $("appShell").style.display = "";
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
    $("shieldTag").style.display = state.shielded ? "" : "none";

    if (state.hp <= 0) $("downedBanner").style.display = "";
    else $("downedBanner").style.display = "none";

    const dashVault = $("dashBankVault");
    if (dashVault) dashVault.textContent = fmt(state.bankCoins);
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
    pvp: renderPvpTab,
    shop: renderShopTab,
    inventory: renderInventoryTab,
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
    if (panel) panel.style.display = "";
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
    renderDashboardPvp();
    renderDashboardShop();
    renderDashboardLog();
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
        '<div class="pvp-name">' + escapeHtml(t.realName) + '<span class="dim"> Lv.' + t.level + "</span></div>" +
        '<div class="pvp-stat">DEF ' + t.def + "</div>" +
        '<div class="pvp-stat">승률 ' + t.estimatedVictoryPct + "%</div>" +
        '<div class="pvp-stat">⚡' + t.staminaCost + "</div>" +
        '<button class="btn-ghost" data-scan="' + t.userId + '">SCAN</button>' +
        '<button class="btn-danger" data-attack="' + t.userId + '"' + (state.stamina < t.staminaCost ? " disabled" : "") + ">ATTACK</button>" +
        "</div>"
      )).join("");
      listEl.querySelectorAll("button[data-scan]").forEach((btn) => {
        btn.addEventListener("click", () => openScanModal(btn.dataset.scan));
      });
      listEl.querySelectorAll("button[data-attack]").forEach((btn) => {
        btn.addEventListener("click", () => doAttack(btn.dataset.attack, btn));
      });
    } catch (e) { listEl.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  async function openScanModal(targetUserId) {
    try {
      const r = await api("/arena/scan", { method: "POST", body: { targetUserId } });
      $("scanModalBody").innerHTML =
        "<h3>🔎 PRACTICE SCAN — " + escapeHtml(r.realName) + " (Lv." + r.level + ")</h3>" +
        '<div class="scan-row">내 ATK <b>' + r.myAtk + "</b></div>" +
        '<div class="scan-row">상대 DEF <b>' + r.def + "</b></div>" +
        '<div class="scan-row">소모 스태미나 <b>' + r.staminaCost + "</b></div>" +
        '<div class="scan-winrate">예상 승률<br><span>' + r.estimatedVictoryPct + "%</span></div>";
      $("scanModal").style.display = "flex";
    } catch (e) { toast(e.message, true); }
  }

  async function doAttack(targetUserId, btn) {
    btn.disabled = true;
    try {
      const r = await api("/arena/attack", { method: "POST", body: { targetUserId } });
      if (r.attackerWins) toast("✅ 침투 성공! 약탈 +" + fmt(r.coinsDelta) + " 코인");
      else toast("❌ 침투 실패...", true);
      state = r.state; renderHeader();
      if (currentTab === "pvp") renderPvpTab();
      if (currentTab === "jobs") { renderDashboardPvp(); renderDashboardLog(); }
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  }

  // ── 홈 대시보드(Network Control Center)용 축약 위젯들 — 각 탭의 전체 화면과 별개로,
  //    한눈에 볼 수 있는 요약본만 보여준다(최대 6건). 상세 조작은 해당 사이드바 탭에서. ──
  async function renderDashboardPvp() {
    const el = document.querySelector(".pvp-compact-list");
    if (!el || !state) return;
    el.innerHTML = '<p class="dim">타겟 스캔 중...</p>';
    try {
      const { targets } = await api("/arena/targets");
      if (!targets.length) { el.innerHTML = '<p class="dim">공격 가능한 대상이 없습니다.</p>'; return; }
      el.innerHTML = targets.slice(0, 6).map((t) => (
        '<div class="compact-row">' +
        '<span>' + escapeHtml(t.realName) + '<span class="dim"> Lv.' + t.level + " · DEF " + t.def + "</span></span>" +
        '<button class="btn-ghost" data-dscan="' + t.userId + '">SCAN</button>' +
        '<button class="btn-danger" data-dattack="' + t.userId + '"' + (state.stamina < t.staminaCost ? " disabled" : "") + ">⚡" + t.staminaCost + "</button>" +
        "</div>"
      )).join("");
      el.querySelectorAll("button[data-dscan]").forEach((btn) => btn.addEventListener("click", () => openScanModal(btn.dataset.dscan)));
      el.querySelectorAll("button[data-dattack]").forEach((btn) => btn.addEventListener("click", () => doAttack(btn.dataset.dattack, btn)));
    } catch (e) { el.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  async function renderDashboardShop() {
    const el = document.querySelector(".shop-compact-list");
    if (!el || !state) return;
    el.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const { items } = await api("/shop");
      el.innerHTML = items.map((it) => {
        const owned = (it.type === "weapon" || it.type === "armor") && it.owned > 0;
        return (
          '<div class="compact-row">' +
          '<span>' + escapeHtml(it.name) + '<span class="dim"> 💰' + fmt(it.price) + "</span></span>" +
          '<button class="btn-primary" data-dbuy="' + it.id + '"' + (owned || state.pocketCoins < it.price ? " disabled" : "") + ">" +
          (owned ? "보유중" : "구매") + "</button><span></span></div>"
        );
      }).join("");
      el.querySelectorAll("button[data-dbuy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await api("/shop/buy", { method: "POST", body: { itemId: btn.dataset.dbuy } });
            toast("구매 완료!"); state.pocketCoins = r.pocketCoins; renderHeader(); renderDashboardShop();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
      });
    } catch (e) { el.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  async function renderDashboardLog() {
    const el = document.querySelector(".log-compact-list");
    if (!el) return;
    el.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const { logs } = await api("/logs");
      if (!logs.length) { el.innerHTML = '<p class="dim">기록이 없습니다.</p>'; return; }
      el.innerHTML = logs.slice(0, 6).map((l) => {
        let desc = "";
        if (l.kind === "job") desc = (l.opponent_name || "") + " 작업 완료";
        else if (l.kind === "pvp_attack") desc = (l.result === "win" ? "침투 성공: " : "침투 실패: ") + escapeHtml(l.opponent_name || "");
        else if (l.kind === "pvp_defend") desc = (l.result === "win" ? "방어 성공: " : "피격당함: ") + escapeHtml(l.opponent_name || "");
        const coinCls = l.coins_delta > 0 ? "pos" : l.coins_delta < 0 ? "neg" : "";
        return '<div class="compact-row"><span>' + desc + '</span><span class="' + coinCls + '">' +
          (l.coins_delta ? (l.coins_delta > 0 ? "+" : "") + fmt(l.coins_delta) : "") + "</span><span></span></div>";
      }).join("");
    } catch (e) { el.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
  }

  // ── ③ Hardware Shop ──
  async function renderShopTab() {
    if (!state) return;
    const panel = $("panel-shop");
    const grid = panel.querySelector(".shop-grid");
    grid.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const { items } = await api("/shop");
      grid.innerHTML = items.map((it) => {
        const statLabel = it.stat === "atk" ? "ATK +" + it.value : it.stat === "def" ? "DEF +" + it.value :
          it.effect === "stamina" ? "Stamina +" + it.value : it.effect === "heal_full" ? "HP 100% 회복" : "";
        const owned = (it.type === "weapon" || it.type === "armor") && it.owned > 0;
        return (
          '<div class="shop-card">' +
          '<div class="shop-card-name">' + escapeHtml(it.name) + "</div>" +
          '<div class="shop-card-type">' + it.type.toUpperCase() + "</div>" +
          '<div class="shop-card-stat">' + statLabel + "</div>" +
          '<div class="shop-card-price">💰 ' + fmt(it.price) + "</div>" +
          '<button class="btn-primary" data-buy="' + it.id + '"' + (owned || state.pocketCoins < it.price ? " disabled" : "") + ">" +
          (owned ? "보유중" : "구매") + "</button></div>"
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

  // ── ④ Digital Inventory ──
  async function renderInventoryTab() {
    const panel = $("panel-inventory");
    const list = panel.querySelector(".inv-list");
    list.innerHTML = '<p class="dim">불러오는 중...</p>';
    try {
      const inv = await api("/inventory");
      if (!inv.items.length) { list.innerHTML = '<p class="dim">보유한 아이템이 없습니다. Hardware Shop에서 구매하세요.</p>'; return; }
      list.innerHTML = inv.items.map((it) => {
        const isEquip = it.type === "weapon" || it.type === "armor";
        const equipped = (it.type === "weapon" && inv.equippedWeapon === it.id) || (it.type === "armor" && inv.equippedArmor === it.id);
        const statLabel = it.stat === "atk" ? "ATK +" + it.value : it.stat === "def" ? "DEF +" + it.value :
          it.effect === "stamina" ? "Stamina +" + it.value : it.effect === "heal_full" ? "HP 100% 회복" : "";
        return (
          '<div class="inv-row">' +
          '<div class="inv-name">' + escapeHtml(it.name) + (it.qty > 1 ? " ×" + it.qty : "") + "</div>" +
          '<div class="dim">' + statLabel + "</div>" +
          (isEquip
            ? '<button class="btn-ghost" data-equip="' + it.id + '"' + (equipped ? " disabled" : "") + ">" + (equipped ? "장착됨" : "장착") + "</button>"
            : '<button class="btn-ghost" data-use="' + it.id + '">사용</button>') +
          "</div>"
        );
      }).join("");
      list.querySelectorAll("button[data-equip]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try { await api("/inventory/equip", { method: "POST", body: { itemId: btn.dataset.equip } }); toast("장착 완료"); await refreshState(); renderInventoryTab(); }
          catch (e) { toast(e.message, true); }
        });
      });
      list.querySelectorAll("button[data-use]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try { const r = await api("/inventory/use", { method: "POST", body: { itemId: btn.dataset.use } }); toast("사용 완료"); state = r.state; renderHeader(); renderInventoryTab(); }
          catch (e) { toast(e.message, true); }
        });
      });
    } catch (e) { list.innerHTML = '<p class="dim">' + escapeHtml(e.message) + "</p>"; }
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
      try { const r = await api("/bank/deposit", { method: "POST", body: { amount } }); state = r.state; renderHeader(); renderBankTab(); $(inputId).value = ""; toast("입금 완료"); }
      catch (e) { toast(e.message, true); }
    }
    async function withdraw(inputId) {
      const amount = parseInt($(inputId).value, 10);
      if (!amount || amount <= 0) return toast("금액을 입력하세요.", true);
      try { const r = await api("/bank/withdraw", { method: "POST", body: { amount } }); state = r.state; renderHeader(); renderBankTab(); $(inputId).value = ""; toast("출금 완료"); }
      catch (e) { toast(e.message, true); }
    }
    $("depositBtn").addEventListener("click", () => deposit("depositInput"));
    $("withdrawBtn").addEventListener("click", () => withdraw("withdrawInput"));
    $("dashDepositBtn").addEventListener("click", () => deposit("dashDepositInput"));
    $("dashWithdrawBtn").addEventListener("click", () => withdraw("dashWithdrawInput"));
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
        if (l.kind === "job") { icon = "💾"; desc = (l.opponent_name || "") + " 작업 완료"; }
        else if (l.kind === "pvp_attack") { icon = l.result === "win" ? "⚔️" : "🛡️"; desc = (l.result === "win" ? "침투 성공: " : "침투 실패: ") + escapeHtml(l.opponent_name || "알 수 없음"); }
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
    $("scanModalClose").addEventListener("click", () => { $("scanModal").style.display = "none"; });
    $("scanModal").addEventListener("click", (e) => { if (e.target.id === "scanModal") $("scanModal").style.display = "none"; });
    // 로그인 전 화면의 큰 CTA 버튼 — auth-widget.js가 실제로 리스닝하는 loginNavBtn 클릭을 그대로 위임한다.
    const cta = $("loggedOutCta");
    if (cta) cta.addEventListener("click", () => $("loginNavBtn").click());
    watchLogin();
    if (session()) startDashboard();
  });
})();
