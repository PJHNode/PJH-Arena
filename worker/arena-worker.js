/* ============================================================
   arena-worker.js — PJH Arena 백엔드 (Cloudflare Worker + D1)

   계정은 PJH-Hub와 완전히 공유한다 — pjh-auth가 쓰는 SESSIONS/USERS KV
   네임스페이스를 그대로 바인딩해서(board-worker.js의 verifyUser와 동일한
   방식) 로그인 여부/정지 여부만 읽어온다. 절대 이 두 KV에 쓰지 않는다
   (게임 상태는 전부 이 Worker 소유의 별도 D1 "arena"에만 저장) — PJH-Hub의
   XP/코인/뱃지 시스템과 Arena의 사이버 코인 경제는 완전히 별개다.
   ============================================================ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ── 계정 검증 — board-worker.js의 verifyUser와 동일한 계약(SESSIONS/USERS KV를
//    pjh-auth와 공유). 여기서는 읽기만 하고 절대 쓰지 않는다. ──
async function verifyUser(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const raw = await env.SESSIONS.get("session:" + token);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.userId) return null;

    const userRaw = await env.USERS.get("user:" + session.userId);
    if (userRaw) {
      const userData = JSON.parse(userRaw);
      if (userData.banned) return { _error: "정지된 계정입니다.", _status: 403 };
    }
    return { userId: session.userId, realName: session.realName || session.userId };
  } catch (e) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  게임 상수 — 기획 스펙 그대로
// ══════════════════════════════════════════════════════════
const MAX_HP = 100, MAX_ENERGY = 100, MAX_STAMINA = 10;
const ENERGY_REGEN_PER_TICK = 5, ENERGY_TICK_MS = 5 * 60 * 1000;   // 5분당 +5
const STAMINA_REGEN_PER_TICK = 1, STAMINA_TICK_MS = 10 * 60 * 1000; // 10분당 +1
const HP_REGEN_PER_TICK = Math.round(MAX_HP * 0.05), HP_TICK_MS = 5 * 60 * 1000; // 5분당 최대체력의 5%

// 기본 ATK/DEF — 기획서에 레벨별 성장 수식이 명시돼 있지 않아, 장비 없이도 레벨업이
// 전투력에 의미가 있도록 "레벨당 +2"의 완만한 성장을 임의로 추가했다(합리적 기본값).
function baseAtkFor(level) { return 10 + level * 2; }
function baseDefFor(level) { return 10 + level * 2; }

function nextExpFor(level) { return level * 100; }

const JOB_TIERS = {
  low:    { label: "Low",    minLevel: 1,  energyCost: 10, coinMin: 100, coinMax: 150,  xp: 15 },
  medium: { label: "Medium", minLevel: 5,  energyCost: 20, coinMin: 250, coinMax: 350,  xp: 35 },
  high:   { label: "High",   minLevel: 10, energyCost: 35, coinMin: 500, coinMax: 700,  xp: 70 },
  master: { label: "Master", minLevel: 20, energyCost: 50, coinMin: 900, coinMax: 1300, xp: 120 },
};

const SHOP_ITEMS = {
  wannacry: { name: "Virus-Wannacry2.1",     type: "weapon",     price: 1000, stat: "atk", value: 25 },
  fortress: { name: "Firewall-Fortress v3.0", type: "armor",      price: 1000, stat: "def", value: 30 },
  ddos:     { name: "DDoS Booster",           type: "consumable", price: 800,  effect: "stamina", value: 3 },
  vaccine:  { name: "급속 치료 백신",           type: "consumable", price: 300,  effect: "heal_full" },
};

const PVP_LEVEL_RANGE = 15;
const PVP_SHIELD_MS = 12 * 60 * 60 * 1000; // 피격 직후 12시간 보호막
const PVP_PLUNDER_RATE = 0.10;
const PVP_WIN_ATK_HP_LOSS = 10, PVP_WIN_DEF_HP_LOSS = 40;   // 공격자 승리 시
const PVP_LOSE_ATK_HP_LOSS = 30, PVP_LOSE_DEF_HP_LOSS = 5;  // 방어자 승리 시
const BANK_DAILY_INTEREST_RATE = 0.01;
const BANK_DAILY_INTEREST_CAP = 10000;

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randMult() { return 0.9 + Math.random() * 0.2; } // 0.9 ~ 1.1
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function kstDateString(ts) { return new Date((ts || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10); }

// ══════════════════════════════════════════════════════════
//  스키마
// ══════════════════════════════════════════════════════════
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_users (" +
    "user_id TEXT PRIMARY KEY, real_name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0, " +
    "hp INTEGER NOT NULL DEFAULT 100, energy INTEGER NOT NULL DEFAULT 100, stamina INTEGER NOT NULL DEFAULT 10, " +
    "pocket_coins INTEGER NOT NULL DEFAULT 0, bank_coins INTEGER NOT NULL DEFAULT 0, " +
    "equipped_weapon TEXT, equipped_armor TEXT, shield_until INTEGER NOT NULL DEFAULT 0, plunder_wins INTEGER NOT NULL DEFAULT 0, " +
    "last_energy_tick INTEGER NOT NULL, last_stamina_tick INTEGER NOT NULL, last_hp_tick INTEGER NOT NULL, created_at INTEGER NOT NULL)"
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1)"
  );
  try { await env.DB.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_user_item ON arena_inventory(user_id, item_id)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, " +
    "opponent_id TEXT, opponent_name TEXT, result TEXT, coins_delta INTEGER NOT NULL DEFAULT 0, hp_delta INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_logs_user ON arena_logs(user_id, created_at)"); } catch (e) {}
  await env.DB.exec("CREATE TABLE IF NOT EXISTS arena_meta (key TEXT PRIMARY KEY, value TEXT)");
  schemaReady = true;
}

// ── 로그인한 유저의 arena_users 행을 가져오거나 처음이면 생성. 매번 실명(real_name)을
//    최신화해서(가입 이후 실명이 바뀔 일은 거의 없지만 어차피 매 요청 갱신이라 공짜) 별도
//    동기화 로직 없이 항상 최신 상태를 유지한다. ──
async function loadOrCreateUser(env, userId, realName) {
  const now = Date.now();
  let row = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(userId).first();
  if (!row) {
    await env.DB.prepare(
      "INSERT INTO arena_users (user_id, real_name, last_energy_tick, last_stamina_tick, last_hp_tick, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, realName, now, now, now, now).run();
    row = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(userId).first();
  } else if (row.real_name !== realName) {
    await env.DB.prepare("UPDATE arena_users SET real_name = ? WHERE user_id = ?").bind(realName, userId).run();
    row.real_name = realName;
  }
  return applyRegen(row, now);
}

// ── 자연 회복 — 실제 cron으로 전 유저를 매번 도는 대신, 각 유저가 요청을 보낼 때마다
//    "마지막 회복 시각 이후 몇 틱이 지났는지"를 계산해서 그만큼만 채워준다(lazy regen).
//    heartbeat KV put 폭주 사고(PJH-hub 메모 참고)와 같은 이유로, 활성 유저가 없어도 주기적으로
//    전원을 갱신하는 배치보다 이 방식이 훨씬 저렴하고 오차도 없다. 자원별로 tick 간격이 달라서
//    (에너지 5분/스태미나 10분/HP 5분) 완료된 틱 수만큼만 시간을 전진시키고 나머지는 다음
//    계산을 위해 남겨둔다(끝수를 버리지 않음). ──
function applyRegen(row, now) {
  const out = { ...row };
  if (out.hp > 0) { // 사망(HP 0) 상태에서는 자연 회복도 멈춘다 — 소생은 백신/스탯 회복 액션으로만
    const energyTicks = Math.floor((now - out.last_energy_tick) / ENERGY_TICK_MS);
    if (energyTicks > 0 && out.energy < MAX_ENERGY) {
      out.energy = Math.min(MAX_ENERGY, out.energy + energyTicks * ENERGY_REGEN_PER_TICK);
      out.last_energy_tick += energyTicks * ENERGY_TICK_MS;
    } else if (energyTicks > 0) {
      out.last_energy_tick += energyTicks * ENERGY_TICK_MS; // 이미 꽉 찼어도 시계는 전진시켜 누적 오차 방지
    }
    const staminaTicks = Math.floor((now - out.last_stamina_tick) / STAMINA_TICK_MS);
    if (staminaTicks > 0) {
      out.stamina = Math.min(MAX_STAMINA, out.stamina + staminaTicks * STAMINA_REGEN_PER_TICK);
      out.last_stamina_tick += staminaTicks * STAMINA_TICK_MS;
    }
    const hpTicks = Math.floor((now - out.last_hp_tick) / HP_TICK_MS);
    if (hpTicks > 0) {
      out.hp = Math.min(MAX_HP, out.hp + hpTicks * HP_REGEN_PER_TICK);
      out.last_hp_tick += hpTicks * HP_TICK_MS;
    }
  }
  return out;
}

async function persistRegen(env, row) {
  await env.DB.prepare(
    "UPDATE arena_users SET energy=?, stamina=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
  ).bind(row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();
}

// ── XP 획득 + 레벨업 처리. 스펙의 "Next EXP = Level × 100"은 누적치가 아니라
//    "그 레벨 안에서 채워야 할 양"이라, 넘친 만큼 다음 레벨로 이월하며 여러 레벨이 한 번에
//    오를 수도 있게 while로 처리한다. 레벨업 순간 HP/에너지/스태미나 전부 100% 즉시 회복. ──
function applyXpAndLevel(row, xpGain) {
  row.xp += xpGain;
  let leveledUp = false;
  while (row.xp >= nextExpFor(row.level)) {
    row.xp -= nextExpFor(row.level);
    row.level += 1;
    leveledUp = true;
  }
  if (leveledUp) {
    row.hp = MAX_HP; row.energy = MAX_ENERGY; row.stamina = MAX_STAMINA;
    const now = Date.now();
    row.last_energy_tick = now; row.last_stamina_tick = now; row.last_hp_tick = now;
  }
  return leveledUp;
}

function equipStats(row) {
  const weapon = row.equipped_weapon ? SHOP_ITEMS[row.equipped_weapon] : null;
  const armor = row.equipped_armor ? SHOP_ITEMS[row.equipped_armor] : null;
  return {
    atk: baseAtkFor(row.level) + (weapon && weapon.stat === "atk" ? weapon.value : 0),
    def: baseDefFor(row.level) + (armor && armor.stat === "def" ? armor.value : 0),
  };
}

function publicState(row) {
  const { atk, def } = equipStats(row);
  return {
    userId: row.user_id, realName: row.real_name,
    level: row.level, xp: row.xp, nextExp: nextExpFor(row.level),
    hp: row.hp, maxHp: MAX_HP, energy: row.energy, maxEnergy: MAX_ENERGY, stamina: row.stamina, maxStamina: MAX_STAMINA,
    pocketCoins: row.pocket_coins, bankCoins: row.bank_coins,
    atk, def, equippedWeapon: row.equipped_weapon, equippedArmor: row.equipped_armor,
    shieldUntil: row.shield_until, shielded: row.shield_until > Date.now(),
    plunderWins: row.plunder_wins,
  };
}

async function insertLog(env, userId, kind, opponentId, opponentName, result, coinsDelta, hpDelta) {
  await env.DB.prepare(
    "INSERT INTO arena_logs (user_id, kind, opponent_id, opponent_name, result, coins_delta, hp_delta, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(userId, kind, opponentId || null, opponentName || null, result || null, coinsDelta || 0, hpDelta || 0, Date.now()).run();
}

// ── 일일 이자 — 10분마다 도는 cron에서 KST 날짜가 바뀐 첫 실행에만 전원에게 한 번 지급.
//    board-worker.js의 오늘의 밸런스 게임/백업 cron과 동일한 "날짜 게이트" 패턴. ──
async function maybeRunDailyInterest(env) {
  const today = kstDateString();
  const metaRow = await env.DB.prepare("SELECT value FROM arena_meta WHERE key = 'interest_last_run'").first();
  if (metaRow && metaRow.value === today) return;
  await env.DB.exec(
    "UPDATE arena_users SET bank_coins = bank_coins + MIN(CAST(bank_coins * " + BANK_DAILY_INTEREST_RATE + " AS INTEGER), " + BANK_DAILY_INTEREST_CAP + ")"
  );
  await env.DB.prepare("INSERT INTO arena_meta (key, value) VALUES ('interest_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .bind(today, today).run();
}

// ══════════════════════════════════════════════════════════
//  라우터
// ══════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      await ensureSchema(env);

      const user = await verifyUser(request, env);
      if (!user) return json({ error: "로그인이 필요합니다." }, 401);
      if (user._error) return json({ error: user._error }, user._status);

      // ── GET /state ──
      if (request.method === "GET" && path === "/state") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        await persistRegen(env, row);
        return json(publicState(row));
      }

      // ── POST /hack-job { tier } ──
      if (request.method === "POST" && path === "/hack-job") {
        const body = await request.json().catch(() => ({}));
        const tier = JOB_TIERS[body.tier];
        if (!tier) return json({ error: "알 수 없는 작업입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.hp <= 0) return json({ error: "HP가 0입니다. 회복 후 다시 시도하세요." }, 400);
        if (row.level < tier.minLevel) return json({ error: "레벨이 부족합니다. (필요 Lv." + tier.minLevel + ")" }, 400);
        if (row.energy < tier.energyCost) return json({ error: "에너지가 부족합니다." }, 400);

        row.energy -= tier.energyCost;
        const coinsGained = randInt(tier.coinMin, tier.coinMax);
        row.pocket_coins += coinsGained;
        const leveledUp = applyXpAndLevel(row, tier.xp);

        await env.DB.prepare(
          "UPDATE arena_users SET energy=?, stamina=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=?, " +
          "pocket_coins=?, xp=?, level=? WHERE user_id=?"
        ).bind(row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick,
               row.pocket_coins, row.xp, row.level, row.user_id).run();
        await insertLog(env, user.userId, "job", null, tier.label, "success", coinsGained, 0);

        return json({ ok: true, coinsGained, xpGained: tier.xp, leveledUp, state: publicState(row) });
      }

      // ── GET /arena/targets — 레벨 ±15 이내, HP>0, 보호막 없는 유저 최대 20명 ──
      if (request.method === "GET" && path === "/arena/targets") {
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        const now = Date.now();
        const { results } = await env.DB.prepare(
          "SELECT * FROM arena_users WHERE user_id != ? AND hp > 0 AND shield_until <= ? AND level BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 20"
        ).bind(user.userId, now, me.level - PVP_LEVEL_RANGE, me.level + PVP_LEVEL_RANGE).all();

        const myAtk = equipStats(me).atk;
        const targets = results.map((t) => {
          const { def } = equipStats(t);
          const staminaCost = 1 + Math.max(0, Math.floor((me.level - t.level) / 5));
          // 정확한 확률분포 대신, 실제 전투와 같은 랜덤배율(0.9~1.1)로 다회 시뮬레이션해 승률을 추정한다.
          let wins = 0;
          for (let i = 0; i < 300; i++) if (myAtk * randMult() > def * randMult()) wins++;
          return {
            userId: t.user_id, realName: t.real_name, level: t.level, def,
            estimatedVictoryPct: Math.round((wins / 300) * 100), staminaCost,
          };
        });
        return json({ targets, myStamina: me.stamina });
      }

      // ── POST /arena/scan { targetUserId } — 정찰(스태미나 소모 없음), 정확한 DEF + 시뮬레이션 승률 ──
      if (request.method === "POST" && path === "/arena/scan") {
        const body = await request.json().catch(() => ({}));
        const targetUserId = String(body.targetUserId || "");
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        const target = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!target) return json({ error: "대상을 찾을 수 없습니다." }, 404);

        const myAtk = equipStats(me).atk;
        const { def } = equipStats(target);
        let wins = 0;
        const rounds = 1000;
        for (let i = 0; i < rounds; i++) if (myAtk * randMult() > def * randMult()) wins++;

        return json({
          targetUserId, realName: target.real_name, level: target.level, def,
          myAtk, estimatedVictoryPct: Math.round((wins / rounds) * 100),
          staminaCost: 1 + Math.max(0, Math.floor((me.level - target.level) / 5)),
        });
      }

      // ── POST /arena/attack { targetUserId } ──
      if (request.method === "POST" && path === "/arena/attack") {
        const body = await request.json().catch(() => ({}));
        const targetUserId = String(body.targetUserId || "");
        if (targetUserId === user.userId) return json({ error: "자기 자신은 공격할 수 없습니다." }, 400);

        const attacker = await loadOrCreateUser(env, user.userId, user.realName);
        if (attacker.hp <= 0) return json({ error: "HP가 0입니다. 회복 후 다시 시도하세요." }, 400);

        const defender = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!defender) return json({ error: "대상을 찾을 수 없습니다." }, 404);
        if (defender.hp <= 0) return json({ error: "이미 다운된 대상입니다." }, 400);
        if (defender.shield_until > Date.now()) return json({ error: "대상이 보호막 상태입니다." }, 400);
        if (Math.abs(attacker.level - defender.level) > PVP_LEVEL_RANGE) return json({ error: "레벨 차이가 너무 큽니다." }, 400);

        const staminaCost = 1 + Math.max(0, Math.floor((attacker.level - defender.level) / 5));
        if (attacker.stamina < staminaCost) return json({ error: "스태미나가 부족합니다." }, 400);
        attacker.stamina -= staminaCost;

        const attackerPower = equipStats(attacker).atk * randMult();
        const defenderPower = equipStats(defender).def * randMult();
        const attackerWins = attackerPower > defenderPower;

        let coinsDelta = 0;
        if (attackerWins) {
          coinsDelta = Math.floor(defender.pocket_coins * PVP_PLUNDER_RATE);
          defender.pocket_coins -= coinsDelta;
          attacker.pocket_coins += coinsDelta;
          defender.hp = clamp(defender.hp - PVP_WIN_DEF_HP_LOSS, 0, MAX_HP);
          attacker.hp = clamp(attacker.hp - PVP_WIN_ATK_HP_LOSS, 0, MAX_HP);
          attacker.plunder_wins += 1;
        } else {
          defender.hp = clamp(defender.hp - PVP_LOSE_DEF_HP_LOSS, 0, MAX_HP);
          attacker.hp = clamp(attacker.hp - PVP_LOSE_ATK_HP_LOSS, 0, MAX_HP);
        }
        defender.shield_until = Date.now() + PVP_SHIELD_MS; // 승패 무관 — 공격당한 것 자체로 보호막 부여

        await env.DB.batch([
          env.DB.prepare(
            "UPDATE arena_users SET stamina=?, energy=?, hp=?, pocket_coins=?, plunder_wins=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
          ).bind(attacker.stamina, attacker.energy, attacker.hp, attacker.pocket_coins, attacker.plunder_wins,
                 attacker.last_energy_tick, attacker.last_stamina_tick, attacker.last_hp_tick, attacker.user_id),
          env.DB.prepare(
            "UPDATE arena_users SET hp=?, pocket_coins=?, shield_until=? WHERE user_id=?"
          ).bind(defender.hp, defender.pocket_coins, defender.shield_until, defender.user_id),
        ]);

        await insertLog(env, attacker.user_id, "pvp_attack", defender.user_id, defender.real_name, attackerWins ? "win" : "lose", attackerWins ? coinsDelta : 0, attackerWins ? -PVP_WIN_ATK_HP_LOSS : -PVP_LOSE_ATK_HP_LOSS);
        await insertLog(env, defender.user_id, "pvp_defend", attacker.user_id, attacker.real_name, attackerWins ? "lose" : "win", attackerWins ? -coinsDelta : 0, attackerWins ? -PVP_WIN_DEF_HP_LOSS : -PVP_LOSE_DEF_HP_LOSS);

        return json({ ok: true, attackerWins, coinsDelta, state: publicState(attacker) });
      }

      // ── POST /bank/deposit { amount } ──
      if (request.method === "POST" && path === "/bank/deposit") {
        const body = await request.json().catch(() => ({}));
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount) || amount <= 0) return json({ error: "유효하지 않은 금액입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.pocket_coins < amount) return json({ error: "소지금이 부족합니다." }, 400);
        row.pocket_coins -= amount; row.bank_coins += amount;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=?, bank_coins=?, energy=?, stamina=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?")
          .bind(row.pocket_coins, row.bank_coins, row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();
        return json({ ok: true, state: publicState(row) });
      }

      // ── POST /bank/withdraw { amount } ──
      if (request.method === "POST" && path === "/bank/withdraw") {
        const body = await request.json().catch(() => ({}));
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount) || amount <= 0) return json({ error: "유효하지 않은 금액입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.bank_coins < amount) return json({ error: "은행 잔액이 부족합니다." }, 400);
        row.bank_coins -= amount; row.pocket_coins += amount;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=?, bank_coins=?, energy=?, stamina=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?")
          .bind(row.pocket_coins, row.bank_coins, row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();
        return json({ ok: true, state: publicState(row) });
      }

      // ── GET /shop ──
      if (request.method === "GET" && path === "/shop") {
        const { results: owned } = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const ownedMap = {};
        owned.forEach((o) => { ownedMap[o.item_id] = o.qty; });
        const items = Object.entries(SHOP_ITEMS).map(([id, item]) => ({ id, ...item, owned: ownedMap[id] || 0 }));
        return json({ items });
      }

      // ── POST /shop/buy { itemId } ──
      if (request.method === "POST" && path === "/shop/buy") {
        const body = await request.json().catch(() => ({}));
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item) return json({ error: "알 수 없는 아이템입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.pocket_coins < item.price) return json({ error: "코인이 부족합니다." }, 400);

        if (item.type === "weapon" || item.type === "armor") {
          const existing = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
          if (existing) return json({ error: "이미 보유한 장비입니다." }, 400);
        }

        row.pocket_coins -= item.price;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id).run();
        await env.DB.prepare(
          "INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1"
        ).bind(user.userId, itemId).run();

        // 무기/방어구는 해당 슬롯이 비어있으면 구매 즉시 자동 장착
        if (item.type === "weapon" && !row.equipped_weapon) {
          await env.DB.prepare("UPDATE arena_users SET equipped_weapon=? WHERE user_id=?").bind(itemId, row.user_id).run();
        }
        if (item.type === "armor" && !row.equipped_armor) {
          await env.DB.prepare("UPDATE arena_users SET equipped_armor=? WHERE user_id=?").bind(itemId, row.user_id).run();
        }

        return json({ ok: true, pocketCoins: row.pocket_coins });
      }

      // ── GET /inventory ──
      if (request.method === "GET" && path === "/inventory") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const { results } = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const items = results.map((r) => ({ id: r.item_id, qty: r.qty, ...SHOP_ITEMS[r.item_id] }));
        return json({ items, equippedWeapon: row.equipped_weapon, equippedArmor: row.equipped_armor });
      }

      // ── POST /inventory/equip { itemId } ──
      if (request.method === "POST" && path === "/inventory/equip") {
        const body = await request.json().catch(() => ({}));
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item || (item.type !== "weapon" && item.type !== "armor")) return json({ error: "장착할 수 없는 아이템입니다." }, 400);
        const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
        if (!owned) return json({ error: "보유하지 않은 아이템입니다." }, 400);

        const col = item.type === "weapon" ? "equipped_weapon" : "equipped_armor";
        await env.DB.prepare("UPDATE arena_users SET " + col + " = ? WHERE user_id = ?").bind(itemId, user.userId).run();
        return json({ ok: true });
      }

      // ── POST /inventory/use { itemId } ──
      if (request.method === "POST" && path === "/inventory/use") {
        const body = await request.json().catch(() => ({}));
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item || item.type !== "consumable") return json({ error: "사용할 수 없는 아이템입니다." }, 400);
        const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
        if (!owned || owned.qty <= 0) return json({ error: "보유하지 않은 아이템입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (item.effect === "stamina") row.stamina = Math.min(MAX_STAMINA, row.stamina + item.value);
        if (item.effect === "heal_full") row.hp = MAX_HP;

        await env.DB.prepare("UPDATE arena_users SET hp=?, energy=?, stamina=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?")
          .bind(row.hp, row.energy, row.stamina, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();

        if (owned.qty <= 1) await env.DB.prepare("DELETE FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).run();
        else await env.DB.prepare("UPDATE arena_inventory SET qty = qty - 1 WHERE user_id=? AND item_id=?").bind(user.userId, itemId).run();

        return json({ ok: true, state: publicState(row) });
      }

      // ── GET /logs?kind=job|pvp (선택) ──
      if (request.method === "GET" && path === "/logs") {
        const kind = url.searchParams.get("kind");
        const stmt = kind
          ? env.DB.prepare("SELECT * FROM arena_logs WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 20").bind(user.userId, kind)
          : env.DB.prepare("SELECT * FROM arena_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.userId);
        const { results } = await stmt.all();
        return json({ logs: results });
      }

      // ── GET /leaderboard?type=level|assets|plunder ──
      if (request.method === "GET" && path === "/leaderboard") {
        const type = url.searchParams.get("type") || "level";
        let orderBy;
        if (type === "assets") orderBy = "(pocket_coins + bank_coins) DESC";
        else if (type === "plunder") orderBy = "plunder_wins DESC";
        else orderBy = "level DESC, xp DESC";
        const { results } = await env.DB.prepare(
          "SELECT user_id, real_name, level, pocket_coins, bank_coins, plunder_wins FROM arena_users ORDER BY " + orderBy + " LIMIT 50"
        ).all();
        return json({ type, rows: results });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "서버 오류: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(maybeRunDailyInterest(env));
  },
};
