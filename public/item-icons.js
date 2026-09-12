// ══════════════════════════════════════════════════════════
//  아이템 전용 아이콘 — 상점/도감에 있는 텍스트뿐인 카드가 밋밋해서, 아이템 하나하나에 맞춰
//  직접 그린(손 코딩한) 최소 라인 SVG 아이콘을 붙였다. 전부 stroke="currentColor" 기준으로
//  그렸기 때문에, 감싸는 요소에 style="color:<등급색>"만 주면 그 아이템 등급 색으로 알아서
//  물든다(기존 rarityColor 관례와 그대로 맞춘 것). 무기/방어/코어는 등급이 오를수록 도안이
//  점점 더 정교해지도록(초반엔 단순한 렌치/방패, 후반엔 특이점·차원문 급으로), 소비재는
//  효과(회복/에너지/스태미나/보호막)별로 한눈에 구분되도록 설계했다.
// ══════════════════════════════════════════════════════════
window.ITEM_ICONS = {
  // ── 무기(weapon) ──
  rusty_script: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="1"/><path d="M6 9l3 2-3 2M11 13h4"/><path d="M9 20h6"/></svg>',
  packet_spoofer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 10c0-3 3.5-5 8-5s8 2 8 5-3.5 7-8 7-8-4-8-7z"/><circle cx="9" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"/></svg>',
  plasma_cannon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="10" width="12" height="4" rx="1"/><circle cx="18" cy="12" r="4"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>',
  hf_blade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20L17 7l2 2L6 22z"/><path d="M9 6q2-2 4 0M12 3q2-2 4 0"/></svg>',
  emp_missile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 14l6-9 3 3-9 6z"/><path d="M13 8l3 3"/><circle cx="17" cy="17" r="2"/><circle cx="17" cy="17" r="5" stroke-dasharray="2 2"/></svg>',
  stuxnet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.5 6.5l2 2M15.5 15.5l2 2M6.5 17.5l2-2M15.5 8.5l2-2"/></svg>',
  singularity_worm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3a9 9 0 100 18 6 6 0 100-12 3 3 0 100 6"/></svg>',
  omega_killswitch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v7"/><path d="M6.5 7a8 8 0 1011 0"/></svg>',
  abyssal_maw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9c3 6 15 6 18 0"/><path d="M4 9l2 3M8 9l1.5 4M12 9v4.5M16 9l-1.5 4M20 9l-2 3"/></svg>',
  // 진짜 최종 등급(abyssal보다 위) — "그 무엇보다 강력해보이게" 요청 반영, 거대한 낫 날에
  // 사방으로 균열/번개가 뻗어나가는 도안으로 지금까지 중 가장 화려하게 그렸다.
  apocalypse_scythe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 21c0-9 5-17 14-18 1 5-3 11-9 13-3 1-5 3-5 5z"/><path d="M9 15l-5 6"/><path d="M14 6l2-3M17 9l3-2M11 9l-2-3M6 12l-2 1"/></svg>',

  // ── 방어구(armor) ──
  basic_av: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  packet_filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h16l-6 8v6l-4 2v-8z"/></svg>',
  nano_composite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M12 3v18M5 7l7 4 7-4M5 17l7-4 7 4"/></svg>',
  ngfw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M8 4v5M14 9v5M8 14v6M16 14v6"/></svg>',
  phase_shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6z"/><path d="M8 11q2-2 4 0t4 0"/></svg>',
  adaptive_ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6z"/><circle cx="12" cy="10" r="1.5" fill="currentColor" stroke="none"/><path d="M12 11.5V15M9 13h6M9.5 9l-2-1.5M14.5 9l2-1.5"/></svg>',
  black_ice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l3 6 6 1-4.5 4 1.5 6-6-3.5L6 22l1.5-6L3 12l6-1z"/></svg>',
  absolute_zero: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v20M4 7l16 10M20 7L4 17"/><path d="M12 5l-2 2M12 5l2 2M12 19l-2-2M12 19l2-2"/></svg>',
  eventhorizon_ward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  // 방패 안에 빛나는 코어 + 사방으로 뻗는 광선 — 지금까지 방어구 중 가장 정교/화려하게.
  omega_aegis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2l8 3.5v6c0 6-4 9.5-8 10.5-4-1-8-4.5-8-10.5v-6z"/><path d="M12 4v3M12 15v3M6.5 11h3M14.5 11h3" stroke-width="1.2"/><circle cx="12" cy="11" r="2.4" fill="currentColor" stroke="none"/></svg>',

  // ── 코어(core) ──
  overclock_chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/></svg>',
  tactical_matrix: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="7" cy="7" r="1.6"/><circle cx="12" cy="7" r="1.6"/><circle cx="17" cy="7" r="1.6"/><circle cx="7" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="17" cy="12" r="1.6"/><circle cx="7" cy="17" r="1.6"/><circle cx="12" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/></svg>',
  quantum_core: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="12" cy="12" rx="9" ry="4"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
  neural_accelerator: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4a4 4 0 00-4 4 4 4 0 000 8 4 4 0 004 4h6a4 4 0 004-4 4 4 0 000-8 4 4 0 00-4-4z"/><path d="M9 8h6M8 12h8M9 16h6"/></svg>',
  singularity_core: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="12" rx="9" ry="3.2"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>',
  dimensional_proc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><rect x="8" y="8" width="8" height="8" transform="rotate(45 12 12)"/></svg>',
  observers_eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
  algorithm_of_god: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6.5 9a3 3 0 100 6 5 5 0 004-2 5 5 0 004 2 3 3 0 100-6 5 5 0 00-4 2 5 5 0 00-4-2z"/></svg>',
  voidheart_core: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 12c0-4 4-6 6-3s0 7-4 7-6-3-6-6 2-6 5-6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
  // 붕괴하는 특이점 + 8방향으로 뻗는 코로나 — voidheart_core보다 한층 더 복잡하고 폭발적으로.
  genesis_singularity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="9.5" stroke-dasharray="1.5 2"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4.5 4.5l1.4 1.4M18.1 18.1l1.4 1.4M4.5 19.5l1.4-1.4M18.1 5.9l1.4-1.4"/></svg>',

  // ── 소비재(consumable) ──
  nanobot_kit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M12 10v6M9 13h6"/><path d="M9 6V5a3 3 0 016 0v1"/></svg>',
  energy_drink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="4" width="10" height="16" rx="2"/><path d="M13 7l-3 5h3l-3 5"/></svg>',
  vaccine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 3h6M10 3v5l-4 8a3 3 0 003 4h6a3 3 0 003-4l-4-8V3"/><path d="M9 14h6"/></svg>',
  ddos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="2"/><circle cx="4" cy="5" r="1.4"/><circle cx="20" cy="5" r="1.4"/><circle cx="4" cy="19" r="1.4"/><circle cx="20" cy="19" r="1.4"/><path d="M5.2 6.2L10.5 10.5M18.8 6.2L13.5 10.5M5.2 17.8L10.5 13.5M18.8 17.8L13.5 13.5"/></svg>',
  mega_energy_cell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="8" width="16" height="10" rx="1.5"/><path d="M19 11v4"/><path d="M11 8l-3 5h3l-3 5"/></svg>',
  adrenaline_shot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 4l-2-2-3 3 2 2z"/><path d="M15 7L6 16l-2 4 4-2 9-9-2-2z"/><path d="M12 9l2 2"/></svg>',
  stealth_cloak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 20V10a6 6 0 0112 0v10l-2-2-2 2-2-2-2 2-2-2z"/><circle cx="9.5" cy="10" r="0.8" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10" r="0.8" fill="currentColor" stroke="none"/></svg>',
  nano_cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 17a4 4 0 01-1-7.9A5 5 0 0116 8a4 4 0 011 7.9z"/><path d="M12 12v4M10 14h4"/></svg>',
  dimension_veil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="12" rx="9" ry="5"/><ellipse cx="12" cy="12" rx="4" ry="5"/><path d="M12 7v10"/></svg>',

  // ── 상자(box) — 등급별로 도안은 하나(상자 모양)로 통일하고, 다른 아이템들과 똑같이
  // rarityColor로만 구분한다(등급이 오를수록 더 정교해지는 무기/방어/코어와 달리, 상자는
  // "안에 뭐가 들었는지" 여는 재미가 핵심이라 겉모습은 일부러 다 똑같이 뒀다).
  box_uncommon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/></svg>',
  box_rare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/></svg>',
  box_epic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/></svg>',
  box_legendary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/></svg>',
  box_mythic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/></svg>',
  box_secret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M3 8v9l9 4 9-4V8"/><path d="M12 12v9"/></svg>',
};

// 못 찾은 아이템(신규 아이템 추가를 깜빡한 경우)에 대한 안전망 — 물음표 아이콘.
window.ITEM_ICON_FALLBACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 1.8-2.5 3.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/></svg>';

// ══════════════════════════════════════════════════════════
//  Property(부동산/방치 수익 기기) 전용 아이콘 — 그동안 이름 텍스트만 있던 걸 무기/방어/코어와
//  똑같은 방식(손 코딩 SVG, stroke="currentColor")으로 하나씩 그렸다. 등급 필드는 따로 없지만
//  서버가 가격 순 5단계로 나눠 내려주는 tierColor로 물들여서(무채색 은색 → 청록 → 에메랄드 →
//  골드 → 앰버), 저가 기기부터 최종 티어까지 점점 화려해지는 감각을 준다.
// ══════════════════════════════════════════════════════════
window.PROPERTY_ICONS = {
  proxy_relay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21V9"/><circle cx="12" cy="6" r="2"/><path d="M8 9a6 6 0 018 0M6 12a9 9 0 0112 0"/></svg>',
  botnet_node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="2"/><circle cx="4" cy="6" r="1.6"/><circle cx="20" cy="6" r="1.6"/><circle cx="12" cy="20" r="1.6"/><path d="M12 12L4 6M12 12L20 6M12 12L12 20"/></svg>',
  gpu_rig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="8" width="20" height="9" rx="1.5"/><circle cx="8" cy="12.5" r="2.3"/><circle cx="16" cy="12.5" r="2.3"/><path d="M2 8V6h6M22 8V6h-4"/></svg>',
  packet_sniffer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 12L18 7"/><circle cx="15" cy="9" r="1" fill="currentColor" stroke="none"/></svg>',
  darkpool_bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="3" width="10" height="8" rx="2"/><circle cx="10" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="6.5" r="1" fill="currentColor" stroke="none"/><path d="M9 11v3M15 11v3M6 14h12v7H6z"/></svg>',
  asic_farm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>',
  neural_farm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="6" r="1.5"/><circle cx="19" cy="6" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="18" r="1.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><path d="M5 6l7 6M19 6l-7 6M5 18l7-6M19 18l-7-6"/></svg>',
  cloud_scraper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 17a4 4 0 01-1-7.9A5 5 0 0116 8a4 4 0 011 7.9z"/><path d="M12 8V3M10 5l2-2 2 2"/></svg>',
  fusion_reactor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)"/></svg>',
  quantum_miner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20L14 10"/><path d="M9 3c3 0 8 2 11 6-3 1-8-1-11-4z"/><circle cx="17" cy="7" r="1" fill="currentColor" stroke="none"/></svg>',
  dyson_node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="10" ry="4"/></svg>',
  singularity_farm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3a9 9 0 100 18 6 6 0 100-12 3 3 0 100 6"/></svg>',
  fusion_array: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="7" cy="17" r="3"/><circle cx="17" cy="17" r="3"/></svg>',
  dyson_sphere: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.5 5.5l13 13M18.5 5.5l-13 13"/></svg>',
  quantum_nexus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l8 4.5v11L12 22l-8-4.5v-11z"/><path d="M12 2v20M4 6.5l16 11M20 6.5L4 17.5"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
  galactic_forge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3l7 7-3 3-7-7z"/><path d="M11 9L4 16v4h4l7-7"/><path d="M3 3l2 2M19 19l2 2M3 21l2-2"/></svg>',
  stellar_engine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l2.5 7H21l-5.5 4.5L17.5 21 12 16.5 6.5 21l2-7.5L3 9h6.5z"/></svg>',
};
window.propertyIconHtml = function propertyIconHtml(deviceId, color, sizePx) {
  const svg = window.PROPERTY_ICONS[deviceId] || window.ITEM_ICON_FALLBACK;
  const size = sizePx || 22;
  return '<span class="item-icon" style="color:' + (color || "currentColor") + ";width:" + size + "px;height:" + size + 'px;">' + svg + "</span>";
};

// ══════════════════════════════════════════════════════════
//  등급 파티클/아우라 이펙트 — "레전더리 이상이면 주변에 파티클과 아우라, 희귀도가 올라갈수록
//  화려하게" 요청 반영. RARITY_ORDER 전체를 여기 다시 못 박아두는 대신(서버 값과 어긋날 위험),
//  legendary부터 최상위까지의 단계만 알면 충분해서 그 구간만 하드코딩했다(apocalyptic 추가로
//  6단계). rarity가 이 목록에 없으면(=legendary 미만이거나 아예 없으면) 이펙트 없이 기존과
//  동일한 아이콘만 낸다.
// ══════════════════════════════════════════════════════════
const RARITY_FX_TIERS = ["legendary", "mythic", "secret", "forbidden", "abyssal", "apocalyptic"];
// 아우라/파티클/링 레이어를 만드는 공용 코어 — 아이콘(고정 크기 정사각형)과 플레이어 이름
// 배지(가변 폭 텍스트) 둘 다 이 레이어들을 재사용한다. rarity가 5단계에 없으면(=legendary
// 미만) null을 반환해서 호출부가 이펙트 없이 그대로 내보내게 한다.
function rarityFxLayers(color, rarity) {
  const tierIdx = RARITY_FX_TIERS.indexOf(rarity);
  if (tierIdx === -1) return null;
  // mythic(tierIdx>=1)부터는 한 단계 더 화려하게(요청 반영: "조금만 더 화려하게, mythic부터는")
  // — 파티클 개수를 legendary(3개)에서 한 번에 확 늘리고(mythic 7 → abyssal 13), 회전하는
  // 그라디언트 링을 추가로 두른다. legendary는 기존처럼 은은한 아우라 + 파티클 3개만 유지.
  const flashy = tierIdx >= 1;
  const flashyTier = tierIdx - 1; // mythic=0, secret=1, forbidden=2, abyssal=3
  const particleCount = flashy ? 7 + flashyTier * 2 : 3;
  const auraDur = (flashy ? 2.0 - flashyTier * 0.2 : 2.6).toFixed(2) + "s";
  const particleDur = (flashy ? 1.7 - flashyTier * 0.15 : 2.6).toFixed(2) + "s";
  const ringDur = (2.4 - flashyTier * 0.35).toFixed(2) + "s";
  let particles = "";
  for (let i = 0; i < particleCount; i++) {
    const angle = Math.round((360 / particleCount) * i);
    const delay = (particleDur.replace("s", "") * (i / particleCount)).toFixed(2) + "s";
    particles += '<span class="item-fx-particle" style="--angle:' + angle + 'deg;--fx-delay:' + delay + ';"></span>';
  }
  const ring = flashy ? '<span class="item-fx-ring" style="--fx-ring-dur:' + ringDur + ';"></span>' : "";
  return {
    flashy: flashy, auraDur: auraDur, particleDur: particleDur,
    layersHtml: '<span class="item-fx-aura"></span>' + ring + particles,
    tierClass: "rarity-fx-" + rarity + (flashy ? " rarity-fx-flashy" : ""),
    colorVar: color || "currentColor",
  };
}
// 아이콘(SVG) 본체를 등급 이펙트 래퍼(아우라 + 궤도 파티클)로 감싼다 — 이펙트가 없을 때는
// 기존과 완전히 같은 마크업을 내서(레이아웃 영향 없음) 호출부를 안 건드려도 되게 했다.
function wrapWithRarityFx(innerHtml, color, size, rarity) {
  const fx = rarityFxLayers(color, rarity);
  if (!fx) return '<span class="item-icon" style="color:' + (color || "currentColor") + ";width:" + size + "px;height:" + size + 'px;">' + innerHtml + "</span>";
  return (
    '<span class="item-icon-fx ' + fx.tierClass + '" style="--fx-color:' + fx.colorVar +
    ";--fx-aura-dur:" + fx.auraDur + ";--fx-particle-dur:" + fx.particleDur + ";width:" + size + "px;height:" + size + 'px;">' +
    fx.layersHtml +
    '<span class="item-icon" style="color:' + (color || "currentColor") + ';width:100%;height:100%;">' + innerHtml + "</span>" +
    "</span>"
  );
}
// ══════════════════════════════════════════════════════════
//  Arena P2P(PvP) 대상 목록 전용 — "레벨/환생 횟수/장착 무기 등급·공격력에 따라 주변에
//  아우라 파티클이 풍기게" 요청 반영. 위 아이콘용 레이어를 그대로 재사용하되, 아이콘처럼
//  정사각형 고정 크기가 아니라 이름 텍스트(가변 폭)를 감싸는 배지 형태로 낸다. 실제 등급
//  판정(레벨/환생/무기 등급을 합쳐 legendary~abyssal 중 하나로 매핑)은 서버(auraTier
//  필드)가 하고, 여기는 그 결과를 그대로 시각화만 한다.
// ══════════════════════════════════════════════════════════
window.auraNameHtml = function auraNameHtml(nameHtml, color, tier) {
  const fx = rarityFxLayers(color, tier);
  // legendary 미만(아우라 대상이 아님)이어도 색은 항상 입힌다 — 예: 칭호는 등급마다 색이
  // 달라야 하는데 낮은 등급은 파티클 없이 색만 다른 게 맞는 디자인(요청 반영: "칭호별로
  // 색과 아우라가 다르게, 어려울수록 화려하게" — 색은 전부, 화려함은 상위 등급만).
  if (!fx) return color ? '<span style="color:' + color + ';">' + nameHtml + "</span>" : nameHtml;
  return (
    '<span class="item-icon-fx name-fx ' + fx.tierClass + '" style="--fx-color:' + fx.colorVar +
    ";--fx-aura-dur:" + fx.auraDur + ";--fx-particle-dur:" + fx.particleDur + ';">' +
    fx.layersHtml +
    '<span class="name-fx-inner" style="color:' + fx.colorVar + ';">' + nameHtml + "</span>" +
    "</span>"
  );
};

// itemId + 색상을 받아 인라인 스타일이 적용된 아이콘 래퍼 HTML을 만든다(공용 헬퍼). rarity를
// 같이 넘기면(legendary 이상일 때만) 주변에 아우라 + 궤도 파티클이 붙는다.
window.itemIconHtml = function itemIconHtml(itemId, color, sizePx, rarity) {
  const svg = window.ITEM_ICONS[itemId] || window.ITEM_ICON_FALLBACK;
  const size = sizePx || 22;
  return wrapWithRarityFx(svg, color, size, rarity);
};

// ══════════════════════════════════════════════════════════
//  BOT 전용 아이콘 — "봇도 단순히 이모티콘으로 치부하지 말고 등급에 따라 달라지면 좋겠다"는
//  요청 반영. 아이템(무기/방어/코어)과 같은 원칙으로, 등급이 오를수록 도안이 점점 더
//  정교해지도록(단순 상자형 머리 → 어깨 장갑 → 바이저 → 블레이드 → 이중 안테나 → 왕관형
//  스파이크 → 후광 → 뿔 → 보이드 코어) 9단계 전부를 손 코딩했다. 봇의 "등급"은 Bots 탭에서
//  쓰는 gacha_rarity 그대로 재사용한다(별도 개념 아님).
// ══════════════════════════════════════════════════════════
window.BOT_ICONS = {
  common: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="8" width="12" height="10" rx="2"/><circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/></svg>',
  uncommon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="8" width="12" height="10" rx="2"/><rect x="3" y="10" width="2.4" height="5" rx="1"/><rect x="18.6" y="10" width="2.4" height="5" rx="1"/><circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/></svg>',
  rare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="8" width="12" height="10" rx="2"/><rect x="3" y="10" width="2.4" height="5" rx="1"/><rect x="18.6" y="10" width="2.4" height="5" rx="1"/><rect x="8" y="12" width="8" height="2" rx="1" fill="currentColor" stroke="none"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.3"/></svg>',
  epic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="8" width="12" height="10" rx="2"/><path d="M6 10l-3 1.5 3 2M18 10l3 1.5-3 2"/><rect x="8" y="11.5" width="8" height="2" rx="1" fill="currentColor" stroke="none"/><circle cx="12" cy="16.3" r="1.3" fill="currentColor" stroke="none"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.3"/></svg>',
  legendary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="8" width="12" height="10" rx="2"/><path d="M6 10l-3.5 1.5L6 13M18 10l3.5 1.5L18 13"/><rect x="8" y="11.5" width="8" height="2" rx="1" fill="currentColor" stroke="none"/><circle cx="12" cy="16.3" r="1.3" fill="currentColor" stroke="none"/><path d="M10 8V4M14 8V4"/><circle cx="10" cy="3" r="1"/><circle cx="14" cy="3" r="1"/></svg>',
  mythic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="9" width="12" height="9" rx="2"/><path d="M6 10l-3.5 1.5L6 13M18 10l3.5 1.5L18 13"/><rect x="8" y="12" width="8" height="2" rx="1" fill="currentColor" stroke="none"/><circle cx="12" cy="16.3" r="1.3" fill="currentColor" stroke="none"/><path d="M7 9l1-4 2 3 2-4 2 4 2-3 1 4"/></svg>',
  secret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="12" cy="6.5" rx="6.5" ry="2" stroke-dasharray="2 1.5"/><rect x="6" y="9" width="12" height="9" rx="2"/><path d="M6 10l-3.5 1.5L6 13M18 10l3.5 1.5L18 13"/><rect x="8" y="12" width="8" height="2" rx="1" fill="currentColor" stroke="none"/><circle cx="12" cy="16.3" r="1.3" fill="currentColor" stroke="none"/></svg>',
  forbidden: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.5 9l-2.5-5 4 3M17.5 9l2.5-5-4 3"/><rect x="6" y="9" width="12" height="9" rx="1.5"/><path d="M6 10l-3.5 1.5L6 13M18 10l3.5 1.5L18 13"/><path d="M8 12.5l2 2 2-2 2 2 2-2"/><circle cx="12" cy="16.8" r="1.3" fill="currentColor" stroke="none"/></svg>',
  abyssal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.5 9l-2.5-5 4 3M17.5 9l2.5-5-4 3"/><rect x="6" y="9" width="12" height="9" rx="1.5"/><path d="M9 12.5c0-1.8 1.8-2.7 2.7-1.3s0 3.1-1.8 3.1-2.7-1.3-2.7-2.7 1-2.7 2.3-2.7"/><path d="M4 18c2.2 1.8 5 2.6 8 2.6s5.8-.8 8-2.6"/></svg>',
};
window.botIconHtml = function botIconHtml(rarity, color, sizePx) {
  const svg = window.BOT_ICONS[rarity] || window.BOT_ICONS.common;
  const size = sizePx || 22;
  return wrapWithRarityFx(svg, color, size, rarity);
};
