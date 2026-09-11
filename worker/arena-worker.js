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

// 테스트 계정 전용 관리자 커맨드(GET /admin, POST /admin/*) — 이 userId가 아니면 전부 403.
// 이 계정은 리더보드에서도 제외한다(치트로 쌓인 수치가 랭킹을 오염시키지 않게).
const ADMIN_USER_ID = "pjhg0605i";

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
    let avatar = null;
    if (userRaw) {
      const userData = JSON.parse(userRaw);
      if (userData.banned) return { _error: "정지된 계정입니다.", _status: 403 };
      avatar = userData.avatar || null; // PJH-Hub에서 산 아바타 id(neon/gold/prism/galaxy) — 읽기만
    }
    return { userId: session.userId, realName: session.realName || session.userId, avatar: avatar };
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
const ENERGY_REGEN_PER_TICK = 5, ENERGY_TICK_MS = 30 * 1000;   // 30초당 +5
const STAMINA_REGEN_PER_TICK = 1, STAMINA_TICK_MS = 2 * 60 * 1000; // 2분당 +1
const HP_REGEN_PER_TICK = 10, HP_TICK_MS = 5 * 60 * 1000; // 5분당 +10(최대치와 무관한 고정량)

// 기본 ATK/DEF — 기획서에 레벨별 성장 수식이 명시돼 있지 않아, 장비 없이도 레벨업이
// 전투력에 의미가 있도록 "레벨당 +2"의 완만한 성장을 임의로 추가했다(합리적 기본값).
function baseAtkFor(level) { return 10 + level * 2; }
function baseDefFor(level) { return 10 + level * 2; }

function nextExpFor(level) { return level * 100; }

// ── 환생(Rebirth) — 레벨 100에서 레벨/XP/스탯 포인트(HP·에너지·스태미나 최대치 포함)를
// 전부 기본값으로 되돌리는 대신, 회당 ATK/DEF에 영구 +1%가 붙는다(최대 10회, +10%에서 상한).
// 코인/다이아/장비/봇/행성/클럽 등 "진짜 경제"는 절대 안 건드린다 — 순수하게 "레벨을 다시
// 밟아 올라가는 동안 잠깐 약해지는 대가로 아주 작은 영구 우위를 얻는" 선택지로만 설계했다. ──
const REBIRTH_LEVEL_REQUIREMENT = 100;
const REBIRTH_BONUS_PER_COUNT = 0.01;
const REBIRTH_BONUS_MAX_COUNT = 10;

// ── 환생 등급(티어) — 환생 횟수를 브론즈/실버/골드/무지개 4단계로 묶어서 프로필 테두리·
//    이름표가 환생할수록 단계적으로 화려해지게 한다. 순수 표시용 등급이라 클라이언트에서도
//    (public/arena.js의 동일한 계단식으로) 그대로 다시 계산할 수 있다 — 서버는 신뢰 판정에만 쓴다.
function rebirthTier(count) {
  const c = count || 0;
  if (c >= REBIRTH_BONUS_MAX_COUNT) return 4; // 무지개(최고 등급) — 전투력 보너스 상한(10회)과 일치
  if (c >= 5) return 3; // 골드
  if (c >= 3) return 2; // 실버
  if (c >= 1) return 1; // 브론즈
  return 0;
}
// 환생 등급별 전투/QoL 특권 — "작고 상한 있게" 원칙을 그대로 이어받아 인챈트 최대 레벨
// +2/티어(최대 +8), 봇 모집 한도 +1/티어(최대 +4), 공격 쿨다운 -4초/티어(최소 14초)만 준다.
function enchantMaxLevelFor(row) { return ENCHANT_MAX_LEVEL + rebirthTier(row.rebirth_count) * 2; }
function botMaxCountFor(row) { return BOT_MAX_COUNT + rebirthTier(row.rebirth_count); }
function attackCooldownMsFor(row) { return Math.max(14000, ATTACK_COOLDOWN_MS - rebirthTier(row.rebirth_count) * 4000); }

// 환생석 — 환생할 때마다 지급되는 전용 화폐. 코인/다이아 경제와 완전히 분리해서 인플레이션
// 걱정 없이 "환생 상점" 전용 코스메틱/칭호/버프 구매에만 쓴다. 1회차 20개부터 시작해서
// 환생을 거듭할수록 회당 +5개씩 늘어난다(20, 25, 30, 35...) — 많이 환생한 사람일수록
// 다음 환생이 더 후하게 보상받도록. newCount는 이번 환생으로 "방금 올라간" 횟수(1부터 시작).
function rebirthStonesForCount(newCount) { return 15 + Math.max(1, newCount) * 5; }

// 코인 보상은 전부 x15 — Property 수익이 가격의 1/4(예전 대비 약 15배)로 오른 것과 밸런스를
// 맞추기 위함. 에너지 소모/필요 레벨/XP는 그대로 둔다.
const JOB_TIERS = {
  trivial:   { label: "Trivial",   minLevel: 1,  energyCost: 5,  coinMin: 600,   coinMax: 900,   xp: 8 },
  low:       { label: "Low",       minLevel: 1,  energyCost: 10, coinMin: 1500,  coinMax: 2250,  xp: 15 },
  guarded:   { label: "Guarded",   minLevel: 3,  energyCost: 15, coinMin: 2700,  coinMax: 3750,  xp: 25 },
  medium:    { label: "Medium",    minLevel: 5,  energyCost: 20, coinMin: 3750,  coinMax: 5250,  xp: 35 },
  corporate: { label: "Corporate", minLevel: 8,  energyCost: 28, coinMin: 6000,  coinMax: 8250,  xp: 55 },
  high:      { label: "High",      minLevel: 10, energyCost: 35, coinMin: 7500,  coinMax: 10500, xp: 70 },
  fortress:  { label: "Fortress",  minLevel: 15, energyCost: 42, coinMin: 10500, coinMax: 14250, xp: 95 },
  master:    { label: "Master",    minLevel: 20, energyCost: 50, coinMin: 13500, coinMax: 19500, xp: 120 },
  apex:      { label: "Apex",      minLevel: 28, energyCost: 50, coinMin: 22500, coinMax: 30000, xp: 180 },
  legendary: { label: "Legendary", minLevel: 35, energyCost: 50, coinMin: 37500,  coinMax: 51000,  xp: 260 },
  // 레벨 35(legendary) 이후로 갈 곳이 없었다 — 아이템 등급 이름을 그대로 가져와서(장비가 mythic
  // ~abyssal까지 있는데 작업은 legendary에서 끝나는 게 안 맞았음) 레벨 100(환생 조건과 동일)까지
  // 이어지도록 4단계를 더 얹었다. 성장률은 legendary까지의 패턴(단계마다 최대 보상 ~1.5~1.7배)을
  // 그대로 이어간다 — energyCost는 master부터 이미 상한(50)이라 더 안 올린다.
  mythic:    { label: "Mythic",    minLevel: 45,  energyCost: 50, coinMin: 60000,  coinMax: 82500,  xp: 380 },
  secret:    { label: "Secret",    minLevel: 60,  energyCost: 50, coinMin: 97500,  coinMax: 135000, xp: 550 },
  forbidden: { label: "Forbidden", minLevel: 75,  energyCost: 50, coinMin: 157500, coinMax: 217500, xp: 800 },
  abyssal:   { label: "Abyssal",   minLevel: 100, energyCost: 50, coinMin: 255000, coinMax: 352500, xp: 1200 },
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
const RARITY_ORDER = ["common", "uncommon", "rare", "epic", "legendary", "mythic", "secret", "forbidden", "abyssal"];
// 기본 확률(연구 보너스 적용 전) — "1000번 뽑으면 common 650 / uncommon 200 / epic 100 /
// legendary 40 / secret 10 / forbidden 0" 요청을 그대로 chance(=count/1000)에 반영했다.
// rare·mythic는 명시되지 않아서 양옆 값 사이로 자연스럽게 보간했다(rare는 uncommon·epic
// 사이 0.15, mythic는 legendary·secret 사이 0.025). forbidden은 0이라 기본 로테이션에는
// 아예 안 뜨고, 연구로 얻는 보너스(레벨당 +2%)가 쌓여야만 언젠가 뜰 수 있다.
// abyssal은 forbidden보다도 한 단계 위인 "최종 등급" — 일반 로테이션/연구 보너스 공식을
// 아예 안 타고(chance는 표시상 0), 상점 행운 연구 레벨이 ABYSSAL_RESEARCH_UNLOCK_LEVEL(6)에
// 도달한 순간부터만 고정 1% 확률로 등장한다(effectiveRarityChance 안의 별도 분기 참고).
const RARITY_META = {
  common:    { chance: 1,     maxSlots: 3, label: "COMMON",    color: "#9a9a9a" }, // 항상 뜸(요청 반영)
  uncommon:  { chance: 0.20,  maxSlots: 2, label: "UNCOMMON",  color: "#4cd137" },
  rare:      { chance: 0.15,  maxSlots: 1, label: "RARE",      color: "#00d4ff" },
  epic:      { chance: 0.10,  maxSlots: 1, label: "EPIC",      color: "#b060e8" },
  legendary: { chance: 0.04,  maxSlots: 1, label: "LEGENDARY", color: "#ff8a3d" },
  mythic:    { chance: 0.025, maxSlots: 1, label: "MYTHIC",    color: "#ff3d9e" },
  secret:    { chance: 0.01,  maxSlots: 1, label: "SECRET",    color: "#ffd700" },
  forbidden: { chance: 0,     maxSlots: 1, label: "FORBIDDEN", color: "#ff1744" },
  abyssal:   { chance: 0,     maxSlots: 1, label: "ABYSSAL",   color: "#e100ff" },
};
const SHOP_ROTATION_MS = 4 * 60 * 1000;

const ITEM_TYPE_META = {
  weapon: { label: "무장 모듈", color: "#ff6b4a" },
  armor:  { label: "방어 장갑", color: "#3d8bff" },
  core:   { label: "연산 코어", color: "#b060e8" },
};

// PJH-Hub 상점에서 파는 아바타 id -> 아이콘(board-worker.js SHOP_ITEMS와 동일하게 맞춤).
// Arena는 계정을 공유할 뿐 PJH-Hub의 실제 픽셀 아트 에셋은 안 갖고 있어서, 대신 그 아바타의
// 상점 아이콘(이모지)을 그대로 가져와 쓴다.
const AVATAR_ICONS = { neon: "⚡", gold: "⭐", prism: "💎", galaxy: "🌌" };

// 장착 가능한 아이템(무장/방어/코어) — 타입 3종 x 등급 9종 = 27개.
// 가격 곡선 — 예전엔 등급이 오를수록 배율이 오히려 3x→2.1x로 줄어들어서(선형에 가까움) 고티어가
// 너무 쌌다. 이제 등급마다 배율 자체가 점점 커지도록 다시 짰다(common만 50으로 그대로 두고,
// forbidden은 800만/코어는 2,400만까지). 코어는 기존처럼 무기/방어 가격의 3배를 유지.
// abyssal(최종 등급)은 forbidden의 10배 가격 · value는 forbidden의 정확히 3배 이상(요청 반영,
// 무기/방어 250→800, 코어 100→320)으로 확실히 더 세게 설계했다 — research 행운 연구 6레벨을
// 찍어야만 1% 확률로 등장한다.
// legendary는 mythic 이상 등급만 x15 리밸런싱될 때 같이 안 올라서, epic 대비로는 적당한데
// mythic 대비로는 90배 가까이 차이 나는 기형적인 가격 단절이 생겨 있었다 — 무기/방어 25,000→
// 200,000(x8), 코어 75,000→600,000(x8)로 올려서 mythic(무기/방어 225만·코어 675만)과의 격차를
// 약 11배로 줄였다(여전히 mythic보다는 확실히 싸다). value(스탯)는 그대로 — 가격만 조정.
// ── value(스탯) 곡선 리밸런싱 — 예전엔 등급이 오를수록 배율이 오히려 줄어들었다(2, 2, 1.75,
// 1.71, 1.67, 1.6, 1.56배로 계속 감소하다가 forbidden→abyssal에서만 갑자기 3.2배). "등급이
// 높을수록 값이 곱셈으로 커져야 한다"는 요청 반영 — 이제 common부터 secret까지 깔끔하게
// 매 등급 정확히 2배(5→10→20→40→80→160→320)로 커지고, forbidden에서 2.5배(320→800),
// abyssal에서는 그보다 훨씬 큰 5배(800→4000)를 줘서 최종 등급이 확실히 도드라지게 했다.
// 가격은 이 변경과 무관하게 그대로 둔다(리롤/시세 체계 재설계는 별도 사안). 코어는 항상
// 무기/방어 value의 0.4배 유지.
const SHOP_ITEMS = {
  rusty_script:     { name: "Rusty Script Kit",     type: "weapon", rarity: "common",    price: 50,       value: 5 },
  packet_spoofer:   { name: "Packet Spoofer",       type: "weapon", rarity: "uncommon",  price: 200,      value: 10 },
  plasma_cannon:    { name: "플라즈마 캐논",         type: "weapon", rarity: "rare",      price: 900,      value: 20 },
  hf_blade:         { name: "고주파 블레이드",       type: "weapon", rarity: "epic",      price: 4500,     value: 40 },
  emp_missile:      { name: "EMP 유도 미사일",       type: "weapon", rarity: "legendary", price: 200000,   value: 80 },
  stuxnet:          { name: "Stuxnet Variant",      type: "weapon", rarity: "mythic",    price: 2250000,   value: 160 },
  singularity_worm: { name: "Singularity Worm",     type: "weapon", rarity: "secret",    price: 15000000,  value: 320 },
  omega_killswitch: { name: "종말의 킬스위치",       type: "weapon", rarity: "forbidden", price: 120000000, value: 800 },
  abyssal_maw:      { name: "심연의 아가리",         type: "weapon", rarity: "abyssal",   price: 1200000000, value: 4000 },

  basic_av:         { name: "Basic Antivirus",      type: "armor", rarity: "common",    price: 50,       value: 5 },
  packet_filter:    { name: "Packet Filter",        type: "armor", rarity: "uncommon",  price: 200,      value: 10 },
  nano_composite:   { name: "나노 복합 장갑",         type: "armor", rarity: "rare",      price: 900,      value: 20 },
  ngfw:             { name: "Next-Gen Firewall",    type: "armor", rarity: "epic",      price: 4500,     value: 40 },
  phase_shield:     { name: "위상 변조 실드",         type: "armor", rarity: "legendary", price: 200000,   value: 80 },
  adaptive_ai:      { name: "Adaptive AI Shield",   type: "armor", rarity: "mythic",    price: 2250000,   value: 160 },
  black_ice:        { name: "Black ICE",            type: "armor", rarity: "secret",    price: 15000000,  value: 320 },
  absolute_zero:    { name: "절대영도 방벽",          type: "armor", rarity: "forbidden", price: 120000000, value: 800 },
  eventhorizon_ward: { name: "사건의 지평선 방벽",    type: "armor", rarity: "abyssal",   price: 1200000000, value: 4000 },

  overclock_chip:     { name: "오버클럭 칩셋",       type: "core", rarity: "common",    price: 150,      value: 2 },
  tactical_matrix:    { name: "AI 전술 매트릭스",    type: "core", rarity: "uncommon",  price: 600,      value: 4 },
  quantum_core:       { name: "양자 연산 장치",      type: "core", rarity: "rare",      price: 2700,     value: 8 },
  neural_accelerator: { name: "뉴럴 가속기",         type: "core", rarity: "epic",      price: 13500,    value: 16 },
  singularity_core:   { name: "특이점 코어",         type: "core", rarity: "legendary", price: 600000,   value: 32 },
  dimensional_proc:   { name: "차원 연산 프로세서",   type: "core", rarity: "mythic",    price: 6750000,   value: 64 },
  observers_eye:      { name: "관측자의 눈",         type: "core", rarity: "secret",    price: 45000000,  value: 128 },
  algorithm_of_god:   { name: "신의 알고리즘",       type: "core", rarity: "forbidden", price: 360000000, value: 320 },
  voidheart_core:     { name: "보이드하트 코어",     type: "core", rarity: "abyssal",   price: 3600000000, value: 1600 },

  nanobot_kit:      { name: "나노봇 응급키트",         type: "consumable", rarity: "common",    price: 100,  effect: "heal_flat", value: 30 },
  energy_drink:     { name: "에너지 드링크",           type: "consumable", rarity: "common",    price: 150,  effect: "energy", value: 20 },
  vaccine:          { name: "급속 치료 백신",           type: "consumable", rarity: "uncommon",  price: 300,  effect: "heal_flat", value: 90 },
  ddos:             { name: "DDoS Booster",           type: "consumable", rarity: "uncommon",  price: 800,  effect: "stamina", value: 3 },
  mega_energy_cell: { name: "메가 에너지 셀",           type: "consumable", rarity: "rare",      price: 500,  effect: "energy", value: 100 },
  adrenaline_shot:  { name: "아드레날린 샷",            type: "consumable", rarity: "rare",      price: 400,  effect: "stamina", value: 5 },
  stealth_cloak:    { name: "스텔스 클로크",            type: "consumable", rarity: "epic",      price: 1200, effect: "self_shield", value: 3600000 },
  nano_cloud:       { name: "메가 회복 나노클라우드",     type: "consumable", rarity: "legendary", price: 3000, effect: "heal_and_energy", value: 150, value2: 80 },
  dimension_veil:   { name: "차원 은신 프로토콜",        type: "consumable", rarity: "mythic",    price: 8000, effect: "self_shield", value: 21600000 },
};

// ── 상자(Box) — 상점에 "가끔" 뜨는 특수 아이템(요청 반영). 등급별로 셋 중 하나가 나온다:
// 자기 등급 75% / 한 단계 위 20% / 두 단계 위 5%. 두 단계 위 등급까지 존재해야 하므로
// secret(다음 forbidden, 다다음 abyssal)까지만 만든다 — forbidden/abyssal 상자는 그 위
// 등급이 모자라 같은 확률표를 못 쓴다. 상자 자체는 상점 로테이션에서 그 등급 아이템과
// 똑같은 확률로 뜨므로("가끔"), 등급이 높을수록 자연히 더 드물게 보인다.
// 가격은 세 결과의 기대값에 30% 프리미엄을 얹어 자동 계산한다 — 무기 가격을 그 등급의
// 대표가로 쓴다(무기/방어는 동일가, 코어만 3배 비싸서 대표값에서 제외).
const BOX_ODDS = [0.75, 0.20, 0.05];
const BOX_RARITIES = ["uncommon", "rare", "epic", "legendary", "mythic", "secret"];
function rarityWeaponPrice(rarity) {
  const found = Object.values(SHOP_ITEMS).find(function (it) { return it.type === "weapon" && it.rarity === rarity; });
  return found ? found.price : 0;
}
const BOX_ITEMS = {};
BOX_RARITIES.forEach(function (rarity) {
  const idx = RARITY_ORDER.indexOf(rarity);
  const ev = BOX_ODDS[0] * rarityWeaponPrice(RARITY_ORDER[idx]) + BOX_ODDS[1] * rarityWeaponPrice(RARITY_ORDER[idx + 1]) + BOX_ODDS[2] * rarityWeaponPrice(RARITY_ORDER[idx + 2]);
  const price = Math.max(50, Math.round(ev * 1.3 / 10) * 10);
  BOX_ITEMS["box_" + rarity] = {
    name: RARITY_META[rarity].label + " 상자", type: "box", rarity: rarity, price: price,
    boxTiers: [rarity, RARITY_ORDER[idx + 1], RARITY_ORDER[idx + 2]],
  };
});
Object.assign(SHOP_ITEMS, BOX_ITEMS);
// 상자를 열었을 때 실제로 무엇을 주는지 결정 — boxTiers([자기,다음,다다음])에서 BOX_ODDS
// 가중치로 등급 하나를 뽑고, 그 등급의 weapon/armor/core 중 하나를 균등하게 고른다.
function openBoxRoll(box) {
  const roll = Math.random();
  const tierRarity = roll < BOX_ODDS[0] ? box.boxTiers[0] : roll < BOX_ODDS[0] + BOX_ODDS[1] ? box.boxTiers[1] : box.boxTiers[2];
  const candidates = Object.keys(SHOP_ITEMS).filter(function (id) {
    const it = SHOP_ITEMS[id];
    return it.rarity === tierRarity && (it.type === "weapon" || it.type === "armor" || it.type === "core");
  });
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// 예전엔 공격당하면 자동으로 12시간 보호막이 붙어서 그 사람이 전체 유저의 타겟 목록에서
// 아예 사라졌는데, 폐지했다 — 대신 "같은 상대를 한 주기 안에 몇 번까지 노릴 수 있는지"만
// 공격자별로 제한한다(아래 PVP_MAX_ATTACKS_PER_TARGET_PER_RESET). 소비재로 사는 자가 보호막
// (stealth_cloak 등, shield_until 컬럼)은 이것과 별개로 그대로 유효하다.
// 처음엔 "최근 24시간" 롤링 윈도우였고, 8시간으로 줄여달라는 요청을 받아 상점 로테이션 같은
// "고정 시계 경계" 버킷 방식으로 바꿨었는데, 그 방식은 실제로 악용 가능한 구멍이었다 — 경계
// (예: 매일 17시) 직전에 5번 몰아 때리고 경계가 지나자마자 또 5번을 몰아 때리면, 실제로는
// 같은 사람을 1~2시간 안에 5번을 훌쩍 넘겨(최악의 경우 10번까지도) 때릴 수 있었다. 그래서
// "지금부터 8시간 전"까지를 보는 롤링 윈도우로 되돌렸다 — 시계 경계와 무관하게 진짜로 최근
// 8시간 동안 몇 번 맞았는지만 정확히 세므로 이 구멍이 없다.
const PVP_MAX_ATTACKS_PER_TARGET_PER_RESET = 5;
const ATTACK_LIMIT_RESET_MS = 8 * 60 * 60 * 1000;
// 공격(PvP 직접/행성/원정) 직후 30초 동안은 다음 공격을 아예 못 한다 — 대상이 누구든, 어떤
// 종류의 공격이든 상관없이 "내가 마지막으로 공격한 시각"만 본다. 연속 클릭/매크로로 몰아
// 때리는 것 자체를 막는 전역 쿨다운이라, 위 8시간/5회 한도(같은 상대 한정)와는 별개다.
const ATTACK_COOLDOWN_MS = 30 * 1000;
function attackCooldownRemainingMs(row) {
  return row.last_attack_at ? Math.max(0, attackCooldownMsFor(row) - (Date.now() - row.last_attack_at)) : 0;
}
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
const SCAN_STAMINA_COST = 1; // 정찰도 이제 공짜가 아니다
// 레벨 차이가 아무리 커도 공격 자체는 항상 가능하다(더 이상 막지 않음) — 대신 차이가 클수록
// 스태미나가 훨씬 더 든다. ±10까지는 기본 비용 그대로, 그 이후부터 구간마다 배로 뛴다.
// 위/아래 방향 상관없이(내가 높든 낮든) 똑같이 적용된다.
function levelGapStaminaSurcharge(attackerLevel, defenderLevel) {
  const gap = Math.abs(attackerLevel - defenderLevel);
  if (gap <= 10) return 0;
  if (gap <= 20) return 4;
  if (gap <= 30) return 8;
  return 16;
}
function computeAttackStaminaCost(attackerLevel, defenderLevel, online) {
  const base = online ? PVP_STAMINA_COST_ONLINE : PVP_STAMINA_COST_OFFLINE;
  return Math.max(base, levelGapStaminaSurcharge(attackerLevel, defenderLevel));
}
const ONLINE_THRESHOLD_MS = 150 * 1000;
const BANK_DEPOSIT_TAX_RATE = 0.10;
// Jobs/Galaxy Map/Property 코인 소득이 x15 뛴 뒤에도 이 환전 시세는 그대로 10,000이라 다이아가
// 상대적으로 15배 싸져 있었다(연구 비용이 너무 싸다는 문제의 실제 원인). 소득과 같은 배율로
// 올려서 "다이아=특수 재화"라는 상대적 희소성을 예전 수준으로 되돌렸다.
const DIAMOND_EXCHANGE_COIN_COST = 150000; // 코인 150,000개 -> 다이아 1개(단방향, 코인 싱크)
const SHOP_REROLL_DIAMOND_COST = 1; // 다이아 1개로 자연 타이머 안 기다리고 내 상점 즉시 리롤

// ── Trade — 유저 간 코인+아이템 동시 거래. "고인물이 초보를 코인으로 그냥 키워주는" 것을
//    막기 위해, 한 번에 오가는 코인은 두 사람 중 레벨이 더 낮은 쪽 자산의 1/3을 넘을 수 없다.
//    "지금까지 얻은 코인의 총합"을 정확히 추적하려면 코인이 늘어나는 모든 지점(작업/PvP/행성/
//    Property 등)을 다 건드려야 해서 위험이 크므로, 대신 "현재 총자산(포켓+뱅크)"으로 대체했다
//    — 실제 누적 수익보다 항상 작거나 같은 값이라(다 쓰고 나면 줄어드니) 오히려 더 보수적인
//    상한이 된다. ──
const TRADE_COIN_CAP_DIVISOR = 3;
const TRADE_MAX_PENDING_OUTGOING = 10;
function tradeCoinCap(row) { return Math.floor((row.pocket_coins + row.bank_coins) / TRADE_COIN_CAP_DIVISOR); }
function validateTradeCoinAmounts(fromRow, toRow, offerCoins, requestCoins) {
  const lowerRow = fromRow.level <= toRow.level ? fromRow : toRow;
  const cap = tradeCoinCap(lowerRow);
  if (offerCoins > cap) return "제안한 코인이 너무 많습니다 — 레벨이 더 낮은 쪽 자산의 1/3(" + fmtNum(cap) + ")을 넘을 수 없습니다.";
  if (requestCoins > cap) return "요구한 코인이 너무 많습니다 — 레벨이 더 낮은 쪽 자산의 1/3(" + fmtNum(cap) + ")을 넘을 수 없습니다.";
  return null;
}
function parseTradeItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(function (it) { return { itemId: String(it && it.itemId || ""), qty: parseInt(it && it.qty, 10) }; })
    .filter(function (it) { return SHOP_ITEMS[it.itemId] && Number.isInteger(it.qty) && it.qty > 0; });
}
async function checkItemAvailability(env, userId, items) {
  const equippedCount = await equippedCountMap(env, userId);
  for (const it of items) {
    const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(userId, it.itemId).first();
    const available = (owned ? owned.qty : 0) - (equippedCount[it.itemId] || 0);
    if (available < it.qty) return SHOP_ITEMS[it.itemId].name + "이(가) 부족합니다(장착 중인 건 제외하고 " + available + "개 보유).";
  }
  return null;
}
async function transferTradeItems(env, fromUserId, toUserId, items) {
  const ops = [];
  for (const it of items) {
    ops.push(env.DB.prepare("UPDATE arena_inventory SET qty = qty - ? WHERE user_id=? AND item_id=?").bind(it.qty, fromUserId, it.itemId));
    ops.push(env.DB.prepare(
      "INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + ?"
    ).bind(toUserId, it.itemId, it.qty, it.qty));
  }
  if (ops.length) await env.DB.batch(ops);
  await env.DB.prepare("DELETE FROM arena_inventory WHERE qty <= 0").run();
}

// ── Club(길드) ── 이름/설명이 있는 그룹, 대표(leader) 1명 + 멤버들. 클럽끼리 우호/적대
// 관계를 선언할 수 있고, 적대 관계인 두 클럽 소속끼리 PvP(플레이어 간 결투든 남의 홈 행성
// 점령이든)에서 이기면 그 클럽에 전적(war_score)이 쌓인다. ──
const CLUB_CREATE_COST = 5000;
const CLUB_MAX_MEMBERS = 20;
const CLUB_NAME_MAX_LEN = 20;
const CLUB_DESC_MAX_LEN = 200;
const PROFILE_SHOWCASE_MAX = 3;
const PROFILE_STATUS_MAX_LEN = 60;

const CLUB_CHAT_MAX_LEN = 300;
const CLUB_CHAT_HISTORY = 50;
// 기부한 코인 1개당 클럽 XP 1(그대로 클럽 창고에도 쌓임). 레벨업에 필요한 XP는 플레이어
// 레벨식(level*100)과 같은 느낌으로 가되, 여러 멤버가 같이 채우는 값이라 훨씬 크게 잡았다.
const CLUB_XP_PER_LEVEL = 1000;
function clubLevelForXp(xp) {
  let level = 1;
  while (xp >= level * CLUB_XP_PER_LEVEL) { xp -= level * CLUB_XP_PER_LEVEL; level++; }
  return level;
}
function clubNextXpFor(level) { return level * CLUB_XP_PER_LEVEL; }
// { level, xpIntoLevel, xpForLevel } — 표시용으로 "지금 레벨 안에서 얼마나 채웠는지"까지 준다.
function clubXpProgress(xp) {
  let level = 1, remaining = xp;
  while (remaining >= level * CLUB_XP_PER_LEVEL) { remaining -= level * CLUB_XP_PER_LEVEL; level++; }
  return { level: level, xpIntoLevel: remaining, xpForLevel: level * CLUB_XP_PER_LEVEL };
}
// 클럽 레벨 보너스 — 해킹 작업/PvP 약탈 보상에만 적용(모든 코인 획득 지점에 다 걸면 손댈 곳이
// 너무 많아 위험이 커짐). 레벨 30에서 +30%로 상한.
const CLUB_BONUS_PER_LEVEL = 0.01;
const CLUB_BONUS_MAX_LEVEL = 30;
async function clubCoinBonusMult(env, userId) {
  const clubId = await clubIdOf(env, userId);
  if (!clubId) return 1;
  const club = await env.DB.prepare("SELECT xp FROM arena_clubs WHERE id = ?").bind(clubId).first();
  if (!club) return 1;
  return 1 + Math.min(clubLevelForXp(club.xp), CLUB_BONUS_MAX_LEVEL) * CLUB_BONUS_PER_LEVEL;
}

// ── 클럽 레이드(Co-op Boss) — 클럽원 전원이 힘을 합쳐 거대 HP를 가진 보스 하나를 같이
// 깎는 협동 콘텐츠. 클럽당 한 번에 하나만 진행되고(arena_club_raids.status='active'),
// 각자 totalCombatStats의 ATK로 데미지를 넣는다(장비/봇/환생 등 기존 전투력 시스템을 그대로
// 재사용 — 새 전투 스탯 체계를 안 만들어도 됨). 보스가 죽으면 기여 데미지 비율대로 코인·EXP를
// 나눠 받고, 클럽 자체에도 소량의 클럽 경험치가 들어간다. "작고 상한 있게" 원칙과 달리 이건
// 협동 콘텐츠 특성상 상한을 안 두는 대신, 클럽당 재도전 대기시간(RAID_COOLDOWN_MS)으로
// 무한 반복을 막는다. ──
const RAID_HP_MULT_MIN = 10, RAID_HP_MULT_MAX = 12; // HP = 클럽 전체 ATK 합 * 10~12배(랜덤)
const RAID_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 처치 후 클럽당 20시간 대기
const RAID_STAMINA_COST = 2;
const RAID_ATTACK_POWER_MULT = 10; // 데미지 = ATK * 이 배수 * randMult()
const RAID_COIN_PER_HP = 3; // 총 보상 코인 풀 = maxHp * 이 값, 기여 데미지 비율대로 분배 — HP가
// 클럽 전체 ATK에 비례하므로 보상도 자연히 그 클럽의 실제 전투력 수준에 맞춰 스케일된다.
const RAID_XP_PCT_AT_FULL_CONTRIBUTION = 0.30; // 기여도 100%(=혼자 다 깼음) 기준 nextExpFor의 30%
const RAID_CLUB_XP_PER_HP = 0.01; // 처치 시 클럽 경험치 = maxHp * 이 값
const RAID_BOSS_NAMES = ["제로데이 리바이어던", "블랙아이스 콜로서스", "고스트 프로토콜 AI", "옵시디언 방화벽 수호자", "심연의 루트킷"];

// 보스 HP = 지금 이 클럽 멤버 전원의 ATK(totalCombatStats, 장비·봇·환생 다 반영)를 합산한 값의
// 10~12배(요청 반영, 매번 랜덤) — 클럽이 강해질수록 보스도 그만큼 세져서 "다 같이 몇 대씩만
// 때리면 끝나는" 허무함 없이 항상 여러 명이 힘을 합쳐야 하는 수준을 유지한다.
async function clubTotalAtk(env, clubId) {
  const membersRes = await env.DB.prepare("SELECT user_id FROM arena_club_members WHERE club_id = ?").bind(clubId).all();
  let total = 0;
  for (const m of membersRes.results) {
    const memberRow = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(m.user_id).first();
    if (!memberRow) continue;
    const combat = await totalCombatStats(env, memberRow);
    total += combat.atk;
  }
  return total;
}
function raidMaxHpFor(totalAtk) {
  const mult = RAID_HP_MULT_MIN + Math.random() * (RAID_HP_MULT_MAX - RAID_HP_MULT_MIN);
  return Math.max(1000, Math.round(totalAtk * mult));
}

// 보스 처치 시점에 호출 — 참여자별 기여 데미지 비율대로 코인 풀을 나누고, 각자 자기 레벨
// 기준 XP도 지분만큼 받는다(레벨이 제각각이라도 공평하게 "내 다음 레벨의 몇 %"로 계산).
async function settleRaid(env, raidId, clubId, maxHp) {
  const damageRes = await env.DB.prepare("SELECT user_id, user_name, damage, hits FROM arena_club_raid_damage WHERE raid_id = ?").bind(raidId).all();
  const participants = damageRes.results;
  const totalDamage = participants.reduce(function (sum, p) { return sum + p.damage; }, 0) || 1;
  const eventMult = globalEventMult(); // 전역 이벤트(코인·EXP 2배) 기간이면 레이드 보상도 함께 2배
  const coinPool = Math.round(maxHp * RAID_COIN_PER_HP * eventMult);
  const writes = [];
  const summary = [];
  for (const p of participants) {
    const share = p.damage / totalDamage;
    const coinShare = Math.round(coinPool * share);
    const row = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(p.user_id).first();
    if (!row) continue;
    row.pocket_coins += coinShare;
    const xpGain = Math.round(xpPct(row, RAID_XP_PCT_AT_FULL_CONTRIBUTION * share) * eventMult);
    const leveledUp = applyXpAndLevel(row, xpGain);
    writes.push(env.DB.prepare(
      "UPDATE arena_users SET pocket_coins=?, xp=?, level=?, stat_points=?, hp=?, energy=?, stamina=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
    ).bind(row.pocket_coins, row.xp, row.level, row.stat_points, row.hp, row.energy, row.stamina, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id));
    summary.push({ userId: p.user_id, userName: p.user_name, damage: p.damage, sharePct: Math.round(share * 1000) / 10, coinReward: coinShare, xpGained: xpGain, leveledUp: leveledUp });
  }
  const clubXpGain = Math.round(maxHp * RAID_CLUB_XP_PER_HP);
  writes.push(env.DB.prepare("UPDATE arena_clubs SET xp = xp + ? WHERE id = ?").bind(clubXpGain, clubId));
  await env.DB.batch(writes);
  summary.sort(function (a, b) { return b.damage - a.damage; });
  return { participants: summary, coinPool: coinPool, clubXpGained: clubXpGain };
}

// ── 클럽 전쟁 시즌 — 기존 war_score(전체 누적)와 별개로 "이번 시즌 점수"만 따로 쌓는다.
// 시즌 경계는 상점 로테이션과 같은 방식으로 시간을 나눈 결정론적 버킷이라 크론이 필요 없다
// — 지금이 몇 번째 시즌인지는 그냥 Date.now()로 계산하면 되고, "방금 끝난 시즌"의 순위/보상은
// 그 버킷 번호로 그때 쌓인 점수를 그대로 다시 읽으면 된다(더 이상 그 버킷에 쓰기가 없으므로
// 안전하게 고정된 결과). recordWarScoreIfHostile이 전체 누적과 이번 시즌 점수를 동시에 올린다. ──
const CLUB_WAR_SEASON_MS = 7 * 24 * 3600 * 1000; // 7일
function clubWarSeasonBucket(nowMs) { return Math.floor((nowMs || Date.now()) / CLUB_WAR_SEASON_MS); }
// 순위별 보상(코인, 멤버 1인당) — 시즌 종료 후 그 클럽 소속이면 누구나 한 번씩 받는다.
const CLUB_WAR_REWARD_TIERS = [
  { minRank: 1, maxRank: 1, coins: 50000 },
  { minRank: 2, maxRank: 3, coins: 25000 },
  { minRank: 4, maxRank: 10, coins: 10000 },
];
function clubWarRewardForRank(rank) {
  const tier = CLUB_WAR_REWARD_TIERS.find(function (t) { return rank >= t.minRank && rank <= t.maxRank; });
  return tier ? tier.coins : 0;
}
// 특정 시즌 버킷의 순위표(점수 내림차순, 0점인 클럽은 제외) — 방금 끝난 시즌의 보상 계산과
// 진행 중인 시즌의 실시간 순위 표시에 둘 다 쓴다.
async function clubWarStandings(env, seasonBucket, limit) {
  const res = await env.DB.prepare(
    "SELECT s.club_id, s.score, c.name FROM arena_club_war_seasons s JOIN arena_clubs c ON c.id = s.club_id " +
    "WHERE s.season_bucket = ? AND s.score > 0 ORDER BY s.score DESC LIMIT ?"
  ).bind(seasonBucket, limit || 50).all();
  return res.results;
}

// ── 환생 직후 30분 부스트 — 경험치/코인 2배. "다시 약해진 채로 처음부터"인 기간을 좀 편하게
// 넘어가라는 취지라, 실제로 그 창 안에서 직접 플레이해서 버는 소득(해킹 작업 XP/코인, PvP
// 약탈, 행성 약탈)에만 건다 — Property처럼 켜 놓고 안 해도 쌓이는 소득까지 2배로 치면 "환생
// 직후에 몰아서 수거만" 하는 식으로 새는 구멍이 생기므로 일부러 뺐다. ──
const REBIRTH_BOOST_MS = 30 * 60 * 1000;
const REBIRTH_BOOST_MULT = 2;
function rebirthBoostMult(row) {
  return (row.rebirth_boost_until && Date.now() < row.rebirth_boost_until) ? REBIRTH_BOOST_MULT : 1;
}

// ── 출석 + 오늘의 미션 3종을 전부(수령까지) 끝내면 20분간 코인/XP 2배 — 환생 부스트와 같은
// 컬럼 패턴(만료 시각 하나만 저장)이고, 적용 범위도 똑같이 "직접 플레이해서 버는 소득"으로
// 한정한다(Property 제외 이유도 동일 — 몰아서 수거만 하는 구멍 방지). 두 부스트가 우연히
// 겹치면(환생 직후 30분 안에 일일 완료) 곱해져서 최대 4배까지 갈 수 있는데, 둘 다 그 시점에
// 실제로 노력해서 얻은 조건이라 일부러 막지 않았다(클럽 보너스도 이미 곱연산으로 쌓이는 것과
// 같은 방식). 활성 여부/남은 시간 확인은 rebirthBoostMult와 완전히 대칭이다. ──
const DAILY_BOOST_MS = 20 * 60 * 1000;
const DAILY_BOOST_MULT = 2;
function dailyBoostMult(row) {
  return (row.daily_boost_until && Date.now() < row.daily_boost_until) ? DAILY_BOOST_MULT : 1;
}
// ── 전역 이벤트: 코인·EXP 2배(48시간) — 특정 유저 상태가 아니라 "지금이 이벤트 기간
// 안인지"만 보는 서버 전역 값이라 DB 컬럼이 필요 없다. 주의: Date.now() + N을 모듈 상단
// 에서 계산해 쓰면 Cloudflare Workers 아이솔레이트가 콜드스타트될 때마다 "지금부터 N"이
// 다시 계산되어 이벤트가 사실상 영원히 안 끝나는 버그가 생긴다 — 그래서 반드시 배포
// 시점에 고정한 절대 타임스탬프 리터럴을 쓴다(요청: "지금부터 2일간 코인 exp 2배 이벤트",
// 2026-09-11 시작 기준 +48시간).
const GLOBAL_EVENT_COIN_XP_2X_END_AT = 1789300800000; // 2026-09-13T12:00:00.000Z
const GLOBAL_EVENT_COIN_XP_2X_MULT = 2;
function globalEventMult() { return Date.now() < GLOBAL_EVENT_COIN_XP_2X_END_AT ? GLOBAL_EVENT_COIN_XP_2X_MULT : 1; }

// 환생 부스트 + 일일 완료 부스트 + 전역 이벤트를 곱해서 쓰는 곳(해킹 작업/PvP 약탈/행성
// 약탈과 그에 따른 XP)에서 공통으로 쓰는 합산 배율.
function activityBoostMult(row) {
  return rebirthBoostMult(row) * dailyBoostMult(row) * globalEventMult();
}

// ── 특수 연구: 환생 가속 연구 — 환생을 최소 1번은 해본 유저만 연구할 수 있다("리버스를 해야만
// 연구 가능한 특수 연구" 요청 반영). 레벨당 환생 직후 부스트 창(REBIRTH_BOOST_MS)을 5분씩
// 늘려준다 — 그 창 안에서 직접 버는 소득만 2배가 되는 기존 룰은 그대로고, 그냥 그 기간이
// 길어질 뿐이라 사기성 없이(작고 상한 있게) 환생을 더 자주 하는 유저에게 자연스러운 보상이 된다.
// 이 연구는 Research 탭에서 "영구 EXP 부스터" 연구로 대체되어(아래 EXP_BOOSTER_* 참고)
// 더 이상 새로 레벨을 올릴 수 없다(업그레이드 엔드포인트 자체를 없앴다) — 하지만 이미
// research_rebirth_level을 올려둔 유저의 투자는 그대로 존중한다: 이 상수/함수들은 남겨두고
// POST /rebirth에서 여전히 읽어서 환생 직후 부스트 창 길이를 계산한다(그때 그 값 그대로 고정).
const RESEARCH_REBIRTH_MAX_LEVEL = 10;
const RESEARCH_REBIRTH_BOOST_MS_PER_LEVEL = 5 * 60 * 1000; // 레벨당 +5분, 최대 +50분(총 80분)
function rebirthBoostTotalMs(level) { return REBIRTH_BOOST_MS + Math.min(level || 0, RESEARCH_REBIRTH_MAX_LEVEL) * RESEARCH_REBIRTH_BOOST_MS_PER_LEVEL; }

// ── 영구 EXP 부스터 연구 — "환생 가속 연구" 슬롯을 대체(요청 반영). 환생과 무관하게 처음부터
// 연구 가능하고, 딱 3단계뿐이라 지수 성장식 대신 고정 비용표를 쓴다. 레벨 1/2/3 = 모든 경험치
// 획득에 영구 x1.2/x1.5/x2 — 활동 부스트(환생 직후/일일완료 2배, 시간제한 있음)와는 곱연산으로
// 함께 적용된다(xpPct를 쓰는 모든 호출부에서 두 배율을 다 곱함).
const EXP_BOOSTER_MAX_LEVEL = 3;
const EXP_BOOSTER_COSTS = [500, 750, 1000]; // 인덱스 = 현재 레벨(0→1, 1→2, 2→3 비용)
const EXP_BOOSTER_MULTS = [1, 1.2, 1.5, 2]; // 인덱스 = 레벨(0 = 아직 연구 안 함)
function expBoosterMult(row) { return EXP_BOOSTER_MULTS[Math.min(row.research_exp_booster_level || 0, EXP_BOOSTER_MAX_LEVEL)]; }
function expBoosterUpgradeCost(level) { return level >= EXP_BOOSTER_MAX_LEVEL ? null : EXP_BOOSTER_COSTS[level]; }

// KST(UTC+9) 기준 날짜 문자열 — 일일 출석/퀘스트 리셋 경계로 쓴다(PJH-Hub board-worker.js의
// kstDateString과 동일한 방식).
function kstDateString(ts) { return new Date((ts || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10); }

const ATTENDANCE_BASE_REWARD = 200;
const ATTENDANCE_STREAK_BONUS = 50; // 연속 출석 1일당 추가 코인(상한 있음)
const ATTENDANCE_STREAK_BONUS_CAP_DAYS = 10;
// 오늘의 미션 3종 — 목표치를 채우면 "받기"로 수동 수령(자동 지급 아님, 성취감용).
const DAILY_QUESTS = {
  battles:   { label: "전투 3회 (PvP 또는 행성)", goal: 3, reward: 300 },
  jobs:      { label: "해킹 작업 3회",             goal: 3, reward: 250 },
  purchases: { label: "상점에서 구매 1회",          goal: 1, reward: 200 },
};

// ══════════════════════════════════════════════════════════
//  현상금 게시판(Bounty Board) — 오늘의 미션(3종 고정)보다 훨씬 다채로운 목표가 8시간마다
//  통째로 새로 뽑혀서 5개씩 뜬다. 진행도는 새 카운터 테이블 없이 이미 있는 arena_logs를
//  그대로 세서 계산한다(모든 카운트 대상 행동이 insertLog로 이미 기록되고 있으므로) —
//  "청구했는지"만 별도 테이블(arena_bounty_claims)에 남긴다. 유저마다 다른 5개가 뜨도록
//  (userId + 게시판 회차)를 섞어 시드로 쓴다(상점 로테이션과 같은 발상).
// ══════════════════════════════════════════════════════════
const BOUNTY_PERIOD_MS = 8 * 60 * 60 * 1000; // 하루 3번 갱신
const BOUNTY_BOARD_SIZE = 5;
// counterKey는 GET /bounties에서 arena_logs 한 번 조회로 만드는 counts 객체의 키와 맞춘다.
const BOUNTY_TEMPLATES = [
  { id: "b_job_3",        label: "해킹 작업 3회 완료",        counterKey: "job",           goal: 3, coin: 900,   xpPct: 0.03 },
  { id: "b_job_6",        label: "해킹 작업 6회 완료",        counterKey: "job",           goal: 6, coin: 2200,  xpPct: 0.06 },
  { id: "b_job_10",       label: "해킹 작업 10회 완료",       counterKey: "job",           goal: 10, coin: 4000, xpPct: 0.10 },
  { id: "b_pvp_2",        label: "PvP 침투 성공 2회",         counterKey: "pvp_win",       goal: 2, coin: 1800,  xpPct: 0.06 },
  { id: "b_pvp_4",        label: "PvP 침투 성공 4회",         counterKey: "pvp_win",       goal: 4, coin: 4200,  xpPct: 0.12 },
  { id: "b_planet_2",     label: "행성 공격 성공 2회",         counterKey: "planet_win",    goal: 2, coin: 1800,  xpPct: 0.06 },
  { id: "b_planet_3",     label: "행성 공격 성공 3회",         counterKey: "planet_win",    goal: 3, coin: 3200,  xpPct: 0.10 },
  { id: "b_expedition_3", label: "원정 성공 3회",             counterKey: "expedition_win", goal: 3, coin: 1500,  xpPct: 0.05 },
  { id: "b_expedition_6", label: "원정 성공 6회",             counterKey: "expedition_win", goal: 6, coin: 3000,  xpPct: 0.09 },
  { id: "b_trade_1",      label: "거래 완료 1회",             counterKey: "trade",         goal: 1, coin: 700,   xpPct: 0.02 },
];
function bountyBoardFor(userId, bucket) {
  const rng = mulberry32(hashStr(userId + ":bounty:" + bucket) >>> 0);
  const pool = BOUNTY_TEMPLATES.slice();
  for (let i = pool.length - 1; i > 0; i--) { // Fisher-Yates
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, BOUNTY_BOARD_SIZE);
}
async function bountyProgressCounts(env, userId, bucketStart) {
  const res = await env.DB.prepare(
    "SELECT kind, result FROM arena_logs WHERE user_id = ? AND created_at >= ? AND kind IN ('job','pvp_attack','planet_attack','planet_expedition','trade')"
  ).bind(userId, bucketStart).all();
  const counts = { job: 0, pvp_win: 0, planet_win: 0, expedition_win: 0, trade: 0 };
  res.results.forEach(function (r) {
    if (r.kind === "job") counts.job++;
    else if (r.kind === "pvp_attack" && (r.result === "win" || r.result === "crit")) counts.pvp_win++;
    else if (r.kind === "planet_attack" && r.result === "win") counts.planet_win++;
    else if (r.kind === "planet_expedition" && r.result === "win") counts.expedition_win++;
    else if (r.kind === "trade") counts.trade++;
  });
  return counts;
}

async function clubIdOf(env, userId) {
  const row = await env.DB.prepare("SELECT club_id FROM arena_club_members WHERE user_id = ?").bind(userId).first();
  return row ? row.club_id : null;
}
// 두 클럽 사이의 "실제" 관계 — 한쪽이라도 상대를 hostile로 선언했으면 전쟁(hostile), 서로가
// 서로를 friendly로 선언해야만 동맹(allied), 그 외엔 neutral. 짝사랑 우호는 동맹이 아니다.
async function effectiveClubRelation(env, clubA, clubB) {
  if (!clubA || !clubB || clubA === clubB) return "neutral";
  const res = await env.DB.prepare(
    "SELECT * FROM arena_club_relations WHERE (from_club_id=? AND to_club_id=?) OR (from_club_id=? AND to_club_id=?)"
  ).bind(clubA, clubB, clubB, clubA).all();
  let aToB = "neutral", bToA = "neutral";
  res.results.forEach(function (r) { if (r.from_club_id === clubA) aToB = r.status; else bToA = r.status; });
  if (aToB === "hostile" || bToA === "hostile") return "hostile";
  if (aToB === "friendly" && bToA === "friendly") return "allied";
  return "neutral";
}
async function recordWarScoreIfHostile(env, attackerUserId, defenderUserId) {
  const clubA = await clubIdOf(env, attackerUserId);
  if (!clubA) return;
  const clubB = await clubIdOf(env, defenderUserId);
  if (!clubB || clubA === clubB) return;
  const relation = await effectiveClubRelation(env, clubA, clubB);
  if (relation === "hostile") {
    const seasonBucket = clubWarSeasonBucket(Date.now());
    await env.DB.batch([
      env.DB.prepare("UPDATE arena_clubs SET war_score = war_score + 1 WHERE id = ?").bind(clubA),
      env.DB.prepare(
        "INSERT INTO arena_club_war_seasons (club_id, season_bucket, score) VALUES (?, ?, 1) " +
        "ON CONFLICT(club_id, season_bucket) DO UPDATE SET score = score + 1"
      ).bind(clubA, seasonBucket),
    ]);
  }
}
const RESEARCH_EXPEDITION_UNLOCK_COST = 300; // 원정(오프라인 자동 전투) 연구 — 다이아로 1회 해금(x15)
const STARTING_ENERGY = BASE_MAX_ENERGY;

// 경비병 시스템이 생기면서 봇 하나가 "내 전투력용"과 "행성 방어용"을 놓고 경합하게 됐다 —
// 결국 봇 10기를 다 채워야 둘 다 어느 정도 감당이 되는데, 예전 곡선(2000 * 2.5^n)은 10기를
// 다 채우는 데 총 ~1,270만 코인이 들어서 너무 느렸다. base를 낮추고(2000→1200) 배율도 낮춰서
// (2.5→2.0) 특히 후반 봇(8~10번째)이 확 싸지도록 했다 — 10기 총합이 약 123만으로(예전의
// 1/10 수준) 줄어든다.
const BOT_BASE_COST = 1200;
const BOT_COST_GROWTH = 2.0;
const BOT_MAX_COUNT = 10;
const BOT_SELL_RATE = 0.5; // 되팔 때는 모집 당시 낸 비용(recruit_cost)의 50%만 환불
function botRecruitCost(currentCount) { return Math.round(BOT_BASE_COST * Math.pow(BOT_COST_GROWTH, currentCount)); }

// ── 봇 가챠 — 봇 칸을 산 뒤(위 recruit) 그 봇의 3슬롯(무장/방어/코어)을 한 번에 랜덤으로 채운다.
//    가격이 100배씩 뛸 때마다 등급 확률표도 확 좋아진다(낮은 가챠는 legendary가 사실상 상한선,
//    제일 비싼 가챠는 common이 아예 안 나오고 legendary 이상이 절반 가까이 나온다). ──
const BOT_GACHA_TIERS = {
  basic:    { label: "Basic",    price: 1000,
    table: { common: 0.70, uncommon: 0.20, rare: 0.05,  epic: 0.04,  legendary: 0.01,  mythic: 0,     secret: 0,     forbidden: 0 } },
  advanced: { label: "Advanced", price: 100000,
    table: { common: 0.20, uncommon: 0.30, rare: 0.25,  epic: 0.15,  legendary: 0.07,  mythic: 0.025, secret: 0.004, forbidden: 0.001 } },
  premium:  { label: "Premium",  price: 10000000,
    table: { common: 0,    uncommon: 0.05, rare: 0.15,  epic: 0.25,  legendary: 0.25,  mythic: 0.18,  secret: 0.08,  forbidden: 0.04 } },
};
// 타입x등급 조합마다 SHOP_ITEMS에 정확히 하나씩 있으므로(3종 x 9등급 = 27개, 단 abyssal은 봇
// 가챠 테이블(BOT_GACHA_TIERS)엔 아예 없어서 가챠로는 절대 안 나옴), 롤한 등급이
// 정해지면 아이템도 하나로 정해진다.
const EQUIP_ITEM_BY_TYPE_RARITY = {};
for (const _id in SHOP_ITEMS) {
  const _it = SHOP_ITEMS[_id];
  if (_it.type === "weapon" || _it.type === "armor" || _it.type === "core") {
    (EQUIP_ITEM_BY_TYPE_RARITY[_it.type] = EQUIP_ITEM_BY_TYPE_RARITY[_it.type] || {})[_it.rarity] = _id;
  }
}
function rollGachaRarity(table) {
  const r = Math.random();
  let cum = 0;
  for (const rarity of RARITY_ORDER) {
    cum += table[rarity] || 0;
    if (r < cum) return rarity;
  }
  return RARITY_ORDER[RARITY_ORDER.length - 1]; // 부동소수점 오차로 못 걸렸을 때의 안전망
}
function rollBotGacha(tierKey) {
  const tier = BOT_GACHA_TIERS[tierKey];
  const slots = ["weapon", "armor", "core"];
  const result = {};
  let bestIdx = -1;
  for (const slot of slots) {
    const rarity = rollGachaRarity(tier.table);
    result[slot] = EQUIP_ITEM_BY_TYPE_RARITY[slot][rarity];
    const idx = RARITY_ORDER.indexOf(rarity);
    if (idx > bestIdx) bestIdx = idx;
  }
  result.bestRarity = RARITY_ORDER[bestIdx];
  return result;
}

const PROPERTY_MAX_ACCRUAL_MS = 24 * 60 * 60 * 1000;
const PROPERTY_MAX_DEVICES = 6;
const PROPERTY_SELL_RATE = 0.5; // 되팔 때는 구매가의 50%만 환불(무한 사고팔기로 코인 복사 방지)
// coinsPerHour = 가격의 1/6(요청 반영, 기존 1/4에서 하향) — 대신 그만큼 종류를 늘리고 훨씬
// 고렙까지 이어지는 상위 기기 6종을 새로 얹었다("개당 효율은 낮추는 대신 선택지와 상한을
// 넓힌다"는 방향). PROPERTY_MAX_DEVICES(보유 슬롯 6개)는 그대로라, 17종 중 어떤 6개를
// 채울지 고르는 게 진짜 선택이 된다.
const PROPERTY_DEVICES = {
  proxy_relay:     { name: "Proxy Relay",          price: 200,      coinsPerHour: 33 },
  botnet_node:     { name: "Botnet Node",          price: 500,      coinsPerHour: 83 },
  gpu_rig:         { name: "GPU Mining Rig",       price: 1000,     coinsPerHour: 167 },
  packet_sniffer:  { name: "Packet Sniffer Rig",   price: 1500,     coinsPerHour: 250 },
  darkpool_bot:    { name: "Darkpool Trading Bot",  price: 2800,     coinsPerHour: 467 },
  asic_farm:       { name: "Mining ASIC Farm",     price: 4000,     coinsPerHour: 667 },
  neural_farm:     { name: "Neural Farm Cluster",  price: 7000,     coinsPerHour: 1167 },
  cloud_scraper:   { name: "Cloud Scraper Array",  price: 10000,    coinsPerHour: 1667 },
  fusion_reactor:  { name: "Fusion Reactor Node",  price: 17000,    coinsPerHour: 2833 },
  quantum_miner:   { name: "Quantum Miner",        price: 25000,    coinsPerHour: 4167 },
  dyson_node:      { name: "Dyson Swarm Node",     price: 60000,    coinsPerHour: 10000 },
  singularity_farm:{ name: "Singularity Farm",     price: 150000,   coinsPerHour: 25000 },
  fusion_array:    { name: "Fusion Array",         price: 450000,   coinsPerHour: 75000 },
  dyson_sphere:    { name: "Dyson Sphere",         price: 1350000,  coinsPerHour: 225000 },
  quantum_nexus:   { name: "Quantum Nexus",        price: 4050000,  coinsPerHour: 675000 },
  galactic_forge:  { name: "Galactic Forge",       price: 12000000, coinsPerHour: 2000000 },
  stellar_engine:  { name: "Stellar Engine",       price: 36000000, coinsPerHour: 6000000 },
};

// ── 행성 기반 성간 전쟁(Galaxy Map) ── 각 유저는 공격받지 않는 "홈 행성"(is_home=1)을
// 거점으로 시작한다. 그 외 고정된 개수의 "야생 행성"이 맵에 깔려 있고, 처음엔 전부 PVE 봇이
// 지키고 있다(bot_tier). 유저는 기존 PvP 전투 엔진(태세+타이밍 미니게임, PVP_ROUNDS)을 그대로
// 재사용해 봇이나 다른 유저 소유의 야생 행성을 공격한다 — 이기면 그 행성을 정복(소유권 이전)
// 하고 그동안 쌓인 수익을 약탈한다. 홈 행성도 공격 대상이지만(아래 HOME_PLANET_* 참고 — 레벨
// 20 미만은 무적, 그 이후엔 방어력이 2배로 뻥튀기된 요새) 절대 정복되지 않는다 — 이기면
// 코인 몰수 보상만 받고, 행성 자체와 소유권은 그대로 원래 주인에게 남는다.
const PLANET_COUNT = 48;
// 한 명이 은하 지도를 통째로 독차지하는 문제 — 예전엔 3개 한도가 있었는데, 홈 행성까지 공격
// 대상이 되면서 "정복이 전부 막히는 것처럼 보이는" 혼란으로 이어져 한도를 아예 없앴었다. 그
// 결과 전투력이 압도적인 유저 한 명이 사실상 맵 전체를 집어삼키는 부작용이 생겼다 — 그래서
// "한도를 넘으면 공격 자체를 막는" 방식 대신 "이겨도 정복은 안 되고 그 순간의 약탈(코인)만
// 챙기는" 소프트 캡으로 되살렸다(이 분기 자체는 이미 만들어져 있었다 — POST /planets/attack의
// capCapped 응답 필드, 프런트의 "정복 한도 초과 — 약탈만" 문구. 캡 숫자만 null이었을 뿐).
// 48개 중 1/6(8개)로 잡아서, 아무리 강한 유저라도 맵 대부분은 다른 유저들 몫으로 남는다.
const PLANET_MAX_OWNED_WILD = 8;
const PLANET_ATTACK_STAMINA_COST = 2;
// ── 홈 행성 특수 규칙 ──
// (1) 레벨 20 미만이면 무적 — 막 시작한 유저의 홈 행성이 접속하자마자 털리는 걸 막는다.
// (2) 그 이후엔 공격 가능하지만, 방어력이 실전 전투력의 2배로 뻥튀기된 "최후의 요새"라 뚫기
//     훨씬 어렵다(다른 곳에 쓰는 실제 ATK/DEF는 그대로, 홈 행성 방어 계산에서만 2배).
// (3) 그래도 뚫리면(공격자가 이기면) — 홈 행성은 원래 시세(coins_per_hour)가 항상 0이라 기존
//     "쌓인 수익 약탈" 방식으로는 약탈해도 0원이었다. 대신 포켓 코인의 20%를 그 자리에서
//     몰수한다(뱅크는 그대로 보호 — 기존 "예치하면 안전하다" 컨셉과 일관됨).
// (4) 소유권은 절대 넘어가지 않는다 — 홈 행성은 뺏을 수 없고, 이겨도 위 (3)의 보상만 받는다.
const HOME_PLANET_INVULNERABLE_UNTIL_LEVEL = 20;
const HOME_PLANET_DEFENSE_MULT = 2;
const HOME_PLANET_BREACH_CONFISCATE_RATE = 0.20;
// 예전엔 strong(110/95)이 사실상 최고 난이도였는데, 레벨 30 정도만 돼도 장비+봇 몇 기만으로
// 가볍게 이겨버린다는 피드백을 받아서 그 위로 3단계(정예/악몽/극한)를 더 얹었다. 극한은
// 등장 확률 2%로 아주 드물지만, 뜨면 왕급 장비 없이는 사실상 못 이기는 수준으로 잡았다.
// 악몽/극한이 리롤마다 너무 자주 뜬다는 피드백으로 가중치를 크게 낮췄다 — 48개 행성 기준
// 기대값이 악몽은 회당 ~0.7기(뜨는 리롤 절반 정도), 극한은 ~0.24기(리롤 5번 중 1번꼴)라
// "뜨면 특별한" 수준까지 희소해졌다. 각 리롤은 이전 결과와 완전히 무관한 새 추첨이라(seed가
// 슬롯+시간구간으로만 정해짐) 낮은 확률에 걸리지 않으면 그 즉시 사라지고 다시 안 뜬다.
// coinsPerHour도 Property와 같은 이유로 x15 — 전투력/등장 확률은 그대로.
const PLANET_BOT_TIERS = {
  weak:      { label: "약함", atk: 18,   def: 15,   crit: 5,  coinsPerHour: 225,   weight: 0.40 },
  medium:    { label: "보통", atk: 55,   def: 48,   crit: 10, coinsPerHour: 750,   weight: 0.30 },
  strong:    { label: "강함", atk: 140,  def: 120,  crit: 15, coinsPerHour: 2400,  weight: 0.20 },
  elite:     { label: "정예", atk: 320,  def: 280,  crit: 20, coinsPerHour: 6000,  weight: 0.08 },
  nightmare: { label: "악몽", atk: 750,  def: 650,  crit: 28, coinsPerHour: 15000, weight: 0.015 },
  apex:      { label: "극한", atk: 1800, def: 1600, crit: 35, coinsPerHour: 42000, weight: 0.005 },
};
// ── 경비병(행성 배치 봇) — 완전히 새로운 로스터를 또 만드는 대신, 이미 있는 "봇" 자원을 그대로
// 쓴다. 봇 하나는 항상 둘 중 하나 상태다: "나와 함께"(stationed_planet_id NULL — 지금까지처럼
// 개인 전투력(totalCombatStats)에 합산, PvP/공격/홈 행성 방어에 반영) 또는 "OO 행성에 배치"
// (그 행성 하나의 방어에만 반영되고 개인 전투력에선 빠짐). 새 가챠/새 화폐 없이 "이미 가진
// 봉을 어떻게 나눠 쓸지"를 진짜 트레이드오프로 만든 것 — 방어에 쏟으면 그만큼 내가 약해진다.
// 정복한 야생 행성(홈 아님)은 더 이상 주인의 개인 전투력을 그대로 복제해서 방어하지 않는다
// (그러면 행성을 몇 개 갖든 방어가 공짜로 무한 복제되는 문제가 있었다) — 대신 그 행성에 실제
// 배치된 경비병들의 장비 스탯 합만 방어력이 되고, 아무도 배치 안 했으면 최약체 PVE 등급(weak)
// 수준의 최소 수비대로만 지킨다. 홈 행성은 이미 확정한 "실전 스탯 x2" 고정 공식을 그대로 쓰므로
// 경비병 배치 대상이 아니다(POST /bots/station이 명시적으로 막는다).
const PLANET_GARRISON_MAX_PER_PLANET = 3;
const PLANET_UNGARRISONED_DEFENSE = { atk: PLANET_BOT_TIERS.weak.atk, def: PLANET_BOT_TIERS.weak.def, crit: PLANET_BOT_TIERS.weak.crit };
const PLANET_NAME_PREFIXES = ["Nova", "Zenith", "Vortex", "Cinder", "Helix", "Obsidian", "Quasar", "Drift", "Ember", "Static", "Neon", "Glitch", "Rogue", "Nexus", "Eclipse", "Fracture"];
// 아직 아무도 정복하지 않은 행성은 15분마다 난이도가 통째로 리롤된다(슬롯 번호+시간 구간으로
// 시드하는 결정론적 뽑기라 저장 없이 매번 다시 계산해도 같은 결과가 나온다) — 정복되고 나면
// bot_tier가 NULL이 되면서 리롤 대상에서 완전히 빠진다(그때부턴 주인의 실제 전투력이 곧 난이도).
const PLANET_REROLL_MS = 15 * 60 * 1000;
function planetRerollBucket(nowMs) { return Math.floor((nowMs || Date.now()) / PLANET_REROLL_MS); }
function pickTierFromRng(rng) {
  const r = rng();
  let cum = 0;
  for (const key in PLANET_BOT_TIERS) {
    cum += PLANET_BOT_TIERS[key].weight;
    if (r < cum) return key;
  }
  return "weak"; // 부동소수점 오차 안전망
}
function effectivePlanetTier(slotIndex, nowMs) {
  const bucket = planetRerollBucket(nowMs);
  return pickTierFromRng(mulberry32((slotIndex ^ bucket) | 0));
}
function rollPlanetTier() {
  return pickTierFromRng(Math.random); // 최초 시드용 — 어차피 미정복 상태론 위 effectivePlanetTier로 계속 덮임
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

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ── 연구(Research) — 상점 행운 연구 레벨만큼 rare 이상 등급의 "뜰 확률"에 고정 보너스가
//    붙는다(등급별 상한 1.0). 레벨업 비용은 매번 RESEARCH_SHOP_GROWTH배씩 뛴다. 다이아 환전
//    시세가 x15 오른 것과 같은 배율로 기본 비용도 올렸다(안 그러면 다이아가 비싸진 만큼
//    연구가 상대적으로 더 싸져 버림 — 실제로 그게 "연구가 너무 싸다"는 문제의 원인이었다). ──
const RESEARCH_SHOP_BONUS_PER_LEVEL = 0.02;
const RESEARCH_SHOP_BASE_COST = 150;
const RESEARCH_SHOP_GROWTH = 1.6;
function researchShopUpgradeCost(level) { return Math.round(RESEARCH_SHOP_BASE_COST * Math.pow(RESEARCH_SHOP_GROWTH, level)); }
// abyssal은 다른 등급과 달리 "연구 레벨에 비례해서 서서히 확률이 붙는" 방식이 아니라, 상점 행운
// 연구가 이 레벨(6)에 도달하기 전까진 무조건 0%였다가 도달한 순간부터 고정 1%로 등장한다 —
// 그 이상 연구해도 더 잘 뜨진 않는, "문을 여는" 개념의 게이트다.
const ABYSSAL_RESEARCH_UNLOCK_LEVEL = 6;
const ABYSSAL_CHANCE = 0.01;
function effectiveRarityChance(rarity, researchLevel) {
  if (rarity === "abyssal") return (researchLevel || 0) >= ABYSSAL_RESEARCH_UNLOCK_LEVEL ? ABYSSAL_CHANCE : 0;
  return clamp(RARITY_META[rarity].chance + (researchLevel || 0) * RESEARCH_SHOP_BONUS_PER_LEVEL, 0, 1);
}

// ══════════════════════════════════════════════════════════
//  업적/칭호 — 진행도를 따로 저장하지 않는다(레벨/환생/보유 행성 수 등은 이미 다른 테이블에
//  정확히 남아있으므로, check(ctx)가 그때그때 다시 계산해서 "지금 달성했는지"를 판정한다).
//  DB엔 "누가 언제 뭘 청구(claim)했는지"만 남는다 — 청구하면 코인 보상 + 그 업적의 칭호를
//  장착할 수 있게 된다(칭호 텍스트 자체는 항상 여기서 새로 읽으므로 나중에 이름을 바꿔도
//  이미 장착 중인 유저에게 안 꼬인다).
// ══════════════════════════════════════════════════════════
const ACHIEVEMENTS = {
  level_10:      { name: "견습 해커",     desc: "레벨 10 달성",                    title: "견습 해커",     reward: 3000,   check: function (ctx) { return ctx.row.level >= 10; } },
  level_25:      { name: "숙련 해커",     desc: "레벨 25 달성",                    title: "숙련 해커",     reward: 10000,  check: function (ctx) { return ctx.row.level >= 25; } },
  level_50:      { name: "베테랑 해커",   desc: "레벨 50 달성",                    title: "베테랑 해커",   reward: 30000,  check: function (ctx) { return ctx.row.level >= 50; } },
  level_100:     { name: "전설의 해커",   desc: "레벨 100 달성(환생 조건)",          title: "전설의 해커",   reward: 120000, check: function (ctx) { return ctx.row.level >= 100; } },
  rebirth_1:     { name: "첫 환생",       desc: "환생 1회 달성",                    title: "환생자",       reward: 60000,  check: function (ctx) { return (ctx.row.rebirth_count || 0) >= 1; } },
  rebirth_max:   { name: "윤회의 끝",     desc: "환생 " + REBIRTH_BONUS_MAX_COUNT + "회(최대) 달성", title: "윤회의 지배자", reward: 600000, check: function (ctx) { return (ctx.row.rebirth_count || 0) >= REBIRTH_BONUS_MAX_COUNT; } },
  plunder_10:    { name: "약탈자",       desc: "PvP 약탈 승리 10회",               title: "약탈자",       reward: 6000,   check: function (ctx) { return (ctx.row.plunder_wins || 0) >= 10; } },
  plunder_100:   { name: "정복왕",       desc: "PvP 약탈 승리 100회",              title: "정복왕",       reward: 90000,  check: function (ctx) { return (ctx.row.plunder_wins || 0) >= 100; } },
  bots_full:     { name: "함대 완성",     desc: "봇 " + BOT_MAX_COUNT + "기 모집",   title: "함대 사령관",   reward: 25000,  check: function (ctx) { return ctx.botCount >= BOT_MAX_COUNT; } },
  abyssal_owner: { name: "심연을 본 자",  desc: "Abyssal 등급 장비 보유",            title: "심연을 본 자",  reward: 250000, check: function (ctx) { return ctx.hasAbyssal; } },
  planet_baron:  { name: "은하 남작",     desc: "야생 행성 5개 이상 동시 보유",       title: "은하 남작",     reward: 35000,  check: function (ctx) { return ctx.ownedWildCount >= 5; } },
  planet_emperor:{ name: "은하 황제",     desc: "야생 행성 한도(" + PLANET_MAX_OWNED_WILD + "개) 전부 보유", title: "은하 황제", reward: 150000, check: function (ctx) { return ctx.ownedWildCount >= PLANET_MAX_OWNED_WILD; } },
  club_member:   { name: "동료애",       desc: "클럽 가입",                        title: "클럽원",       reward: 3000,   check: function (ctx) { return !!ctx.clubId; } },
  club_leader:   { name: "리더십",       desc: "클럽 대표(리더) 취임",              title: "클럽 리더",     reward: 12000,  check: function (ctx) { return ctx.isClubLeader; } },
  lucky_researcher: { name: "행운의 연구자", desc: "상점 행운 연구 레벨 " + ABYSSAL_RESEARCH_UNLOCK_LEVEL + " 달성(Abyssal 해금)", title: "행운의 연구자", reward: 60000, check: function (ctx) { return (ctx.row.research_shop_level || 0) >= ABYSSAL_RESEARCH_UNLOCK_LEVEL; } },
};

// ── 환생 상점 — 환생석으로만 사는 1회성 소장품. 코인 경제와 무관한 순수 명예/코스메틱
//    보상이라 밸런스 걱정 없이 계속 늘려도 된다. type:"frame"은 보유 즉시 자동 적용(별도
//    장착 절차 없음 — 프레임이 하나뿐이라 온오프 개념이 필요 없다), type:"title"은
//    ACHIEVEMENTS와 같은 방식으로 /achievements/set-title에서 장착한다. ──
const REBIRTH_SHOP_ITEMS = {
  rebirth_frame_aurora: {
    name: "오로라 프로필 프레임", type: "frame", cost: 5,
    desc: "프로필 카드 테두리에 오로라 애니메이션을 추가로 겹쳐 표시합니다(환생 등급 발광과 별개로 항상 적용).",
  },
  rebirth_title_wanderer: {
    name: "칭호: 차원 방랑자", type: "title", title: "차원 방랑자", cost: 15,
    desc: "환생 상점 전용 칭호 — 구매 즉시 장착 가능.",
  },
  rebirth_title_witness: {
    name: "칭호: 만물의 목격자", type: "title", title: "만물의 목격자", cost: 50,
    desc: "환생 상점 최고가 전용 칭호.",
  },
  // ── 코스메틱뿐 아니라 실질적인 버프/보상도 원하는 요청 반영 — 순수 명예 아이템 사이에
  // 실전에 도움되는 것도 하나씩 섞는다. stat_boost는 totalCombatStats에서 rebirthMult와는
  // 별개로 곱연산 적용(작고 상한 있게 원칙 유지 — 딱 +3%, 중복 구매 불가라 추가 인플레 없음).
  rebirth_core_overclock: {
    name: "환생 코어 오버클럭", type: "stat_boost", cost: 25,
    desc: "ATK/DEF 영구 +3% (환생 등급 전투력 보너스와는 별개로 추가 곱연산 적용).",
  },
  // diamond_grant는 "소장품"이 아니라 1회성 보상이라 owned 플래그가 곧 "이미 수령함" 표시다.
  rebirth_diamond_cache: {
    name: "환생 보상 상자", type: "diamond_grant", cost: 10, diamonds: 800,
    desc: "구매(수령) 즉시 다이아 💎800 지급 — 1인당 1회 한정.",
  },
};
function rebirthShopOwnedSet(row) {
  try { return new Set(JSON.parse(row.rebirth_shop_owned || "[]")); } catch (e) { return new Set(); }
}
// 칭호 텍스트 조회를 ACHIEVEMENTS(업적 달성)와 REBIRTH_SHOP_ITEMS(환생석 구매) 두 출처
// 어디서 왔는지 신경 안 쓰고 한 곳에서 통일해서 찾는다 — equipped_title_id는 둘 중 하나의
// id를 그대로 담을 뿐이라, 표시 로직은 항상 이 함수 하나만 거치면 된다.
function lookupTitleText(id) {
  if (!id) return null;
  if (ACHIEVEMENTS[id]) return ACHIEVEMENTS[id].title;
  const shopItem = REBIRTH_SHOP_ITEMS[id];
  if (shopItem && shopItem.type === "title") return shopItem.title;
  return null;
}

// 달성 판정에 필요한 부가 정보(봇 수/Abyssal 보유/보유 행성 수/클럽 소속 등)를 한 번에 모아
// ctx로 만든다 — GET /achievements와 POST /achievements/claim이 공유.
async function buildAchievementContext(env, row) {
  const [botCountRow, invRes, wildCountRow, membership] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_bots WHERE user_id = ?").bind(row.user_id).first(),
    env.DB.prepare("SELECT item_id FROM arena_inventory WHERE user_id = ? AND qty > 0").bind(row.user_id).all(),
    env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_planets WHERE owner_user_id = ? AND is_home = 0").bind(row.user_id).first(),
    env.DB.prepare("SELECT club_id, role FROM arena_club_members WHERE user_id = ?").bind(row.user_id).first(),
  ]);
  const hasAbyssal = invRes.results.some(function (r) { return SHOP_ITEMS[r.item_id] && SHOP_ITEMS[r.item_id].rarity === "abyssal"; });
  return {
    row: row,
    botCount: (botCountRow && botCountRow.cnt) || 0,
    hasAbyssal: hasAbyssal,
    ownedWildCount: (wildCountRow && wildCountRow.cnt) || 0,
    clubId: membership ? membership.club_id : null,
    isClubLeader: !!(membership && membership.role === "leader"),
  };
}

// ── 상점은 이제 유저별 로컬 로테이션이다(예전엔 전 서버 공용이라 모두가 같은 상점을 봤음) —
//    씨앗에 userId 해시를 섞어서 같은 4분 구간에도 사람마다 다른 상점이 뜨게 한다. 재고
//    테이블(arena_shop_stock)도 (user_id, item_id, bucket) 단위로 따로 관리한다. rerollNonce는
//    다이아로 즉시 리롤(POST /shop/reroll)할 때만 바뀌는 값 — 자연 타이머(bucket)는 그대로
//    두고 아이템 목록만 다시 뽑는다(재고 카운터는 bucket 기준이라 리롤해도 초기화 안 됨). ──
// 확률표대로만 뽑으면(특히 연구를 안 한 초반) 운이 나쁘면 common 몇 개만 뜨고 끝나는 경우가
// 흔해서 상점이 휑해 보인다는 피드백으로, 최소 개수를 보장한다. 부족분은 common~epic 범위
// (그 이상은 채우기 후보에서 아예 뺀다 — legendary 이상은 여전히 순수 확률로만 떠야 그
// 희소성이 의미가 있다)에서 아직 안 뽑힌 아이템으로 채운다.
const MIN_SHOP_ITEMS = 8;
const SHOP_FILLER_MAX_RARITY_IDX = RARITY_ORDER.indexOf("epic");
// "상점 진열대 확장" 연구(레벨당 +1)로 이 최소 개수를 유저별로 늘릴 수 있다 — minItems를
// 안 넘기면(기존 호출부) 그냥 MIN_SHOP_ITEMS 그대로라 하위 호환된다.
function computeShopRotation(nowMs, userId, researchLevel, rerollNonce, minItems) {
  const bucket = Math.floor((nowMs || Date.now()) / SHOP_ROTATION_MS);
  const rng = mulberry32((bucket ^ hashStr(userId || "") ^ (rerollNonce || 0)) | 0);
  const byRarity = {};
  for (const id in SHOP_ITEMS) {
    const item = SHOP_ITEMS[id];
    (byRarity[item.rarity] = byRarity[item.rarity] || []).push(id);
  }
  const itemIds = [];
  for (const rarity of RARITY_ORDER) {
    const meta = RARITY_META[rarity];
    const chance = effectiveRarityChance(rarity, researchLevel);
    const pool = (byRarity[rarity] || []).slice();
    if (!pool.length) continue;
    if (rng() > chance) continue;
    const slots = Math.min(meta.maxSlots, pool.length);
    for (let i = 0; i < slots; i++) {
      const idx = Math.floor(rng() * pool.length);
      itemIds.push(pool.splice(idx, 1)[0]);
    }
  }
  const targetMin = minItems || MIN_SHOP_ITEMS;
  if (itemIds.length < targetMin) {
    const chosen = new Set(itemIds);
    const remaining = Object.keys(SHOP_ITEMS).filter(function (id) {
      return !chosen.has(id) && RARITY_ORDER.indexOf(SHOP_ITEMS[id].rarity) <= SHOP_FILLER_MAX_RARITY_IDX;
    });
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = remaining[i]; remaining[i] = remaining[j]; remaining[j] = tmp;
    }
    remaining.sort(function (a, b) { return RARITY_ORDER.indexOf(SHOP_ITEMS[a].rarity) - RARITY_ORDER.indexOf(SHOP_ITEMS[b].rarity); });
    itemIds.push.apply(itemIds, remaining.slice(0, targetMin - itemIds.length));
  }
  return { itemIds: itemIds, bucket: bucket, nextRotationAt: (bucket + 1) * SHOP_ROTATION_MS };
}
// ── 연구: 상점 진열대 확장 — 레벨당 최소 진열 개수 +1. 채우기 후보 풀(common~epic, 19개)
//    보다 커봐야 의미가 없으니 최대 레벨을 낮게(8) 잡았다 — 그래도 8(기본)+8=16개까지 늘어난다.
const RESEARCH_SLOTS_BASE_COST = 15;
const RESEARCH_SLOTS_GROWTH = 1.7;
const RESEARCH_SLOTS_MAX_LEVEL = 8;
const RESEARCH_SLOTS_BONUS_PER_LEVEL = 1;
function researchSlotsUpgradeCost(level) { return Math.round(RESEARCH_SLOTS_BASE_COST * Math.pow(RESEARCH_SLOTS_GROWTH, level)); }
function effectiveMinShopItems(slotsLevel) { return MIN_SHOP_ITEMS + Math.min(slotsLevel || 0, RESEARCH_SLOTS_MAX_LEVEL) * RESEARCH_SLOTS_BONUS_PER_LEVEL; }

// ── 상점 재고 — 장착 아이템(무기/방어/코어)과 소비재 전부, 로테이션(bucket)마다 아이템별로
//    1~3개 중 하나가 시드되어 다 팔리면 그 로테이션 동안은 품절. 등급이 높을수록 "떴다 하면
//    딱 1개"일 확률이 훨씬 높아진다(희귀할수록 더 귀해야 하니까) — COMMON은 1개 50%/2개
//    35%/3개 15%인 반면 FORBIDDEN은 1개 99%로 사실상 항상 1개만 나온다. 상점이 유저별
//    로컬이 되면서 재고도 유저별로 따로 씨앗을 섞는다. ──
const STOCK_WEIGHTS_BY_RARITY = {
  common:    { one: 0.50, two: 0.35, three: 0.15 },
  uncommon:  { one: 0.60, two: 0.30, three: 0.10 },
  rare:      { one: 0.70, two: 0.23, three: 0.07 },
  epic:      { one: 0.80, two: 0.16, three: 0.04 },
  legendary: { one: 0.88, two: 0.10, three: 0.02 },
  mythic:    { one: 0.93, two: 0.06, three: 0.01 },
  secret:    { one: 0.97, two: 0.025, three: 0.005 },
  forbidden: { one: 0.99, two: 0.009, three: 0.001 },
  abyssal:   { one: 0.995, two: 0.004, three: 0.001 },
};
// 특정 소비재는 등급표 대신 자기만의 재고 범위를 쓴다(요청 반영) — 에너지 드링크는 3~5개,
// 메가 에너지 셀은 2~4개로 시작한다. 범위 안에서 균등 랜덤(로테이션/유저별로 다시 섞임).
const SHOP_ITEM_STOCK_OVERRIDE = {
  energy_drink:     { min: 3, max: 5 },
  mega_energy_cell: { min: 2, max: 4 },
};
function rollItemStock(itemId, bucket, rarity, userId) {
  const rng = mulberry32((bucket ^ hashStr(itemId) ^ hashStr(userId || "")) | 0);
  const override = SHOP_ITEM_STOCK_OVERRIDE[itemId];
  if (override) {
    const span = override.max - override.min + 1;
    return override.min + Math.floor(rng() * span);
  }
  const w = STOCK_WEIGHTS_BY_RARITY[rarity] || STOCK_WEIGHTS_BY_RARITY.common;
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
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN diamonds INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN research_shop_level INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN research_shop_slots_level INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN research_rebirth_level INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN research_expedition_unlocked INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN shop_reroll_nonce INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN rebirth_count INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN rebirth_boost_until INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
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
  try { await env.DB.exec("ALTER TABLE arena_bots ADD COLUMN recruit_cost INTEGER NOT NULL DEFAULT " + BOT_BASE_COST); } catch (e) {}
  // 경비병 — NULL이면 "나와 함께"(개인 전투력), 값이 있으면 그 행성 id에 배치되어 그 행성
  // 방어에만 반영된다(아래 PLANET_GARRISON_MAX_PER_PLANET 참고).
  try { await env.DB.exec("ALTER TABLE arena_bots ADD COLUMN stationed_planet_id INTEGER"); } catch (e) {}
  // 봇의 "등급" 배지 — 장착된 아이템으로 그때그때 다시 계산하지 않고, 가장 최근 가챠 결과를
  // 고정 저장해서 쓴다(POST /bots/gacha에서만 갱신). 그래야 가챠 없이 그냥 인벤토리 아이템을
  // 수동으로 꽂기만 해서 등급이 바뀌는 일이 없다 — 실전 스탯은 여전히 지금 장착된 걸 그대로
  // 반영하되(equipStats), "등급"만큼은 가챠를 통해서만 오른다.
  try { await env.DB.exec("ALTER TABLE arena_bots ADD COLUMN gacha_rarity TEXT"); } catch (e) {}
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_bots_stationed ON arena_bots(stationed_planet_id)"); } catch (e) {}
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
  // arena_shop_stock2 — 상점이 유저별 로컬 로테이션이 되면서 재고 테이블도 (user_id, item_id,
  // bucket) 3중 키로 바뀌었다. SQLite는 PRIMARY KEY를 ALTER로 못 바꾸므로 예전 arena_shop_stock
  // (item_id, bucket) 2중 키 테이블은 그냥 버려두고(용량 미미, 4분짜리 휘발성 카운터) 새 이름으로
  // 새로 만든다. ──
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_shop_stock2 (user_id TEXT NOT NULL, item_id TEXT NOT NULL, bucket INTEGER NOT NULL, bought INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, item_id, bucket))"
  );
  // arena_trades — 유저 간 거래(코인+아이템 동시 제안). offer_items/request_items는
  // [{itemId,qty}] JSON 문자열로 저장한다(품목 수가 가변적이라 별도 테이블보다 이쪽이 간단).
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "from_user_id TEXT NOT NULL, from_name TEXT NOT NULL, to_user_id TEXT NOT NULL, to_name TEXT NOT NULL, " +
    "offer_coins INTEGER NOT NULL DEFAULT 0, offer_items TEXT NOT NULL DEFAULT '[]', " +
    "request_coins INTEGER NOT NULL DEFAULT 0, request_items TEXT NOT NULL DEFAULT '[]', " +
    "status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, resolved_at INTEGER)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_trades_to ON arena_trades(to_user_id, status)"); } catch (e) {}
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_trades_from ON arena_trades(from_user_id, status)"); } catch (e) {}
  // ── 클럽(길드) ── 멤버는 arena_club_members에 user_id를 PK로 둬서 "한 사람당 클럽 하나만"을
  // 자연스럽게 강제한다. 관계(arena_club_relations)는 (from,to) 방향성 선언이고, 실제 "적대/우호"
  // 판정은 양쪽 선언을 합쳐서 계산한다(한쪽만 적대여도 전쟁, 양쪽 다 우호여야 동맹).
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_clubs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, " +
    "leader_user_id TEXT NOT NULL, leader_name TEXT NOT NULL, description TEXT, war_score INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_club_members (user_id TEXT PRIMARY KEY, club_id INTEGER NOT NULL, user_name TEXT NOT NULL, " +
    "role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_club_members_club ON arena_club_members(club_id)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_club_relations (from_club_id INTEGER NOT NULL, to_club_id INTEGER NOT NULL, " +
    "status TEXT NOT NULL DEFAULT 'neutral', updated_at INTEGER NOT NULL, PRIMARY KEY (from_club_id, to_club_id))"
  );
  try { await env.DB.exec("ALTER TABLE arena_clubs ADD COLUMN bank_coins INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_clubs ADD COLUMN xp INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  // 클럽 채팅 — 클럽당 최근 CLUB_CHAT_HISTORY개만 화면에 보여준다(오래된 것도 DB엔 남지만 굳이
  // 안 지움 — 용량이 크지 않음).
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_club_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER NOT NULL, " +
    "user_id TEXT NOT NULL, user_name TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_club_chat_club ON arena_club_chat(club_id, created_at)"); } catch (e) {}
  // 출석 — 연속 출석일과 마지막 출석 날짜(KST, "YYYY-MM-DD")만 유저 테이블에 얹는다.
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN last_attendance_date TEXT"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN attendance_streak INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  // 오늘의 미션 진행도 — 하루(KST)마다 새 행. 지난 날짜 행은 그냥 쌓이게 둠(자동 정리 없음).
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_daily_progress (user_id TEXT NOT NULL, date TEXT NOT NULL, " +
    "battles INTEGER NOT NULL DEFAULT 0, jobs INTEGER NOT NULL DEFAULT 0, purchases INTEGER NOT NULL DEFAULT 0, " +
    "battles_claimed INTEGER NOT NULL DEFAULT 0, jobs_claimed INTEGER NOT NULL DEFAULT 0, purchases_claimed INTEGER NOT NULL DEFAULT 0, " +
    "PRIMARY KEY (user_id, date))"
  );
  // 프로필 — 상태메시지 + 자랑 진열대(최대 3칸, 아이템 또는 봇). showcase는
  // [{type:'item'|'bot', itemId?, botId?}] JSON 문자열로 저장한다.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_profiles (user_id TEXT PRIMARY KEY, status_message TEXT, showcase TEXT NOT NULL DEFAULT '[]', " +
    "rebirth_effect_enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)"
  );

  // ── 업적/칭호 — 정의(ACHIEVEMENTS)는 코드에만 있고, DB엔 "누가 언제 뭘 받았는지"만 남긴다.
  // 지금 장착 중인 칭호는 arena_users에 achievement id로만 저장하고(텍스트는 항상 정의에서
  // 새로 읽어옴 — 나중에 이름을 바꿔도 안 꼬임), 실제 달성 여부는 매번 현재 상태(레벨/환생/
  // 보유 행성 수 등)로 다시 계산한다(별도 진행도 테이블 없이도 항상 정확함).
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN equipped_title_id TEXT"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_achievement_claims (user_id TEXT NOT NULL, achievement_id TEXT NOT NULL, " +
    "claimed_at INTEGER NOT NULL, PRIMARY KEY (user_id, achievement_id))"
  );

  // ── 오프라인 활동 요약 — "마지막으로 이 요약을 확인한 시각" 하나만 저장한다. GET
  // /activity-summary 호출 시 이 시각 이후의 arena_logs(피격/행성 강탈당함)를 모아 보여주고
  // 그 즉시 이 시각을 지금으로 갱신한다(다음엔 또 그 이후분만 보여줌 — 읽으면 확인 처리).
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN last_activity_summary_at INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  // 공격 쿨다운(30초) — 마지막으로 공격(PvP/행성/원정 무엇이든)한 시각.
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN last_attack_at INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  // 출석 + 오늘의 미션 3종을 전부 끝내면 20분간 켜지는 코인/XP 2배 부스트의 만료 시각.
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN daily_boost_until INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  // 환생 상점 — 환생할 때마다 쌓이는 전용 화폐(rebirth_stones)와, 그 화폐로 산 소장품 id
  // 목록(rebirth_shop_owned, JSON 배열 문자열). max_theme_enabled는 환생 10회(최대 등급)만
  // 잠금 해제되는 사이트 전체 테마의 온오프 — 프로필 탭에서 본인이 직접 켜고 끌 수 있다.
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN rebirth_stones INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN rebirth_shop_owned TEXT NOT NULL DEFAULT '[]'"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN max_theme_enabled INTEGER NOT NULL DEFAULT 1"); } catch (e) {}
  // 영구 EXP 부스터 연구 레벨(0~3) — "환생 가속 연구" 대체. research_rebirth_level은 그대로
  // 남겨두되(이미 투자한 유저 보호) 더 이상 이 컬럼을 새로 올릴 방법은 없다.
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN research_exp_booster_level INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  // 현상금 게시판 — 진행도는 arena_logs를 그대로 세서 계산하므로(카운터 테이블 불필요),
  // "이 회차(bucket)에 이 현상금을 이미 청구했는지"만 여기 남긴다.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_bounty_claims (user_id TEXT NOT NULL, bucket INTEGER NOT NULL, bounty_id TEXT NOT NULL, " +
    "claimed_at INTEGER NOT NULL, PRIMARY KEY (user_id, bucket, bounty_id))"
  );
  // 클럽 레이드 — 클럽당 한 번에 하나만 진행 가능(status='active'). 보스를 처치하면
  // status='completed'로 바뀌고, 참여자별 기여 데미지(arena_club_raid_damage)에 비례해
  // 보상을 나눠준다.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_club_raids (id INTEGER PRIMARY KEY AUTOINCREMENT, club_id INTEGER NOT NULL, " +
    "boss_name TEXT NOT NULL, max_hp INTEGER NOT NULL, hp INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', " +
    "started_at INTEGER NOT NULL, ended_at INTEGER)"
  );
  try { await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_club_raids_club ON arena_club_raids(club_id, status)"); } catch (e) {}
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_club_raid_damage (raid_id INTEGER NOT NULL, user_id TEXT NOT NULL, user_name TEXT NOT NULL, " +
    "damage INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (raid_id, user_id))"
  );
  // 레이드 공격 전용 쿨다운(PvP의 30초 쿨다운과는 별개 — 협동 콘텐츠라 매크로 방지 정도로만
  // 짧게 둔다) + 클럽이 마지막 레이드를 끝낸 시각(재도전 대기시간 계산용, arena_clubs에 저장).
  try { await env.DB.exec("ALTER TABLE arena_users ADD COLUMN last_raid_attack_at INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
  try { await env.DB.exec("ALTER TABLE arena_clubs ADD COLUMN last_raid_ended_at INTEGER NOT NULL DEFAULT 0"); } catch (e) {}

  // ── 클럽 전쟁 시즌 — 기존 arena_clubs.war_score(전체 누적)는 그대로 두고, 시즌별 점수만
  // 따로 쌓는다(club_id, season_bucket) 복합키. 시즌 경계는 별도 크론 없이 시간을 CLUB_WAR_
  // SEASON_MS로 나눈 결정론적 버킷이라(상점 로테이션과 같은 방식) 인프라 추가가 필요 없다.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_club_war_seasons (club_id INTEGER NOT NULL, season_bucket INTEGER NOT NULL, " +
    "score INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (club_id, season_bucket))"
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_club_war_claims (user_id TEXT NOT NULL, season_bucket INTEGER NOT NULL, " +
    "claimed_at INTEGER NOT NULL, PRIMARY KEY (user_id, season_bucket))"
  );

  // ── 장비 강화(인챈트) — 아이템은 개별 인스턴스가 아니라 (user_id, item_id) 재고 수량으로만
  // 존재하므로, 강화도 "이 유저가 이 아이템 종류를 얼마나 마스터했는지"로 (user_id, item_id)당
  // 레벨 하나로 관리한다 — 그 유저가 가진 그 아이템 전부에 동일하게 적용된다.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS arena_item_enchants (user_id TEXT NOT NULL, item_id TEXT NOT NULL, " +
    "level INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, item_id))"
  );
  schemaReady = true;
}

// 오늘자 진행도 행이 없으면 만들어서 돌려준다(멱등) — 하루 지나면 자연히 새 행을 만들게 된다.
async function ensureDailyProgress(env, userId) {
  const date = kstDateString();
  let row = await env.DB.prepare("SELECT * FROM arena_daily_progress WHERE user_id = ? AND date = ?").bind(userId, date).first();
  if (!row) {
    await env.DB.prepare("INSERT INTO arena_daily_progress (user_id, date) VALUES (?, ?)").bind(userId, date).run();
    row = await env.DB.prepare("SELECT * FROM arena_daily_progress WHERE user_id = ? AND date = ?").bind(userId, date).first();
  }
  return row;
}
// 오늘의 미션 3종을 전부 수령했는지 — "출석 + 미션 전부 완료 시 20분 부스트" 조건의 절반.
async function allDailyQuestsClaimed(env, userId) {
  const progress = await ensureDailyProgress(env, userId);
  return Object.keys(DAILY_QUESTS).every(function (key) { return !!progress[key + "_claimed"]; });
}
// 미션 카운터 +1 — 실패해도(테이블이 아직 없다거나) 본 기능(전투/작업/구매)을 막으면 안 되므로
// 에러는 그냥 삼킨다.
async function bumpDailyProgress(env, userId, field) {
  try {
    await ensureDailyProgress(env, userId);
    await env.DB.prepare("UPDATE arena_daily_progress SET " + field + " = " + field + " + 1 WHERE user_id = ? AND date = ?").bind(userId, kstDateString()).run();
  } catch (e) {}
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

  // 버그 수정: 예전엔 에너지/스태미나 회복까지 전부 "HP > 0"(다운 안 됨) 안에 묶여 있어서,
  // 다운되면 HP뿐 아니라 에너지/스태미나까지 같이 멈춰버렸다. 전투 불능과 자원 회복은 서로
  // 다른 개념이라 묶일 이유가 없으므로 항상 회복되게 뺐다.
  const energyTicks = Math.floor((now - out.last_energy_tick) / ENERGY_TICK_MS);
  if (energyTicks > 0) {
    out.energy = Math.min(out.max_energy, out.energy + energyTicks * ENERGY_REGEN_PER_TICK);
    out.last_energy_tick += energyTicks * ENERGY_TICK_MS;
  }
  const staminaTicks = Math.floor((now - out.last_stamina_tick) / STAMINA_TICK_MS);
  if (staminaTicks > 0) {
    out.stamina = Math.min(out.max_stamina, out.stamina + staminaTicks * STAMINA_REGEN_PER_TICK);
    out.last_stamina_tick += staminaTicks * STAMINA_TICK_MS;
  }
  // HP도 이제 다운(0) 상태든 오프라인이든 상관없이 자연 회복된다(요청 반영 — 예전엔 다운되면
  // 아이템으로만 회복 가능하게 일부러 막아뒀었는데, 그러면 자리를 비운 사이 회복이 전혀 안
  // 돼서 계정이 사실상 묶여버리는 문제가 있었다). 에너지/스태미나와 완전히 같은 방식 —
  // 마지막 틱 이후 지난 실제 시간만큼 계산하므로 오프라인이었어도 다음 접속 때 그대로 반영된다.
  {
    const hpTicks = Math.floor((now - out.last_hp_tick) / HP_TICK_MS);
    if (hpTicks > 0) {
      out.hp = Math.min(out.max_hp, out.hp + hpTicks * HP_REGEN_PER_TICK);
      out.last_hp_tick += hpTicks * HP_TICK_MS;
    }
  }
  return out;
}

// 완전 회복까지 남은 시간(ms) — applyRegen이 이미 꽉 찬 틱만큼은 다 반영해 둔 상태이므로,
// (필요한 틱 수 * 틱 간격) - (마지막 틱 이후 이미 지난 시간)만 계산하면 된다.
function msUntilFull(current, max, regenPerTick, tickMs, lastTick, now) {
  if (current >= max) return 0;
  const ticksNeeded = Math.ceil((max - current) / regenPerTick);
  const elapsedIntoTick = now - lastTick;
  return Math.max(0, ticksNeeded * tickMs - elapsedIntoTick);
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

// ── XP 획득 수단 확장 — 예전엔 사실상 Hacking Jobs가 유일한 경험치원이라 "얻을 방법이
// 너무 적다"는 피드백. 전부 nextExpFor(레벨)의 %로 계산해서 레벨이 오를수록 자동으로
// 같이 커지게 한다(job_tiers처럼 고정 표를 쓰면 고레벨에서 상대적으로 하찮아짐). 지는
// 것도 소량이나마 경험치를 줘서 "져도 완전히 헛수고는 아니다"는 최소한의 보상을 둔다.
// activityBoostMult(환생/일일완료 2배 부스트)는 각 호출부에서 곱해서 적용한다(Hacking
// Jobs와 동일한 방식).
// row를 받는 이유는 nextExpFor(레벨) 계산뿐 아니라 영구 EXP 부스터(expBoosterMult, 연구로
// 산 x1.2/x1.5/x2)까지 여기서 한 번에 곱해서, 이 함수를 쓰는 모든 XP 획득 경로가 새 연구
// 배율을 자동으로 반영하게 하기 위해서다(호출부마다 따로 곱하는 걸 깜빡할 걱정이 없음).
function xpPct(row, pct) { return Math.max(1, Math.round(nextExpFor(row.level) * pct * expBoosterMult(row))); }
const PVP_WIN_XP_PCT = 0.06, PVP_LOSE_XP_PCT = 0.015;
const PLANET_WIN_XP_PCT = 0.06, PLANET_LOSE_XP_PCT = 0.015;
const EXPEDITION_WIN_XP_PCT = 0.04, EXPEDITION_LOSE_XP_PCT = 0.01; // 오프라인 자동 원정이라 살짝 낮게
const ACHIEVEMENT_CLAIM_XP_PCT = 0.15; // 1회성 업적 청구 — 큰 보상
const DAILY_QUEST_CLAIM_XP_PCT = 0.05; // 오늘의 미션 3종, 각각
const ATTENDANCE_XP_PCT = 0.04;

// ── 장비 강화(인챈트) — 아이템은 개별 인스턴스가 없으므로(재고 수량만 존재) "이 유저가 이
// 아이템 종류를 얼마나 마스터했는지"를 (user_id, item_id)당 레벨 하나로 관리한다. 레벨당
// value에 +2%, 최대 10레벨(+20%)에서 상한(환생과 같은 "작고 상한 있게" 철학). enchantMap을
// 안 넘기면(기존 호출부 다수) 그냥 보너스 없이 기존과 완전히 동일하게 동작한다 — 하위 호환.
const ENCHANT_MAX_LEVEL = 10;
const ENCHANT_BONUS_PCT_PER_LEVEL = 0.02;
const ENCHANT_COST_BASE_PCT = 0.05; // 1레벨 비용 = 아이템 가격의 5%
const ENCHANT_COST_GROWTH = 1.6;
// maxLevel을 안 넘기면(기존 호출부 다수) ENCHANT_MAX_LEVEL(기본 10레벨)로 동작한다 — 하위 호환.
// 환생 등급이 있는 유저는 enchantMaxLevelFor(row)로 계산한 개인별 상한을 넘겨서 그만큼 더
// 강화할 수 있게 한다(환생 등급별 전투 특권, rebirthTier 참고).
function enchantMultiplier(level, maxLevel) { return 1 + Math.min(level || 0, maxLevel == null ? ENCHANT_MAX_LEVEL : maxLevel) * ENCHANT_BONUS_PCT_PER_LEVEL; }
function enchantUpgradeCost(item, currentLevel) { return Math.max(1, Math.round(item.price * ENCHANT_COST_BASE_PCT * Math.pow(ENCHANT_COST_GROWTH, currentLevel))); }
async function loadEnchantMap(env, userId) {
  const res = await env.DB.prepare("SELECT item_id, level FROM arena_item_enchants WHERE user_id = ?").bind(userId).all();
  const map = {};
  res.results.forEach(function (r) { map[r.item_id] = r.level; });
  return map;
}

function slotBonus(itemId, wantType, enchantMap, maxLevel) {
  const it = itemId ? SHOP_ITEMS[itemId] : null;
  if (!it || it.type !== wantType) return 0;
  const mult = enchantMap ? enchantMultiplier(enchantMap[itemId], maxLevel) : 1;
  return Math.round(it.value * mult);
}
function equipStats(unit, enchantMap, maxLevel) {
  return {
    atk: slotBonus(unit.equipped_weapon, "weapon", enchantMap, maxLevel),
    def: slotBonus(unit.equipped_armor, "armor", enchantMap, maxLevel),
    crit: slotBonus(unit.equipped_core, "core", enchantMap, maxLevel),
  };
}

async function totalCombatStats(env, row) {
  // 이 유저 소유의 모든 장비(본인 + 봇)가 같은 인챈트 표를 공유하므로 한 번만 불러온다.
  const enchantMap = await loadEnchantMap(env, row.user_id);
  // 인챈트 최대 레벨도 이 유저의 환생 등급에 따라 개인별로 달라진다(봇 포함 전부 동일하게 적용).
  const maxLevel = enchantMaxLevelFor(row);
  const self = equipStats(row, enchantMap, maxLevel);
  let atk = baseAtkFor(row.level) + self.atk;
  let def = baseDefFor(row.level) + self.def;
  let crit = BASE_CRIT_PCT + self.crit;
  // 경비병으로 행성에 배치된 봇(stationed_planet_id 있음)은 여기서 뺀다 — 그 봇의 스탯은
  // 대신 planetGarrisonStats로 그 행성 하나의 방어력에만 들어간다(중복 합산 방지).
  const botsRes = await env.DB.prepare(
    "SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE user_id = ? AND stationed_planet_id IS NULL"
  ).bind(row.user_id).all();
  const bots = botsRes.results;
  for (const b of bots) {
    const bs = equipStats(b, enchantMap, maxLevel);
    atk += bs.atk; def += bs.def; crit += bs.crit;
  }
  // 환생 보너스 — 회당 ATK/DEF +1%(치명타는 제외), 최대 10회(+10%)에서 상한. 봇까지 합산한
  // 총 전투력에 곱해서 "전체적으로 조금 더 강해짐"이 되게 한다(사기 방지를 위해 작고 상한 있게).
  const rebirthMult = 1 + Math.min(row.rebirth_count || 0, REBIRTH_BONUS_MAX_COUNT) * REBIRTH_BONUS_PER_COUNT;
  // 환생 상점의 "환생 코어 오버클럭"(1회 구매, 중복 불가) — 위 환생 등급 보너스와는 별개로
  // 딱 +3%만 추가 곱연산. 중복 구매가 안 되니 인플레 걱정 없이 고정값으로 둔다.
  const statBoostMult = rebirthShopOwnedSet(row).has("rebirth_core_overclock") ? 1.03 : 1;
  atk = Math.round(atk * rebirthMult * statBoostMult);
  def = Math.round(def * rebirthMult * statBoostMult);
  return { atk: atk, def: def, crit: crit, botCount: bots.length };
}

// 특정 행성 하나에 배치된 경비병 봇들의 장비 스탯 합 — resolvePlanetCombat(전투 1회 판정)처럼
// 행성 하나만 필요할 때 쓴다. 여러 행성을 한 번에 나열할 때(GET /planets)는 이 함수를 행성
// 개수만큼 반복 호출하지 않고 대신 한 번의 쿼리로 전부 묶어서 그룹화한다(N+1 방지) — 그
// 경로는 여러 주인의 봇이 섞여있어 인챈트 표를 주인별로 또 조회해야 하므로(N+1 재발),
// 일부러 인챈트 보너스를 안 붙인다(실제 전투 판정보다 약간 보수적으로 표시될 뿐 — 여기
// ownerUserId를 넘겨줄 때만(실제 전투 판정 경로, 주인 한 명 확정) 정확히 반영한다.
async function planetGarrisonStats(env, planetId, ownerUserId) {
  const res = await env.DB.prepare(
    "SELECT equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE stationed_planet_id = ?"
  ).bind(planetId).all();
  const enchantMap = ownerUserId ? await loadEnchantMap(env, ownerUserId) : null;
  // enchantMap이 null이면(위 N+1 방지 경로) 어차피 slotBonus가 mult=1로 무시하므로 maxLevel도
  // 안 쓰인다 — ownerUserId가 확정된 실제 전투 판정 경로에서만 주인의 환생 등급을 한 번 더 조회한다.
  const ownerRow = ownerUserId ? await env.DB.prepare("SELECT rebirth_count FROM arena_users WHERE user_id = ?").bind(ownerUserId).first() : null;
  const maxLevel = ownerRow ? enchantMaxLevelFor(ownerRow) : ENCHANT_MAX_LEVEL;
  let atk = 0, def = 0, crit = 0;
  for (const b of res.results) {
    const s = equipStats(b, enchantMap, maxLevel);
    atk += s.atk; def += s.def; crit += s.crit;
  }
  return { atk: atk, def: def, crit: crit, count: res.results.length };
}

// ── 프로필(누구나 조회 가능) — 진열대(최대 3칸, 아이템/봇)를 실제 표시 데이터로 풀어서
// 돌려준다. 없는 유저면 null. ──
async function buildPublicProfile(env, userId) {
  const row = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(userId).first();
  if (!row) return null;
  const profileRow = await env.DB.prepare("SELECT * FROM arena_profiles WHERE user_id = ?").bind(userId).first();
  const showcaseRaw = profileRow ? JSON.parse(profileRow.showcase || "[]") : [];

  const membership = await env.DB.prepare("SELECT club_id FROM arena_club_members WHERE user_id = ?").bind(userId).first();
  let clubName = null;
  if (membership) {
    const club = await env.DB.prepare("SELECT name FROM arena_clubs WHERE id = ?").bind(membership.club_id).first();
    clubName = club ? club.name : null;
  }

  const showcase = [];
  for (const entry of showcaseRaw.slice(0, PROFILE_SHOWCASE_MAX)) {
    if (entry.type === "item" && SHOP_ITEMS[entry.itemId]) {
      const item = SHOP_ITEMS[entry.itemId];
      const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(userId, entry.itemId).first();
      if (!owned || owned.qty <= 0) continue; // 그새 팔았거나 거래로 넘겼으면 조용히 건너뜀
      showcase.push({
        type: "item", id: entry.itemId, name: item.name, itemType: item.type,
        typeLabel: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].label : null,
        typeColor: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].color : null,
        rarity: item.rarity, rarityLabel: RARITY_META[item.rarity].label, rarityColor: RARITY_META[item.rarity].color,
      });
    } else if (entry.type === "bot") {
      const bot = await env.DB.prepare("SELECT * FROM arena_bots WHERE id = ? AND user_id = ?").bind(entry.botId, userId).first();
      if (!bot) continue; // 되팔았으면 건너뜀
      const stats = equipStats(bot);
      // 등급은 가챠 결과 기준(gacha_rarity) — 장착된 아이템으로 다시 계산하지 않는다.
      const bestRarity = bot.gacha_rarity || null;
      showcase.push({
        type: "bot", id: bot.id, atk: stats.atk, def: stats.def, crit: stats.crit,
        rarity: bestRarity, rarityLabel: bestRarity ? RARITY_META[bestRarity].label : "미배정",
        rarityColor: bestRarity ? RARITY_META[bestRarity].color : "#666",
      });
    }
  }

  const shopOwned = rebirthShopOwnedSet(row);
  return {
    userId: row.user_id, realName: row.real_name, level: row.level,
    rebirthCount: row.rebirth_count || 0,
    title: lookupTitleText(row.equipped_title_id),
    plunderWins: row.plunder_wins, clubName: clubName,
    statusMessage: profileRow ? (profileRow.status_message || "") : "",
    showcase: showcase,
    rebirthEffectEnabled: (row.rebirth_count || 0) > 0 && (!profileRow || !!profileRow.rebirth_effect_enabled),
    // 환생 상점 전용 코스메틱 — 프레임은 보유 즉시 자동 적용(별도 온오프 없음).
    auroraFrameOwned: shopOwned.has("rebirth_frame_aurora"),
    // 환생 10회(최대 등급)만 잠기는 사이트 전체 테마 — 자기 프로필/다른 사람 프로필 모두
    // 표시엔 필요 없지만(적용은 /state에서만), 이 함수가 isSelf 응답도 겸하므로 같이 내려준다.
    maxThemeUnlocked: (row.rebirth_count || 0) >= REBIRTH_BONUS_MAX_COUNT,
    maxThemeEnabled: row.max_theme_enabled === undefined ? true : !!row.max_theme_enabled,
  };
}

function publicState(row, combat) {
  const now = Date.now();
  // HP도 이제 0(다운)이든 아니든 자연 회복되므로(applyRegen 참고) 항상 완충 예상 시간을 준다.
  const hpFullInMs = msUntilFull(row.hp, row.max_hp, HP_REGEN_PER_TICK, HP_TICK_MS, row.last_hp_tick, now);
  const energyFullInMs = msUntilFull(row.energy, row.max_energy, ENERGY_REGEN_PER_TICK, ENERGY_TICK_MS, row.last_energy_tick, now);
  const staminaFullInMs = msUntilFull(row.stamina, row.max_stamina, STAMINA_REGEN_PER_TICK, STAMINA_TICK_MS, row.last_stamina_tick, now);
  return {
    userId: row.user_id, realName: row.real_name,
    level: row.level, xp: row.xp, nextExp: nextExpFor(row.level),
    hp: row.hp, maxHp: row.max_hp, energy: row.energy, maxEnergy: row.max_energy, stamina: row.stamina, maxStamina: row.max_stamina,
    hpFullInMs: hpFullInMs, energyFullInMs: energyFullInMs, staminaFullInMs: staminaFullInMs,
    statPoints: row.stat_points,
    pocketCoins: row.pocket_coins, bankCoins: row.bank_coins, diamonds: row.diamonds,
    atk: combat.atk, def: combat.def, crit: combat.crit, botCount: combat.botCount,
    equippedWeapon: row.equipped_weapon, equippedArmor: row.equipped_armor, equippedCore: row.equipped_core,
    shieldUntil: row.shield_until, shielded: row.shield_until > Date.now(),
    plunderWins: row.plunder_wins,
    rebirthCount: row.rebirth_count || 0,
    rebirthBonusPct: Math.min(row.rebirth_count || 0, REBIRTH_BONUS_MAX_COUNT) * REBIRTH_BONUS_PER_COUNT * 100,
    rebirthReady: row.level >= REBIRTH_LEVEL_REQUIREMENT,
    rebirthLevelRequirement: REBIRTH_LEVEL_REQUIREMENT,
    isAdmin: row.user_id === ADMIN_USER_ID,
    rebirthBoostActive: rebirthBoostMult(row) > 1,
    rebirthBoostUntil: row.rebirth_boost_until || 0,
    dailyBoostActive: dailyBoostMult(row) > 1,
    dailyBoostUntil: row.daily_boost_until || 0,
    // 칭호 텍스트는 저장하지 않고 매번 정의(ACHIEVEMENTS 또는 REBIRTH_SHOP_ITEMS)에서 새로
    // 읽는다 — 장착한 뒤 이름이 바뀌어도 안 꼬이고, 정의 자체가 삭제되면 자연히 칭호도 사라진다.
    equippedTitle: lookupTitleText(row.equipped_title_id),
    // 환생 등급(0~4, 프로필/이름표 발광 단계) + 환생 상점(환생석) + 환생 등급별 전투/QoL 특권 —
    // 전부 클라이언트가 그대로 표시/계산에 쓸 수 있게 여기서 최종값으로 내려준다.
    rebirthTier: rebirthTier(row.rebirth_count),
    rebirthStones: row.rebirth_stones || 0,
    enchantMaxLevel: enchantMaxLevelFor(row),
    botMaxCount: botMaxCountFor(row),
    attackCooldownMs: attackCooldownMsFor(row),
    auroraFrameOwned: rebirthShopOwnedSet(row).has("rebirth_frame_aurora"),
    maxThemeUnlocked: (row.rebirth_count || 0) >= REBIRTH_BONUS_MAX_COUNT,
    maxThemeEnabled: row.max_theme_enabled === undefined ? true : !!row.max_theme_enabled,
    // 영구 EXP 부스터(연구, 다이아 500/750/1000 → x1.2/x1.5/x2) — 헤더에 항상 보이는 표시용.
    expBoosterMult: expBoosterMult(row),
    // 전역 이벤트(GM이 켠 기간 한정 코인·EXP 2배) — 모든 유저에게 동일하게 적용되는 서버
    // 절대 시각 기준이라 유저별 상태 없이 그대로 노출한다.
    globalEventActive: globalEventMult() > 1,
    globalEventEndAt: GLOBAL_EVENT_COIN_XP_2X_END_AT,
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

// ── 같은 (공격자, 방어자) 쌍이 최근 8시간(지금부터 ATTACK_LIMIT_RESET_MS 전까지) 안에 몇 번
// 붙었는지 — arena_logs에 이미 매 공격마다 기록이 남으므로 새 테이블 없이 그대로 센다.
// 한때 "고정 시계 경계(상점 로테이션과 같은 버킷 방식)"로 바꿨었는데, 경계 앞뒤로 몰아 때리면
// 실제 8시간보다 훨씬 짧은 시간에 한도를 몇 배로 넘길 수 있는 구멍이 있어서(실사례로 발견)
// "지금부터 8시간 전"을 보는 롤링 윈도우로 되돌렸다 — 시계 경계와 무관하게 항상 정확하다. ──
// kind를 생략하면 기존과 동일하게 PvP 직접 결투(pvp_attack)만 센다 — 행성 공격 쪽에서
// "이 사람의 행성들을 최근 8시간 안에 몇 번이나 노렸는지"를 셀 때는 kind="planet_attack"으로
// 넘긴다(행성이 몇 개든 opponent_id는 그 소유자 한 명으로 고정이라 자연스럽게 "그 사람 전체"가 묶인다).
async function countRecentAttacks(env, attackerId, defenderId, kind) {
  // 고정 시계 경계(예: 매일 17시) 버킷으로 셌더니 실제로 악용됐다 — 경계 직전에 몰아서 때리고
  // 경계가 지나자마자 또 몰아서 때리면, 같은 사람을 1~2시간 안에 5번을 훌쩍 넘겨 때릴 수
  // 있었다(실제로 이윤결이 16:48~18:30(1시간 42분) 사이에 6번 때린 사례로 발견됨 — 16:48
  // 공격은 이전 버킷, 17:02 이후 5번은 새 버킷이라 버킷 기준으론 "위반 아님"으로 통과했었다).
  // "지금부터 8시간 전"까지를 그대로 보는 슬라이딩 윈도우로 되돌려서, 시계 경계와 무관하게
  // 실제로 최근 8시간 동안 몇 번 맞았는지를 정확히 센다.
  const since = Date.now() - ATTACK_LIMIT_RESET_MS;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM arena_logs WHERE user_id = ? AND opponent_id = ? AND kind = ? AND created_at > ?"
  ).bind(attackerId, defenderId, kind || "pvp_attack", since).first();
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

// ── 행성 전투 판정 — /planets/attack(직접, 태세+타이밍 미니게임)과 /planets/expedition(연구로
//    해금하는 오프라인 자동 전투, 중립 태세+평균 타이밍으로 대신 계산)이 완전히 같은 판정
//    로직을 쓴다. attacker의 stamina/hp/pocket_coins는 여기서 갱신하지 않는다(호출부가 검증
//    후 직접 persist) — 이 함수는 순수하게 "싸우면 어떻게 되는지"만 계산+정복/약탈 반영. ──
async function resolvePlanetCombat(env, user, attacker, planet, stanceId, timingScores) {
  const stance = STANCES[stanceId];
  const isBotPlanet = !planet.owner_user_id;
  const now = Date.now();
  let defenderCombat, defenderLastStance = null, effectiveTierKey = null, defenderRow = null;

  if (isBotPlanet) {
    effectiveTierKey = effectivePlanetTier(planet.slot_index, now);
    const t = PLANET_BOT_TIERS[effectiveTierKey];
    defenderCombat = { atk: t.atk, def: t.def, crit: t.crit };
  } else if (planet.is_home) {
    defenderRow = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(planet.owner_user_id).first();
    if (!defenderRow) return { error: "행성 소유자를 찾을 수 없습니다." };
    if (defenderRow.level < HOME_PLANET_INVULNERABLE_UNTIL_LEVEL) {
      return { error: "레벨 " + HOME_PLANET_INVULNERABLE_UNTIL_LEVEL + " 미만 유저의 홈 행성은 무적입니다." };
    }
    const ownerCombat = await totalCombatStats(env, defenderRow);
    // 홈 행성 방어 시에만 실전 ATK/DEF를 2배로 — 다른 곳(PvP 등)의 실제 전투력엔 영향 없다.
    defenderCombat = { atk: ownerCombat.atk * HOME_PLANET_DEFENSE_MULT, def: ownerCombat.def * HOME_PLANET_DEFENSE_MULT, crit: ownerCombat.crit };
    defenderLastStance = defenderRow.last_stance;
  } else {
    // 정복한 야생 행성 — 주인의 개인 전투력을 그대로 복제하지 않는다(그러면 행성을 몇 개
    // 갖든 방어가 공짜로 무한 복제된다). 실제 배치된 경비병 봇들의 장비 스탯 합 + 최소
    // 수비대(약함 등급 PVE와 동급)가 방어력이다. "평소 태세" 개념도 없다(사람이 아니라
    // 경비병이 지키는 것이므로 상성 보너스 계산에서 제외).
    const garrison = await planetGarrisonStats(env, planet.id, planet.owner_user_id);
    defenderCombat = {
      atk: PLANET_UNGARRISONED_DEFENSE.atk + garrison.atk,
      def: PLANET_UNGARRISONED_DEFENSE.def + garrison.def,
      crit: PLANET_UNGARRISONED_DEFENSE.crit + garrison.crit,
    };
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
  // 홈 행성은 coins_per_hour가 항상 0(순수 거점이라 수익이 없음)이라, 정복해서 일반 행성으로
  // 강등시킬 때 그대로 0을 물려주면 "빼앗아도 쓸모없는 행성"이 된다 — medium 등급 시세를
  // 기본값으로 붙여준다(적당히 쓸만한 수준, 과하지 않게).
  const newCoinsPerHour = isBotPlanet ? PLANET_BOT_TIERS[effectiveTierKey].coinsPerHour
    : planet.is_home ? PLANET_BOT_TIERS.medium.coinsPerHour : planet.coins_per_hour;

  let captured = false, lootCoins = 0;
  if (attackerWins) {
    if (isBotPlanet) {
      lootCoins = Math.round(newCoinsPerHour * 0.5);
    } else if (planet.is_home) {
      // 홈 행성은 coins_per_hour가 항상 0이라 "쌓인 수익 약탈" 방식이 의미가 없다 — 대신
      // 포켓 코인의 20%를 그 자리에서 몰수한다(뱅크 예치분은 보호됨).
      lootCoins = Math.floor(defenderRow.pocket_coins * HOME_PLANET_BREACH_CONFISCATE_RATE);
      defenderRow.pocket_coins -= lootCoins;
      await env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(defenderRow.pocket_coins, defenderRow.user_id).run();
    } else {
      const elapsedMs = Math.min(now - planet.last_collect, PROPERTY_MAX_ACCRUAL_MS);
      lootCoins = Math.floor(planet.coins_per_hour * (elapsedMs / 3600000));
    }
    lootCoins = Math.round(lootCoins * activityBoostMult(attacker)); // 환생 직후 30분/일일 완료 20분 약탈 2배
    attacker.pocket_coins += lootCoins;

    if (!isBotPlanet) await recordWarScoreIfHostile(env, user.userId, planet.owner_user_id);

    // 홈 행성은 이제 절대 소유권이 넘어가지 않는다 — 뚫려도 위 몰수 보상만 주고 그 자리에
    // 그대로 남는다(요청 반영: "홈 행성은 뺏을 수 없다, 공격 성공하면 보상만").
    if (!planet.is_home) {
      // 은하 지도 독차지 방지(소프트 캡) — 이미 한도(PLANET_MAX_OWNED_WILD)만큼 야생 행성을
      // 보유 중이면, 이겨도 정복(소유권 이전)은 안 되고 위 약탈만 챙긴다.
      let ownedWildCount = 0;
      if (PLANET_MAX_OWNED_WILD != null) {
        const cntRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_planets WHERE owner_user_id=? AND is_home=0").bind(user.userId).first();
        ownedWildCount = (cntRow && cntRow.cnt) || 0;
      }
      if (PLANET_MAX_OWNED_WILD == null || ownedWildCount < PLANET_MAX_OWNED_WILD) {
        captured = true;
        await env.DB.prepare(
          "UPDATE arena_planets SET owner_user_id=?, owner_name=?, is_home=0, bot_tier=NULL, coins_per_hour=?, last_collect=?, captured_at=? WHERE id=?"
        ).bind(user.userId, user.realName, newCoinsPerHour, now, now, planet.id).run();
        // 이 행성에 경비병으로 배치돼 있던 봇이 있다면(패자 소유였을 때) 소속 행성을 잃었으니
        // 다시 "나와 함께"로 귀환시킨다 — 안 그러면 그 봇들이 아무 데도 반영 안 되는 채로
        // 영영 묶여버린다.
        await env.DB.prepare("UPDATE arena_bots SET stationed_planet_id = NULL WHERE stationed_planet_id = ?").bind(planet.id).run();
      }
    }
    // 완전 승리(3판 전승)면 HP 손실 없음 — 스치지도 않고 이겼는데 깎이는 게 이상하다는 요청 반영.
    if (!sweep) attacker.hp = clamp(attacker.hp - PVP_WIN_ATK_HP_LOSS, 0, attacker.max_hp);
  } else {
    attacker.hp = clamp(attacker.hp - PVP_LOSE_ATK_HP_LOSS, 0, attacker.max_hp);
  }

  return {
    attackerWins: attackerWins, sweep: sweep, captured: captured, lootCoins: lootCoins,
    rounds: rounds, attackerRoundWins: attackerRoundWins, rpsMod: rpsMod,
    attackerCombat: attackerCombat, defenderCombat: defenderCombat, isBotPlanet: isBotPlanet, effectiveTierKey: effectiveTierKey,
  };
}

function fmtNum(n) { return Number(n || 0).toLocaleString("en-US"); }

const SHOP_TYPE_ORDER = { weapon: 0, armor: 1, core: 2, consumable: 3, box: 4 };
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
        return json(Object.assign(publicState(row, combat), { avatarIcon: AVATAR_ICONS[user.avatar] || null }));
      }

      // ── GET /activity-summary — "자리를 비운 사이 무슨 일이 있었는지" 한 번에 보여준다(PvP로
      //    피격당함, 행성/홈 행성을 뺏기거나 뚫림). 마지막으로 이 요약을 확인한 시각
      //    (last_activity_summary_at) 이후분만 모으고, 조회하는 즉시 그 시각을 지금으로
      //    갱신한다 — "읽으면 확인 처리"라 따로 ack 호출이 필요 없다. ──
      if (request.method === "GET" && path === "/activity-summary") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const since = row.last_activity_summary_at || 0;
        const now = Date.now();
        const res = await env.DB.prepare(
          "SELECT kind, coins_delta FROM arena_logs WHERE user_id = ? AND created_at > ? AND kind IN ('pvp_defend','planet_lost') AND coins_delta < 0"
        ).bind(user.userId, since).all();
        let pvpDefendLossCount = 0, pvpCoinsLost = 0, planetLostCount = 0, planetCoinsLost = 0;
        res.results.forEach(function (r) {
          if (r.kind === "pvp_defend") { pvpDefendLossCount++; pvpCoinsLost += -r.coins_delta; }
          else { planetLostCount++; planetCoinsLost += -r.coins_delta; }
        });
        await env.DB.prepare("UPDATE arena_users SET last_activity_summary_at = ? WHERE user_id = ?").bind(now, user.userId).run();
        return json({
          since: since, until: now,
          pvpDefendLossCount: pvpDefendLossCount, pvpCoinsLost: pvpCoinsLost,
          planetLostCount: planetLostCount, planetCoinsLost: planetCoinsLost,
          totalCoinsLost: pvpCoinsLost + planetCoinsLost,
          hasActivity: pvpDefendLossCount > 0 || planetLostCount > 0,
        });
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

      // ── POST /rebirth — 레벨 100 이상이어야 가능. 레벨/XP/스탯 포인트(HP·에너지·스태미나
      //    최대치 포함)를 전부 기본값으로 되돌리고 rebirth_count를 1 올린다. 코인/다이아/장비/
      //    봇/행성/클럽 등은 절대 안 건드린다 — totalCombatStats에서 rebirth_count당 ATK/DEF
      //    +1%(최대 10회)로 보상된다. ──
      if (request.method === "POST" && path === "/rebirth") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.level < REBIRTH_LEVEL_REQUIREMENT) {
          return json({ error: "환생은 레벨 " + REBIRTH_LEVEL_REQUIREMENT + "부터 가능합니다. (현재 Lv." + row.level + ")" }, 400);
        }
        const now = Date.now();
        row.level = 1;
        row.xp = 0;
        row.stat_points = 0;
        row.max_hp = BASE_MAX_HP;
        row.max_energy = BASE_MAX_ENERGY;
        row.max_stamina = BASE_MAX_STAMINA;
        row.hp = BASE_MAX_HP;
        row.energy = BASE_MAX_ENERGY;
        row.stamina = BASE_MAX_STAMINA;
        row.rebirth_count = (row.rebirth_count || 0) + 1;
        // 기본 30분 + 환생 가속 연구 레벨당 +5분(연구 안 했으면 그대로 30분).
        row.rebirth_boost_until = now + rebirthBoostTotalMs(row.research_rebirth_level); // 해킹 작업/PvP/행성 약탈 XP·코인 2배
        const stonesGained = rebirthStonesForCount(row.rebirth_count);
        row.rebirth_stones = (row.rebirth_stones || 0) + stonesGained;
        await env.DB.prepare(
          "UPDATE arena_users SET level=?, xp=?, stat_points=?, max_hp=?, max_energy=?, max_stamina=?, hp=?, energy=?, stamina=?, " +
          "rebirth_count=?, rebirth_boost_until=?, rebirth_stones=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
        ).bind(row.level, row.xp, row.stat_points, row.max_hp, row.max_energy, row.max_stamina, row.hp, row.energy, row.stamina,
               row.rebirth_count, row.rebirth_boost_until, row.rebirth_stones, now, now, now, row.user_id).run();

        const combat = await totalCombatStats(env, row);
        return json({ ok: true, rebirthCount: row.rebirth_count, rebirthStonesGained: stonesGained, state: publicState(row, combat) });
      }

      // ══════════════════════════════════════════════════════════
      //  Admin — ADMIN_USER_ID 테스트 계정 전용 치트 커맨드. 그 계정이 아니면 전부 403.
      // ══════════════════════════════════════════════════════════
      if (path.indexOf("/admin") === 0 && user.userId !== ADMIN_USER_ID) {
        return json({ error: "권한이 없습니다." }, 403);
      }

      if (request.method === "POST" && path === "/admin/add-xp") {
        const body = await request.json().catch(function () { return {}; });
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount) || amount <= 0) return json({ error: "유효하지 않은 값입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const leveledUp = applyXpAndLevel(row, amount);
        await env.DB.prepare(
          "UPDATE arena_users SET xp=?, level=?, stat_points=?, hp=?, energy=?, stamina=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
        ).bind(row.xp, row.level, row.stat_points, row.hp, row.energy, row.stamina, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, leveledUp: leveledUp, state: publicState(row, combat) });
      }

      // 레벨을 목표치로 직접 맞춘다(낮추는 것도 가능 — 테스트용). 올릴 때만 그 구간의
      // 스탯 포인트를 정직하게 계산해서 얹어준다(내리는 건 포인트를 도로 뺏지 않음 — 테스트
      // 편의상 그렇게 둠).
      if (request.method === "POST" && path === "/admin/set-level") {
        const body = await request.json().catch(function () { return {}; });
        const target = parseInt(body.level, 10);
        if (!Number.isInteger(target) || target < 1) return json({ error: "유효하지 않은 레벨입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (target > row.level) {
          let points = 0;
          for (let lv = row.level + 1; lv <= target; lv++) points += statPointsForLevel(lv);
          row.stat_points += points;
        }
        row.level = target;
        row.xp = 0;
        await env.DB.prepare("UPDATE arena_users SET level=?, xp=?, stat_points=? WHERE user_id=?").bind(row.level, row.xp, row.stat_points, row.user_id).run();
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, state: publicState(row, combat) });
      }

      if (request.method === "POST" && path === "/admin/add-coins") {
        const body = await request.json().catch(function () { return {}; });
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount)) return json({ error: "유효하지 않은 값입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        row.pocket_coins = Math.max(0, row.pocket_coins + amount);
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id).run();
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, state: publicState(row, combat) });
      }

      if (request.method === "POST" && path === "/admin/add-diamonds") {
        const body = await request.json().catch(function () { return {}; });
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount)) return json({ error: "유효하지 않은 값입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        row.diamonds = Math.max(0, row.diamonds + amount);
        await env.DB.prepare("UPDATE arena_users SET diamonds=? WHERE user_id=?").bind(row.diamonds, row.user_id).run();
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, state: publicState(row, combat) });
      }

      // 대상 계정을 지정할 수 있다(targetUserId 생략 시 본인) — 자기 계정 확인용을 넘어 다른
      // 계정에게도 테스트용 아이템을 줄 수 있게 해달라는 요청 반영.
      if (request.method === "POST" && path === "/admin/give-item") {
        const body = await request.json().catch(function () { return {}; });
        const itemId = String(body.itemId || "");
        const qty = Math.max(1, parseInt(body.qty, 10) || 1);
        const targetUserId = String(body.targetUserId || user.userId).trim();
        if (!SHOP_ITEMS[itemId]) return json({ error: "알 수 없는 아이템입니다." }, 400);
        const targetRow = await env.DB.prepare("SELECT user_id FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!targetRow) return json({ error: "존재하지 않는 계정입니다: " + targetUserId }, 404);
        await env.DB.prepare(
          "INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + ?"
        ).bind(targetUserId, itemId, qty, qty).run();
        return json({ ok: true, targetUserId: targetUserId });
      }

      // HP/에너지/스태미나를 즉시 최대치로 채우고, 구매형 자가 보호막도 풀어준다 — 전투/스캔
      // 테스트를 반복할 때마다 자원 부족으로 막히지 않게 하기 위함.
      if (request.method === "POST" && path === "/admin/refill") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const now = Date.now();
        await env.DB.prepare(
          "UPDATE arena_users SET hp=max_hp, energy=max_energy, stamina=max_stamina, shield_until=0, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
        ).bind(now, now, now, row.user_id).run();
        const refreshed = await loadOrCreateUser(env, user.userId, user.realName);
        const combat = await totalCombatStats(env, refreshed);
        return json({ ok: true, state: publicState(refreshed, combat) });
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
        const clubBonus = await clubCoinBonusMult(env, user.userId);
        const boostMult = activityBoostMult(row);
        const coinsGained = Math.round(randInt(tier.coinMin, tier.coinMax) * clubBonus * boostMult);
        row.pocket_coins += coinsGained;
        const xpGained = Math.round(tier.xp * boostMult * expBoosterMult(row));
        const leveledUp = applyXpAndLevel(row, xpGained);

        await env.DB.prepare(
          "UPDATE arena_users SET energy=?, stamina=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=?, " +
          "pocket_coins=?, xp=?, level=?, stat_points=? WHERE user_id=?"
        ).bind(row.energy, row.stamina, row.hp, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick,
               row.pocket_coins, row.xp, row.level, row.stat_points, row.user_id).run();
        await insertLog(env, user.userId, "job", null, tier.label, "success", coinsGained, 0);
        await bumpDailyProgress(env, user.userId, "jobs");

        const combat = await totalCombatStats(env, row);
        return json({ ok: true, coinsGained: coinsGained, xpGained: xpGained, leveledUp: leveledUp, boosted: boostMult > 1, state: publicState(row, combat) });
      }

      if (request.method === "GET" && path === "/arena/targets") {
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        const myCombat = await totalCombatStats(env, me);
        const now = Date.now();
        // 공격 불가능한 상대(자가 보호막 중, 다운 상태, 오늘 공격 한도 초과, 레벨 차이 초과)라도
        // 목록에서 아예 사라지진 않는다 — 그냥 ATTACK 버튼만 비활성화되고 사유가 표시된다.
        // 관리자 테스트 계정은 치트 수치로 실제 유저 대전을 왜곡할 수 있어 애초에 목록에서 뺀다.
        const res = await env.DB.prepare(
          "SELECT * FROM arena_users WHERE user_id != ? AND user_id != ? ORDER BY RANDOM() LIMIT 20"
        ).bind(user.userId, ADMIN_USER_ID).all();

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
          const attackCapped = attacksUsed >= PVP_MAX_ATTACKS_PER_TARGET_PER_RESET;
          // 레벨 차이는 더 이상 공격을 막지 않는다 — 정보 표시용으로만 남겨둔다(스태미나가
          // 더 드는 구간에 들어왔는지 보여주기 위함, computeAttackStaminaCost와 같은 ±10 기준).
          const levelGapHigh = Math.abs(me.level - t.level) > 10;
          targets.push({
            userId: t.user_id, realName: t.real_name, level: t.level, def: tCombat.def, online: online,
            offlinePendingCoins: bonusPocket,
            lastStance: t.last_stance || null, lastStanceLabel: t.last_stance ? STANCES[t.last_stance].label : null,
            estimatedVictoryPct: Math.round((wins / 300) * 100),
            staminaCost: computeAttackStaminaCost(me.level, t.level, online),
            attacksUsedToday: attacksUsed, attacksMaxPerDay: PVP_MAX_ATTACKS_PER_TARGET_PER_RESET,
            attackCapped: attackCapped, shielded: shielded, downed: downed, levelGapHigh: levelGapHigh,
            attackable: !shielded && !downed && !attackCapped,
          });
        }
        return json({ targets: targets, myStamina: me.stamina, stances: STANCES });
      }

      if (request.method === "POST" && path === "/arena/scan") {
        const body = await request.json().catch(function () { return {}; });
        const targetUserId = String(body.targetUserId || "");
        const me = await loadOrCreateUser(env, user.userId, user.realName);
        if (me.stamina < SCAN_STAMINA_COST) return json({ error: "스태미나가 부족합니다. (정찰에 " + SCAN_STAMINA_COST + " 필요)" }, 400);
        const target = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!target) return json({ error: "대상을 찾을 수 없습니다." }, 404);

        // 정찰도 이제 스태미나를 소모한다 — 정보만 보고 공짜로 간만 보는 걸 막기 위함.
        me.stamina -= SCAN_STAMINA_COST;
        await env.DB.prepare(
          "UPDATE arena_users SET stamina=?, energy=?, hp=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
        ).bind(me.stamina, me.energy, me.hp, me.last_energy_tick, me.last_stamina_tick, me.last_hp_tick, me.user_id).run();

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
        const combat = await totalCombatStats(env, me);

        return json({
          targetUserId: targetUserId, realName: target.real_name, level: target.level, def: tCombat.def, online: online, offlinePendingCoins: offlinePendingCoins,
          lastStance: target.last_stance || null, lastStanceLabel: target.last_stance ? STANCES[target.last_stance].label : null,
          myAtk: myCombat.atk, estimatedVictoryPct: Math.round((wins / rounds) * 100),
          staminaCost: computeAttackStaminaCost(me.level, target.level, online),
          scanStaminaCost: SCAN_STAMINA_COST,
          attacksUsedToday: attacksUsed, attacksMaxPerDay: PVP_MAX_ATTACKS_PER_TARGET_PER_RESET,
          attackCapped: attacksUsed >= PVP_MAX_ATTACKS_PER_TARGET_PER_RESET,
          levelGapHigh: Math.abs(me.level - target.level) > 10,
          state: publicState(me, combat),
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
        const cooldownLeft = attackCooldownRemainingMs(attacker);
        if (cooldownLeft > 0) return json({ error: "공격 후 " + Math.ceil(cooldownLeft / 1000) + "초 동안은 다시 공격할 수 없습니다." }, 400);

        const defender = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(targetUserId).first();
        if (!defender) return json({ error: "대상을 찾을 수 없습니다." }, 404);
        if (defender.hp <= 0) return json({ error: "이미 다운된 대상입니다." }, 400);
        if (defender.shield_until > Date.now()) return json({ error: "대상이 보호막 상태입니다." }, 400);
        // 레벨 차이는 더 이상 공격 자체를 막지 않는다 — computeAttackStaminaCost가 차이가
        // 클수록 스태미나를 훨씬 더 물리는 것으로 대신한다.

        // 같은 상대를 최근 8시간 안에 너무 많이 노리는 것만 막는다(한 명 붙잡고 무한 파밍 방지) — 그 외엔
        // 공격을 당해도 상대가 목록에서 아예 사라지지는 않는다(예전의 "피격 시 12시간 자동 보호막"은
        // 폐지, 소비재로 직접 사는 자가 보호막(shield_until)만 그대로 유효).
        const attackCount = await countRecentAttacks(env, attacker.user_id, defender.user_id);
        if (attackCount >= PVP_MAX_ATTACKS_PER_TARGET_PER_RESET) {
          return json({ error: "이 상대는 8시간 안에 이미 " + PVP_MAX_ATTACKS_PER_TARGET_PER_RESET + "번 공격했습니다. 다른 대상을 노려보세요." }, 400);
        }

        const defenderOnline = await isTargetOnline(env, defender.user_id);
        const staminaCost = computeAttackStaminaCost(attacker.level, defender.level, defenderOnline);
        if (attacker.stamina < staminaCost) return json({ error: "스태미나가 부족합니다. (필요 " + staminaCost + ")" }, 400);
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

        let coinsDelta = 0, attackerGain = 0;
        if (attackerWins) {
          let plunderMult = 1 + (isCrit ? CRIT_MULTIPLIER - 1 : 0) + (sweep ? 0.2 : 0);
          coinsDelta = Math.floor(defender.pocket_coins * PVP_PLUNDER_RATE * plunderMult);
          coinsDelta = Math.min(coinsDelta, defender.pocket_coins);
          defender.pocket_coins -= coinsDelta;
          // 클럽 보너스/부스트(환생·일일완료) 둘 다 방어자가 더 잃게 만드는 게 아니라 공격자가
          // "더 받는" 쪽으로만 적용한다(방어자는 공격자 사정과 아무 상관이 없으므로).
          const clubBonus = await clubCoinBonusMult(env, attacker.user_id);
          attackerGain = Math.round(coinsDelta * clubBonus * activityBoostMult(attacker));
          attacker.pocket_coins += attackerGain;
          defender.hp = clamp(defender.hp - PVP_WIN_DEF_HP_LOSS, 0, defender.max_hp);
          // 완전 승리(3판 전승)면 공격자 HP 손실 없음 — 방어자 쪽 피해는 그대로(패배 페널티라
          // 공격자가 얼마나 완벽하게 이겼는지와는 무관).
          if (!sweep) attacker.hp = clamp(attacker.hp - PVP_WIN_ATK_HP_LOSS, 0, attacker.max_hp);
          attacker.plunder_wins += 1;
        } else {
          defender.hp = clamp(defender.hp - PVP_LOSE_DEF_HP_LOSS, 0, defender.max_hp);
          attacker.hp = clamp(attacker.hp - PVP_LOSE_ATK_HP_LOSS, 0, attacker.max_hp);
        }

        // 경험치 — 이겨도 져도 준다(져도 완전히 헛수고는 아니게). 레벨업이 일어나면
        // applyXpAndLevel이 hp/energy/stamina를 전부 최대치로 되돌리므로(위 전투 피해를
        // 오히려 덮어씀) 반드시 hp/energy/stamina 피해 반영 "이후"에 호출한다.
        const xpGain = Math.round(xpPct(attacker, attackerWins ? PVP_WIN_XP_PCT : PVP_LOSE_XP_PCT) * activityBoostMult(attacker));
        const leveledUp = applyXpAndLevel(attacker, xpGain);

        attacker.last_attack_at = Date.now();
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE arena_users SET stamina=?, energy=?, hp=?, pocket_coins=?, plunder_wins=?, last_stance=?, xp=?, level=?, stat_points=?, " +
            "last_energy_tick=?, last_stamina_tick=?, last_hp_tick=?, last_attack_at=? WHERE user_id=?"
          ).bind(attacker.stamina, attacker.energy, attacker.hp, attacker.pocket_coins, attacker.plunder_wins, stanceId, attacker.xp, attacker.level, attacker.stat_points,
                 attacker.last_energy_tick, attacker.last_stamina_tick, attacker.last_hp_tick, attacker.last_attack_at, attacker.user_id),
          env.DB.prepare(
            "UPDATE arena_users SET hp=?, pocket_coins=?, shield_until=? WHERE user_id=?"
          ).bind(defender.hp, defender.pocket_coins, defender.shield_until, defender.user_id),
        ]);

        const attackResult = attackerWins ? (isCrit ? "crit" : "win") : "lose";
        await insertLog(env, attacker.user_id, "pvp_attack", defender.user_id, defender.real_name, attackResult, attackerWins ? attackerGain : 0, attackerWins ? (sweep ? 0 : -PVP_WIN_ATK_HP_LOSS) : -PVP_LOSE_ATK_HP_LOSS);
        await insertLog(env, defender.user_id, "pvp_defend", attacker.user_id, attacker.real_name, attackerWins ? "lose" : "win", attackerWins ? -coinsDelta : 0, attackerWins ? -PVP_WIN_DEF_HP_LOSS : -PVP_LOSE_DEF_HP_LOSS);
        if (attackerWins) await recordWarScoreIfHostile(env, attacker.user_id, defender.user_id);
        await bumpDailyProgress(env, attacker.user_id, "battles");

        const combat = await totalCombatStats(env, attacker);
        return json({
          ok: true, attackerWins: attackerWins, isCrit: isCrit, sweep: sweep, coinsDelta: attackerGain,
          xpGained: xpGain, leveledUp: leveledUp,
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

      // ══════════════════════════════════════════════════════════
      //  Trade — 유저 간 거래. 요청(pending) → 상대가 승낙(accepted)하면 그 순간 코인+아이템이
      //  동시에 오간다. 거절(declined)/취소(cancelled)는 아무 일도 안 일어난다.
      // ══════════════════════════════════════════════════════════

      // ── GET /trade — 받은 요청(내가 to)/보낸 요청(내가 from) 중 대기중인 것 + 최근 처리 내역. ──
      if (request.method === "GET" && path === "/trade") {
        const incoming = await env.DB.prepare("SELECT * FROM arena_trades WHERE to_user_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(user.userId).all();
        const outgoing = await env.DB.prepare("SELECT * FROM arena_trades WHERE from_user_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(user.userId).all();
        const history = await env.DB.prepare(
          "SELECT * FROM arena_trades WHERE (to_user_id = ? OR from_user_id = ?) AND status != 'pending' ORDER BY resolved_at DESC LIMIT 15"
        ).bind(user.userId, user.userId).all();
        function fmtRow(r) {
          return {
            id: r.id, fromUserId: r.from_user_id, fromName: r.from_name, toUserId: r.to_user_id, toName: r.to_name,
            offerCoins: r.offer_coins, offerItems: JSON.parse(r.offer_items || "[]"),
            requestCoins: r.request_coins, requestItems: JSON.parse(r.request_items || "[]"),
            status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at,
          };
        }
        return json({
          incoming: incoming.results.map(fmtRow), outgoing: outgoing.results.map(fmtRow), history: history.results.map(fmtRow),
          coinCap: tradeCoinCap(await loadOrCreateUser(env, user.userId, user.realName)),
        });
      }

      // ── POST /trade/request { toUserId, offerCoins, offerItems, requestCoins, requestItems } ──
      if (request.method === "POST" && path === "/trade/request") {
        const body = await request.json().catch(function () { return {}; });
        const toUserId = String(body.toUserId || "").trim();
        if (!toUserId || toUserId === user.userId) return json({ error: "올바른 상대를 지정하세요." }, 400);
        const offerCoins = Math.max(0, parseInt(body.offerCoins, 10) || 0);
        const requestCoins = Math.max(0, parseInt(body.requestCoins, 10) || 0);
        const offerItems = parseTradeItems(body.offerItems);
        const requestItems = parseTradeItems(body.requestItems);
        if (offerCoins === 0 && requestCoins === 0 && !offerItems.length && !requestItems.length) {
          return json({ error: "제안할 코인이나 아이템을 하나 이상 넣으세요." }, 400);
        }

        const fromRow = await loadOrCreateUser(env, user.userId, user.realName);
        const toRow = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(toUserId).first();
        if (!toRow) return json({ error: "상대를 찾을 수 없습니다(아직 접속 기록이 없을 수 있습니다)." }, 404);

        if (fromRow.pocket_coins < offerCoins) return json({ error: "제안한 코인만큼 보유하고 있지 않습니다." }, 400);
        const itemErr = await checkItemAvailability(env, user.userId, offerItems);
        if (itemErr) return json({ error: itemErr }, 400);
        const coinErr = validateTradeCoinAmounts(fromRow, toRow, offerCoins, requestCoins);
        if (coinErr) return json({ error: coinErr }, 400);

        const pendingCountRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_trades WHERE from_user_id = ? AND status = 'pending'").bind(user.userId).first();
        if ((pendingCountRow && pendingCountRow.cnt) >= TRADE_MAX_PENDING_OUTGOING) {
          return json({ error: "대기 중인 보낸 거래 요청이 너무 많습니다(최대 " + TRADE_MAX_PENDING_OUTGOING + "개)." }, 400);
        }

        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO arena_trades (from_user_id, from_name, to_user_id, to_name, offer_coins, offer_items, request_coins, request_items, status, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
        ).bind(user.userId, user.realName, toUserId, toRow.real_name, offerCoins, JSON.stringify(offerItems), requestCoins, JSON.stringify(requestItems), now).run();

        return json({ ok: true });
      }

      // ── POST /trade/accept { tradeId } — 받은 요청만 승낙할 수 있다. 승낙 순간 다시 한번
      //    전부 재검증한다(요청 이후 상대가 코인을 다 쓰거나 레벨이 바뀌었을 수 있으므로). ──
      if (request.method === "POST" && path === "/trade/accept") {
        const body = await request.json().catch(function () { return {}; });
        const tradeId = parseInt(body.tradeId, 10);
        const trade = await env.DB.prepare("SELECT * FROM arena_trades WHERE id = ?").bind(tradeId).first();
        if (!trade || trade.status !== "pending") return json({ error: "이미 처리됐거나 존재하지 않는 거래입니다." }, 400);
        if (trade.to_user_id !== user.userId) return json({ error: "받은 요청만 승낙할 수 있습니다." }, 403);

        const fromRow = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(trade.from_user_id).first();
        const toRow = await loadOrCreateUser(env, user.userId, user.realName);
        if (!fromRow) return json({ error: "상대를 찾을 수 없습니다." }, 400);

        const offerItems = JSON.parse(trade.offer_items || "[]");
        const requestItems = JSON.parse(trade.request_items || "[]");

        if (fromRow.pocket_coins < trade.offer_coins) return json({ error: "상대가 제안한 코인을 더 이상 보유하고 있지 않습니다." }, 400);
        if (toRow.pocket_coins < trade.request_coins) return json({ error: "요구받은 코인을 보유하고 있지 않습니다." }, 400);
        const fromItemErr = await checkItemAvailability(env, trade.from_user_id, offerItems);
        if (fromItemErr) return json({ error: "상대 쪽 아이템 문제: " + fromItemErr }, 400);
        const toItemErr = await checkItemAvailability(env, user.userId, requestItems);
        if (toItemErr) return json({ error: toItemErr }, 400);
        const coinErr = validateTradeCoinAmounts(fromRow, toRow, trade.offer_coins, trade.request_coins);
        if (coinErr) return json({ error: coinErr }, 400);

        const now = Date.now();
        const newFromCoins = fromRow.pocket_coins - trade.offer_coins + trade.request_coins;
        const newToCoins = toRow.pocket_coins - trade.request_coins + trade.offer_coins;
        await env.DB.batch([
          env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(newFromCoins, trade.from_user_id),
          env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(newToCoins, user.userId),
          env.DB.prepare("UPDATE arena_trades SET status='accepted', resolved_at=? WHERE id=?").bind(now, tradeId),
        ]);
        if (offerItems.length) await transferTradeItems(env, trade.from_user_id, user.userId, offerItems);
        if (requestItems.length) await transferTradeItems(env, user.userId, trade.from_user_id, requestItems);

        const coinsNoteFrom = trade.request_coins - trade.offer_coins;
        const coinsNoteTo = trade.offer_coins - trade.request_coins;
        await insertLog(env, trade.from_user_id, "trade", user.userId, user.realName, "done", coinsNoteFrom, 0);
        await insertLog(env, user.userId, "trade", trade.from_user_id, trade.from_name, "done", coinsNoteTo, 0);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const combat = await totalCombatStats(env, row);
        return json({ ok: true, state: publicState(row, combat) });
      }

      // ── POST /trade/decline { tradeId } — 받은 요청 거절(상대에게 알림은 따로 없음, 그냥 사라짐). ──
      if (request.method === "POST" && path === "/trade/decline") {
        const body = await request.json().catch(function () { return {}; });
        const tradeId = parseInt(body.tradeId, 10);
        const trade = await env.DB.prepare("SELECT * FROM arena_trades WHERE id = ?").bind(tradeId).first();
        if (!trade || trade.status !== "pending") return json({ error: "이미 처리됐거나 존재하지 않는 거래입니다." }, 400);
        if (trade.to_user_id !== user.userId) return json({ error: "받은 요청만 거절할 수 있습니다." }, 403);
        await env.DB.prepare("UPDATE arena_trades SET status='declined', resolved_at=? WHERE id=?").bind(Date.now(), tradeId).run();
        return json({ ok: true });
      }

      // ── POST /trade/cancel { tradeId } — 내가 보낸 요청 취소. ──
      if (request.method === "POST" && path === "/trade/cancel") {
        const body = await request.json().catch(function () { return {}; });
        const tradeId = parseInt(body.tradeId, 10);
        const trade = await env.DB.prepare("SELECT * FROM arena_trades WHERE id = ?").bind(tradeId).first();
        if (!trade || trade.status !== "pending") return json({ error: "이미 처리됐거나 존재하지 않는 거래입니다." }, 400);
        if (trade.from_user_id !== user.userId) return json({ error: "내가 보낸 요청만 취소할 수 있습니다." }, 403);
        await env.DB.prepare("UPDATE arena_trades SET status='cancelled', resolved_at=? WHERE id=?").bind(Date.now(), tradeId).run();
        return json({ ok: true });
      }

      // ══════════════════════════════════════════════════════════
      //  Club — 길드. 대표(leader) 1명 + 멤버들, 클럽 간 우호/적대 관계, 적대 클럽 상대
      //  PvP 승리마다 쌓이는 전적(war_score).
      // ══════════════════════════════════════════════════════════

      // ── GET /club — 내가 클럽에 속해 있으면 그 클럽의 상세(멤버/관계/전적)를, 아니면
      //    가입 가능한 전체 클럽 목록을 내려준다. ──
      if (request.method === "GET" && path === "/club") {
        const membership = await env.DB.prepare("SELECT * FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership) {
          const all = await env.DB.prepare("SELECT c.*, (SELECT COUNT(*) FROM arena_club_members m WHERE m.club_id = c.id) AS member_count FROM arena_clubs c ORDER BY c.war_score DESC, c.created_at ASC LIMIT 50").all();
          return json({
            myClub: null, createCost: CLUB_CREATE_COST, maxMembers: CLUB_MAX_MEMBERS,
            clubs: all.results.map(function (c) { return { id: c.id, name: c.name, description: c.description, leaderName: c.leader_name, memberCount: c.member_count, warScore: c.war_score, level: clubLevelForXp(c.xp) }; }),
          });
        }
        const club = await env.DB.prepare("SELECT * FROM arena_clubs WHERE id = ?").bind(membership.club_id).first();
        if (!club) { // 소속 클럽이 어쩌다 사라진 경우(방어적 처리) — 멤버십만 정리
          await env.DB.prepare("DELETE FROM arena_club_members WHERE user_id = ?").bind(user.userId).run();
          return json({ myClub: null, createCost: CLUB_CREATE_COST, maxMembers: CLUB_MAX_MEMBERS, clubs: [] });
        }
        const membersRes = await env.DB.prepare("SELECT * FROM arena_club_members WHERE club_id = ? ORDER BY role DESC, joined_at ASC").bind(club.id).all();
        const relRes = await env.DB.prepare("SELECT * FROM arena_club_relations WHERE from_club_id = ? OR to_club_id = ?").bind(club.id, club.id).all();
        const otherClubIds = new Set();
        relRes.results.forEach(function (r) { otherClubIds.add(r.from_club_id === club.id ? r.to_club_id : r.from_club_id); });
        const relations = [];
        for (const otherId of otherClubIds) {
          const otherClub = await env.DB.prepare("SELECT id, name, war_score FROM arena_clubs WHERE id = ?").bind(otherId).first();
          if (!otherClub) continue;
          const myDeclared = relRes.results.find(function (r) { return r.from_club_id === club.id && r.to_club_id === otherId; });
          relations.push({
            clubId: otherClub.id, clubName: otherClub.name, warScore: otherClub.war_score,
            myDeclared: myDeclared ? myDeclared.status : "neutral",
            effective: await effectiveClubRelation(env, club.id, otherId),
          });
        }
        // ── 클럽 레이드 현황 — 진행 중인 레이드가 있으면 보스 HP/상위 기여자 톱10, 없으면
        //    재도전까지 남은 대기시간을 같이 내려준다. ──
        const activeRaid = await env.DB.prepare("SELECT * FROM arena_club_raids WHERE club_id = ? AND status = 'active'").bind(club.id).first();
        let raidInfo = null, raidCooldownLeftMs = 0;
        if (activeRaid) {
          const topRes = await env.DB.prepare("SELECT user_id, user_name, damage, hits FROM arena_club_raid_damage WHERE raid_id = ? ORDER BY damage DESC LIMIT 10").bind(activeRaid.id).all();
          raidInfo = {
            id: activeRaid.id, bossName: activeRaid.boss_name, hp: activeRaid.hp, maxHp: activeRaid.max_hp, startedAt: activeRaid.started_at,
            topContributors: topRes.results.map(function (r) { return { userId: r.user_id, userName: r.user_name, damage: r.damage, hits: r.hits }; }),
          };
        } else {
          raidCooldownLeftMs = club.last_raid_ended_at ? Math.max(0, RAID_COOLDOWN_MS - (Date.now() - club.last_raid_ended_at)) : 0;
        }
        return json({
          myClub: {
            id: club.id, name: club.name, description: club.description, leaderUserId: club.leader_user_id, leaderName: club.leader_name, warScore: club.war_score,
            isLeader: club.leader_user_id === user.userId,
            bankCoins: club.bank_coins, xp: club.xp,
            level: clubXpProgress(club.xp).level, xpIntoLevel: clubXpProgress(club.xp).xpIntoLevel, nextLevelXp: clubXpProgress(club.xp).xpForLevel,
            coinBonusPct: Math.min(clubXpProgress(club.xp).level, CLUB_BONUS_MAX_LEVEL) * CLUB_BONUS_PER_LEVEL * 100,
            members: membersRes.results.map(function (m) { return { userId: m.user_id, userName: m.user_name, role: m.role, joinedAt: m.joined_at }; }),
            relations: relations,
            raid: raidInfo, raidCooldownLeftMs: raidCooldownLeftMs,
          },
          // 리더가 관계를 걸 상대 클럽의 ID를 찾을 수 있도록, 내 클럽 소속이어도 다른 클럽
          // 목록(ID 포함)은 계속 내려준다.
          otherClubs: (await env.DB.prepare("SELECT id, name FROM arena_clubs WHERE id != ? ORDER BY war_score DESC LIMIT 50").bind(club.id).all()).results,
          createCost: CLUB_CREATE_COST, maxMembers: CLUB_MAX_MEMBERS,
        });
      }

      // ── POST /club/raid/start — 진행 중인 레이드가 없고 재도전 대기시간(RAID_COOLDOWN_MS)이
      //    지났으면 클럽원 누구나 새 보스를 소환할 수 있다. HP는 클럽원 수 + 클럽 레벨에 비례. ──
      if (request.method === "POST" && path === "/club/raid/start") {
        const clubId = await clubIdOf(env, user.userId);
        if (!clubId) return json({ error: "클럽에 소속되어 있지 않습니다." }, 400);
        const club = await env.DB.prepare("SELECT * FROM arena_clubs WHERE id = ?").bind(clubId).first();
        const existing = await env.DB.prepare("SELECT id FROM arena_club_raids WHERE club_id = ? AND status = 'active'").bind(clubId).first();
        if (existing) return json({ error: "이미 진행 중인 레이드가 있습니다." }, 400);
        const cooldownLeft = club.last_raid_ended_at ? Math.max(0, RAID_COOLDOWN_MS - (Date.now() - club.last_raid_ended_at)) : 0;
        if (cooldownLeft > 0) return json({ error: "다음 레이드까지 " + Math.ceil(cooldownLeft / 3600000) + "시간 남았습니다." }, 400);
        const totalAtk = await clubTotalAtk(env, clubId);
        const maxHp = raidMaxHpFor(totalAtk);
        const bossName = RAID_BOSS_NAMES[Math.floor(Math.random() * RAID_BOSS_NAMES.length)];
        await env.DB.prepare(
          "INSERT INTO arena_club_raids (club_id, boss_name, max_hp, hp, status, started_at) VALUES (?, ?, ?, ?, 'active', ?)"
        ).bind(clubId, bossName, maxHp, maxHp, Date.now()).run();
        return json({ ok: true, bossName: bossName, maxHp: maxHp });
      }

      // ── POST /club/raid/attack — 내 클럽의 진행 중인 레이드에 데미지를 넣는다. 공격 간
      //    쿨다운은 없다(요청 반영) — 스태미나 소모(RAID_STAMINA_COST)만이 자연스러운 속도
      //    제한이다. ──
      if (request.method === "POST" && path === "/club/raid/attack") {
        const clubId = await clubIdOf(env, user.userId);
        if (!clubId) return json({ error: "클럽에 소속되어 있지 않습니다." }, 400);
        const raid = await env.DB.prepare("SELECT * FROM arena_club_raids WHERE club_id = ? AND status = 'active'").bind(clubId).first();
        if (!raid) return json({ error: "진행 중인 레이드가 없습니다." }, 400);

        const attacker = await loadOrCreateUser(env, user.userId, user.realName);
        if (attacker.stamina < RAID_STAMINA_COST) return json({ error: "스태미나가 부족합니다. (필요 " + RAID_STAMINA_COST + ")" }, 400);

        const combat = await totalCombatStats(env, attacker);
        const damage = Math.max(1, Math.round(combat.atk * RAID_ATTACK_POWER_MULT * randMult()));
        const newHp = Math.max(0, raid.hp - damage);

        attacker.stamina -= RAID_STAMINA_COST;
        await env.DB.batch([
          env.DB.prepare("UPDATE arena_users SET stamina=? WHERE user_id=?").bind(attacker.stamina, attacker.user_id),
          env.DB.prepare("UPDATE arena_club_raids SET hp=? WHERE id=?").bind(newHp, raid.id),
          env.DB.prepare(
            "INSERT INTO arena_club_raid_damage (raid_id, user_id, user_name, damage, hits) VALUES (?, ?, ?, ?, 1) " +
            "ON CONFLICT(raid_id, user_id) DO UPDATE SET damage = damage + ?, hits = hits + 1"
          ).bind(raid.id, user.userId, user.realName, damage, damage),
        ]);

        let defeated = false, rewards = null;
        if (newHp <= 0) {
          defeated = true;
          rewards = await settleRaid(env, raid.id, clubId, raid.max_hp);
          await env.DB.batch([
            env.DB.prepare("UPDATE arena_club_raids SET status='completed', ended_at=? WHERE id=?").bind(Date.now(), raid.id),
            env.DB.prepare("UPDATE arena_clubs SET last_raid_ended_at=? WHERE id=?").bind(Date.now(), clubId),
          ]);
        }

        return json({ ok: true, damage: damage, raidHp: newHp, raidMaxHp: raid.max_hp, bossName: raid.boss_name, defeated: defeated, rewards: rewards, stamina: attacker.stamina });
      }

      // ── POST /club/create { name, description } ──
      if (request.method === "POST" && path === "/club/create") {
        const existing = await env.DB.prepare("SELECT 1 FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (existing) return json({ error: "이미 클럽에 소속돼 있습니다. 먼저 탈퇴하세요." }, 400);
        const body = await request.json().catch(function () { return {}; });
        const name = String(body.name || "").trim().slice(0, CLUB_NAME_MAX_LEN);
        const description = String(body.description || "").trim().slice(0, CLUB_DESC_MAX_LEN);
        if (!name) return json({ error: "클럽 이름을 입력하세요." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.pocket_coins < CLUB_CREATE_COST) return json({ error: "코인이 부족합니다. (필요 " + fmtNum(CLUB_CREATE_COST) + ")" }, 400);

        const dup = await env.DB.prepare("SELECT 1 FROM arena_clubs WHERE name = ?").bind(name).first();
        if (dup) return json({ error: "이미 존재하는 클럽 이름입니다." }, 400);

        const now = Date.now();
        row.pocket_coins -= CLUB_CREATE_COST;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(row.pocket_coins, row.user_id).run();
        const inserted = await env.DB.prepare(
          "INSERT INTO arena_clubs (name, leader_user_id, leader_name, description, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(name, user.userId, user.realName, description || null, now).run();
        const clubId = inserted.meta.last_row_id;
        await env.DB.prepare("INSERT INTO arena_club_members (user_id, club_id, user_name, role, joined_at) VALUES (?, ?, ?, 'leader', ?)")
          .bind(user.userId, clubId, user.realName, now).run();

        return json({ ok: true, clubId: clubId, pocketCoins: row.pocket_coins });
      }

      // ── POST /club/join { clubId } ──
      if (request.method === "POST" && path === "/club/join") {
        const existing = await env.DB.prepare("SELECT 1 FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (existing) return json({ error: "이미 클럽에 소속돼 있습니다." }, 400);
        const body = await request.json().catch(function () { return {}; });
        const clubId = parseInt(body.clubId, 10);
        const club = await env.DB.prepare("SELECT * FROM arena_clubs WHERE id = ?").bind(clubId).first();
        if (!club) return json({ error: "존재하지 않는 클럽입니다." }, 404);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_club_members WHERE club_id = ?").bind(clubId).first();
        if ((countRow && countRow.cnt) >= CLUB_MAX_MEMBERS) return json({ error: "클럽 정원이 가득 찼습니다(최대 " + CLUB_MAX_MEMBERS + "명)." }, 400);
        await env.DB.prepare("INSERT INTO arena_club_members (user_id, club_id, user_name, role, joined_at) VALUES (?, ?, ?, 'member', ?)")
          .bind(user.userId, clubId, user.realName, Date.now()).run();
        return json({ ok: true });
      }

      // ── POST /club/leave — 리더가 나가면 가장 먼저 가입한 멤버에게 자동으로 리더를 넘긴다.
      //    혼자 남은 리더가 나가면 클럽 자체가 사라진다(관계까지 정리). ──
      if (request.method === "POST" && path === "/club/leave") {
        const membership = await env.DB.prepare("SELECT * FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership) return json({ error: "클럽에 소속돼 있지 않습니다." }, 400);
        const others = await env.DB.prepare("SELECT * FROM arena_club_members WHERE club_id = ? AND user_id != ? ORDER BY joined_at ASC").bind(membership.club_id, user.userId).all();
        await env.DB.prepare("DELETE FROM arena_club_members WHERE user_id = ?").bind(user.userId).run();
        if (membership.role === "leader") {
          if (others.results.length) {
            const next = others.results[0];
            await env.DB.prepare("UPDATE arena_club_members SET role='leader' WHERE user_id=?").bind(next.user_id).run();
            await env.DB.prepare("UPDATE arena_clubs SET leader_user_id=?, leader_name=? WHERE id=?").bind(next.user_id, next.user_name, membership.club_id).run();
          } else {
            await env.DB.batch([
              env.DB.prepare("DELETE FROM arena_clubs WHERE id = ?").bind(membership.club_id),
              env.DB.prepare("DELETE FROM arena_club_relations WHERE from_club_id = ? OR to_club_id = ?").bind(membership.club_id, membership.club_id),
            ]);
          }
        }
        return json({ ok: true });
      }

      // ── POST /club/kick { userId } — 리더 전용. ──
      if (request.method === "POST" && path === "/club/kick") {
        const membership = await env.DB.prepare("SELECT * FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership || membership.role !== "leader") return json({ error: "클럽 리더만 추방할 수 있습니다." }, 403);
        const body = await request.json().catch(function () { return {}; });
        const targetUserId = String(body.userId || "");
        if (targetUserId === user.userId) return json({ error: "자기 자신은 추방할 수 없습니다(탈퇴를 이용하세요)." }, 400);
        const target = await env.DB.prepare("SELECT * FROM arena_club_members WHERE user_id = ? AND club_id = ?").bind(targetUserId, membership.club_id).first();
        if (!target) return json({ error: "해당 멤버를 찾을 수 없습니다." }, 404);
        await env.DB.prepare("DELETE FROM arena_club_members WHERE user_id = ?").bind(targetUserId).run();
        return json({ ok: true });
      }

      // ── POST /club/disband — 리더 전용. ──
      if (request.method === "POST" && path === "/club/disband") {
        const membership = await env.DB.prepare("SELECT * FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership || membership.role !== "leader") return json({ error: "클럽 리더만 해체할 수 있습니다." }, 403);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM arena_club_members WHERE club_id = ?").bind(membership.club_id),
          env.DB.prepare("DELETE FROM arena_clubs WHERE id = ?").bind(membership.club_id),
          env.DB.prepare("DELETE FROM arena_club_relations WHERE from_club_id = ? OR to_club_id = ?").bind(membership.club_id, membership.club_id),
        ]);
        return json({ ok: true });
      }

      // ── POST /club/relation { toClubId, status } — 리더 전용. status: 'friendly'|'hostile'|'neutral'. ──
      if (request.method === "POST" && path === "/club/relation") {
        const membership = await env.DB.prepare("SELECT * FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership || membership.role !== "leader") return json({ error: "클럽 리더만 관계를 설정할 수 있습니다." }, 403);
        const body = await request.json().catch(function () { return {}; });
        const toClubId = parseInt(body.toClubId, 10);
        const status = String(body.status || "");
        if (["friendly", "hostile", "neutral"].indexOf(status) === -1) return json({ error: "잘못된 관계 상태입니다." }, 400);
        if (toClubId === membership.club_id) return json({ error: "자기 클럽에는 설정할 수 없습니다." }, 400);
        const target = await env.DB.prepare("SELECT id FROM arena_clubs WHERE id = ?").bind(toClubId).first();
        if (!target) return json({ error: "존재하지 않는 클럽입니다." }, 404);
        await env.DB.prepare(
          "INSERT INTO arena_club_relations (from_club_id, to_club_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(from_club_id, to_club_id) DO UPDATE SET status=?, updated_at=?"
        ).bind(membership.club_id, toClubId, status, Date.now(), status, Date.now()).run();
        return json({ ok: true });
      }

      // ── POST /club/contribute { amount } — 코인을 클럽 창고에 기부. 기부액만큼 클럽 XP도
      //    똑같이 쌓여서 클럽 레벨(→전 멤버 코인 보너스)의 재원이 된다. ──
      if (request.method === "POST" && path === "/club/contribute") {
        const membership = await env.DB.prepare("SELECT * FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership) return json({ error: "클럽에 소속돼 있지 않습니다." }, 400);
        const body = await request.json().catch(function () { return {}; });
        const amount = parseInt(body.amount, 10);
        if (!Number.isInteger(amount) || amount <= 0) return json({ error: "유효하지 않은 금액입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.pocket_coins < amount) return json({ error: "소지금이 부족합니다." }, 400);
        const club = await env.DB.prepare("SELECT * FROM arena_clubs WHERE id = ?").bind(membership.club_id).first();
        const levelBefore = clubLevelForXp(club.xp);

        row.pocket_coins -= amount;
        await env.DB.batch([
          env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id),
          env.DB.prepare("UPDATE arena_clubs SET bank_coins = bank_coins + ?, xp = xp + ? WHERE id=?").bind(amount, amount, club.id),
        ]);
        const levelAfter = clubLevelForXp(club.xp + amount);
        return json({ ok: true, pocketCoins: row.pocket_coins, leveledUp: levelAfter > levelBefore, newLevel: levelAfter });
      }

      // ── GET /club/chat — 내 클럽의 최근 대화 CLUB_CHAT_HISTORY개(오래된→최신 순). ──
      if (request.method === "GET" && path === "/club/chat") {
        const membership = await env.DB.prepare("SELECT club_id FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership) return json({ error: "클럽에 소속돼 있지 않습니다." }, 400);
        const res = await env.DB.prepare("SELECT * FROM arena_club_chat WHERE club_id = ? ORDER BY created_at DESC LIMIT ?").bind(membership.club_id, CLUB_CHAT_HISTORY).all();
        const messages = res.results.reverse().map(function (m) { return { id: m.id, userId: m.user_id, userName: m.user_name, message: m.message, createdAt: m.created_at }; });
        return json({ messages: messages });
      }

      // ── POST /club/chat/send { message } ──
      if (request.method === "POST" && path === "/club/chat/send") {
        const membership = await env.DB.prepare("SELECT club_id FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership) return json({ error: "클럽에 소속돼 있지 않습니다." }, 400);
        const body = await request.json().catch(function () { return {}; });
        const message = String(body.message || "").trim().slice(0, CLUB_CHAT_MAX_LEN);
        if (!message) return json({ error: "메시지를 입력하세요." }, 400);
        await env.DB.prepare("INSERT INTO arena_club_chat (club_id, user_id, user_name, message, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(membership.club_id, user.userId, user.realName, message, Date.now()).run();
        return json({ ok: true });
      }

      // ── GET /club/war-season — 이번 시즌 실시간 순위(전체 클럽 상위 50) + 내 클럽의 이번
      //    시즌 점수/순위 + 남은 시간 + "방금 끝난 시즌" 보상을 아직 안 받았으면 그 액수까지. ──
      if (request.method === "GET" && path === "/club/war-season") {
        const now = Date.now();
        const currentBucket = clubWarSeasonBucket(now);
        const nextSeasonAt = (currentBucket + 1) * CLUB_WAR_SEASON_MS;
        const standings = await clubWarStandings(env, currentBucket, 50);

        const membership = await env.DB.prepare("SELECT club_id FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        let myClubScore = 0, myClubRank = null;
        if (membership) {
          const idx = standings.findIndex(function (s) { return s.club_id === membership.club_id; });
          if (idx !== -1) { myClubScore = standings[idx].score; myClubRank = idx + 1; }
        }

        // 방금 끝난(직전) 시즌의 보상 — 이미 받았으면 다시 안 뜬다.
        let previousReward = null;
        if (membership) {
          const prevBucket = currentBucket - 1;
          const alreadyClaimed = await env.DB.prepare("SELECT 1 FROM arena_club_war_claims WHERE user_id=? AND season_bucket=?").bind(user.userId, prevBucket).first();
          if (!alreadyClaimed) {
            const prevStandings = await clubWarStandings(env, prevBucket, CLUB_WAR_REWARD_TIERS[CLUB_WAR_REWARD_TIERS.length - 1].maxRank);
            const prevIdx = prevStandings.findIndex(function (s) { return s.club_id === membership.club_id; });
            if (prevIdx !== -1) {
              const rank = prevIdx + 1;
              const coins = clubWarRewardForRank(rank);
              if (coins > 0) previousReward = { seasonBucket: prevBucket, rank: rank, coins: coins };
            }
          }
        }

        return json({
          standings: standings.map(function (s) { return { clubId: s.club_id, name: s.name, score: s.score }; }),
          myClubScore: myClubScore, myClubRank: myClubRank,
          seasonEndsAt: nextSeasonAt, rewardTiers: CLUB_WAR_REWARD_TIERS,
          previousSeasonReward: previousReward,
        });
      }

      // ── POST /club/war-season/claim — 직전 시즌 순위 보상을 청구한다. ──
      if (request.method === "POST" && path === "/club/war-season/claim") {
        const membership = await env.DB.prepare("SELECT club_id FROM arena_club_members WHERE user_id = ?").bind(user.userId).first();
        if (!membership) return json({ error: "클럽에 소속돼 있지 않습니다." }, 400);

        const prevBucket = clubWarSeasonBucket(Date.now()) - 1;
        const already = await env.DB.prepare("SELECT 1 FROM arena_club_war_claims WHERE user_id=? AND season_bucket=?").bind(user.userId, prevBucket).first();
        if (already) return json({ error: "이미 받았습니다." }, 400);

        const prevStandings = await clubWarStandings(env, prevBucket, CLUB_WAR_REWARD_TIERS[CLUB_WAR_REWARD_TIERS.length - 1].maxRank);
        const idx = prevStandings.findIndex(function (s) { return s.club_id === membership.club_id; });
        const rank = idx === -1 ? null : idx + 1;
        const coins = rank ? clubWarRewardForRank(rank) : 0;
        if (!coins) return json({ error: "직전 시즌 보상 대상이 아닙니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        row.pocket_coins += coins;
        await env.DB.batch([
          env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id),
          env.DB.prepare("INSERT INTO arena_club_war_claims (user_id, season_bucket, claimed_at) VALUES (?, ?, ?)").bind(user.userId, prevBucket, Date.now()),
        ]);
        return json({ ok: true, coins: coins, rank: rank, pocketCoins: row.pocket_coins });
      }

      // ══════════════════════════════════════════════════════════
      //  Profile — 누구나 조회 가능한 프로필(상태메시지 + 자랑 진열대 최대 3칸 + 환생 이팩트).
      // ══════════════════════════════════════════════════════════

      // ── GET /profile?userId=X — userId 생략 시 내 프로필. isSelf로 프론트가 편집 UI를
      //    보여줄지 판단한다. ──
      if (request.method === "GET" && path === "/profile") {
        const targetUserId = url.searchParams.get("userId") || user.userId;
        const profile = await buildPublicProfile(env, targetUserId);
        if (!profile) return json({ error: "존재하지 않는 유저입니다." }, 404);
        return json(Object.assign({ isSelf: targetUserId === user.userId }, profile));
      }

      // ── POST /profile/update { statusMessage, showcase: [{type,itemId|botId}], rebirthEffectEnabled } ──
      if (request.method === "POST" && path === "/profile/update") {
        const body = await request.json().catch(function () { return {}; });
        const statusMessage = String(body.statusMessage || "").trim().slice(0, PROFILE_STATUS_MAX_LEN);
        const rawShowcase = Array.isArray(body.showcase) ? body.showcase.slice(0, PROFILE_SHOWCASE_MAX) : [];

        const validated = [];
        for (const entry of rawShowcase) {
          if (entry && entry.type === "item" && SHOP_ITEMS[entry.itemId]) {
            const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, entry.itemId).first();
            if (owned && owned.qty > 0) validated.push({ type: "item", itemId: entry.itemId });
          } else if (entry && entry.type === "bot") {
            const botId = parseInt(entry.botId, 10);
            const bot = await env.DB.prepare("SELECT id FROM arena_bots WHERE id=? AND user_id=?").bind(botId, user.userId).first();
            if (bot) validated.push({ type: "bot", botId: botId });
          }
        }

        const rebirthEffectEnabled = body.rebirthEffectEnabled === false ? 0 : 1;
        await env.DB.prepare(
          "INSERT INTO arena_profiles (user_id, status_message, showcase, rebirth_effect_enabled, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET status_message=?, showcase=?, rebirth_effect_enabled=?, updated_at=?"
        ).bind(
          user.userId, statusMessage, JSON.stringify(validated), rebirthEffectEnabled, Date.now(),
          statusMessage, JSON.stringify(validated), rebirthEffectEnabled, Date.now()
        ).run();

        // 환생 마스터 전용 테마 온오프 — 편집 폼에 이 체크박스 자체가 환생 10회 미만이면 아예
        // 안 그려지므로(잠금), body에 필드가 없을 땐 건드리지 않는다(값을 없앤 걸로 오해해서
        // 매번 강제로 다시 켜는 걸 방지).
        if (body.maxThemeEnabled !== undefined) {
          const maxThemeEnabled = body.maxThemeEnabled === false ? 0 : 1;
          await env.DB.prepare("UPDATE arena_users SET max_theme_enabled = ? WHERE user_id = ?").bind(maxThemeEnabled, user.userId).run();
        }

        const profile = await buildPublicProfile(env, user.userId);
        return json(Object.assign({ ok: true, isSelf: true }, profile));
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
        const row0 = await loadOrCreateUser(env, user.userId, user.realName);
        const ownedRes = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const ownedMap = {};
        ownedRes.results.forEach(function (o) { ownedMap[o.item_id] = o.qty; });
        const equippedCount = await equippedCountMap(env, user.userId);
        const rotation = computeShopRotation(Date.now(), user.userId, row0.research_shop_level, row0.shop_reroll_nonce, effectiveMinShopItems(row0.research_shop_slots_level));
        // 재고는 "자연 로테이션 구간(bucket)"뿐 아니라 "몇 번째 리롤인지(shop_reroll_nonce)"까지
        // 합쳐서 키로 쓴다 — 안 그러면 common/uncommon처럼 후보가 적어 리롤해도 거의 항상 같은
        // 아이템이 다시 뜨는 등급은, 품절시켜 놓고 리롤해도 같은 재고 카운터를 계속 보게 되어
        // "리롤해도 품절 그대로"인 것처럼 보이는 버그가 있었다.
        const stockBucket = rotation.bucket * 1000000 + (row0.shop_reroll_nonce || 0);
        const stockRes = await env.DB.prepare("SELECT item_id, bought FROM arena_shop_stock2 WHERE user_id = ? AND bucket = ?").bind(user.userId, stockBucket).all();
        const boughtMap = {};
        stockRes.results.forEach(function (s) { boughtMap[s.item_id] = s.bought; });
        const entries = rotation.itemIds.map(function (id) { return [id, SHOP_ITEMS[id]]; });
        const items = sortedShopEntries(entries).map(function (pair) {
          const id = pair[0], item = pair[1];
          const totalStock = rollItemStock(id, stockBucket, item.rarity, user.userId);
          const remainingStock = Math.max(0, totalStock - (boughtMap[id] || 0));
          return Object.assign({ id: id }, item, {
            rarityLabel: RARITY_META[item.rarity].label, rarityColor: RARITY_META[item.rarity].color,
            typeLabel: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].label : null,
            typeColor: ITEM_TYPE_META[item.type] ? ITEM_TYPE_META[item.type].color : null,
            owned: ownedMap[id] || 0, equipped: equippedCount[id] || 0,
            totalStock: totalStock, remainingStock: remainingStock,
          });
        });
        return json({
          items: items, nextRotationAt: rotation.nextRotationAt, rotationMs: SHOP_ROTATION_MS,
          diamonds: row0.diamonds, diamondExchangeCost: DIAMOND_EXCHANGE_COIN_COST, rerollCost: SHOP_REROLL_DIAMOND_COST,
        });
      }

      // ── POST /shop/exchange-diamond — 코인 → 다이아 교환(단방향). qty로 여러 개 한 번에 가능. ──
      if (request.method === "POST" && path === "/shop/exchange-diamond") {
        const body = await request.json().catch(function () { return {}; });
        const qty = Math.max(1, parseInt(body.qty, 10) || 1);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const totalCost = DIAMOND_EXCHANGE_COIN_COST * qty;
        if (row.pocket_coins < totalCost) return json({ error: "코인이 부족합니다. (필요 " + fmtNum(totalCost) + ")" }, 400);
        row.pocket_coins -= totalCost;
        row.diamonds += qty;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=?, diamonds=? WHERE user_id=?").bind(row.pocket_coins, row.diamonds, row.user_id).run();
        return json({ ok: true, pocketCoins: row.pocket_coins, diamonds: row.diamonds });
      }

      // ── POST /shop/reroll — 다이아 2개로 자연 타이머를 기다리지 않고 내 상점 목록만 즉시
      //    다시 뽑는다. rerollNonce를 1 늘리는 게 전부라 다음 자연 로테이션 시각(nextRotationAt)
      //    자체는 안 바뀐다 — "지금 이 목록이 마음에 안 들 때 한 번 더 보는" 용도. ──
      if (request.method === "POST" && path === "/shop/reroll") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.diamonds < SHOP_REROLL_DIAMOND_COST) return json({ error: "다이아가 부족합니다. (필요 " + SHOP_REROLL_DIAMOND_COST + ")" }, 400);
        row.diamonds -= SHOP_REROLL_DIAMOND_COST;
        row.shop_reroll_nonce += 1;
        await env.DB.prepare("UPDATE arena_users SET diamonds=?, shop_reroll_nonce=? WHERE user_id=?").bind(row.diamonds, row.shop_reroll_nonce, row.user_id).run();
        return json({ ok: true, diamonds: row.diamonds });
      }

      if (request.method === "POST" && path === "/shop/buy") {
        const body = await request.json().catch(function () { return {}; });
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item) return json({ error: "알 수 없는 아이템입니다." }, 400);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const rotation = computeShopRotation(Date.now(), user.userId, row.research_shop_level, row.shop_reroll_nonce, effectiveMinShopItems(row.research_shop_slots_level));
        if (rotation.itemIds.indexOf(itemId) === -1) return json({ error: "지금 상점에 없는 아이템입니다(로테이션이 바뀌었어요)." }, 400);

        if (row.pocket_coins < item.price) return json({ error: "코인이 부족합니다." }, 400);

        // 아이템별 최대 보유 개수(maxOwned) — 예: 에너지 드링크는 최대 2개까지만 들고 있을 수 있다.
        if (item.maxOwned) {
          const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
          if (owned && owned.qty >= item.maxOwned) {
            return json({ error: item.name + "은(는) 최대 " + item.maxOwned + "개까지만 보유할 수 있습니다." }, 400);
          }
        }

        // 상점 재고(로테이션당 1~3개, 장착 아이템도 포함, 이제 유저별로 따로) — 조건부
        // UPDATE(bought < total)로 품절 이후엔 나 자신도 더 못 사게 막는다. 재고 키는 리롤
        // 횟수까지 합쳐서 계산한다(위 GET /shop과 동일한 이유).
        const stockBucket = rotation.bucket * 1000000 + (row.shop_reroll_nonce || 0);
        const totalStock = rollItemStock(itemId, stockBucket, item.rarity, user.userId);
        const stockRes = await env.DB.prepare(
          "INSERT INTO arena_shop_stock2 (user_id, item_id, bucket, bought) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, item_id, bucket) DO UPDATE SET bought = bought + 1 WHERE bought < ?"
        ).bind(user.userId, itemId, stockBucket, totalStock).run();
        if (!stockRes.meta.changes) return json({ error: "품절된 아이템입니다. 다음 로테이션을 기다려주세요." }, 400);

        row.pocket_coins -= item.price;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id).run();
        await env.DB.prepare(
          "INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1"
        ).bind(user.userId, itemId).run();
        await bumpDailyProgress(env, user.userId, "purchases");

        return json({ ok: true, pocketCoins: row.pocket_coins });
      }

      if (request.method === "GET" && path === "/inventory") {
        const res = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const equippedCount = await equippedCountMap(env, user.userId);
        const items = res.results.map(function (r) {
          const item = SHOP_ITEMS[r.item_id];
          return Object.assign({ id: r.item_id, qty: r.qty, available: r.qty - (equippedCount[r.item_id] || 0) }, item, {
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
        if (!item || (item.type !== "consumable" && item.type !== "box")) return json({ error: "사용할 수 없는 아이템입니다." }, 400);
        const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
        if (!owned || owned.qty <= 0) return json({ error: "보유하지 않은 아이템입니다." }, 400);

        // ── 상자 개봉 — 소비재(hp/energy/stamina)와 달리 무기/방어/코어 하나를 새로 지급한다.
        //    openBoxRoll이 이 상자의 boxTiers(자기/다음/다다음 등급) 중 하나를 75/20/5%로
        //    뽑고, 그 등급의 장비 하나를 균등하게 골라준다. ──
        if (item.type === "box") {
          const wonItemId = openBoxRoll(item);
          const wonItem = wonItemId ? SHOP_ITEMS[wonItemId] : null;
          if (!wonItem) return json({ error: "상자 결과를 생성하지 못했습니다. 다시 시도해주세요." }, 500);
          await env.DB.batch([
            owned.qty <= 1
              ? env.DB.prepare("DELETE FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId)
              : env.DB.prepare("UPDATE arena_inventory SET qty = qty - 1 WHERE user_id=? AND item_id=?").bind(user.userId, itemId),
            env.DB.prepare("INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1").bind(user.userId, wonItemId),
          ]);
          return json({
            ok: true, boxOpened: true, wonItemId: wonItemId, wonItemName: wonItem.name,
            wonRarity: wonItem.rarity, wonRarityLabel: RARITY_META[wonItem.rarity].label, wonRarityColor: RARITY_META[wonItem.rarity].color,
          });
        }

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
        const botsRes = await env.DB.prepare("SELECT id, equipped_weapon, equipped_armor, equipped_core, recruit_cost, stationed_planet_id, gacha_rarity FROM arena_bots WHERE user_id = ? ORDER BY id").bind(user.userId).all();
        const ownedRes = await env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all();
        const equippedCount = await equippedCountMap(env, user.userId);
        const rawEntries = ownedRes.results
          .map(function (o) { return [o.item_id, Object.assign({ available: o.qty - (equippedCount[o.item_id] || 0) }, SHOP_ITEMS[o.item_id])]; })
          .filter(function (pair) { return pair[1].available > 0 && (pair[1].type === "weapon" || pair[1].type === "armor" || pair[1].type === "core"); });
        const availableItems = sortedShopEntries(rawEntries).map(function (pair) {
          return Object.assign({ id: pair[0] }, pair[1], { rarityLabel: RARITY_META[pair[1].rarity].label, rarityColor: RARITY_META[pair[1].rarity].color });
        });
        // 봇은 레벨 개념이 없어서 equipStats(장비 보너스)가 곧 그 봇의 전투력 전부다(totalCombatStats
        // 에서도 봇은 base 없이 equipStats만 더함) — 그대로 ATK/DEF/CRIT 수치로 보여준다(인챈트
        // 보너스 포함, 실제 전투 판정과 정확히 같은 값).
        // gacha_rarity가 없으면(한 번도 가챠를 안 돌린 봇) 등급 배지 자체가 없는 상태다.
        const enchantMap = await loadEnchantMap(env, user.userId);
        const enchantMaxLvl = enchantMaxLevelFor(row);
        const botMaxCnt = botMaxCountFor(row);
        const botsWithStats = botsRes.results.map(function (b) {
          return Object.assign({}, b, {
            stats: equipStats(b, enchantMap, enchantMaxLvl),
            gachaRarityLabel: b.gacha_rarity ? RARITY_META[b.gacha_rarity].label : null,
            gachaRarityColor: b.gacha_rarity ? RARITY_META[b.gacha_rarity].color : null,
          });
        });
        // 경비병 배치 UI(드롭다운) 재료 — 내가 정복한 야생 행성(홈 제외) 목록 + 행성별 현재
        // 경비병 수(이 유저 소유 봇 중 stationed_planet_id로 이미 다 갖고 있으니 별도 쿼리 없이
        // JS에서 그룹화). 홈 행성은 애초에 배치 대상이 아니라 목록에서 제외한다.
        const myPlanetsRes = await env.DB.prepare("SELECT id, name FROM arena_planets WHERE owner_user_id = ? AND is_home = 0 ORDER BY id").bind(user.userId).all();
        const garrisonCounts = {};
        botsRes.results.forEach(function (b) { if (b.stationed_planet_id) garrisonCounts[b.stationed_planet_id] = (garrisonCounts[b.stationed_planet_id] || 0) + 1; });
        const stationOptions = myPlanetsRes.results.map(function (p) {
          return { id: p.id, name: p.name, garrisonCount: garrisonCounts[p.id] || 0 };
        });
        return json({
          player: { equippedWeapon: row.equipped_weapon, equippedArmor: row.equipped_armor, equippedCore: row.equipped_core, stats: equipStats(row, enchantMap, enchantMaxLvl) },
          bots: botsWithStats,
          botCount: botsRes.results.length,
          maxBots: botMaxCnt,
          nextBotCost: botsRes.results.length < botMaxCnt ? botRecruitCost(botsRes.results.length) : null,
          botSellRate: BOT_SELL_RATE,
          availableItems: availableItems,
          stationOptions: stationOptions, garrisonMax: PLANET_GARRISON_MAX_PER_PLANET,
        });
      }

      if (request.method === "POST" && path === "/bots/recruit") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const botMaxCnt = botMaxCountFor(row);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_bots WHERE user_id = ?").bind(user.userId).first();
        const count = (countRow && countRow.cnt) || 0;
        if (count >= botMaxCnt) return json({ error: "더 이상 봇을 모집할 수 없습니다(최대 " + botMaxCnt + "기)." }, 400);
        const cost = botRecruitCost(count);
        if (row.pocket_coins < cost) return json({ error: "코인이 부족합니다. (필요 " + fmtNum(cost) + ")" }, 400);

        await env.DB.prepare("UPDATE arena_users SET pocket_coins = pocket_coins - ? WHERE user_id = ?").bind(cost, user.userId).run();
        await env.DB.prepare("INSERT INTO arena_bots (user_id, recruit_cost, created_at) VALUES (?, ?, ?)").bind(user.userId, cost, Date.now()).run();
        return json({ ok: true, cost: cost, pocketCoins: row.pocket_coins - cost });
      }

      // ── POST /bots/station { botId, planetId } — 봇을 내가 정복한 야생 행성(홈 제외)에
      //    경비병으로 배치한다. 배치된 순간부터 그 봇은 totalCombatStats(개인 전투력)에서
      //    빠지고 오직 그 행성 하나의 방어에만 쓰인다 — 내가 세질지, 내 것을 지킬지의 진짜
      //    트레이드오프. planetId를 비우거나 null로 보내면 배치를 풀고 "나와 함께"로 귀환시킨다. ──
      if (request.method === "POST" && path === "/bots/station") {
        const body = await request.json().catch(function () { return {}; });
        const botId = parseInt(body.botId, 10);
        const bot = await env.DB.prepare("SELECT id FROM arena_bots WHERE id = ? AND user_id = ?").bind(botId, user.userId).first();
        if (!bot) return json({ error: "봇을 찾을 수 없습니다." }, 404);

        const planetIdRaw = body.planetId;
        if (planetIdRaw === null || planetIdRaw === undefined || planetIdRaw === "") {
          await env.DB.prepare("UPDATE arena_bots SET stationed_planet_id = NULL WHERE id = ?").bind(botId).run();
          return json({ ok: true, stationedPlanetId: null });
        }

        const planetId = parseInt(planetIdRaw, 10);
        const planet = await env.DB.prepare("SELECT * FROM arena_planets WHERE id = ? AND owner_user_id = ?").bind(planetId, user.userId).first();
        if (!planet) return json({ error: "내가 소유한 행성이 아닙니다." }, 400);
        if (planet.is_home) return json({ error: "홈 행성은 별도의 고정 방어 공식을 써서 경비병을 배치할 수 없습니다." }, 400);

        const cntRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM arena_bots WHERE stationed_planet_id = ? AND id != ?").bind(planetId, botId).first();
        const cnt = (cntRow && cntRow.cnt) || 0;
        if (cnt >= PLANET_GARRISON_MAX_PER_PLANET) {
          return json({ error: "이 행성엔 이미 경비병이 가득합니다(최대 " + PLANET_GARRISON_MAX_PER_PLANET + "기)." }, 400);
        }

        await env.DB.prepare("UPDATE arena_bots SET stationed_planet_id = ? WHERE id = ?").bind(planetId, botId).run();
        return json({ ok: true, stationedPlanetId: planetId, planetName: planet.name });
      }

      // ── POST /bots/gacha { botId, tier } — 그 봇의 무장/방어/코어 3슬롯을 한 번에 랜덤으로
      //    뽑아서 무조건 새로 장착한다. 예전엔 "새로 뽑은 게 지금 장착된 것보다 등급이 같거나
      //    높을 때만" 교체했는데, 그 로직 때문에 실제로는 버그가 하나 있었다 — 어비샬 아이템은
      //    가챠 테이블 자체에 없어서(EQUIP_ITEM_BY_TYPE_RARITY 참고, 최고가 forbidden) 어비샬을
      //    수동 장착해 둔 슬롯은 그 뒤로 무슨 가챠를 돌려도 "롤 결과가 어비샬 이상일 때만
      //    교체"라는 조건을 영원히 못 만족해 항상 그대로 어비샬로 남았다. 겉보기엔 "가챠가
      //    자동으로 어비샬만 뽑는" 것처럼 보이지만 실은 롤 자체는 정상 랜덤이고 결과가 그냥
      //    무시되고 있었던 것 — 가챠는 순수 랜덤이어야 하고 지금 장착된 것과는 무관해야
      //    한다는 요청(신고)을 반영해 이 "보호" 로직 자체를 없앴다. ──
      if (request.method === "POST" && path === "/bots/gacha") {
        const body = await request.json().catch(function () { return {}; });
        const tierDef = BOT_GACHA_TIERS[body.tier];
        if (!tierDef) return json({ error: "알 수 없는 가챠 등급입니다." }, 400);
        const botId = parseInt(body.botId, 10);
        const bot = await env.DB.prepare("SELECT id FROM arena_bots WHERE id = ? AND user_id = ?").bind(botId, user.userId).first();
        if (!bot) return json({ error: "봇을 찾을 수 없습니다." }, 404);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.pocket_coins < tierDef.price) return json({ error: "코인이 부족합니다. (필요 " + fmtNum(tierDef.price) + ")" }, 400);

        const rolled = rollBotGacha(body.tier);
        row.pocket_coins -= tierDef.price;

        await env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(row.pocket_coins, row.user_id).run();
        // 가챠로 나온 3개는 인벤토리에도 정식으로 한 벌씩 쌓아둔다 — 이래야 이 봇을 되팔아도
        // (장비 슬롯만 비워질 뿐 인벤토리 소유는 그대로 남음) 장비가 사라지지 않고, 다른
        // 슬롯에 다시 꺼내 쓸 수도 있다.
        await env.DB.batch([
          env.DB.prepare("INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1").bind(user.userId, rolled.weapon),
          env.DB.prepare("INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1").bind(user.userId, rolled.armor),
          env.DB.prepare("INSERT INTO arena_inventory (user_id, item_id, qty) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET qty = qty + 1").bind(user.userId, rolled.core),
          env.DB.prepare("UPDATE arena_bots SET equipped_weapon=?, equipped_armor=?, equipped_core=?, gacha_rarity=? WHERE id=?").bind(rolled.weapon, rolled.armor, rolled.core, rolled.bestRarity, botId),
        ]);

        return json({
          ok: true, pocketCoins: row.pocket_coins,
          weapon: rolled.weapon, armor: rolled.armor, core: rolled.core,
          bestRarity: rolled.bestRarity, rarityLabel: RARITY_META[rolled.bestRarity].label, rarityColor: RARITY_META[rolled.bestRarity].color,
        });
      }

      // ── POST /bots/sell { botId } — 모집 당시 낸 비용(recruit_cost)의 BOT_SELL_RATE(50%)만
      //    환불하고 그 봇을 삭제한다. 장착돼 있던 장비(수동 장착이든 가챠든 이제 둘 다 인벤토리에
      //    정식으로 보유 중이므로)는 인벤토리 수량 그대로 남아있으니 다른 슬롯에 다시 쓸 수
      //    있다 — 봇의 equipped_* 참조만 사라질 뿐 인벤토리 쪽 소유 자체는 건드리지 않는다. ──
      if (request.method === "POST" && path === "/bots/sell") {
        const body = await request.json().catch(function () { return {}; });
        const botId = parseInt(body.botId, 10);
        const bot = await env.DB.prepare("SELECT id, recruit_cost FROM arena_bots WHERE id = ? AND user_id = ?").bind(botId, user.userId).first();
        if (!bot) return json({ error: "봇을 찾을 수 없습니다." }, 404);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const refund = Math.floor((bot.recruit_cost || BOT_BASE_COST) * BOT_SELL_RATE);
        row.pocket_coins += refund;
        await env.DB.prepare("UPDATE arena_users SET pocket_coins = ? WHERE user_id = ?").bind(row.pocket_coins, row.user_id).run();
        await env.DB.prepare("DELETE FROM arena_bots WHERE id = ?").bind(botId).run();

        return json({ ok: true, refund: refund, pocketCoins: row.pocket_coins });
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

      // ══════════════════════════════════════════════════════════
      //  Enchant — 무기/방어/코어를 코인으로 영구 강화한다(레벨당 +2%, 최대 10레벨 +20%).
      //  아이템은 인스턴스가 아니라 재고 수량으로만 존재하므로, 강화도 "이 유저가 이 아이템
      //  종류를 얼마나 마스터했는지"로 (user_id, item_id)당 레벨 하나로 관리 — 그 유저가 가진
      //  그 아이템 전부(본인 장착 + 봇 장착)에 동일하게 적용된다. 최소 1개 보유해야 강화를
      //  시작/추가할 수 있지만, 한번 오른 레벨은 나중에 다 팔아도 그대로 남는다(투자 보존).
      // ══════════════════════════════════════════════════════════

      // ── GET /enchants — 무기/방어/코어 타입 아이템 전부(보유 여부 무관, 상점 카탈로그처럼)에
      //    대해 내 현재 강화 레벨/다음 비용/보유 수량을 같이 내려준다. ──
      if (request.method === "GET" && path === "/enchants") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const maxLevel = enchantMaxLevelFor(row);
        const [enchantMap, ownedRes] = await Promise.all([
          loadEnchantMap(env, user.userId),
          env.DB.prepare("SELECT item_id, qty FROM arena_inventory WHERE user_id = ?").bind(user.userId).all(),
        ]);
        const ownedQty = {};
        ownedRes.results.forEach(function (r) { ownedQty[r.item_id] = r.qty; });
        // 한 번도 얻어본 적 없는 아이템은 아예 목록에 안 보인다 — "지금 보유 중"이거나(qty>0)
        // "예전에 얻어서 강화까지 해뒀다가 지금은 다 팔았음"(level>0, 투자는 유지됨) 둘 중
        //하나라도 해당해야 노출한다. 둘 다 아니면 그 아이템은 아직 본 적도 없는 것이므로 제외.
        const entries = Object.keys(SHOP_ITEMS)
          .map(function (id) { return [id, SHOP_ITEMS[id]]; })
          .filter(function (pair) {
            const id = pair[0], item = pair[1];
            if (item.type !== "weapon" && item.type !== "armor" && item.type !== "core") return false;
            return (ownedQty[id] || 0) > 0 || (enchantMap[id] || 0) > 0;
          });
        const items = sortedShopEntries(entries).map(function (pair) {
          const id = pair[0], item = pair[1];
          const level = enchantMap[id] || 0;
          return Object.assign({ id: id }, item, {
            rarityLabel: RARITY_META[item.rarity].label, rarityColor: RARITY_META[item.rarity].color,
            typeLabel: ITEM_TYPE_META[item.type].label, typeColor: ITEM_TYPE_META[item.type].color,
            owned: ownedQty[id] || 0, level: level, maxLevel: maxLevel,
            bonusPct: Math.round(enchantMultiplier(level, maxLevel) * 10000 - 10000) / 100,
            nextCost: level >= maxLevel ? null : enchantUpgradeCost(item, level),
          });
        });
        return json({ items: items, maxLevel: maxLevel, bonusPctPerLevel: ENCHANT_BONUS_PCT_PER_LEVEL * 100 });
      }

      // ── POST /enchants/upgrade { itemId } — 코인을 내고 그 아이템 종류의 강화 레벨을 1
      //    올린다. 최소 1개는 보유하고 있어야 한다(전혀 가져본 적 없는 장비를 강화할 순 없음). ──
      if (request.method === "POST" && path === "/enchants/upgrade") {
        const body = await request.json().catch(function () { return {}; });
        const itemId = body.itemId;
        const item = SHOP_ITEMS[itemId];
        if (!item || (item.type !== "weapon" && item.type !== "armor" && item.type !== "core")) {
          return json({ error: "강화할 수 없는 아이템입니다." }, 400);
        }
        const owned = await env.DB.prepare("SELECT qty FROM arena_inventory WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
        if (!owned || owned.qty <= 0) return json({ error: "보유하지 않은 아이템은 강화할 수 없습니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const maxLevel = enchantMaxLevelFor(row);
        const existing = await env.DB.prepare("SELECT level FROM arena_item_enchants WHERE user_id=? AND item_id=?").bind(user.userId, itemId).first();
        const currentLevel = existing ? existing.level : 0;
        if (currentLevel >= maxLevel) return json({ error: "이미 최대 강화 레벨입니다." }, 400);
        const cost = enchantUpgradeCost(item, currentLevel);
        if (row.pocket_coins < cost) return json({ error: "코인이 부족합니다. (필요 " + fmtNum(cost) + ")" }, 400);

        row.pocket_coins -= cost;
        await env.DB.batch([
          env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id),
          env.DB.prepare(
            "INSERT INTO arena_item_enchants (user_id, item_id, level) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET level = level + 1"
          ).bind(user.userId, itemId),
        ]);
        const newLevel = currentLevel + 1;
        return json({
          ok: true, pocketCoins: row.pocket_coins, itemId: itemId, level: newLevel,
          bonusPct: Math.round(enchantMultiplier(newLevel, maxLevel) * 10000 - 10000) / 100,
          nextCost: newLevel >= maxLevel ? null : enchantUpgradeCost(item, newLevel),
        });
      }

      // ══════════════════════════════════════════════════════════
      //  Achievements — 업적을 깨면 코인 보상 + 칭호(닉네임 옆에 다는 표시) 해금.
      // ══════════════════════════════════════════════════════════

      // ── GET /achievements — 전체 목록 + 각각의 달성/청구 여부, 지금 장착 중인 칭호 id. ──
      if (request.method === "GET" && path === "/achievements") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const [ctx, claimsRes] = await Promise.all([
          buildAchievementContext(env, row),
          env.DB.prepare("SELECT achievement_id FROM arena_achievement_claims WHERE user_id = ?").bind(user.userId).all(),
        ]);
        const claimed = new Set(claimsRes.results.map(function (r) { return r.achievement_id; }));
        const items = Object.keys(ACHIEVEMENTS).map(function (id) {
          const a = ACHIEVEMENTS[id];
          return {
            id: id, name: a.name, desc: a.desc, title: a.title, reward: a.reward,
            completed: !!a.check(ctx), claimed: claimed.has(id),
          };
        });
        return json({ items: items, equippedTitleId: row.equipped_title_id || null });
      }

      // ── POST /achievements/claim { id } — 달성했는데 아직 안 받은 보상을 청구한다. ──
      if (request.method === "POST" && path === "/achievements/claim") {
        const body = await request.json().catch(function () { return {}; });
        const id = body.id;
        const achievement = ACHIEVEMENTS[id];
        if (!achievement) return json({ error: "존재하지 않는 업적입니다." }, 404);

        const already = await env.DB.prepare("SELECT 1 FROM arena_achievement_claims WHERE user_id=? AND achievement_id=?").bind(user.userId, id).first();
        if (already) return json({ error: "이미 받은 업적입니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const ctx = await buildAchievementContext(env, row);
        if (!achievement.check(ctx)) return json({ error: "아직 달성 조건을 채우지 못했습니다." }, 400);

        // 개인용 activityBoostMult(환생 직후/일일완료)는 여기선 안 곱한다(1회성 업적까지
        // 배로 주면 그 부스트 타이밍에 몰아 청구하는 꼼수가 생김) — 다만 전역 이벤트(GM이
        // 켠 기간 한정 코인·EXP 2배)는 "몰아서 청구"할 방법이 없는 서버 전체 배율이라 예외로
        // 곱한다.
        const eventMult = globalEventMult();
        const coinReward = Math.round(achievement.reward * eventMult);
        row.pocket_coins += coinReward;
        // 업적은 1회성 큰 보상이라 경험치도 그만큼 후하게(ACHIEVEMENT_CLAIM_XP_PCT) 준다.
        const xpGain = Math.round(xpPct(row, ACHIEVEMENT_CLAIM_XP_PCT) * eventMult);
        const leveledUp = applyXpAndLevel(row, xpGain);
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE arena_users SET pocket_coins=?, xp=?, level=?, stat_points=?, hp=?, energy=?, stamina=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
          ).bind(row.pocket_coins, row.xp, row.level, row.stat_points, row.hp, row.energy, row.stamina, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id),
          env.DB.prepare("INSERT INTO arena_achievement_claims (user_id, achievement_id, claimed_at) VALUES (?, ?, ?)").bind(user.userId, id, Date.now()),
        ]);
        return json({ ok: true, reward: coinReward, pocketCoins: row.pocket_coins, title: achievement.title, xpGained: xpGain, leveledUp: leveledUp });
      }

      // ── POST /achievements/set-title { id|null } — 업적 칭호 또는 환생 상점에서 산 칭호로
      //    장착 변경(닉네임 옆에 표시). null이면 칭호를 뗀다. 두 출처 중 어디서 왔는지는
      //    id만 보고 구분한다(ACHIEVEMENTS에 있으면 업적 달성 여부, REBIRTH_SHOP_ITEMS에
      //    있으면 구매 여부를 확인). ──
      if (request.method === "POST" && path === "/achievements/set-title") {
        const body = await request.json().catch(function () { return {}; });
        const id = body.id;
        if (id === null || id === undefined || id === "") {
          await env.DB.prepare("UPDATE arena_users SET equipped_title_id = NULL WHERE user_id = ?").bind(user.userId).run();
          return json({ ok: true, equippedTitleId: null, equippedTitle: null });
        }
        if (ACHIEVEMENTS[id]) {
          const claimedRow = await env.DB.prepare("SELECT 1 FROM arena_achievement_claims WHERE user_id=? AND achievement_id=?").bind(user.userId, id).first();
          if (!claimedRow) return json({ error: "아직 받지 않은 업적의 칭호는 장착할 수 없습니다." }, 400);
        } else if (REBIRTH_SHOP_ITEMS[id] && REBIRTH_SHOP_ITEMS[id].type === "title") {
          const row = await loadOrCreateUser(env, user.userId, user.realName);
          if (!rebirthShopOwnedSet(row).has(id)) return json({ error: "환생 상점에서 구매하지 않은 칭호입니다." }, 400);
        } else {
          return json({ error: "존재하지 않는 칭호입니다." }, 404);
        }
        await env.DB.prepare("UPDATE arena_users SET equipped_title_id = ? WHERE user_id = ?").bind(id, user.userId).run();
        return json({ ok: true, equippedTitleId: id, equippedTitle: lookupTitleText(id) });
      }

      // ══════════════════════════════════════════════════════════
      //  Rebirth Shop — 환생으로만 얻는 "환생석"을 소비하는 전용 상점. 코인/다이아 경제와
      //  완전히 분리된 명예/코스메틱 재화라 인플레이션 걱정 없이 계속 늘려도 안전하다.
      // ══════════════════════════════════════════════════════════

      // ── GET /rebirth-shop — 보유 환생석 + 카탈로그(구매 여부 포함). ──
      if (request.method === "GET" && path === "/rebirth-shop") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const owned = rebirthShopOwnedSet(row);
        const items = Object.keys(REBIRTH_SHOP_ITEMS).map(function (id) {
          return Object.assign({ id: id, owned: owned.has(id) }, REBIRTH_SHOP_ITEMS[id]);
        });
        return json({ stones: row.rebirth_stones || 0, items: items, equippedTitleId: row.equipped_title_id || null });
      }

      // ── POST /rebirth-shop/buy { itemId } — 환생석으로 전용 소장품을 1회성으로 구매한다
      //    (전부 중복 구매 불가). 코인 상점과 달리 재고/로테이션 개념이 없다. ──
      if (request.method === "POST" && path === "/rebirth-shop/buy") {
        const body = await request.json().catch(function () { return {}; });
        const itemId = String(body.itemId || "");
        const item = REBIRTH_SHOP_ITEMS[itemId];
        if (!item) return json({ error: "존재하지 않는 아이템입니다." }, 404);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const owned = rebirthShopOwnedSet(row);
        if (owned.has(itemId)) return json({ error: "이미 보유한 아이템입니다." }, 400);
        if ((row.rebirth_stones || 0) < item.cost) return json({ error: "환생석이 부족합니다. (필요 💠" + item.cost + ")" }, 400);
        owned.add(itemId);
        row.rebirth_stones -= item.cost;
        row.rebirth_shop_owned = JSON.stringify(Array.from(owned));
        // diamond_grant 타입은 "소장품"이 아니라 1회성 즉시 보상 — owned 플래그로 중복 수령만 막는다.
        if (item.type === "diamond_grant") row.diamonds += item.diamonds;
        await env.DB.prepare("UPDATE arena_users SET rebirth_stones=?, rebirth_shop_owned=?, diamonds=? WHERE user_id=?")
          .bind(row.rebirth_stones, row.rebirth_shop_owned, row.diamonds, row.user_id).run();
        return json({ ok: true, stones: row.rebirth_stones, diamonds: row.diamonds, itemId: itemId });
      }

      // ══════════════════════════════════════════════════════════
      //  Research — 다이아(diamonds)로 진행하는 연구. 코인과 완전히 분리된 특수 재화라
      //  코인 인플레이션과 무관하게 "얼마나 오래 했는지"를 보여주는 별도 진행도로 쓴다.
      // ══════════════════════════════════════════════════════════

      // ── GET /research — 현재 다이아, 상점 행운 연구 레벨/다음 비용/등급별 현재 확률,
      //    원정 연구 해금 여부/비용을 한 번에 내려준다. ──
      if (request.method === "GET" && path === "/research") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const rarityChances = {};
        RARITY_ORDER.forEach(function (r) { rarityChances[r] = effectiveRarityChance(r, row.research_shop_level); });
        return json({
          diamonds: row.diamonds,
          shopLevel: row.research_shop_level,
          shopUpgradeCost: researchShopUpgradeCost(row.research_shop_level),
          rarityChances: rarityChances,
          rarityLabels: Object.fromEntries(RARITY_ORDER.map(function (r) { return [r, RARITY_META[r].label]; })),
          rarityColors: Object.fromEntries(RARITY_ORDER.map(function (r) { return [r, RARITY_META[r].color]; })),
          expeditionUnlocked: !!row.research_expedition_unlocked,
          expeditionUnlockCost: RESEARCH_EXPEDITION_UNLOCK_COST,
          slotsLevel: row.research_shop_slots_level || 0,
          slotsMaxLevel: RESEARCH_SLOTS_MAX_LEVEL,
          slotsCurrentMin: effectiveMinShopItems(row.research_shop_slots_level),
          slotsUpgradeCost: (row.research_shop_slots_level || 0) >= RESEARCH_SLOTS_MAX_LEVEL ? null : researchSlotsUpgradeCost(row.research_shop_slots_level || 0),
          // 영구 EXP 부스터 — 환생 여부와 무관하게 처음부터 연구 가능(옛 환생 가속 연구 자리 대체).
          expBoosterLevel: row.research_exp_booster_level || 0,
          expBoosterMaxLevel: EXP_BOOSTER_MAX_LEVEL,
          expBoosterMult: expBoosterMult(row),
          expBoosterNextMult: EXP_BOOSTER_MULTS[Math.min((row.research_exp_booster_level || 0) + 1, EXP_BOOSTER_MAX_LEVEL)],
          expBoosterUpgradeCost: expBoosterUpgradeCost(row.research_exp_booster_level || 0),
        });
      }

      // ── POST /research/shop-upgrade — 다이아를 써서 상점 행운 연구 레벨을 1 올린다.
      //    비용은 매 레벨 RESEARCH_SHOP_GROWTH배씩 뛰어서 위로 갈수록 훨씬 비싸진다. ──
      if (request.method === "POST" && path === "/research/shop-upgrade") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const cost = researchShopUpgradeCost(row.research_shop_level);
        if (row.diamonds < cost) return json({ error: "다이아가 부족합니다. (필요 " + cost + ")" }, 400);
        row.diamonds -= cost;
        row.research_shop_level += 1;
        await env.DB.prepare("UPDATE arena_users SET diamonds=?, research_shop_level=? WHERE user_id=?").bind(row.diamonds, row.research_shop_level, row.user_id).run();
        return json({ ok: true, diamonds: row.diamonds, shopLevel: row.research_shop_level, nextCost: researchShopUpgradeCost(row.research_shop_level) });
      }

      // ── POST /research/expedition-unlock — 다이아 1회 소모로 "원정"(오프라인 자동 전투)을
      //    영구 해금한다. 해금되면 Galaxy Map에서 정예/악몽/극한 등급 행성에 원정을 보낼 수
      //    있다(태세 선택도 타이밍 미니게임도 없이 서버가 즉시 판정 — 그 자리에 없어도 됨). ──
      if (request.method === "POST" && path === "/research/expedition-unlock") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        if (row.research_expedition_unlocked) return json({ error: "이미 해금했습니다." }, 400);
        if (row.diamonds < RESEARCH_EXPEDITION_UNLOCK_COST) return json({ error: "다이아가 부족합니다. (필요 " + RESEARCH_EXPEDITION_UNLOCK_COST + ")" }, 400);
        row.diamonds -= RESEARCH_EXPEDITION_UNLOCK_COST;
        row.research_expedition_unlocked = 1;
        await env.DB.prepare("UPDATE arena_users SET diamonds=?, research_expedition_unlocked=1 WHERE user_id=?").bind(row.diamonds, row.user_id).run();
        return json({ ok: true, diamonds: row.diamonds, expeditionUnlocked: true });
      }

      // ── POST /research/slots-upgrade — 다이아를 써서 상점에 뜨는 최소 진열 개수를 레벨당 1개
      //    늘린다(RESEARCH_SLOTS_MAX_LEVEL에서 상한). 행운 연구(등급 확률)와는 완전히 별개 축 —
      //    이건 순수하게 "몇 개나 보이는지"만 늘린다. ──
      if (request.method === "POST" && path === "/research/slots-upgrade") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const level = row.research_shop_slots_level || 0;
        if (level >= RESEARCH_SLOTS_MAX_LEVEL) return json({ error: "이미 최대 레벨입니다." }, 400);
        const cost = researchSlotsUpgradeCost(level);
        if (row.diamonds < cost) return json({ error: "다이아가 부족합니다. (필요 " + cost + ")" }, 400);
        row.diamonds -= cost;
        row.research_shop_slots_level = level + 1;
        await env.DB.prepare("UPDATE arena_users SET diamonds=?, research_shop_slots_level=? WHERE user_id=?").bind(row.diamonds, row.research_shop_slots_level, row.user_id).run();
        return json({
          ok: true, diamonds: row.diamonds, slotsLevel: row.research_shop_slots_level,
          slotsCurrentMin: effectiveMinShopItems(row.research_shop_slots_level),
          nextCost: row.research_shop_slots_level >= RESEARCH_SLOTS_MAX_LEVEL ? null : researchSlotsUpgradeCost(row.research_shop_slots_level),
        });
      }

      // ── POST /research/exp-booster-upgrade — 영구 EXP 부스터 연구(딱 3단계, 다이아
      //    500/750/1000). 레벨 1/2/3 = 모든 경험치 획득에 영구 x1.2/x1.5/x2. ──
      if (request.method === "POST" && path === "/research/exp-booster-upgrade") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const level = row.research_exp_booster_level || 0;
        if (level >= EXP_BOOSTER_MAX_LEVEL) return json({ error: "이미 최대 레벨입니다." }, 400);
        const cost = expBoosterUpgradeCost(level);
        if (row.diamonds < cost) return json({ error: "다이아가 부족합니다. (필요 " + cost + ")" }, 400);
        row.diamonds -= cost;
        row.research_exp_booster_level = level + 1;
        await env.DB.prepare("UPDATE arena_users SET diamonds=?, research_exp_booster_level=? WHERE user_id=?").bind(row.diamonds, row.research_exp_booster_level, row.user_id).run();
        return json({
          ok: true, diamonds: row.diamonds, expBoosterLevel: row.research_exp_booster_level,
          expBoosterMult: expBoosterMult(row),
          nextCost: expBoosterUpgradeCost(row.research_exp_booster_level),
        });
      }

      // ══════════════════════════════════════════════════════════
      //  Daily — 출석 체크(연속일 보상) + 오늘의 미션 3종.
      // ══════════════════════════════════════════════════════════

      // ── GET /daily — 출석 상태(오늘 이미 했는지, 연속일수) + 미션 진행도/수령 여부. ──
      if (request.method === "GET" && path === "/daily") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const today = kstDateString();
        const progress = await ensureDailyProgress(env, user.userId);
        const quests = {};
        for (const key in DAILY_QUESTS) {
          const q = DAILY_QUESTS[key];
          const done = progress[key] || 0;
          quests[key] = { label: q.label, goal: q.goal, reward: q.reward, done: Math.min(done, q.goal), claimed: !!progress[key + "_claimed"], ready: done >= q.goal && !progress[key + "_claimed"] };
        }
        return json({
          attendedToday: row.last_attendance_date === today,
          streak: row.attendance_streak,
          nextReward: ATTENDANCE_BASE_REWARD + Math.min(row.attendance_streak, ATTENDANCE_STREAK_BONUS_CAP_DAYS) * ATTENDANCE_STREAK_BONUS,
          quests: quests,
        });
      }

      // ── POST /daily/attendance — 하루 한 번(KST 기준). 어제 출석했으면 연속일 +1, 아니면 1로 리셋. ──
      if (request.method === "POST" && path === "/daily/attendance") {
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const today = kstDateString();
        if (row.last_attendance_date === today) return json({ error: "오늘은 이미 출석했습니다." }, 400);
        const yesterday = kstDateString(Date.now() - 24 * 3600 * 1000);
        const streak = row.last_attendance_date === yesterday ? row.attendance_streak + 1 : 1;
        const eventMult = globalEventMult(); // 전역 이벤트(GM이 켠 기간 한정 코인·EXP 2배)
        const reward = Math.round((ATTENDANCE_BASE_REWARD + Math.min(streak, ATTENDANCE_STREAK_BONUS_CAP_DAYS) * ATTENDANCE_STREAK_BONUS) * eventMult);
        row.pocket_coins += reward;
        row.last_attendance_date = today;
        row.attendance_streak = streak;
        const xpGain = Math.round(xpPct(row, ATTENDANCE_XP_PCT) * eventMult);
        const leveledUp = applyXpAndLevel(row, xpGain);
        // 미션 3종을 이미(출석보다 먼저) 다 수령해 둔 상태에서 지금 막 출석까지 마쳤다면 —
        // "출석 + 미션 전부 완료" 조건이 방금 완성된 것이므로 여기서 부스트를 켠다(순서 무관하게
        // 어느 쪽이 마지막이든 그 시점에 켜지도록 두 엔드포인트에 똑같이 체크를 넣었다).
        let dailyBoostGranted = false;
        if (await allDailyQuestsClaimed(env, user.userId)) {
          row.daily_boost_until = Date.now() + DAILY_BOOST_MS;
          dailyBoostGranted = true;
        }
        await env.DB.prepare(
          "UPDATE arena_users SET pocket_coins=?, last_attendance_date=?, attendance_streak=?, daily_boost_until=?, xp=?, level=?, stat_points=?, hp=?, energy=?, stamina=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
        ).bind(row.pocket_coins, row.last_attendance_date, row.attendance_streak, row.daily_boost_until || 0,
               row.xp, row.level, row.stat_points, row.hp, row.energy, row.stamina, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id).run();
        return json({ ok: true, reward: reward, streak: streak, pocketCoins: row.pocket_coins, xpGained: xpGain, leveledUp: leveledUp, dailyBoostGranted: dailyBoostGranted, dailyBoostUntil: row.daily_boost_until || 0 });
      }

      // ── POST /daily/quest-claim { quest } — 목표치를 채운 미션 하나를 수령. ──
      if (request.method === "POST" && path === "/daily/quest-claim") {
        const body = await request.json().catch(function () { return {}; });
        const questKey = String(body.quest || "");
        const q = DAILY_QUESTS[questKey];
        if (!q) return json({ error: "알 수 없는 미션입니다." }, 400);
        const progress = await ensureDailyProgress(env, user.userId);
        if (progress[questKey + "_claimed"]) return json({ error: "이미 수령한 미션입니다." }, 400);
        if ((progress[questKey] || 0) < q.goal) return json({ error: "아직 목표를 채우지 못했습니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const eventMult = globalEventMult(); // 전역 이벤트(GM이 켠 기간 한정 코인·EXP 2배)
        const questReward = Math.round(q.reward * eventMult);
        row.pocket_coins += questReward;
        const xpGain = Math.round(xpPct(row, DAILY_QUEST_CLAIM_XP_PCT) * eventMult);
        const leveledUp = applyXpAndLevel(row, xpGain);
        const today = kstDateString();
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE arena_users SET pocket_coins=?, xp=?, level=?, stat_points=?, hp=?, energy=?, stamina=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
          ).bind(row.pocket_coins, row.xp, row.level, row.stat_points, row.hp, row.energy, row.stamina, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id),
          env.DB.prepare("UPDATE arena_daily_progress SET " + questKey + "_claimed = 1 WHERE user_id=? AND date=?").bind(user.userId, today),
        ]);

        // 이 미션이 오늘의 마지막 미완료 미션이었고, 출석도 이미 했다면 — "출석 + 미션 전부
        // 완료" 조건 완성. 다른 두 미션이 이미 claimed였는지는 방금 UPDATE 반영 후 다시
        // 조회해서 확인한다(이 요청으로 막 claimed된 것까지 포함해서 정확히 셈).
        let dailyBoostGranted = false;
        if (row.last_attendance_date === today && await allDailyQuestsClaimed(env, user.userId)) {
          row.daily_boost_until = Date.now() + DAILY_BOOST_MS;
          await env.DB.prepare("UPDATE arena_users SET daily_boost_until=? WHERE user_id=?").bind(row.daily_boost_until, row.user_id).run();
          dailyBoostGranted = true;
        }
        return json({ ok: true, reward: questReward, pocketCoins: row.pocket_coins, xpGained: xpGain, leveledUp: leveledUp, dailyBoostGranted: dailyBoostGranted, dailyBoostUntil: row.daily_boost_until || 0 });
      }

      // ══════════════════════════════════════════════════════════
      //  Bounty Board — 8시간마다 통째로 새로 뽑히는 개인별 현상금 5개. 오늘의 미션(하루 고정
      //  3종)보다 다채로운 목표/더 큰 보상으로 "경험치·코인 얻을 수단이 더 많으면 좋겠다"는
      //  요청에 대응한다.
      // ══════════════════════════════════════════════════════════

      // ── GET /bounties — 지금 회차의 내 게시판 5개 + 각각의 진행도/청구 여부. ──
      if (request.method === "GET" && path === "/bounties") {
        const bucket = Math.floor(Date.now() / BOUNTY_PERIOD_MS);
        const bucketStart = bucket * BOUNTY_PERIOD_MS;
        const board = bountyBoardFor(user.userId, bucket);
        const [counts, claimsRes] = await Promise.all([
          bountyProgressCounts(env, user.userId, bucketStart),
          env.DB.prepare("SELECT bounty_id FROM arena_bounty_claims WHERE user_id = ? AND bucket = ?").bind(user.userId, bucket).all(),
        ]);
        const claimed = new Set(claimsRes.results.map(function (r) { return r.bounty_id; }));
        const items = board.map(function (b) {
          const progress = Math.min(counts[b.counterKey] || 0, b.goal);
          return {
            id: b.id, label: b.label, goal: b.goal, coin: b.coin, progress: progress,
            claimed: claimed.has(b.id), ready: progress >= b.goal && !claimed.has(b.id),
          };
        });
        return json({ items: items, refreshAt: bucketStart + BOUNTY_PERIOD_MS });
      }

      // ── POST /bounties/claim { id } — 현상금 하나를 청구한다. 서버가 그 유저의 그 회차
      //    게시판을 똑같이 재계산해서 id가 실제로 그 안에 있는지부터 확인한다(클라이언트가
      //    지어낸 id로 청구 못 하게). ──
      if (request.method === "POST" && path === "/bounties/claim") {
        const body = await request.json().catch(function () { return {}; });
        const id = String(body.id || "");
        const bucket = Math.floor(Date.now() / BOUNTY_PERIOD_MS);
        const bucketStart = bucket * BOUNTY_PERIOD_MS;
        const board = bountyBoardFor(user.userId, bucket);
        const bounty = board.find(function (b) { return b.id === id; });
        if (!bounty) return json({ error: "지금 게시판에 없는 현상금입니다." }, 400);

        const already = await env.DB.prepare("SELECT 1 FROM arena_bounty_claims WHERE user_id=? AND bucket=? AND bounty_id=?").bind(user.userId, bucket, id).first();
        if (already) return json({ error: "이미 청구한 현상금입니다." }, 400);

        const counts = await bountyProgressCounts(env, user.userId, bucketStart);
        if ((counts[bounty.counterKey] || 0) < bounty.goal) return json({ error: "아직 목표를 채우지 못했습니다." }, 400);

        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const eventMult = globalEventMult(); // 전역 이벤트(코인·EXP 2배)만 적용, 개인 activityBoostMult는 제외(일회성 청구 몰아받기 방지)
        const coinReward = Math.round(bounty.coin * eventMult);
        row.pocket_coins += coinReward;
        const xpGain = Math.round(xpPct(row, bounty.xpPct) * eventMult);
        const leveledUp = applyXpAndLevel(row, xpGain);
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE arena_users SET pocket_coins=?, xp=?, level=?, stat_points=?, hp=?, energy=?, stamina=?, last_energy_tick=?, last_stamina_tick=?, last_hp_tick=? WHERE user_id=?"
          ).bind(row.pocket_coins, row.xp, row.level, row.stat_points, row.hp, row.energy, row.stamina, row.last_energy_tick, row.last_stamina_tick, row.last_hp_tick, row.user_id),
          env.DB.prepare("INSERT INTO arena_bounty_claims (user_id, bucket, bounty_id, claimed_at) VALUES (?, ?, ?, ?)").bind(user.userId, bucket, id, Date.now()),
        ]);
        return json({ ok: true, reward: coinReward, pocketCoins: row.pocket_coins, xpGained: xpGain, leveledUp: leveledUp });
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
        const rerollBucket = planetRerollBucket(now);
        const nextRerollAt = (rerollBucket + 1) * PLANET_REROLL_MS;
        const res = await env.DB.prepare("SELECT * FROM arena_planets ORDER BY is_home DESC, slot_index ASC").all();
        // 경비병 집계는 행성 개수만큼 반복 쿼리하지 않고 한 번에 몽땅 가져와서 행성 id별로
        // 묶는다(planetGarrisonStats를 48번 부르는 대신 쿼리 1번).
        const garrisonRes = await env.DB.prepare(
          "SELECT stationed_planet_id, equipped_weapon, equipped_armor, equipped_core FROM arena_bots WHERE stationed_planet_id IS NOT NULL"
        ).all();
        const garrisonByPlanet = {};
        for (const b of garrisonRes.results) {
          const s = equipStats(b);
          const g = garrisonByPlanet[b.stationed_planet_id] || (garrisonByPlanet[b.stationed_planet_id] = { atk: 0, def: 0, crit: 0, count: 0 });
          g.atk += s.atk; g.def += s.def; g.crit += s.crit; g.count++;
        }
        let myOwnedWild = 0;
        const ownerCombatCache = {};
        const planets = await Promise.all(res.results.map(async function (p) {
          const mine = p.owner_user_id === user.userId;
          if (mine && !p.is_home) myOwnedWild++;
          const isUnclaimedWild = !p.is_home && !p.owner_user_id;
          // 미정복 행성은 15분마다 리롤되는 "현재" 난이도를 그때그때 계산한다(저장된 bot_tier는
          // 최초 시드값이라 신뢰하지 않는다) — 정복된 행성은 실제 전투 판정과 동일한 방어력을
          // 보여준다(홈은 주인 실전 스탯 x2, 야생은 배치된 경비병 스탯 + 최소 수비대).
          let tierKey = null, combatStats = null, coinsPerHour = p.coins_per_hour, homeInvulnerable = false;
          let garrisonCount = null;
          if (isUnclaimedWild) {
            tierKey = effectivePlanetTier(p.slot_index, now);
            const t = PLANET_BOT_TIERS[tierKey];
            combatStats = { atk: t.atk, def: t.def, crit: t.crit };
            coinsPerHour = t.coinsPerHour;
          } else if (p.owner_user_id && p.is_home) {
            if (!ownerCombatCache[p.owner_user_id]) {
              const ownerRow = await env.DB.prepare("SELECT * FROM arena_users WHERE user_id = ?").bind(p.owner_user_id).first();
              ownerCombatCache[p.owner_user_id] = ownerRow ? { level: ownerRow.level, combat: await totalCombatStats(env, ownerRow) } : null;
            }
            const cached = ownerCombatCache[p.owner_user_id];
            if (cached) {
              combatStats = { atk: cached.combat.atk * HOME_PLANET_DEFENSE_MULT, def: cached.combat.def * HOME_PLANET_DEFENSE_MULT, crit: cached.combat.crit };
              if (cached.level < HOME_PLANET_INVULNERABLE_UNTIL_LEVEL) homeInvulnerable = true;
            }
          } else if (p.owner_user_id) {
            // 정복된 야생 행성 — 주인의 개인 전투력이 아니라 배치된 경비병 스탯을 보여준다.
            const g = garrisonByPlanet[p.id] || { atk: 0, def: 0, crit: 0, count: 0 };
            combatStats = {
              atk: PLANET_UNGARRISONED_DEFENSE.atk + g.atk,
              def: PLANET_UNGARRISONED_DEFENSE.def + g.def,
              crit: PLANET_UNGARRISONED_DEFENSE.crit + g.crit,
            };
            garrisonCount = g.count;
          }
          const elapsedMs = mine && !p.is_home ? Math.min(now - p.last_collect, PROPERTY_MAX_ACCRUAL_MS) : 0;
          const pendingCoins = mine && !p.is_home ? Math.floor(p.coins_per_hour * (elapsedMs / 3600000)) : 0;
          return {
            id: p.id, name: p.name, isHome: !!p.is_home,
            ownerUserId: p.owner_user_id, ownerName: p.owner_name, mine: mine,
            botTier: tierKey, botTierLabel: tierKey ? PLANET_BOT_TIERS[tierKey].label : null,
            combatStats: combatStats,
            garrisonCount: garrisonCount, garrisonMax: PLANET_GARRISON_MAX_PER_PLANET,
            coinsPerHour: coinsPerHour, pendingCoins: pendingCoins,
            homeInvulnerable: homeInvulnerable,
            attackable: !mine && !homeInvulnerable,
            expeditionEligible: !!(tierKey && ["elite", "nightmare", "apex"].indexOf(tierKey) !== -1),
          };
        }));
        const tierMeta = {};
        for (const key in PLANET_BOT_TIERS) {
          const t = PLANET_BOT_TIERS[key];
          tierMeta[key] = { label: t.label, weight: t.weight, atk: t.atk, def: t.def, crit: t.crit, coinsPerHour: t.coinsPerHour };
        }
        return json({
          planets: planets, myOwnedWild: myOwnedWild, maxOwnedWild: PLANET_MAX_OWNED_WILD, stances: STANCES,
          tierMeta: tierMeta, nextRerollAt: nextRerollAt, rerollMs: PLANET_REROLL_MS,
          homeInvulnerableLevel: HOME_PLANET_INVULNERABLE_UNTIL_LEVEL,
        });
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

      // ── POST /planets/abandon { planetId } — 정복한 야생 행성을 포기한다(홈 행성은 포기 불가 —
      //    ensureHomePlanet이 어차피 하나 없으면 새로 만들어주므로 포기해도 의미가 없고, 유저를
      //    거점 없는 상태로 만들지 않기 위해 막아둔다). 먼저 대기 수익을 정산해준 뒤 소유권을
      //    풀어서 다시 무주인(PVE 봇이 지키는) 행성으로 되돌린다 — 이제 아무나(자신 포함) 다시
      //    정복할 수 있고 PLANET_MAX_OWNED_WILD 한도에서도 바로 빠진다. ──
      if (request.method === "POST" && path === "/planets/abandon") {
        const body = await request.json().catch(function () { return {}; });
        const planetId = parseInt(body.planetId, 10);
        const row = await loadOrCreateUser(env, user.userId, user.realName);
        const planet = await env.DB.prepare("SELECT * FROM arena_planets WHERE id = ? AND owner_user_id = ?").bind(planetId, user.userId).first();
        if (!planet) return json({ error: "내가 소유한 행성이 아닙니다." }, 400);
        if (planet.is_home) return json({ error: "홈 행성은 포기할 수 없습니다." }, 400);

        const now = Date.now();
        const elapsedMs = Math.min(now - planet.last_collect, PROPERTY_MAX_ACCRUAL_MS);
        const collected = Math.floor(planet.coins_per_hour * (elapsedMs / 3600000));
        if (collected > 0) {
          row.pocket_coins += collected;
          await env.DB.prepare("UPDATE arena_users SET pocket_coins=? WHERE user_id=?").bind(row.pocket_coins, row.user_id).run();
        }
        await env.DB.prepare(
          "UPDATE arena_planets SET owner_user_id=NULL, owner_name=NULL, coins_per_hour=0, last_collect=?, captured_at=NULL WHERE id=?"
        ).bind(now, planet.id).run();
        // 여기 배치돼 있던 경비병 봇도 소속 행성을 잃었으니 "나와 함께"로 귀환.
        await env.DB.prepare("UPDATE arena_bots SET stationed_planet_id = NULL WHERE stationed_planet_id = ?").bind(planet.id).run();

        return json({ ok: true, collected: collected, pocketCoins: row.pocket_coins });
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
        const cooldownLeft1 = attackCooldownRemainingMs(attacker);
        if (cooldownLeft1 > 0) return json({ error: "공격 후 " + Math.ceil(cooldownLeft1 / 1000) + "초 동안은 다시 공격할 수 없습니다." }, 400);
        if (attacker.stamina < PLANET_ATTACK_STAMINA_COST) return json({ error: "스태미나가 부족합니다." }, 400);

        const planet = await env.DB.prepare("SELECT * FROM arena_planets WHERE id = ?").bind(planetId).first();
        if (!planet) return json({ error: "존재하지 않는 행성입니다." }, 404);
        // 홈 행성도 이제 공격 대상이다 — 정복하면 그 즉시 일반 행성으로 강등되고(is_home=0),
        // 원래 주인은 다음 접속 때 ensureHomePlanet이 새 홈 행성을 자동으로 만들어준다.
        if (planet.owner_user_id === user.userId) return json({ error: "이미 내 행성입니다." }, 400);
        // 같은 유저의 행성들(홈 + 강등된 야생 전부)을 최근 8시간 안에 너무 많이 노리는 것만 막는다
        // — opponent_id가 소유자 한 명으로 고정이라 그 사람 행성이 몇 개든 합쳐서 센다.
        if (planet.owner_user_id) {
          const planetAttackCount = await countRecentAttacks(env, user.userId, planet.owner_user_id, "planet_attack");
          if (planetAttackCount >= PVP_MAX_ATTACKS_PER_TARGET_PER_RESET) {
            return json({ error: "이 유저의 행성은 8시간 안에 이미 " + PVP_MAX_ATTACKS_PER_TARGET_PER_RESET + "번 공격했습니다. 다른 대상을 노려보세요." }, 400);
          }
        }

        const result = await resolvePlanetCombat(env, user, attacker, planet, stanceId, timingScores);
        if (result.error) return json({ error: result.error }, 400);

        // 경험치 — PvP 직접 공격과 동일한 원칙(이겨도 져도 지급, 레벨업 시 hp/energy/stamina
        // 전액 회복이 전투 피해 반영 이후에 적용되도록 반드시 마지막에 호출).
        const xpGain = Math.round(xpPct(attacker, result.attackerWins ? PLANET_WIN_XP_PCT : PLANET_LOSE_XP_PCT) * activityBoostMult(attacker));
        const leveledUp = applyXpAndLevel(attacker, xpGain);

        attacker.stamina -= PLANET_ATTACK_STAMINA_COST;
        attacker.last_attack_at = Date.now();
        await env.DB.prepare(
          "UPDATE arena_users SET stamina=?, energy=?, hp=?, pocket_coins=?, last_stance=?, xp=?, level=?, stat_points=?, " +
          "last_energy_tick=?, last_stamina_tick=?, last_hp_tick=?, last_attack_at=? WHERE user_id=?"
        ).bind(attacker.stamina, attacker.energy, attacker.hp, attacker.pocket_coins, stanceId, attacker.xp, attacker.level, attacker.stat_points,
               attacker.last_energy_tick, attacker.last_stamina_tick, attacker.last_hp_tick, attacker.last_attack_at, attacker.user_id).run();

        await insertLog(env, attacker.user_id, "planet_attack", result.isBotPlanet ? null : planet.owner_user_id, result.isBotPlanet ? planet.name : planet.owner_name,
          result.attackerWins ? "win" : "lose", result.attackerWins ? result.lootCoins : 0, (result.attackerWins ? (result.sweep ? 0 : -PVP_WIN_ATK_HP_LOSS) : -PVP_LOSE_ATK_HP_LOSS));
        if (!result.isBotPlanet && result.attackerWins) {
          await insertLog(env, planet.owner_user_id, "planet_lost", user.userId, user.realName, "lose", -result.lootCoins, 0);
        }
        await bumpDailyProgress(env, attacker.user_id, "battles");

        const combat = await totalCombatStats(env, attacker);
        return json({
          ok: true, attackerWins: result.attackerWins, sweep: result.sweep, captured: result.captured, lootCoins: result.lootCoins,
          xpGained: xpGain, leveledUp: leveledUp,
          capCapped: result.attackerWins && !result.captured, planetName: planet.name, isHome: !!planet.is_home,
          rounds: result.rounds, attackerRoundWins: result.attackerRoundWins, rpsMod: result.rpsMod,
          myAtk: result.attackerCombat.atk, theirDef: result.defenderCombat.def, stanceLabel: stance.label,
          state: publicState(attacker, combat),
        });
      }

      // ── POST /planets/expedition { planetId } — 연구로 해금한 "원정": 정예/악몽/극한 등급
      //    PVE 행성에 한해 태세 선택도 타이밍 미니게임도 없이(중립 태세 "기습형" + 평균 정확도
      //    70점 고정) 서버가 즉시 판정한다. 자리에 없어도 보낼 수 있고, 결과는 Hack Log
      //    최상단(created_at DESC라 자동으로 그렇게 됨)에서 돌아왔을 때 확인한다. ──
      if (request.method === "POST" && path === "/planets/expedition") {
        const body = await request.json().catch(function () { return {}; });
        const planetId = parseInt(body.planetId, 10);

        const attacker = await loadOrCreateUser(env, user.userId, user.realName);
        if (!attacker.research_expedition_unlocked) return json({ error: "원정 연구를 먼저 해금하세요." }, 400);
        if (attacker.hp <= 0) return json({ error: "HP가 0입니다. 회복 후 다시 시도하세요." }, 400);
        const cooldownLeft2 = attackCooldownRemainingMs(attacker);
        if (cooldownLeft2 > 0) return json({ error: "공격 후 " + Math.ceil(cooldownLeft2 / 1000) + "초 동안은 다시 공격할 수 없습니다." }, 400);
        if (attacker.stamina < PLANET_ATTACK_STAMINA_COST) return json({ error: "스태미나가 부족합니다." }, 400);

        const planet = await env.DB.prepare("SELECT * FROM arena_planets WHERE id = ?").bind(planetId).first();
        if (!planet) return json({ error: "존재하지 않는 행성입니다." }, 404);
        if (planet.is_home) return json({ error: "홈 행성은 공격할 수 없습니다." }, 400);
        if (planet.owner_user_id) return json({ error: "원정은 PVE 행성(봇이 지키는 곳)에서만 가능합니다." }, 400);

        const tierKey = effectivePlanetTier(planet.slot_index, Date.now());
        if (["elite", "nightmare", "apex"].indexOf(tierKey) === -1) {
          return json({ error: "원정은 정예 이상 등급(정예/악몽/극한) 행성에서만 가능합니다." }, 400);
        }

        const stanceId = "ambush";
        const timingScores = [70, 70, 70]; // 사람이 직접 안 하니 평균적인 정확도로 고정
        const result = await resolvePlanetCombat(env, user, attacker, planet, stanceId, timingScores);
        if (result.error) return json({ error: result.error }, 400);

        // 원정은 사람이 직접 안 하는 자동 전투라 같은 승패라도 일반 공격보다 경험치를
        // 살짝 낮게 준다(EXPEDITION_*_XP_PCT). 나머지 원칙은 위 /planets/attack과 동일.
        const xpGain = Math.round(xpPct(attacker, result.attackerWins ? EXPEDITION_WIN_XP_PCT : EXPEDITION_LOSE_XP_PCT) * activityBoostMult(attacker));
        const leveledUp = applyXpAndLevel(attacker, xpGain);

        attacker.stamina -= PLANET_ATTACK_STAMINA_COST;
        attacker.last_attack_at = Date.now();
        await env.DB.prepare(
          "UPDATE arena_users SET stamina=?, energy=?, hp=?, pocket_coins=?, last_stance=?, xp=?, level=?, stat_points=?, " +
          "last_energy_tick=?, last_stamina_tick=?, last_hp_tick=?, last_attack_at=? WHERE user_id=?"
        ).bind(attacker.stamina, attacker.energy, attacker.hp, attacker.pocket_coins, stanceId, attacker.xp, attacker.level, attacker.stat_points,
               attacker.last_energy_tick, attacker.last_stamina_tick, attacker.last_hp_tick, attacker.last_attack_at, attacker.user_id).run();

        await insertLog(env, attacker.user_id, "planet_expedition", null, planet.name,
          result.attackerWins ? "win" : "lose", result.attackerWins ? result.lootCoins : 0, (result.attackerWins ? (result.sweep ? 0 : -PVP_WIN_ATK_HP_LOSS) : -PVP_LOSE_ATK_HP_LOSS));

        const combat = await totalCombatStats(env, attacker);
        return json({
          ok: true, attackerWins: result.attackerWins, sweep: result.sweep, captured: result.captured, lootCoins: result.lootCoins,
          xpGained: xpGain, leveledUp: leveledUp,
          planetName: planet.name, tierLabel: PLANET_BOT_TIERS[tierKey].label,
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
        // 관리자 테스트 계정은 치트로 쌓인 수치가 랭킹을 오염시키지 않도록 항상 제외한다.
        const res = await env.DB.prepare(
          "SELECT user_id, real_name, level, pocket_coins, bank_coins, plunder_wins, rebirth_count, equipped_title_id FROM arena_users WHERE user_id != ? ORDER BY " + orderBy + " LIMIT 50"
        ).bind(ADMIN_USER_ID).all();
        const rows = res.results.map(function (r) {
          return Object.assign({}, r, { title: lookupTitleText(r.equipped_title_id) });
        });
        return json({ type: type, rows: rows });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "서버 오류: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};
