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
};

// 못 찾은 아이템(신규 아이템 추가를 깜빡한 경우)에 대한 안전망 — 물음표 아이콘.
window.ITEM_ICON_FALLBACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 1.8-2.5 3.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/></svg>';

// itemId + 색상을 받아 인라인 스타일이 적용된 아이콘 래퍼 HTML을 만든다(공용 헬퍼).
window.itemIconHtml = function itemIconHtml(itemId, color, sizePx) {
  const svg = window.ITEM_ICONS[itemId] || window.ITEM_ICON_FALLBACK;
  const size = sizePx || 22;
  return '<span class="item-icon" style="color:' + (color || "currentColor") + ";width:" + size + "px;height:" + size + 'px;">' + svg + "</span>";
};
