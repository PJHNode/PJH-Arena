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
//  게임 상수
// ══════════════════════════════════════════════════════════
// HP/Energy/Stamina 최대치는 이제 전역 고정값이 아니라 유저별 컬럼(max_hp/max_energy/max_stamina)
// 이다 — 레벨업으로 받는 스탯 포인트로 늘릴 수 있기 때문. 아래 값들은 "신규 유저의 시작 최대치"
// 로만 쓰인다(DB 컬럼 기본값과 반드시 맞춰둘 것).
const BASE_MAX_HP = 100, BASE_MAX_ENERGY = 50, BASE_MAX_STAMINA = 10;
const ENERGY_REGEN_PER_TICK = 5, ENERGY_TICK_MS = 5 * 60 * 1000;   // 5분당 +5
const STAMINA_REGEN_PER_TICK = 1, STAMINA_TICK_MS = 10 * 60 * 1000; // 10분당 +1
const HP_REGEN_PCT = 0.05, HP_TICK_MS = 5 * 60 * 1000; // 5분당 "그때그때의 최대체력"의 5%

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

// ── 레벨업 스탯 포인트 — 10레벨 구간마다 레벨당 지급량이 5→7→9…로 2씩 늘어난다(그만큼
//    그 구간의 레벨업 자체가 필요 XP도 커서 더 힘들어지므로 밸런스가 맞는다는 게 기획 의도). ──
function statPointsForLevel(level) { return 5 + 2 * Math.floor((level - 1) / 10); }

// ── 스탯 강화 비용 — 세 스탯 모두 "1회 강화 = 시작값의 일정 비율만큼 증가"로 통일하고,
//    강화 비용은 현재 최대치가 시작값의 3배/4배/5배를 넘을 때마다 1포인트씩 올라간다
//    (2→3→4→5, 5에서 상한). 예: 에너지는 시작 50이라 150/200/250을 넘을 때마다 비용이
//    오른다(기획서에 나온 예시 그대로). 스태미나(시작10→30/40/50)와 HP(시작100→300/400/500)도
//    같은 배율을 적용해 자연스럽게 확장했다. ──
const STAT_CONFIG = {
  hp:      { base: BASE_MAX_HP,      increment: 20, column: "max_hp" },
  energy:  { base: BASE_MAX_ENERGY,  increment: 10, column: "max_energy" },
  stamina: { base: BASE_MAX_STAMINA, increment: 2,  column: "max_stamina" },
};
function statUpgradeCost(stat, currentMax) {
  const base = STAT_CONFIG[stat].base;
  if (currentMax >= base * 5) return 5;
  if (currentMax >= base * 4) return 4;
  if (currentMax >= base * 3) return 3;
  return 2;
}

// ══════════════════════════════════════════════════════════
//  아이템 등급(Rarity) — 상점 로테이션의 확률/등장 개수를 결정한다.
// ══════════════════════════════════════════════════════════
const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "mythic", "secret", "forbidden"];
const RARITY_META = {
  common:    { chance: 1,     maxSlots: 3, label: "COMMON",    color: "#9a9a9a" },
  uncommon:  { chance: 1,     maxSlots: 2, label: "UNCOMMON",  color: "#4cd137" },
  rare:      { chance: 0.5,   maxSlots: 1, label: "RARE",      color: "#00d4ff" },
  epic:      { chance: 0.25,  maxSlots: 1, label: "EPIC",      color: "#b060e8" },
  legendary: { chance: 0.10,  maxSlots: 1, label: "LEGENDARY", color: "#ff8a3d" },
  mythic:    { chance: 0.04,  maxSlots: 1, label: "MYTHIC",    color: "#ff3d9e" },
  secret:    { chance: 0.015, maxSlots: 1, label: "SECRET",    color: "#ffd700" },
  forbidden: { chance: 0.005, maxSlots: 1, label: "FORBIDDEN", color: "#ff1744" },
};
const SHOP_ROTATION_MS = 4 * 60 * 1000;

const ITEM_TYPE_META = {
  weapon: { label: "무장 모듈", color: "#ff6b4a" },
  armor:  { label: "방어 장갑", color: "#3d8bff" },
  core:   { label: "연산 코어", color: "#b060e8" },
};

// 장착 가능한 아이템(무장/방어/코어) — 타입 3종 x 등급 8종 = 24개.
const SHOP_ITEMS = {
  rusty_script:     { name: "Rusty Script Kit",     type: "weapon", rarity: "common",    price: 50,    value: 5 },
  packet_spoofer:   { name: "Packet Spoofer",       type: "weapon", rarity: "uncommon",  price: 150,   value: 10 },
  plasma_cannon:    { name: "플라즈마 캐논",         type: "weapon", rarity: "rare",      price: 400,   value: 20 },
  hf_blade:         { name: "고주파 블레이드",       type: "weapon", rarity: "epic",      price: 1000,  value: 35 },
  emp_missile:      { name: "EMP 유도 미사일",       type: "weapon", rarity: "legendary", price: 2500,  value: 60 },
  stuxnet:          { name: "Stuxnet Variant",      type: "weapon", rarity: "mythic",    price: 6000,  value: 100 },
  singularity_worm: { name: "Singularity Worm",     type: "weapon", rarity: "secret",    price: 14000, value: 160 },
  omega_killswitch: { name: "종말의 킬스위치",       type: "weapon", rarity: "forbidden", price: 30000, value: 250 },

  basic_av:         { name: "Basic Antivirus",      type: "armor", rarity: "common",    price: 50,    value: 5 },
  packet_filter:    { name: "Packet Filter",        type: "armor", rarity: "uncommon",  price: 150,   value: 10 },
  nano_composite:   { name: "나노 복합 장갑",         type: "armor", rarity: "rare",      price: 400,   value: 20 },
  ngfw:             { name: "Next-Gen Firewall",    type: "armor", rarity: "epic",      price: 1000,  value: 35 },
  phase_shield:     { name: "위상 변조 실드",         type: "armor", rarity: "legendary", price: 2500,  value: 60 },
  adaptive_ai:      { name: "Adaptive AI Shield",   type: "armor", rarity: "mythic",    price: 6000,  value: 100 },
  black_ice:        { name: "Black ICE",            type: "armor", rarity: "secret",    price: 14000, value: 160 },
  absolute_zero:    { name: "절대영도 방벽",          type: "armor", rarity: "forbidden", price: 30000, value: 250 },

  overclock_chip:     { name: "오버클럭 칩셋",       type: "core", rarity: "common",    price: 150,   value: 2 },
  tactical_matrix:    { name: "AI 전술 매트릭스",    type: "core", rarity: "uncommon",  price: 450,   value: 4 },
  quantum_core:       { name: "양자 연산 장치",      type: "core", rarity: "rare",      price: 1200,  value: 8 },
  neural_accelerator: { name: "뉴럴 가속기",         type: "core", rarity: "epic",      price: 3000,  value: 14 },
  singularity_core:   { name: "특이점 코어",         type: "core", rarity: "legendary", price: 7500,  value: 24 },
  dimensional_proc:   { name: "차원 연산 프로세서",   type: "core", rarity: "mythic",    price: 18000, value: 40 },
  observers_eye:      { name: "관측자의 눈",         type: "core", rarity: "secret",    price: 42000, value: 64 },
  algorithm_of_god:   { name: "신의 알고리즘",       type: "core", rarity: "forbidden", price: 90000, value: 100 },

  nanobot_kit:      { name: "나노봇 응급키트",         type: "consumable", rarity: "common",    price: 100,  effect: "heal_flat", value: 30 },
  energy_drink:     { name: "에너지 드링크",           type: "consumable", rarity: "common",    price: 150,  effect: "energy", value: 20, maxOwned: 2 },
  vaccine:          { name: "급속 치료 백신",           type: "consumable", rarity: "uncommon",  price: 300,  effect: "heal_flat", value: 90 },
  ddos:             { name: "DDoS Booster",           type: "consumable", rarity: "uncommon",  price: 800,  effect: "stamina", value: 3 },
  mega_energy_cell: { name: "메가 에너지 셀",           type: "consumable", rarity: "rare",      price: 500,  effect: "energy", value: 100 },
  adrenaline_shot:  { name: "아드레날린 샷",            type: "consumable", rarity: "rare",      price: 400,  effect: "stamina", value: 5 },
  stealth_cloak:    { name: "스텔스 클로크",            type: "consumable", rarity: "epic",      price: 1200, effect: "self_shield", value: 3600000 },
  nano_cloud:       { name: "메가 회복 나노클라우드",     type: "consumable", rarity: "legendary", price: 3000, effect: "heal_and_energy", value: 150, value2: 80 },
  dimension_veil:   { name: "차원 은신 프로토콜",        type: "consumable", rarity: "mythic",    price: 8000, effect: "self_shield", value: 21600000 },
};

const PVP_LEVEL_RANGE = 15;
// 예전엔 공격당하면 자동으로 12시간 보호막이 붙어서 그 사람이 전체 유저의 타겟 목록에서
// 아예 사라졌는데, 폐지했다 — 대신 "같은 상대를 24시간 안에 몇 번까지 노릴 수 있는지"만
// 공격자별로 제한한다(아래 PVP_MAX_ATTACKS_PER_TARGET_PER_DAY). 소비재로 사는 자가 보호막
// (stealth_cloak 등, shield_until 컬럼)은 이것과 별개로 그대로 유효하다.
const PVP_MAX_ATTACKS_PER_TARGET_PER_DAY = 5;
const PVP_PLUNDER_RATE = 0.10;
const PVP_WIN_ATK_HP_LOSS = 10, PVP_WIN_DEF_HP_LOSS = 40;
const PVP_LOSE_ATK_HP_LOSS = 30, PVP_LOSE_DEF_HP_LOSS = 5;
const BASE_CRIT_PCT = 5;
const CRIT_MULTIPLIER = 1.5;

// ── 전투 태세(가위바위보) — 공격자가 매 전투마다 고른다. 서로 물고 무는 3종이라 상대의
//    "평소 태세"(last_stance, 가장 최근 공격 시 골랐던 태세)를 알면 유리한 태세로 맞설 수 있다
//    (Practice Scan에서 공개). 방어자의 실시간 DEF 자체는 태세 영향을 안 받는다 — 방어자는
//    오프라인일 수도 있어서 "지금 이 순간 뭘 골랐는지"가 존재하지 않기 때문에, last_stance는
//    어디까지나 "이 사람 패턴 읽기"용 힌트로만 쓰인다. ──
const STANCES = {
  aggressive: { label: "공격형", atkMult: 1.25, defMult: 0.85, beats: "ambush" },
  defensive:  { label: "방어형", atkMult: 0.85, defMult: 1.25, beats: "aggressive" },
  ambush:     { label: "기습형", atkMult: 1.00, defMult: 0.90, beats: "defensive" },
};
const STANCE_RPS_BONUS = 0.15; // 상성으로 이기면 +15%, 지면 -15%

// ── 공격 시퀀스(3라운드 타이밍 미니게임) — 클라이언트가 라운드마다 0~100 정확도를 보내오면
//    ±15% 폭의 배율로 반영한다. 클라이언트가 값을 조작해도 최대 1.15배까지만 영향을 주므로
//    (게임 점수 위조 방지와 동일한 "완벽 차단은 아니지만 최소한의 안전장치" 철학), 스탯 차이를
//    완전히 뒤집을 순 없고 어디까지나 보정 수준으로만 작용한다. 3판 중 2판 이상 이기면 전투 승리,
//    3판 전승(스윕)이면 약탈 보너스를 추가로 준다. ──
const PVP_ROUNDS = 3;
function timingMultiplier(score) {
  const s = clamp(Number(score) || 50, 0, 100);
  return 0.85 + (s / 100) * 0.3;
}
const PVP_STAMINA_COST_ONLINE = 1, PVP_STAMINA_COST_OFFLINE = 2;
const ONLINE_THRESHOLD_MS = 150 * 1000;
const BANK_DEPOSIT_TAX_RATE = 0.10;
const STARTING_ENERGY = BASE_MAX_ENERGY;

const BOT_BASE_COST = 2000;
const BOT_COST_GROWTH = 2.5;
const BOT_MAX_COUNT = 10;
function botRecruitCost(currentCount) { return Math.round(BOT_BASE_COST * Math.pow(BOT_COST_GROWTH, currentCount)); }

const PROPERTY_MAX_ACCRUAL_MS = 24 * 60 * 60 * 1000;
const PROPERTY_MAX_DEVICES = 6;
const PROPERTY_SELL_RATE = 0.5; // 되팔 때는 구매가의 50%만 환불(무한 사고팔기로 코인 복사 방지)
const PROPERTY_DEVICES = {
  botnet_node:     { name: "Botnet Node",          price: 500,   coinsPerHour: 5 },
  packet_sniffer:  { name: "Packet Sniffer Rig",   price: 1500,  coinsPerHour: 18 },
  asic_farm:       { name: "Mining ASIC Farm",     price: 4000,  coinsPerHour: 55 },
  cloud_scraper:   { name: "Cloud Scraper Array",  price: 10000, coinsPerHour: 150 },
  quantum_miner:   { name: "Quantum Miner",        price: 25000, coinsPerHour: 400 },
};

// ── 행성 기반 성간 전쟁(Galaxy Map) ── 각 유저는 공격받지 않는 "홈 행성"(is_home=1)을
// 거점으로 시작한다. 그 외 고정된 개수의 "야생 행성"이 맵에 깔려 있고, 처음엔 전부 PVE 봇이
// 지키고 있다(bot_tier). 유저는 기존 PvP 전투 엔진(태세+타이밍 미니게임, PVP_ROUNDS)을 그대로
// 재사용해 봇이나 다른 유저 소유의 야생 행성을 공격한다 — 이기면 그 행성을 정복(소유권 이전)
// 하고 그동안 쌓인 수익을 약탈한다. 홈 행성은 이 시스템으로는 절대 공격 대상이 되지 않는다
// (플레이어 간 직접 결투는 여전히 기존 Arena P2P 탭의 몫 — 두 시스템은 서로 안 겹친다).
const PLANET_COUNT = 48;
const PLANET_MAX_OWNED_WILD = 3; // 홈 행성 제외, 한 유저가 동시에 정복해 둘 수 있는 야생 행성 수
const PLANET_ATTACK_STAMINA_COST = 2;
const PLANET_BOT_TIERS = {
  weak:   { label: "약함", atk: 18,  def: 15,  crit: 5,  coinsPerHour: 15,  weight: 0.5 },
  medium: { label: "보통", atk: 55,  def: 48,  crit: 10, coinsPerHour: 50,  weight: 0.35 },
  strong: { label: "강함", atk: 110, def: 95,  crit: 15, coinsPerHour: 140, weight: 0.15 },
};
const PLANET_NAME_PREFIXES = ["Nova", "Zenith", "Vortex", "Cinder", "Helix", "Obsidian", "Quasar", "Drift", "Ember", "Static", "Neon", "Glitch", "Rogue", "Nexus", "Eclipse", "Fracture"];
function rollPlanetTier() {
  const r = Math.random();
  if (r < PLANET_BOT_TIERS.weak.weight) return "weak";
  if (r < PLANET_BOT_TIERS.weak.weight + PLANET_BOT_TIERS.medium.weight) return "medium";
  return "strong";
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randMult() { return 0.9 + Math.random() * 0.2; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeShopRotation(nowMs) {
  const bucket = Math.floor((nowMs || Date.now()) / SHOP_ROTATION_MS);
  const rng = mulberry32(bucket);
  const byRarity = {};
  for (const id in SHOP_ITEMS) {
    const item = SHOP_ITEMS[id];
    (byRarity[item.rarity] = byRarity[item.rarity] || []).push(id);
  }
  const itemIds = [];
  for (const rarity of RARITY_ORDER) {
    const meta = RARITY_META[rarity];
    const pool = (byRarity[rarity] || []).slice();
    if (!pool.length) continue;
    if (rng() > meta.chance) continue;
    const slots = Math.min(meta.maxSlots, pool.length);
    for (let i = 0; i < slots; i++) {
      const idx = Math.floor(rng() * pool.length);
      itemIds.push(pool.splice(idx, 1)[0]);
    }
  }
  return { itemIds: itemIds, bucket: bucket, nextRotationAt: (bucket + 1) * SHOP_ROTATION_MS };
}

// ── 상점 재고 — 장착 아이템(무기/방어/코어)과 소비재 전부, 로테이션(bucket)마다 아이템별로
//    1~3개 중 하나가 시드되어 다 팔리면 그 로테이션 동안은 품절. 등급이 높을수록 "떴다 하면
//    딱 1개"일 확률이 훨씬 높아진다(희귀할수록 더 귀해야 하니까) — COMMON은 1개 50%/2개
//    35%/3개 15%인 반면 FORBIDDEN은 1개 99%로 사실상 항상 1개만 나온다. ──
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
const STOCK_WEIGHTS_BY_RARITY = {
  common:    { one: 0.50, two: 0.35, three: 0.15 },
  uncommon:  { one: 0.60, two: 0.30, three: 0.10 },
  rare:      { one: 0.70, two: 0.23, three: 0.07 },
  epic:      { one: 0.80, two: 0.16, three: 0.04 },
  legendary: { one: 0.88, two: 0.10, three: 0.02 },
  mythic:    { one: 0.93, two: 0.06, three: 0.01 },
  secret:    { one: 0.97, two: 0.025, three: 0.005 },
  forbidden: { one: 0.99, two: 0.009, three: 0.001 },
};
function rollItemStock(itemId, bucket, rarity) {
  const w = STOCK_WEIGHTS_BY_RARITY[rarity] || STOCK_WEIGHTS_BY_RARITY.common;
  const rng = mulberry32((bucket ^ hashStr(itemId)) | 0);
  const r = rng();
  if (r < w.one) return 1;
  if (r < w.one + w.two) return 2;
  return 3;
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_users (" +
    "user_id TEXT PRIMARY KEY, real_name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0, " +
    "hp INTEGER NOT NULL DEFAULT 100, energy INTEGER NOT NULL DEFAULT 50, stamina INTEGER NOT NULL DEFAULT 10, " +
    "max_hp INTEGER NOT NULL DEFAULT 100, max_energy INTEGER NOT NULL DEFAULT 50, max_stamina INTEGER NOT NULL DEFAULT 10, " +
    "stat_points INTEGER NOT NULL DEFAULT 0, " +
    "pocket_coins INTEGER NOT NULL DEFAULT 0, bank_coins INTEGER NOT NULL DEFAULT 0, " +
    "equipped_weapon TEXT, equipped_armor TEXT, shield_until INTEGER NOT NULL DEFAULT 0, plunder_wins INTEGER NOT NULL DEFAULT 0, " +
    "last_energy_tick INTEGER NOT NULL, last_stamina_tick INTEGER NOT NULL, last_hp_tick INTEGER NOT NULL, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN equipped_core TEXT"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN last_property_collect INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN max_hp INTEGER NOT NULL DEFAULT 100"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN max_energy INTEGER NOT NULL DEFAULT 50"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN max_stamina INTEGER NOT NULL DEFAULT 10"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN stat_points INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN last_stance TEXT"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1)"
  );
  try { await env.DB.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_user_item ON arena_inventory(user_id, item_id)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, " +
    "opponent_id TEXT, opponent_name TEXT, result TEXT, coins_delta INTEGER NOT NULL DEFAULT 0, hp_delta INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_logs_user ON arena_logs(user_id, created_at)"); } catch (e) {}
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_logs_user_opponent ON arena_logs(user_id, opponent_id, created_at)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_bots (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, " +
    "equipped_weapon TEXT, equipped_armor TEXT, equipped_core TEXT, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_bots_user ON arena_bots(user_id)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_devices (user_id TEXT NOT NULL, device_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1)"
  );
  try { await env.DB.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_item ON arena_devices(user_id, device_id)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_planets (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_index INTEGER NOT NULL DEFAULT -1, " +
    "name TEXT NOT NULL, owner_user_id TEXT, owner_name TEXT, is_home INTEGER NOT NULL DEFAULT 0, bot_tier TEXT, " +
    "coins_per_hour INTEGER NOT NULL DEFAULT 0, last_collect INTEGER NOT NULL DEFAULT 0, captured_at INTEGER, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_planets_owner ON arena_planets(owner_user_id)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_shop_stock (item_id TEXT NOT NULL, bucket INTEGER NOT NULL, bought INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (item_id, bucket))"
  );
  schemaReady = true;
}

// 야생 행성 풀(PLANET_COUNT개)은 최초 한 번만 시드한다 — 이미 하나라도 있으면 건너뜀.
async function ensurePlanetSeed(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_planets WHERE is_home = 0").first();
  if (row && row.cnt > 0) return;
  const now = Date.now();
  const inserts = [];
  for (let i = 0; i < PLANET_COUNT; i++) {
    const tier = rollPlanetTier();
    const name = PLANET_NAME_PREFIXES[randInt(0, PLANET_NAME_PREFIXES.length - 1)] + "-" + (100 + i);
    inserts.push(env.DB.prepare(
      "INSERT INTO arena_planets (slot_index, name, owner_user_id, owner_name, is_home, bot_tier, coins_per_hour, last_collect, created_at) VALUES (?,?,NULL,NULL,0,?,?,?,?)"
    ).bind(i, name, tier, PLANET_BOT_TIERS[tier].coinsPerHour, now, now));
  }
  await env.DB.batch(inserts);
}

// 유저의 홈 행성 — 없으면 하나 만들어준다(멱등). 홈 행성은 공격/정복 대상이 아니라 순수 거점.
async function ensureHomePlanet(env, userId, realName) {
  let home = await env.DB.prepare("SELECT * FROM arena_planets WHERE owner_user_id = ? AND is_home = 1").bind(userId).first();
  if (home) return home;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO arena_planets (slot_index, name, owner_user_id, owner_name, is_home, bot_tier, coins_per_hour, last_collect, created_at) VALUES (-1, ?, ?, ?, 1, NULL, 0, ?, ?)"
  ).bind(realName + "의 홈행성", userId, realName, now, now).run();
  return env.DB.prepare("SELECT * FROM arena_planets WHERE owner_user_id = ? AND is_home = 1").bind(userId).first();
}

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

function applyRegen(row, now) {
  const out = Object.assign({}, row);
  if (out.energy > out.max_energy) out.energy = out.max_energy;
  if (out.stamina > out.max_stamina) out.stamina = out.max_stamina;
  if (out.hp > out.max_hp) out.hp = out.max_hp;
  if (out.hp > 0) {
    const energyTicks = Math.floor((now - out.last_energy_tick) / ENERGY_TICK_MS);
    if (energyTicks > 0 && out.energy < out.max_energy) {
      out.energy = Math.min(out.max_energy, out.energy + energyTicks * ENERGY_REGEN_PER_TICK);
      out.last_energy_tick += energyTicks * ENERGY_TICK_MS;
    } else if (energyTicks > 0) {
      out.last_energy_tick += energyTicks * ENERGY_TICK_MS;
    }
    const staminaTicks = Math.floor((now - out.last_stamina_tick) / STAMINA_TICK_MS);
    if (staminaTicks > 0) {
      out.stamina = Math.min(out.max_stamina, out.stamina + staminaTicks * STAMINA_REGEN_PER_TICK);
      out.last_stamina_tick += staminaTicks * STAMINA_TICK_MS;
    }
    const hpTicks = Math.floor((now - out.last_hp_tick) / HP_TICK_MS);
    if (hpTicks > 0) {
      out.hp = Math.min(out.max_hp, out.hp + hpTicks * Math.round(out.max_hp * HP_REGEN_PCT));
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

function applyXpAndLevel(row, xpGain) {
  row.xp += xpGain;
  let leveledUp = false;
  let pointsGained = 0;
  while (row.xp >= nextExpFor(row.level)) {
    row.xp -= nextExpFor(row.level);
    row.level += 1;
    pointsGained += statPointsForLevel(row.level);
    leveledUp = true;
  }
  if (leveledUp) {
    row.stat_points += pointsGained;
    row.hp = row.max_hp; row.energy = row.max_energy; row.stamina = row.max_stamina;
    const now = Date.now();
    row.last_energy_tick = now; row.last_stamina_tick = now; row.last_hp_tick = now;
  }
  return leveledUp;
}

function slotBonus(itemId, wantType) {
  const it = itemId ? SHOP_ITEMS[itemId] : null;
  return it && it.type === wantType ? it.value : 0;
}
function equipStats(unit) {
  return {
    atk: slotBonus(unit.equipped_weapon, "weapon"),
    def: slotBonus(unit.equipped_armor, "armor"),
    crit: slotBonus(unit.equipped_core, "core"),
  };
}

async function totalCombatStats(env, row) {
  const self = equipStats(row);
  let atk = baseAtkFor(row.level) + self.atk;
  let def = baseDefFor(row.level) + self.def;
  let crit = BASE_CRIT_PCT + self.crit;
  const botsRes = await env.DB.prepare(
    "SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE user_id = ?"
  ).bind(row.user_id).all();
  const bots = botsRes.results;
  for (const b of bots) {
    const bs = equipStats(b);
    atk += bs.atk; def += bs.def; crit += bs.crit;
  }
  return { atk: atk, def: def, crit: crit, botCount: bots.length };
}

function publicState(row, combat) {
  return {
    userId: row.user_id, realName: row.real_name,
    level: row.level, xp: row.xp, nextExp: nextExpFor(row.level),
    hp: row.hp, maxHp: row.max_hp, energy: row.energy, maxEnergy: row.max_energy, stamina: row.stamina, maxStamina: row.max_stamina,
    statPoints: row.stat_points,
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

// ── 같은 (공격자, 방어자) 쌍이 최근 24시간 안에 몇 번 붙었는지 — arena_logs에 이미 매 PvP
// 공격마다 기록이 남으므로 새 테이블 없이 그대로 센다. 24시간이 지난 기록은 자연히 창밖으로
// 밀려나 다시 카운트에서 빠지므로("슬라이딩 윈도우") 별도 리셋 로직이 필요 없다. ──
async function countRecentAttacks(env, attackerId, defenderId) {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM arena_logs WHERE user_id = ? AND opponent_id = ? AND kind = 'pvp_attack' AND created_at > ?"
  ).bind(attackerId, defenderId, dayAgo).first();
  return (row && row.cnt) || 0;
}

async function pendingPropertyIncome(env, row) {
  const res = await env.DB.prepare("SELECT device_id, qty FROM arena_devices WHERE user_id = ?").bind(row.user_id).all();
  const results = res.results;
  let ratePerHour = 0;
  for (const r of results) {
    const dev = PROPERTY_DEVICES[r.device_id];
    if (dev) ratePerHour += dev.coinsPerHour * r.qty;
  }
  const elapsedMs = Math.min(Date.now() - (row.last_property_collect || row.created_at), PROPERTY_MAX_ACCRUAL_MS);
  const pendingCoins = Math.floor(ratePerHour * (elapsedMs / 3600000));
  return { ratePerHour: ratePerHour, pendingCoins: pendingCoins, owned: results };
}

async function collectProperty(env, row) {
  const info = await pendingPropertyIncome(env, row);
  const now = Date.now();
  if (info.pendingCoins > 0) row.pocket_coins += info.pendingCoins;
  row.last_property_collect = now;
  await env.DB.prepare("UPDATE arena_users SET pocket_coins=?, last_property_collect=? WHERE user_id=?")
    .bind(row.pocket_coins, row.last_property_collect, row.user_id).run();
  return info.pendingCoins;
}

async function equippedCountMap(env, userId) {
  const counts = {};
  function bump(id) { if (id) counts[id] = (counts[id] || 0) + 1; }
  const player = await env.DB.prepare("SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_users WHERE user_id = ?").bind(userId).first();
  if (player) { bump(player.equipped_weapon); bump(player.equipped_armor); bump(player.equipped_core); }
  const botsRes = await env.DB.prepare("SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE user_id = ?").bind(userId).all();
  for (const b of botsRes.results) { bump(b.equipped_weapon); bump(b.equipped_armor); bump(b.equipped_core); }
  return counts;
}

function fmtNum(n) { return Number(n || 0).toLocaleString("en-US"); }

const SHOP_TYPE_ORDER = { weapon: 0, armor: 1, core: 2, consumable: 3 };
const SHOP_RARITY_ORDER = {};
RARITY_ORDER.forEach(function (r, i) { SHOP_RARITY_ORDER[r] = i; });
function sortedShopEntries(entries) {
  return entries.sort(function (a, b) {
    const t = SHOP_TYPE_ORDER[a[1].type] - SHOP_TYPE_ORDER[b[1].type];
    if (t !== 0) return t;
    const r = SHOP_RARITY_ORDER[a[1].rarity] - SHOP_RARITY_ORDER[b[1].rarity];
    if (r !== 0) return r;
    return a[1].price - b[1].price;
  });
}

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

      if (request.method === "GET" && path === "/state") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        await persistRegen(env, row);
        const combat = await totalCombatStats(env, row);
        return json(publicState(row, combat));
      }

      if (request.method === "POST" && path === "/stats/upgrade") {
        const body = await request.json().catch(function () { return {}; });
        const stat = body.stat;
        const cfg = STAT_CONFIG[stat];
        if (!cfg) return json({ error: "알 수 없는 스탯입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const currentMax = row[cfg.column];
        const cost = statUpgradeCost(stat, currentMax);
        if (row.stat_points < cost) return json({ error: "스탯 포인트가 부족합니다. (필요 " + cost + ")" }, 400);

        row.stat_points -= cost;
        row[cfg.column] = currentMax + cfg.increment;
        row[stat] = Math.min(row[cfg.column], row[stat] + cfg.increment);

        await env.DB.prepare(
          "UPDATE arena_users SET stat_points=?, " + cfg.column + "=?, " + stat + "=? WHERE user_id=?"
        ).bind(row.stat_points, row[cfg.column], row[stat], row.user_id).run();

        const combat = await totalCombatStats(env, row);
        return json({ ok: true, cost: cost, state: publicState(row, combat) });
      }

      if (request.method === "POST" && path === "/hack-job") {
        const body = await request.json().catch(function () { return {}; });
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
          "pocket_coins=?, xp=?, level=?, stat_points=? WHERE user_id=?"
        ).bind(row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick,
               row.pocket_coins, row.xp, row.level, row.stat_points, row.user_id).run();
        await insertLog(env, user.userId, "job", null, tier.label, "success", coinsGained, 0);

        const combat = await totalCombatStats(env, row);
        return json({ ok: true, coinsGained: coinsGained, xpGained: tier.xp, leveledUp: leveledUp, state: publicState(row, combat) });
      }

      if (request.method === "GET" && path === "/arena/targets") {
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        const myCombat = await totalCombatStats(env, me);
        const now = Date.now();
        // 공격 불가능한 상대(자가 보호막 중, 다운 상태, 오늘 공격 한도 초과)라도 목록에서 아예
        // 사라지진 않는다 — 그냥 ATTACK 버튼만 비활성화되고 사유가 표시된다.
        const res = await env.DB.prepare(
          "SELECT * FROM arena_users WHERE user_id != ? AND level BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 20"
        ).bind(user.userId, me.level - PVP_LEVEL_RANGE, me.level + PVP_LEVEL_RANGE).all();

        const targets = [];
        for (const t of res.results) {
          const tCombat = await totalCombatStats(env, t);
          const online = await isTargetOnline(env, t.user_id);
          let bonusPocket = 0;
          if (!online) {
            const info = await pendingPropertyIncome(env, t);
            bonusPocket = info.pendingCoins;
          }
          let wins = 0;
          for (let i = 0; i < 300; i++) if (myCombat.atk * randMult() > tCombat.def * randMult()) wins++;
          const attacksUsed = await countRecentAttacks(env, user.userId, t.user_id);
          const shielded = t.shield_until > now;
          const downed = t.hp <= 0;
          const attackCapped = attacksUsed >= PVP_MAX_ATTACKS_PER_TARGET_PER_DAY;
          targets.push({
            userId: t.user_id, realName: t.real_name, level: t.level, def: tCombat.def, online: online,
            offlinePendingCoins: bonusPocket,
            lastStance: t.last_stance || null, lastStanceLabel: t.last_stance ? STANCES[t.last_stance].label : null,
            estimatedVictoryPct: Math.round((wins / 300) * 100),
            staminaCost: online ? PVP_STAMINA_COST_ONLINE : PVP_STAMINA_COST_OFFLINE,
            attacksUsedToday: attacksUsed, attacksMaxPerDay: PVP_MAX_ATTACKS_PER_TARGET_PER_DAY,
            attackCapped: attackCapped, shielded: shielded, downed: downed,
            attackable: !shielded && !downed && !attackCapped,
          });
        }
        return json({ targets: targets, myStamina: me.stamina, stances: STANCES });
      }

      if (request.method === "POST" && path === "/arena/scan") {
        const body = await request.json().catch(function () { return {}; });
        const targetUserId = String(body.targetUserId || "");
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        const target = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!target) return json({ error: "대상을 찾을 수 없습니다." }, 404);

        const myCombat = await totalCombatStats(env, me);
        const tCombat = await totalCombatStats(env, target);
        const online = await isTargetOnline(env, target.user_id);
        let offlinePendingCoins = 0;
        if (!online) {
          const info = await pendingPropertyIncome(env, target);
          offlinePendingCoins = info.pendingCoins;
        }
        let wins = 0;
        const rounds = 1000;
        for (let i = 0; i < rounds; i++) if (myCombat.atk * randMult() > tCombat.def * randMult()) wins++;
        const attacksUsed = await countRecentAttacks(env, user.userId, target.user_id);

        return json({
          targetUserId: targetUserId, realName: target.real_name, level: target.level, def: tCombat.def, online: online, offlinePendingCoins: offlinePendingCoins,
          lastStance: target.last_stance || null, lastStanceLabel: target.last_stance ? STANCES[target.last_stance].label : null,
          myAtk: myCombat.atk, estimatedVictoryPct: Math.round((wins / rounds) * 100),
          staminaCost: online ? PVP_STAMINA_COST_ONLINE : PVP_STAMINA_COST_OFFLINE,
          attacksUsedToday: attacksUsed, attacksMaxPerDay: PVP_MAX_ATTACKS_PER_TARGET_PER_DAY,
          attackCapped: attacksUsed >= PVP_MAX_ATTACKS_PER_TARGET_PER_DAY,
        });
      }

      // ── POST /arena/attack { targetUserId, stance, timingScores: [n,n,n] } ──
      //    stance: 'aggressive'|'defensive'|'ambush' — 이번 전투에서만 적용되는 태세.
      //    timingScores: 클라이언트 타이밍 미니게임 결과(라운드당 0~100 정확도). 3판 2선승제로
      //    승부를 가르고, 3판 전승(스윕)이면 약탈 보너스가 추가로 붙는다. ──
      if (request.method === "POST" && path === "/arena/attack") {
        const body = await request.json().catch(function () { return {}; });
        const targetUserId = String(body.targetUserId || "");
        if (targetUserId === user.userId) return json({ error: "자기 자신은 공격할 수 없습니다." }, 400);
        const stanceId = body.stance;
        const stance = STANCES[stanceId];
        if (!stance) return json({ error: "전투 태세를 선택하세요." }, 400);
        const timingScores = Array.isArray(body.timingScores) ? body.timingScores : [];

        const attacker = await loadOrCreateUser(env, user.userId, user.realName);
        if (attacker.hp <= 0) return json({ error: "HP가 0입니다. 회복 후 다시 시도하세요." }, 400);

        const defender = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!defender) return json({ error: "대상을 찾을 수 없습니다." }, 404);
        if (defender.hp <= 0) return json({ error: "이미 다운된 대상입니다." }, 400);
        if (defender.shield_until > Date.now()) return json({ error: "대상이 보호막 상태입니다." }, 400);
        if (Math.abs(attacker.level - defender.level) > PVP_LEVEL_RANGE) return json({ error: "레벨 차이가 너무 큽니다." }, 400);

        // 같은 상대를 24시간 안에 너무 많이 노리는 것만 막는다(한 명 붙잡고 무한 파밍 방지) — 그 외엔
        // 공격을 당해도 상대가 목록에서 아예 사라지지는 않는다(예전의 "피격 시 12시간 자동 보호막"은
        // 폐지, 소비재로 직접 사는 자가 보호막(shield_until)만 그대로 유효).
        const attackCount = await countRecentAttacks(env, attacker.user_id, defender.user_id);
        if (attackCount >= PVP_MAX_ATTACKS_PER_TARGET_PER_DAY) {
          return json({ error: "이 상대는 24시간 안에 이미 " + PVP_MAX_ATTACKS_PER_TARGET_PER_DAY + "번 공격했습니다. 다른 대상을 노려보세요." }, 400);
        }

        const defenderOnline = await isTargetOnline(env, defender.user_id);
        const staminaCost = defenderOnline ? PVP_STAMINA_COST_ONLINE : PVP_STAMINA_COST_OFFLINE;
        if (attacker.stamina < staminaCost) return json({ error: "스태미나가 부족합니다." }, 400);
        attacker.stamina -= staminaCost;

        let offlineBonus = 0;
        if (!defenderOnline) {
          offlineBonus = await collectProperty(env, defender);
        }

        // 상성 보너스 — 상대의 "평소 태세"(last_stance)를 상대로 유리한 태세를 골랐는지에 따라
        // 공격자의 전투력에 ±15%가 붙는다. 상대가 아직 한 번도 공격한 적이 없으면(last_stance
        // 없음) 상성 자체가 성립하지 않아 보정 없음.
        let rpsMod = 0;
        if (defender.last_stance && STANCES[defender.last_stance]) {
          if (stance.beats === defender.last_stance) rpsMod = STANCE_RPS_BONUS;
          else if (STANCES[defender.last_stance].beats === stanceId) rpsMod = -STANCE_RPS_BONUS;
        }

        const attackerCombat = await totalCombatStats(env, attacker);
        const defenderCombat = await totalCombatStats(env, defender);

        let attackerRoundWins = 0;
        const rounds = [];
        for (let i = 0; i < PVP_ROUNDS; i++) {
          const timing = timingMultiplier(timingScores[i]);
          const atkPower = attackerCombat.atk * stance.atkMult * (1 + rpsMod) * timing * randMult();
          const defPower = defenderCombat.def * randMult();
          const roundWin = atkPower > defPower;
          if (roundWin) attackerRoundWins++;
          // atkPower/defPower/timing을 그대로 내려보내 클라이언트가 "왜 이겼는지/졌는지" 라운드별
          // 수치를 보여줄 수 있게 한다(요청: 전투 진행 수치 표시).
          rounds.push({
            round: i + 1, win: roundWin, timingScore: clamp(Number(timingScores[i]) || 50, 0, 100),
            atkPower: Math.round(atkPower), defPower: Math.round(defPower), timingMult: Math.round(timing * 100) / 100,
          });
        }
        const attackerWins = attackerRoundWins >= Math.ceil(PVP_ROUNDS / 2);
        const sweep = attackerWins && attackerRoundWins === PVP_ROUNDS;
        const isCrit = attackerWins && Math.random() * 100 < (attackerCombat.crit + (stanceId === "ambush" ? 10 : 0));

        let coinsDelta = 0;
        if (attackerWins) {
          let plunderMult = 1 + (isCrit ? CRIT_MULTIPLIER - 1 : 0) + (sweep ? 0.2 : 0);
          coinsDelta = Math.floor(defender.pocket_coins * PVP_PLUNDER_RATE * plunderMult);
          coinsDelta = Math.min(coinsDelta, defender.pocket_coins);
          defender.pocket_coins -= coinsDelta;
          attacker.pocket_coins += coinsDelta;
          defender.hp = clamp(defender.hp - PVP_WIN_DEF_HP_LOSS, 0, defender.max_hp);
          attacker.hp = clamp(attacker.hp - PVP_WIN_ATK_HP_LOSS, 0, attacker.max_hp);
          attacker.plunder_wins += 1;
        } else {
          defender.hp = clamp(defender.hp - PVP_LOSE_DEF_HP_LOSS, 0, defender.max_hp);
          attacker.hp = clamp(attacker.hp - PVP_LOSE_ATK_HP_LOSS, 0, attacker.max_hp);
        }

        await env.DB.batch([
          env.DB.prepare(
            "UPDATE arena_users SET stamina=?, energy=?, hp=?, pocket_coins=?, plunder_wins=?, last_stance=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
          ).bind(attacker.stamina, attacker.energy, attacker.hp, attacker.pocket_coins, attacker.plunder_wins, stanceId,
                 attacker.last_energy_tick, attacker.last_stamina_tick, attacker.last_hp_tick, attacker.user_id),
          env.DB.prepare(
            "UPDATE arena_users SET hp=?, pocket_coins=?, shield_until=? WHERE user_id=?"
          ).bind(defender.hp, defender.pocket_coins, defender.shield_until, defender.user_id),
        ]);

        const attackResult = attackerWins ? (isCrit ? "crit" : "win") : "lose";
        await insertLog(env, attacker.user_id, "pvp_attack", defender.user_id, defender.real_name, attackResult, attackerWins ? coinsDelta : 0, attackerWins ? -PVP_WIN_ATK_HP_LOSS : -PVP_LOSE_ATK_HP_LOSS);
        await insertLog(env, defender.user_id, "pvp_defend", attacker.user_id, attacker.real_name, attackerWins ? "lose" : "win", attackerWins ? -coinsDelta : 0, attackerWins ? -PVP_WIN_DEF_HP_LOSS : -PVP_LOSE_DEF_HP_LOSS);

        const combat = await totalCombatStats(env, attacker);
        return json({
          ok: true, attackerWins: attackerWins, isCrit: isCrit, sweep: sweep, coinsDelta: coinsDelta,
          rounds: rounds, attackerRoundWins: attackerRoundWins, rpsMod: rpsMod,
          myAtk: attackerCombat.atk, theirDef: defenderCombat.def, stanceLabel: stance.label,
          offlineBonusCollected: offlineBonus, state: publicState(attacker, combat),
        });
      }

      if (request.method === "POST" && path === "/bank/deposit") {
        const body = await request.json().catch(function () { return {}; });
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
        return json({ ok: true, tax: tax, credited: credited, state: publicState(row, combat) });
      }

      if (request.method === "POST" && path === "/bank/withdraw") {
        const body = await request.json().catch(function () { return {}; });
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

      // ── GET /items — 로테이션과 무관한 SHOP_ITEMS 전체 카탈로그(이름/등급/타입 조회용).
      //    이미 보유 중인 아이템은 지금 상점(rotation)에 안 떠 있을 수도 있으므로, 장착 드롭다운
      //    등에서 "이미 장착된 아이템"의 이름/등급을 보여주려면 로테이션과 무관한 전체 목록이 필요하다. ──
      if (request.method === "GET" && path === "/items") {
        const items = sortedShopEntries(Object.keys(SHOP_ITEMS).map(function (id) { return [id, SHOP_ITEMS[id]]; })).map(function (pair) {
          const id = pair[0], item = pair[1];
          return Object.assign({ id: id }, item, {
            rarityLabel: RARITY_META[item.rarity].label, rarityColor: RARITY_META[item.rarity].color,
            typeLabel: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].label : null,
            typeColor: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].color : null,
          });
        });
        return json({ items: items });
      }

      if (request.method === "GET" && path === "/shop") {
        const ownedRes = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const ownedMap = {};
        ownedRes.results.forEach(function (o) { ownedMap[o.item_id] = o.qty; });
        const equippedCount = await equippedCountMap(env, user.userId);
        const rotation = computeShopRotation();
        const stockRes = await env.DB.prepare("SELECT item_id, bought FROM arena_shop_stock WHERE bucket = ?").bind(rotation.bucket).all();
        const boughtMap = {};
        stockRes.results.forEach(function (s) { boughtMap[s.item_id] = s.bought; });
        const entries = rotation.itemIds.map(function (id) { return [id, SHOP_ITEMS[id]]; });
        const items = sortedShopEntries(entries).map(function (pair) {
          const id = pair[0], item = pair[1];
          const totalStock = rollItemStock(id, rotation.bucket, item.rarity);
          const remainingStock = Math.max(0, totalStock - (boughtMap[id] || 0));
          return Object.assign({ id: id }, item, {
            rarityLabel: RARITY_META[item.rarity].label, rarityColor: RARITY_META[item.rarity].color,
            typeLabel: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].label : null,
            typeColor: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].color : null,
            owned: ownedMap[id] || 0, equipped: equippedCount[id] || 0,
            totalStock: totalStock, remainingStock: remainingStock,
          });
        });
        return json({ items: items, nextRotationAt: rotation.nextRotationAt, rotationMs: SHOP_ROTATION_MS });
      }

      if (request.method === "POST" && path === "/shop/buy") {
        const body = await request.json().catch(function () { return {}; });
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item) return json({ error: "알 수 없는 아이템입니다." }, 400);
        const rotation = computeShopRotation();
        if (rotation.itemIds.indexOf(itemId) === -1) return json({ error: "지금 상점에 없는 아이템입니다(로테이션이 바뀌었어요)." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.pocket_coins < item.price) return json({ error: "코인이 부족합니다." }, 400);

        // 아이템별 최대 보유 개수(maxOwned) — 예: 에너지 드링크는 최대 2개까지만 들고 있을 수 있다.
        if (item.maxOwned) {
          const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
          if (owned && owned.qty >= item.maxOwned) {
            return json({ error: item.name + "은(는) 최대 " + item.maxOwned + "개까지만 보유할 수 있습니다." }, 400);
          }
        }

        // 상점 재고(로테이션당 1~3개, 장착 아이템도 포함) — 조건부 UPDATE(bought < total)로
        // 품절 이후엔 아무도 더 못 사게 막는다. changes가 0이면 이번 로테이션 재고가 이미 다 팔린 것.
        const totalStock = rollItemStock(itemId, rotation.bucket, item.rarity);
        const stockRes = await env.DB.prepare(
          "INSERT INTO arena_shop_stock (item_id, bucket, bought) VALUES (?, ?, 1) ON CONFLICT(item_id, bucket) DO UPDATE SET bought = bought + 1 WHERE bought < ?"
        ).bind(itemId, rotation.bucket, totalStock).run();
        if (!stockRes.meta.changes) return json({ error: "품절된 아이템입니다. 다음 로테이션을 기다려주세요." }, 400);

        row.pocket_coins -= item.price;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id).run();
        await env.DB.prepare(
          "INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1"
        ).bind(user.userId, itemId).run();

        return json({ ok: true, pocketCoins: row.pocket_coins });
      }

      if (request.method === "GET" && path === "/inventory") {
        const res = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const items = res.results.map(function (r) {
          const item = SHOP_ITEMS[r.item_id];
          return Object.assign({ id: r.item_id, qty: r.qty }, item, {
            rarityLabel: item ? RARITY_META[item.rarity].label : null,
            rarityColor: item ? RARITY_META[item.rarity].color : null,
          });
        });
        return json({ items: items });
      }

      if (request.method === "POST" && path === "/inventory/use") {
        const body = await request.json().catch(function () { return {}; });
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item || item.type !== "consumable") return json({ error: "사용할 수 없는 아이템입니다." }, 400);
        const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
        if (!owned || owned.qty <= 0) return json({ error: "보유하지 않은 아이템입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        // 전부 고정 수치 회복이다 — "100% 채움" 류 소비재는 없다(가격을 내면 낼수록 더 많은 양이
        // 채워질 뿐, 최대치까지 무조건 꽉 채워주는 아이템은 두지 않기로 함).
        if (item.effect === "stamina") row.stamina = Math.min(row.max_stamina, row.stamina + item.value);
        if (item.effect === "energy") row.energy = Math.min(row.max_energy, row.energy + item.value);
        if (item.effect === "heal_flat") row.hp = Math.min(row.max_hp, row.hp + item.value);
        if (item.effect === "heal_and_energy") { row.hp = Math.min(row.max_hp, row.hp + item.value); row.energy = Math.min(row.max_energy, row.energy + item.value2); }
        if (item.effect === "self_shield") row.shield_until = Math.max(row.shield_until, Date.now() + item.value);

        await env.DB.prepare("UPDATE arena_users SET hp=?, energy=?, stamina=?, shield_until=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?")
          .bind(row.hp, row.energy, row.stamina, row.shield_until, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();

        if (owned.qty <= 1) await env.DB.prepare("DELETE FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).run();
        else await env.DB.prepare("UPDATE arena_inventory SET qty = qty - 1 WHERE user_id=? AND item_id=?").bind(user.userId, itemId).run();

        const combat = await totalCombatStats(env, row);
        return json({ ok: true, state: publicState(row, combat) });
      }

      if (request.method === "GET" && path === "/bots") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const botsRes = await env.DB.prepare("SELECT id, equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE user_id = ? ORDER BY id").bind(user.userId).all();
        const ownedRes = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const equippedCount = await equippedCountMap(env, user.userId);
        const rawEntries = ownedRes.results
          .map(function (o) { return [o.item_id, Object.assign({ available: o.qty - (equippedCount[o.item_id] || 0) }, SHOP_ITEMS[o.item_id])]; })
          .filter(function (pair) { return pair[1].available > 0 && (pair[1].type === "weapon" || pair[1].type === "armor" || pair[1].type === "core"); });
        const availableItems = sortedShopEntries(rawEntries).map(function (pair) {
          return Object.assign({ id: pair[0] }, pair[1], { rarityLabel: RARITY_META[pair[1].rarity].label, rarityColor: RARITY_META[pair[1].rarity].color });
        });
        return json({
          player: { equippedWeapon: row.equipped_weapon, equippedArmor: row.equipped_armor, equippedCore: row.equipped_core },
          bots: botsRes.results,
          botCount: botsRes.results.length,
          maxBots: BOT_MAX_COUNT,
          nextBotCost: botsRes.results.length < BOT_MAX_COUNT ? botRecruitCost(botsRes.results.length) : null,
          availableItems: availableItems,
        });
      }

      if (request.method === "POST" && path === "/bots/recruit") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_bots WHERE user_id = ?").bind(user.userId).first();
        const count = (countRow && countRow.cnt) || 0;
        if (count >= BOT_MAX_COUNT) return json({ error: "더 이상 봇을 모집할 수 없습니다(최대 " + BOT_MAX_COUNT + "기)." }, 400);
        const cost = botRecruitCost(count);
        if (row.pocket_coins < cost) return json({ error: "코인이 부족합니다. (필요 " + fmtNum(cost) + ")" }, 400);

        await env.DB.prepare("UPDATE arena_users SET pocket_coins = pocket_coins - ? WHERE user_id = ?").bind(cost, user.userId).run();
        await env.DB.prepare("INSERT INTO arena_bots (user_id, created_at) VALUES (?, ?)").bind(user.userId, Date.now()).run();
        return json({ ok: true, cost: cost, pocketCoins: row.pocket_coins - cost });
      }

      if (request.method === "POST" && path === "/bots/equip") {
        const body = await request.json().catch(function () { return {}; });
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

      if (request.method === "POST" && path === "/bots/unequip") {
        const body = await request.json().catch(function () { return {}; });
        const target = body.target;
        const slot = body.slot;
        if (["weapon", "armor", "core"].indexOf(slot) === -1) return json({ error: "잘못된 슬롯입니다." }, 400);
        const col = "equipped_" + slot;
        if (target === "player") {
          await env.DB.prepare("UPDATE arena_users SET " + col + " = NULL WHERE user_id = ?").bind(user.userId).run();
        } else {
          const botId = parseInt(target, 10);
          await env.DB.prepare("UPDATE arena_bots SET " + col + " = NULL WHERE id = ? AND user_id = ?").bind(botId, user.userId).run();
        }
        return json({ ok: true });
      }

      if (request.method === "GET" && path === "/property") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const info = await pendingPropertyIncome(env, row);
        const ownedMap = {};
        let totalOwned = 0;
        info.owned.forEach(function (o) { ownedMap[o.device_id] = o.qty; totalOwned += o.qty; });
        const devices = Object.keys(PROPERTY_DEVICES)
          .map(function (id) { return [id, PROPERTY_DEVICES[id]]; })
          .sort(function (a, b) { return a[1].price - b[1].price; })
          .map(function (pair) { return Object.assign({ id: pair[0] }, pair[1], { owned: ownedMap[pair[0]] || 0 }); });
        return json({ devices: devices, ratePerHour: info.ratePerHour, pendingCoins: info.pendingCoins, totalOwned: totalOwned, maxDevices: PROPERTY_MAX_DEVICES, maxAccrualHours: PROPERTY_MAX_ACCRUAL_MS / 3600000 });
      }

      if (request.method === "POST" && path === "/property/buy") {
        const body = await request.json().catch(function () { return {}; });
        const device = PROPERTY_DEVICES[body.deviceId];
        if (!device) return json({ error: "알 수 없는 기기입니다." }, 400);

        const ownedRes = await env.DB.prepare("SELECT qty FROM arena_devices WHERE user_id = ?").bind(user.userId).all();
        const totalOwned = ownedRes.results.reduce(function (sum, r) { return sum + r.qty; }, 0);
        if (totalOwned >= PROPERTY_MAX_DEVICES) return json({ error: "기기는 최대 " + PROPERTY_MAX_DEVICES + "개까지만 보유할 수 있습니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        await collectProperty(env, row);
        if (row.pocket_coins < device.price) return json({ error: "코인이 부족합니다." }, 400);

        row.pocket_coins -= device.price;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(row.pocket_coins, row.user_id).run();
        await env.DB.prepare(
          "INSERT INTO arena_devices (user_id, device_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, device_id) DO UPDATE SET qty = qty + 1"
        ).bind(user.userId, body.deviceId).run();

        return json({ ok: true, pocketCoins: row.pocket_coins });
      }

      // ── POST /property/sell — 보유 기기를 구매가의 PROPERTY_SELL_RATE(50%)에 되판다.
      //    되팔기 전 먼저 그동안의 대기 수익을 정산해서(collectProperty) 손해 보지 않게 한다. ──
      if (request.method === "POST" && path === "/property/sell") {
        const body = await request.json().catch(function () { return {}; });
        const device = PROPERTY_DEVICES[body.deviceId];
        if (!device) return json({ error: "알 수 없는 기기입니다." }, 400);

        const owned = await env.DB.prepare("SELECT qty FROM arena_devices WHERE user_id=? AND device_id=?").bind(user.userId, body.deviceId).first();
        if (!owned || owned.qty <= 0) return json({ error: "보유하지 않은 기기입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        await collectProperty(env, row);
        const refund = Math.floor(device.price * PROPERTY_SELL_RATE);
        row.pocket_coins += refund;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(row.pocket_coins, row.user_id).run();

        if (owned.qty <= 1) await env.DB.prepare("DELETE FROM arena_devices WHERE user_id=? AND device_id=?").bind(user.userId, body.deviceId).run();
        else await env.DB.prepare("UPDATE arena_devices SET qty = qty - 1 WHERE user_id=? AND device_id=?").bind(user.userId, body.deviceId).run();

        return json({ ok: true, refund: refund, pocketCoins: row.pocket_coins });
      }

      if (request.method === "POST" && path === "/property/collect") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const collected = await collectProperty(env, row);
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, collected: collected, state: publicState(row, combat) });
      }

      // ── GET /planets — 은하 지도 전체 목록(홈 행성들 + 야생 행성 PLANET_COUNT개). 내가 가진
      //    야생 행성엔 대기 수익(pendingCoins)을 같이 계산해 보여준다. ──
      if (request.method === "GET" && path === "/planets") {
        await ensurePlanetSeed(env);
        await ensureHomePlanet(env, user.userId, user.realName);
        const now = Date.now();
        const res = await env.DB.prepare("SELECT * FROM arena_planets ORDER BY is_home DESC, slot_index ASC").all();
        let myOwnedWild = 0;
        const planets = res.results.map(function (p) {
          const mine = p.owner_user_id === user.userId;
          if (mine && !p.is_home) myOwnedWild++;
          const tier = p.bot_tier ? PLANET_BOT_TIERS[p.bot_tier] : null;
          const elapsedMs = mine && !p.is_home ? Math.min(now - p.last_collect, PROPERTY_MAX_ACCRUAL_MS) : 0;
          const pendingCoins = mine && !p.is_home ? Math.floor(p.coins_per_hour * (elapsedMs / 3600000)) : 0;
          return {
            id: p.id, name: p.name, isHome: !!p.is_home,
            ownerUserId: p.owner_user_id, ownerName: p.owner_name, mine: mine,
            botTier: p.bot_tier, botTierLabel: tier ? tier.label : null,
            coinsPerHour: p.coins_per_hour, pendingCoins: pendingCoins,
            attackable: !p.is_home && !mine,
          };
        });
        return json({ planets: planets, myOwnedWild: myOwnedWild, maxOwnedWild: PLANET_MAX_OWNED_WILD, stances: STANCES });
      }

      // ── POST /planets/collect — 내가 정복한 야생 행성들의 누적 대기 수익을 한 번에 정산 ──
      if (request.method === "POST" && path === "/planets/collect") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const res = await env.DB.prepare("SELECT * FROM arena_planets WHERE owner_user_id = ? AND is_home = 0").bind(user.userId).all();
        const now = Date.now();
        let total = 0;
        const updates = [];
        for (const p of res.results) {
          const elapsedMs = Math.min(now - p.last_collect, PROPERTY_MAX_ACCRUAL_MS);
          const coins = Math.floor(p.coins_per_hour * (elapsedMs / 3600000));
          total += coins;
          updates.push(env.DB.prepare("UPDATE arena_planets SET last_collect=? WHERE id=?").bind(now, p.id));
        }
        if (total > 0) {
          row.pocket_coins += total;
          updates.push(env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id));
        }
        if (updates.length) await env.DB.batch(updates);
        return json({ ok: true, collected: total, pocketCoins: row.pocket_coins });
      }

      // ── POST /planets/attack — 야생 행성(봇 또는 다른 유저 소유)을 상대로 기존 PvP 전투
      //    엔진(태세+3라운드 타이밍 미니게임)을 그대로 재사용해 싸운다. 이기면 정복(한도 내에서)
      //    + 그동안 쌓인 수익 약탈, 지면 HP만 깎인다. 홈 행성은 애초에 대상에서 제외. ──
      if (request.method === "POST" && path === "/planets/attack") {
        const body = await request.json().catch(function () { return {}; });
        const planetId = parseInt(body.planetId, 10);
        const stanceId = body.stance;
        const stance = STANCES[stanceId];
        if (!stance) return json({ error: "전투 태세를 선택하세요." }, 400);
        const timingScores = Array.isArray(body.timingScores) ? body.timingScores : [];

        const attacker = await loadOrCreateUser(env, user.userId, user.realName);
        if (attacker.hp <= 0) return json({ error: "HP가 0입니다. 회복 후 다시 시도하세요." }, 400);
        if (attacker.stamina < PLANET_ATTACK_STAMINA_COST) return json({ error: "스태미나가 부족합니다." }, 400);

        const planet = await env.DB.prepare("SELECT * FROM arena_planets WHERE id = ?").bind(planetId).first();
        if (!planet) return json({ error: "존재하지 않는 행성입니다." }, 404);
        if (planet.is_home) return json({ error: "홈 행성은 공격할 수 없습니다." }, 400);
        if (planet.owner_user_id === user.userId) return json({ error: "이미 내 행성입니다." }, 400);

        const isBotPlanet = !planet.owner_user_id;
        let defenderCombat, defenderLastStance = null;
        if (isBotPlanet) {
          const tier = PLANET_BOT_TIERS[planet.bot_tier];
          defenderCombat = { atk: tier.atk, def: tier.def, crit: tier.crit };
        } else {
          const defenderRow = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(planet.owner_user_id).first();
          if (!defenderRow) return json({ error: "행성 소유자를 찾을 수 없습니다." }, 400);
          defenderCombat = await totalCombatStats(env, defenderRow);
          defenderLastStance = defenderRow.last_stance;
        }

        let rpsMod = 0;
        if (defenderLastStance && STANCES[defenderLastStance]) {
          if (stance.beats === defenderLastStance) rpsMod = STANCE_RPS_BONUS;
          else if (STANCES[defenderLastStance].beats === stanceId) rpsMod = -STANCE_RPS_BONUS;
        }

        const attackerCombat = await totalCombatStats(env, attacker);
        let attackerRoundWins = 0;
        const rounds = [];
        for (let i = 0; i < PVP_ROUNDS; i++) {
          const timing = timingMultiplier(timingScores[i]);
          const atkPower = attackerCombat.atk * stance.atkMult * (1 + rpsMod) * timing * randMult();
          const defPower = defenderCombat.def * randMult();
          const roundWin = atkPower > defPower;
          if (roundWin) attackerRoundWins++;
          rounds.push({
            round: i + 1, win: roundWin, timingScore: clamp(Number(timingScores[i]) || 50, 0, 100),
            atkPower: Math.round(atkPower), defPower: Math.round(defPower), timingMult: Math.round(timing * 100) / 100,
          });
        }
        const attackerWins = attackerRoundWins >= Math.ceil(PVP_ROUNDS / 2);
        const sweep = attackerWins && attackerRoundWins === PVP_ROUNDS;

        attacker.stamina -= PLANET_ATTACK_STAMINA_COST;
        const now = Date.now();
        let captured = false, lootCoins = 0;

        if (attackerWins) {
          if (isBotPlanet) {
            lootCoins = Math.round(PLANET_BOT_TIERS[planet.bot_tier].coinsPerHour * 0.5);
          } else {
            const elapsedMs = Math.min(now - planet.last_collect, PROPERTY_MAX_ACCRUAL_MS);
            lootCoins = Math.floor(planet.coins_per_hour * (elapsedMs / 3600000));
          }
          attacker.pocket_coins += lootCoins;

          const ownedCountRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_planets WHERE owner_user_id = ? AND is_home = 0").bind(user.userId).first();
          const ownedCount = (ownedCountRow && ownedCountRow.cnt) || 0;
          if (ownedCount < PLANET_MAX_OWNED_WILD) {
            captured = true;
            await env.DB.prepare(
              "UPDATE arena_planets SET owner_user_id=?, owner_name=?, bot_tier=NULL, last_collect=?, captured_at=? WHERE id=?"
            ).bind(user.userId, user.realName, now, now, planet.id).run();
          }
          attacker.hp = clamp(attacker.hp - PVP_WIN_ATK_HP_LOSS, 0, attacker.max_hp);
        } else {
          attacker.hp = clamp(attacker.hp - PVP_LOSE_ATK_HP_LOSS, 0, attacker.max_hp);
        }

        await env.DB.prepare(
          "UPDATE arena_users SET stamina=?, hp=?, pocket_coins=?, last_stance=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
        ).bind(attacker.stamina, attacker.hp, attacker.pocket_coins, stanceId, attacker.last_energy_tick, attacker.last_stamina_tick, attacker.last_hp_tick, attacker.user_id).run();

        await insertLog(env, attacker.user_id, "planet_attack", isBotPlanet ? null : planet.owner_user_id, isBotPlanet ? planet.name : planet.owner_name,
          attackerWins ? "win" : "lose", attackerWins ? lootCoins : 0, attackerWins ? -PVP_WIN_ATK_HP_LOSS : -PVP_LOSE_ATK_HP_LOSS);
        if (!isBotPlanet && attackerWins) {
          await insertLog(env, planet.owner_user_id, "planet_lost", user.userId, user.realName, "lose", -lootCoins, 0);
        }

        const combat = await totalCombatStats(env, attacker);
        return json({
          ok: true, attackerWins: attackerWins, sweep: sweep, captured: captured, lootCoins: lootCoins,
          capCapped: attackerWins && !captured, planetName: planet.name,
          rounds: rounds, attackerRoundWins: attackerRoundWins, rpsMod: rpsMod,
          myAtk: attackerCombat.atk, theirDef: defenderCombat.def, stanceLabel: stance.label,
          state: publicState(attacker, combat),
        });
      }

      if (request.method === "GET" && path === "/logs") {
        const kind = url.searchParams.get("kind");
        const stmt = kind
          ? env.DB.prepare("SELECT * FROM arena_logs WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 20").bind(user.userId, kind)
          : env.DB.prepare("SELECT * FROM arena_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.userId);
        const res = await stmt.all();
        return json({ logs: res.results });
      }

      if (request.method === "GET" && path === "/leaderboard") {
        const type = url.searchParams.get("type") || "level";
        let orderBy;
        if (type === "assets") orderBy = "(pocket_coins + bank_coins) DESC";
        else if (type === "plunder") orderBy = "plunder_wins DESC";
        else orderBy = "level DESC, xp DESC";
        const res = await env.DB.prepare(
          "SELECT user_id, real_name, level, pocket_coins, bank_coins, plunder_wins FROM arena_users ORDER BY " + orderBy + " LIMIT 50"
        ).all();
        return json({ type: type, rows: res.results });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "서버 오류: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};
