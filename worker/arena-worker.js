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

// 장착 가능한 아이템은 반드시 이 3종 중 하나 — 무장 모듈(ATK) / 방어 장갑(DEF) / 연산 코어(치명타%).
// 플레이어 본인과 각 봇이 각각 이 3슬롯을 독립적으로 갖는다(equipStats/totalCombatStats 참고).
// 가격/성능 편차를 크게 둬서(50 ~ 20000코인) 초반 저가 아이템부터 후반 고가 아이템까지
// 단계적으로 갖춰나가는 재미를 주도록 구성했다.
const SHOP_ITEMS = {
  // ── 무장 모듈 (Weapons Block, ATK) ──
  rusty_script:     { name: "Rusty Script Kit",   type: "weapon", price: 50,    value: 5 },
  packet_spoofer:   { name: "Packet Spoofer",     type: "weapon", price: 200,   value: 10 },
  plasma_cannon:    { name: "플라즈마 캐논",       type: "weapon", price: 700,   value: 20 },
  hf_blade:         { name: "고주파 블레이드",     type: "weapon", price: 1200,  value: 28 },
  emp_missile:      { name: "EMP 유도 미사일",     type: "weapon", price: 3000,  value: 42 },
  stuxnet:          { name: "Stuxnet Variant",    type: "weapon", price: 7000,  value: 65 },
  singularity_worm: { name: "Singularity Worm",   type: "weapon", price: 20000, value: 100 },

  // ── 방어 장갑 (Armor Shell, DEF) ──
  basic_av:         { name: "Basic Antivirus",    type: "armor", price: 50,    value: 5 },
  packet_filter:    { name: "Packet Filter",      type: "armor", price: 200,   value: 10 },
  nano_composite:   { name: "나노 복합 장갑",       type: "armor", price: 700,   value: 20 },
  ngfw:             { name: "Next-Gen Firewall",  type: "armor", price: 1200,  value: 28 },
  phase_shield:     { name: "위상 변조 실드",       type: "armor", price: 3000,  value: 42 },
  adaptive_ai:      { name: "Adaptive AI Shield", type: "armor", price: 7000,  value: 65 },
  black_ice:        { name: "Black ICE",          type: "armor", price: 20000, value: 110 },

  // ── 연산 코어 (Core Processor, 치명타% — 기본 치명타 확률에 가산) ──
  overclock_chip:     { name: "오버클럭 칩셋",       type: "core", price: 300,   value: 3 },
  tactical_matrix:    { name: "AI 전술 매트릭스",    type: "core", price: 900,   value: 6 },
  quantum_core:       { name: "양자 연산 장치",      type: "core", price: 2500,  value: 10 },
  neural_accelerator: { name: "뉴럴 가속기",         type: "core", price: 6000,  value: 15 },
  singularity_core:   { name: "특이점 코어",         type: "core", price: 15000, value: 25 },

  // ── 소비재 ──
  nanobot_kit:      { name: "나노봇 응급키트", type: "consumable", price: 100,  effect: "heal_flat", value: 30 },
  vaccine:          { name: "급속 치료 백신",   type: "consumable", price: 300,  effect: "heal_full" },
  energy_drink:     { name: "에너지 드링크",    type: "consumable", price: 150,  effect: "energy", value: 20 },
  mega_energy_cell: { name: "메가 에너지 셀",   type: "consumable", price: 500,  effect: "energy_full" },
  ddos:             { name: "DDoS Booster",    type: "consumable", price: 800,  effect: "stamina", value: 3 },
  adrenaline_shot:  { name: "아드레날린 샷",    type: "consumable", price: 400,  effect: "stamina_full" },
  stealth_cloak:    { name: "스텔스 클로크",    type: "consumable", price: 1200, effect: "self_shield", value: 3600000 }, // 1시간 자가 보호막
};

const PVP_LEVEL_RANGE = 15;
const PVP_SHIELD_MS = 12 * 60 * 60 * 1000; // 피격 직후 12시간 보호막
const PVP_PLUNDER_RATE = 0.10;
const PVP_WIN_ATK_HP_LOSS = 10, PVP_WIN_DEF_HP_LOSS = 40;   // 공격자 승리 시
const PVP_LOSE_ATK_HP_LOSS = 30, PVP_LOSE_DEF_HP_LOSS = 5;  // 방어자 승리 시
const BASE_CRIT_PCT = 5;   // 코어를 하나도 안 껴도 기본 5% 확률로 치명타
const CRIT_MULTIPLIER = 1.5; // 치명타 시 약탈액 1.5배
// 공격 대상이 "온라인"인지에 따라 소모 스태미나가 다르다 — 오프라인(방심한) 상대를 노리는 게
// 더 손쉬운 이득이라 오히려 더 비싸게 매겨서 온라인 유저끼리의 실시간 대결을 유도한다.
const PVP_STAMINA_COST_ONLINE = 1, PVP_STAMINA_COST_OFFLINE = 2;
const ONLINE_THRESHOLD_MS = 150 * 1000; // board-worker.js의 isOnline()과 동일 기준(공유 USERS KV의 lastSeen)
const BANK_DEPOSIT_TAX_RATE = 0.10; // 입금액의 10%는 수수료로 사라진다(이자 없음 — 안전 보관의 대가)
const STARTING_ENERGY = 50; // 최대치(100)보다 낮게 시작 — 초반부터 꽉 채워주지 않는다

// ── Bot(봇) — 플레이어 본인 슬롯 외에 추가로 모집하는 "팀원" 개념. 각 봇도 무장/장갑/코어
//    3슬롯을 독립적으로 갖고, 봇의 장비 보너스는 전투 시 플레이어의 총 전투력에 그대로 합산된다
//    (봇이 많고 잘 갖출수록 강해짐). 모집 비용은 봇 수가 늘수록 기하급수적으로 증가한다. ──
const BOT_BASE_COST = 2000;
const BOT_COST_GROWTH = 2.5;
const BOT_MAX_COUNT = 10;
function botRecruitCost(currentCount) { return Math.round(BOT_BASE_COST * Math.pow(BOT_COST_GROWTH, currentCount)); }

// ── Property(자동 수익) — 오프라인이어도 실제 경과 시간만큼 코인이 쌓이는 기기들.
//    최대 24시간치까지만 누적되므로(그 이상은 손실), 너무 오래 방치하지 않고 가끔은 들어와서
//    수거(collect)하게 만드는 장치다. ──
const PROPERTY_MAX_ACCRUAL_MS = 24 * 60 * 60 * 1000;
const PROPERTY_DEVICES = {
  botnet_node:     { name: "Botnet Node",          price: 500,   coinsPerHour: 5 },
  packet_sniffer:  { name: "Packet Sniffer Rig",   price: 1500,  coinsPerHour: 18 },
  asic_farm:       { name: "Mining ASIC Farm",     price: 4000,  coinsPerHour: 55 },
  cloud_scraper:   { name: "Cloud Scraper Array",  price: 10000, coinsPerHour: 150 },
  quantum_miner:   { name: "Quantum Miner",        price: 25000, coinsPerHour: 400 },
};

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randMult() { return 0.9 + Math.random() * 0.2; } // 0.9 ~ 1.1
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ══════════════════════════════════════════════════════════
//  스키마
// ══════════════════════════════════════════════════════════
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_users (" +
    "user_id TEXT PRIMARY KEY, real_name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0, " +
    "hp INTEGER NOT NULL DEFAULT 100, energy INTEGER NOT NULL DEFAULT 50, stamina INTEGER NOT NULL DEFAULT 10, " +
    "pocket_coins INTEGER NOT NULL DEFAULT 0, bank_coins INTEGER NOT NULL DEFAULT 0, " +
    "equipped_weapon TEXT, equipped_armor TEXT, shield_until INTEGER NOT NULL DEFAULT 0, plunder_wins INTEGER NOT NULL DEFAULT 0, " +
    "last_energy_tick INTEGER NOT NULL, last_stamina_tick INTEGER NOT NULL, last_hp_tick INTEGER NOT NULL, created_at INTEGER NOT NULL)"
  );
  // 기존에 이미 만들어진 테이블에는 CREATE TABLE의 새 컬럼이 반영 안 되므로 항상 ALTER로 보강한다.
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN equipped_core TEXT"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN last_property_collect INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1)"
  );
  try { await env.DB.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_user_item ON arena_inventory(user_id, item_id)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, " +
    "opponent_id TEXT, opponent_name TEXT, result TEXT, coins_delta INTEGER NOT NULL DEFAULT 0, hp_delta INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_logs_user ON arena_logs(user_id, created_at)"); } catch (e) {}
  // 봇(팀원) — 플레이어 본인 슬롯과 별개로, 각자 무장/장갑/코어 3슬롯을 갖는 모집 유닛.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_bots (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, " +
    "equipped_weapon TEXT, equipped_armor TEXT, equipped_core TEXT, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_bots_user ON arena_bots(user_id)"); } catch (e) {}
  // Property(자동 수익) 기기 보유 현황 — arena_inventory와 별개 테이블(장비/소비재와 섞이지 않도록).
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_devices (user_id TEXT NOT NULL, device_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1)"
  );
  try { await env.DB.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_item ON arena_devices(user_id, device_id)"); } catch (e) {}
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
      "INSERT INTO arena_users (user_id, real_name, energy, last_energy_tick, last_stamina_tick, last_hp_tick, last_property_collect, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, realName, STARTING_ENERGY, now, now, now, now, now).run();
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

// 장착 슬롯 하나(무기/방어구/코어) 하나의 아이템이 주는 보너스만 뽑아낸다 — 슬롯 타입과
// 아이템의 실제 type이 안 맞으면(데이터 꼬임 방지용 방어 코드) 0을 준다.
function slotBonus(itemId, wantType) {
  const it = itemId ? SHOP_ITEMS[itemId] : null;
  return it && it.type === wantType ? it.value : 0;
}
// 유닛 하나(플레이어 자신 또는 봇 1기)의 장비 보너스만 — 레벨 기본치는 포함하지 않는다.
function equipStats(unit) {
  return {
    atk: slotBonus(unit.equipped_weapon, "weapon"),
    def: slotBonus(unit.equipped_armor, "armor"),
    crit: slotBonus(unit.equipped_core, "core"),
  };
}

// ── 총 전투력 — 본인의 레벨 기본치 + 본인 장비 + 모집한 봇 전원의 장비 합산.
//    봇은 레벨 기본치가 없고(팀원 개념) 순수하게 장비 보너스만 더해준다. ──
async function totalCombatStats(env, row) {
  const self = equipStats(row);
  let atk = baseAtkFor(row.level) + self.atk;
  let def = baseDefFor(row.level) + self.def;
  let crit = BASE_CRIT_PCT + self.crit;
  const { results: bots } = await env.DB.prepare(
    "SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE user_id = ?"
  ).bind(row.user_id).all();
  for (const b of bots) {
    const bs = equipStats(b);
    atk += bs.atk; def += bs.def; crit += bs.crit;
  }
  return { atk, def, crit, botCount: bots.length };
}

function publicState(row, combat) {
  return {
    userId: row.user_id, realName: row.real_name,
    level: row.level, xp: row.xp, nextExp: nextExpFor(row.level),
    hp: row.hp, maxHp: MAX_HP, energy: row.energy, maxEnergy: MAX_ENERGY, stamina: row.stamina, maxStamina: MAX_STAMINA,
    pocketCoins: row.pocket_coins, bankCoins: row.bank_coins,
    atk: combat.atk, def: combat.def, crit: combat.crit, botCount: combat.botCount,
    equippedWeapon: row.equipped_weapon, equippedArmor: row.equipped_armor, equippedCore: row.equipped_core,
    shieldUntil: row.shield_until, shielded: row.shield_until > Date.now(),
    plunderWins: row.plunder_wins,
  };
}

async function insertLog(env, userId, kind, opponentId, opponentName, result, coinsDelta, hpDelta) {
  await env.DB.prepare(
    "INSERT INTO arena_logs (user_id, kind, opponent_id, opponent_name, result, coins_delta, hp_delta, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(userId, kind, opponentId || null, opponentName || null, result || null, coinsDelta || 0, hpDelta || 0, Date.now()).run();
}

// ── 공유 USERS KV(pjh-auth/board-worker와 동일 바인딩, 읽기 전용)의 lastSeen으로 온라인 여부
//    판정 — board-worker.js의 isOnline()과 완전히 동일한 기준. Arena 자체는 heartbeat를 보내지
//    않으므로, 여기서 "온라인"은 정확히는 "지금 PJH-Hub 생태계 어딘가에 접속 중"이라는 뜻이다. ──
async function isTargetOnline(env, userId) {
  try {
    const raw = await env.USERS.get("user:" + userId);
    if (!raw) return false;
    const data = JSON.parse(raw);
    return !!(data.lastSeen && Date.now() - data.lastSeen < ONLINE_THRESHOLD_MS);
  } catch (e) {
    return false;
  }
}

// ── Property 대기 수익 계산 — 마지막 수거 이후 실제 경과 시간(최대 24시간)만큼만 쌓인다.
//    로그인 여부와 무관하게 벽시계 기준이라 오프라인 상태에서도 그대로 적용된다. ──
async function pendingPropertyIncome(env, row) {
  const { results } = await env.DB.prepare("SELECT device_id, qty FROM arena_devices WHERE user_id = ?").bind(row.user_id).all();
  let ratePerHour = 0;
  for (const r of results) {
    const dev = PROPERTY_DEVICES[r.device_id];
    if (dev) ratePerHour += dev.coinsPerHour * r.qty;
  }
  const elapsedMs = Math.min(Date.now() - (row.last_property_collect || row.created_at), PROPERTY_MAX_ACCRUAL_MS);
  const pendingCoins = Math.floor(ratePerHour * (elapsedMs / 3600000));
  return { ratePerHour, pendingCoins, owned: results };
}

// 대기 수익을 실제로 pocket_coins에 반영하고 타이머를 리셋한다(구매 직전에도 항상 먼저 호출해서
// 요율이 바뀌기 전 몫을 공정하게 정산한 뒤 새 요율부터 다시 쌓이게 한다).
async function collectProperty(env, row) {
  const { pendingCoins } = await pendingPropertyIncome(env, row);
  const now = Date.now();
  if (pendingCoins > 0) row.pocket_coins += pendingCoins;
  row.last_property_collect = now;
  await env.DB.prepare("UPDATE arena_users SET pocket_coins=?, last_property_collect=? WHERE user_id=?")
    .bind(row.pocket_coins, row.last_property_collect, row.user_id).run();
  return pendingCoins;
}

// ── 아이템 id별로 "지금 플레이어 본인 또는 봇 중 어딘가에 이미 장착돼 있는 개수"를 센다.
//    보유 수량(arena_inventory.qty)에서 이 값을 빼면 "새로 장착 가능한 여분"이 나온다 —
//    장착은 재고를 소모하지 않고 슬롯 참조만 바꾸는 방식이라 이렇게 매번 다시 계산해야 한다. ──
async function equippedCountMap(env, userId) {
  const counts = {};
  const bump = (id) => { if (id) counts[id] = (counts[id] || 0) + 1; };
  const player = await env.DB.prepare("SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_users WHERE user_id = ?").bind(userId).first();
  if (player) { bump(player.equipped_weapon); bump(player.equipped_armor); bump(player.equipped_core); }
  const { results: bots } = await env.DB.prepare("SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE user_id = ?").bind(userId).all();
  for (const b of bots) { bump(b.equipped_weapon); bump(b.equipped_armor); bump(b.equipped_core); }
  return counts;
}

function fmtNum(n) { return Number(n || 0).toLocaleString("en-US"); }

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
        const combat = await totalCombatStats(env, row);
        return json(publicState(row, combat));
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

        const combat = await totalCombatStats(env, row);
        return json({ ok: true, coinsGained, xpGained: tier.xp, leveledUp, state: publicState(row, combat) });
      }

      // ── GET /arena/targets — 레벨 ±15 이내, HP>0, 보호막 없는 유저 최대 20명 ──
      if (request.method === "GET" && path === "/arena/targets") {
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        const myCombat = await totalCombatStats(env, me);
        const now = Date.now();
        const { results } = await env.DB.prepare(
          "SELECT * FROM arena_users WHERE user_id != ? AND hp > 0 AND shield_until <= ? AND level BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 20"
        ).bind(user.userId, now, me.level - PVP_LEVEL_RANGE, me.level + PVP_LEVEL_RANGE).all();

        const targets = [];
        for (const t of results) {
          const tCombat = await totalCombatStats(env, t);
          const online = await isTargetOnline(env, t.user_id);
          // 정확한 확률분포 대신, 실제 전투와 같은 랜덤배율(0.9~1.1)로 다회 시뮬레이션해 승률을 추정한다.
          let wins = 0;
          for (let i = 0; i < 300; i++) if (myCombat.atk * randMult() > tCombat.def * randMult()) wins++;
          targets.push({
            userId: t.user_id, realName: t.real_name, level: t.level, def: tCombat.def, online,
            estimatedVictoryPct: Math.round((wins / 300) * 100),
            staminaCost: online ? PVP_STAMINA_COST_ONLINE : PVP_STAMINA_COST_OFFLINE,
          });
        }
        return json({ targets, myStamina: me.stamina });
      }

      // ── POST /arena/scan { targetUserId } — 정찰(스태미나 소모 없음), 정확한 DEF + 시뮬레이션 승률 ──
      if (request.method === "POST" && path === "/arena/scan") {
        const body = await request.json().catch(() => ({}));
        const targetUserId = String(body.targetUserId || "");
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        const target = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!target) return json({ error: "대상을 찾을 수 없습니다." }, 404);

        const myCombat = await totalCombatStats(env, me);
        const tCombat = await totalCombatStats(env, target);
        const online = await isTargetOnline(env, target.user_id);
        let wins = 0;
        const rounds = 1000;
        for (let i = 0; i < rounds; i++) if (myCombat.atk * randMult() > tCombat.def * randMult()) wins++;

        return json({
          targetUserId, realName: target.real_name, level: target.level, def: tCombat.def, online,
          myAtk: myCombat.atk, estimatedVictoryPct: Math.round((wins / rounds) * 100),
          staminaCost: online ? PVP_STAMINA_COST_ONLINE : PVP_STAMINA_COST_OFFLINE,
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

        const defenderOnline = await isTargetOnline(env, defender.user_id);
        const staminaCost = defenderOnline ? PVP_STAMINA_COST_ONLINE : PVP_STAMINA_COST_OFFLINE;
        if (attacker.stamina < staminaCost) return json({ error: "스태미나가 부족합니다." }, 400);
        attacker.stamina -= staminaCost;

        const attackerCombat = await totalCombatStats(env, attacker);
        const defenderCombat = await totalCombatStats(env, defender);
        const attackerPower = attackerCombat.atk * randMult();
        const defenderPower = defenderCombat.def * randMult();
        const attackerWins = attackerPower > defenderPower;
        const isCrit = attackerWins && Math.random() * 100 < attackerCombat.crit;

        let coinsDelta = 0;
        if (attackerWins) {
          coinsDelta = Math.floor(defender.pocket_coins * PVP_PLUNDER_RATE * (isCrit ? CRIT_MULTIPLIER : 1));
          coinsDelta = Math.min(coinsDelta, defender.pocket_coins); // 크리티컬 배율로 보유액을 넘겨 뺏는 일 방지
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

        const attackResult = attackerWins ? (isCrit ? "crit" : "win") : "lose";
        await insertLog(env, attacker.user_id, "pvp_attack", defender.user_id, defender.real_name, attackResult, attackerWins ? coinsDelta : 0, attackerWins ? -PVP_WIN_ATK_HP_LOSS : -PVP_LOSE_ATK_HP_LOSS);
        await insertLog(env, defender.user_id, "pvp_defend", attacker.user_id, attacker.real_name, attackerWins ? "lose" : "win", attackerWins ? -coinsDelta : 0, attackerWins ? -PVP_WIN_DEF_HP_LOSS : -PVP_LOSE_DEF_HP_LOSS);

        const combat = await totalCombatStats(env, attacker);
        return json({ ok: true, attackerWins, isCrit, coinsDelta, state: publicState(attacker, combat) });
      }

      // ── POST /bank/deposit { amount } — 입금액의 10%는 세금으로 사라진다(이자는 폐지됨) ──
      if (request.method === "POST" && path === "/bank/deposit") {
        const body = await request.json().catch(() => ({}));
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount) || amount <= 0) return json({ error: "유효하지 않은 금액입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.pocket_coins < amount) return json({ error: "소지금이 부족합니다." }, 400);
        const tax = Math.floor(amount * BANK_DEPOSIT_TAX_RATE);
        const credited = amount - tax;
        row.pocket_coins -= amount; row.bank_coins += credited;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=?, bank_coins=?, energy=?, stamina=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?")
          .bind(row.pocket_coins, row.bank_coins, row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, tax, credited, state: publicState(row, combat) });
      }

      // ── POST /bank/withdraw { amount } — 수수료 없음 ──
      if (request.method === "POST" && path === "/bank/withdraw") {
        const body = await request.json().catch(() => ({}));
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount) || amount <= 0) return json({ error: "유효하지 않은 금액입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.bank_coins < amount) return json({ error: "은행 잔액이 부족합니다." }, 400);
        row.bank_coins -= amount; row.pocket_coins += amount;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=?, bank_coins=?, energy=?, stamina=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?")
          .bind(row.pocket_coins, row.bank_coins, row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, state: publicState(row, combat) });
      }

      // ── GET /shop — 장비(무장/장갑/코어)는 이제 여러 개 살 수 있다(플레이어+봇 여러 슬롯에
      //    나눠 장착하기 위함), owned는 "보유 수량", equippedCount는 "이미 어딘가 장착된 수량". ──
      if (request.method === "GET" && path === "/shop") {
        const { results: owned } = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const ownedMap = {};
        owned.forEach((o) => { ownedMap[o.item_id] = o.qty; });
        const equippedCount = await equippedCountMap(env, user.userId);
        const items = Object.entries(SHOP_ITEMS).map(([id, item]) => ({
          id, ...item, owned: ownedMap[id] || 0, equipped: equippedCount[id] || 0,
        }));
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

        row.pocket_coins -= item.price;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id).run();
        await env.DB.prepare(
          "INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1"
        ).bind(user.userId, itemId).run();

        return json({ ok: true, pocketCoins: row.pocket_coins });
      }

      // ── GET /inventory — 소비재 사용 전용 화면(장착은 /bots/* 로 이동됨) ──
      if (request.method === "GET" && path === "/inventory") {
        const { results } = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const items = results.map((r) => ({ id: r.item_id, qty: r.qty, ...SHOP_ITEMS[r.item_id] }));
        return json({ items });
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
        if (item.effect === "stamina_full") row.stamina = MAX_STAMINA;
        if (item.effect === "energy") row.energy = Math.min(MAX_ENERGY, row.energy + item.value);
        if (item.effect === "energy_full") row.energy = MAX_ENERGY;
        if (item.effect === "heal_flat") row.hp = Math.min(MAX_HP, row.hp + item.value);
        if (item.effect === "heal_full") row.hp = MAX_HP;
        if (item.effect === "self_shield") row.shield_until = Math.max(row.shield_until, Date.now() + item.value);

        await env.DB.prepare("UPDATE arena_users SET hp=?, energy=?, stamina=?, shield_until=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?")
          .bind(row.hp, row.energy, row.stamina, row.shield_until, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();

        if (owned.qty <= 1) await env.DB.prepare("DELETE FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).run();
        else await env.DB.prepare("UPDATE arena_inventory SET qty = qty - 1 WHERE user_id=? AND item_id=?").bind(user.userId, itemId).run();

        const combat = await totalCombatStats(env, row);
        return json({ ok: true, state: publicState(row, combat) });
      }

      // ── GET /bots — 플레이어 본인 슬롯 + 보유 봇 목록 + 다음 모집 비용 + 장착 가능한(빈) 보유
      //    아이템 수량. equipStats/장착은 모두 여기서 이뤄진다(Digital Inventory는 소비재 전용). ──
      if (request.method === "GET" && path === "/bots") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const { results: bots } = await env.DB.prepare("SELECT id, equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE user_id = ? ORDER BY id").bind(user.userId).all();
        const { results: owned } = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const equippedCount = await equippedCountMap(env, user.userId);
        const availableItems = owned
          .map((o) => ({ id: o.item_id, available: o.qty - (equippedCount[o.item_id] || 0), ...SHOP_ITEMS[o.item_id] }))
          .filter((o) => o.available > 0 && (o.type === "weapon" || o.type === "armor" || o.type === "core"));
        return json({
          player: { equippedWeapon: row.equipped_weapon, equippedArmor: row.equipped_armor, equippedCore: row.equipped_core },
          bots,
          botCount: bots.length,
          maxBots: BOT_MAX_COUNT,
          nextBotCost: bots.length < BOT_MAX_COUNT ? botRecruitCost(bots.length) : null,
          availableItems,
        });
      }

      // ── POST /bots/recruit — 봇 하나 모집(비용은 보유 봇 수에 따라 기하급수적으로 증가) ──
      if (request.method === "POST" && path === "/bots/recruit") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_bots WHERE user_id = ?").bind(user.userId).first();
        const count = countRow?.cnt ?? 0;
        if (count >= BOT_MAX_COUNT) return json({ error: "더 이상 봇을 모집할 수 없습니다(최대 " + BOT_MAX_COUNT + "기)." }, 400);
        const cost = botRecruitCost(count);
        if (row.pocket_coins < cost) return json({ error: "코인이 부족합니다. (필요 " + fmtNum(cost) + ")" }, 400);

        await env.DB.prepare("UPDATE arena_users SET pocket_coins = pocket_coins - ? WHERE user_id = ?").bind(cost, user.userId).run();
        await env.DB.prepare("INSERT INTO arena_bots (user_id, created_at) VALUES (?, ?)").bind(user.userId, Date.now()).run();
        return json({ ok: true, cost, pocketCoins: row.pocket_coins - cost });
      }

      // ── POST /bots/equip { target: 'player'|botId, slot: 'weapon'|'armor'|'core', itemId } ──
      if (request.method === "POST" && path === "/bots/equip") {
        const body = await request.json().catch(() => ({}));
        const target = body.target;
        const slot = body.slot;
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item || item.type !== slot) return json({ error: "해당 슬롯에 장착할 수 없는 아이템입니다." }, 400);

        const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
        const equippedCount = await equippedCountMap(env, user.userId);
        if (!owned || owned.qty <= (equippedCount[itemId] || 0)) return json({ error: "장착 가능한 여분이 없습니다(전부 다른 슬롯에 장착됨)." }, 400);

        const col = "equipped_" + slot;
        if (target === "player") {
          await env.DB.prepare("UPDATE arena_users SET " + col + " = ? WHERE user_id = ?").bind(itemId, user.userId).run();
        } else {
          const botId = parseInt(target, 10);
          const bot = await env.DB.prepare("SELECT id FROM arena_bots WHERE id = ? AND user_id = ?").bind(botId, user.userId).first();
          if (!bot) return json({ error: "봇을 찾을 수 없습니다." }, 404);
          await env.DB.prepare("UPDATE arena_bots SET " + col + " = ? WHERE id = ?").bind(itemId, botId).run();
        }
        return json({ ok: true });
      }

      // ── POST /bots/unequip { target, slot } ──
      if (request.method === "POST" && path === "/bots/unequip") {
        const body = await request.json().catch(() => ({}));
        const target = body.target;
        const slot = body.slot;
        if (!["weapon", "armor", "core"].includes(slot)) return json({ error: "잘못된 슬롯입니다." }, 400);
        const col = "equipped_" + slot;
        if (target === "player") {
          await env.DB.prepare("UPDATE arena_users SET " + col + " = NULL WHERE user_id = ?").bind(user.userId).run();
        } else {
          const botId = parseInt(target, 10);
          await env.DB.prepare("UPDATE arena_bots SET " + col + " = NULL WHERE id = ? AND user_id = ?").bind(botId, user.userId).run();
        }
        return json({ ok: true });
      }

      // ── GET /property — 보유 기기 + 시간당 총 수익 + 현재까지 쌓인(최대 24시간) 대기 수익 ──
      if (request.method === "GET" && path === "/property") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const { ratePerHour, pendingCoins, owned } = await pendingPropertyIncome(env, row);
        const ownedMap = {};
        owned.forEach((o) => { ownedMap[o.device_id] = o.qty; });
        const devices = Object.entries(PROPERTY_DEVICES).map(([id, d]) => ({ id, ...d, owned: ownedMap[id] || 0 }));
        return json({ devices, ratePerHour, pendingCoins, maxAccrualHours: PROPERTY_MAX_ACCRUAL_MS / 3600000 });
      }

      // ── POST /property/buy { deviceId } — 구매 전 항상 먼저 대기 수익을 정산(공정한 요율 전환) ──
      if (request.method === "POST" && path === "/property/buy") {
        const body = await request.json().catch(() => ({}));
        const device = PROPERTY_DEVICES[body.deviceId];
        if (!device) return json({ error: "알 수 없는 기기입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        await collectProperty(env, row); // row.pocket_coins/last_property_collect 갱신됨
        if (row.pocket_coins < device.price) return json({ error: "코인이 부족합니다." }, 400);

        row.pocket_coins -= device.price;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(row.pocket_coins, row.user_id).run();
        await env.DB.prepare(
          "INSERT INTO arena_devices (user_id, device_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, device_id) DO UPDATE SET qty = qty + 1"
        ).bind(user.userId, body.deviceId).run();

        return json({ ok: true, pocketCoins: row.pocket_coins });
      }

      // ── POST /property/collect — 대기 수익 수거 ──
      if (request.method === "POST" && path === "/property/collect") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const collected = await collectProperty(env, row);
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, collected, state: publicState(row, combat) });
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
};
