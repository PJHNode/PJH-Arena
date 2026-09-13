// ══════════════════════════════════════════════════════════
//  UI 아이콘 — "이모티콘이 너무 많다"는 요청 반영. item-icons.js(아이템/봇/Property)와
//  똑같은 원칙으로, 화면 전체에서 가장 자주 보이는 세 곳(사이드바 탭, 헤더 리소스/스탯,
//  전투 태세 선택)만 우선 손 코딩 SVG로 바꿨다 — 나머지(토스트/로그/카드 등 스쳐 지나가는
//  곳)는 이번엔 그대로 이모티콘을 유지한다(요청 시 "핵심 UI만 우선 교체"로 범위 확정).
//  전부 stroke="currentColor" 기준으로 그려서 감싸는 요소의 글자색을 그대로 물려받는다 —
//  사이드바 탭이 active/hover로 색이 바뀌면 아이콘도 같이 바뀐다.
// ══════════════════════════════════════════════════════════
window.UI_ICONS = {
  // ── 사이드바 탭(21개) — 각 콘텐츠의 성격이 한눈에 구분되도록 서로 다른 형태로 그렸다. ──
  sidebar: {
    // 전투
    jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/><path d="M7 9l2 2-2 2M12 13h3"/></svg>',
    galaxy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="12" r="5" fill="currentColor" stroke="none"/><ellipse cx="11" cy="12" rx="10.5" ry="3" transform="rotate(-18 11 12)"/><circle cx="21" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="19" r="0.8" fill="currentColor" stroke="none"/></svg>',
    pvp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1.5v3.5M12 19v3.5M1.5 12h3.5M19 12h3.5"/></svg>',
    worldraid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 14c2-6 6-9 8-9s6 3 8 9c-2 3-5 4-8 4s-6-1-8-4z"/><path d="M8 8L7 5M16 8l1-3"/><circle cx="9" cy="12.5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12.5" r="1" fill="currentColor" stroke="none"/></svg>',
    bounty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M9 3.5V2h6v1.5"/><circle cx="12" cy="11.5" r="3"/><circle cx="12" cy="11.5" r="0.7" fill="currentColor" stroke="none"/><path d="M9 17.5h6"/></svg>',
    // 경제
    shop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="20" r="1.3" fill="currentColor" stroke="none"/><circle cx="17" cy="20" r="1.3" fill="currentColor" stroke="none"/><path d="M3 4h2l2.4 12.2a2 2 0 002 1.8h8.2a2 2 0 002-1.7L21 8H6"/></svg>',
    bots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="8" width="12" height="10" rx="2"/><circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/></svg>',
    inventory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9l8-5 8 5"/><rect x="4" y="9" width="16" height="11" rx="1.2"/><path d="M4 9.5l8 4 8-4"/><path d="M12 13.5V20"/></svg>',
    property: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="7" width="16" height="14" rx="1"/><path d="M4 21h16"/><rect x="7" y="10" width="3" height="3" fill="currentColor" stroke="none"/><rect x="14" y="10" width="3" height="3" fill="currentColor" stroke="none"/><rect x="7" y="15.5" width="3" height="3" fill="currentColor" stroke="none"/><rect x="14" y="15.5" width="3" height="3" fill="currentColor" stroke="none"/></svg>',
    bank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 10l9-5.5L21 10"/><rect x="5" y="10" width="14" height="8.5" rx="0.5"/><path d="M9 10v8.5M15 10v8.5"/><path d="M3 20.5h18"/></svg>',
    raffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8.5a1.8 1.8 0 010 3.5V16a2 2 0 002 2h14a2 2 0 002-2v-4a1.8 1.8 0 010-3.5V6a2 2 0 00-2-2H5a2 2 0 00-2 2z"/><path d="M9.5 4v16" stroke-dasharray="2 2"/></svg>',
    research: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 3h6M10 3v6l-5.2 8.7A1.8 1.8 0 006.3 20.5h11.4a1.8 1.8 0 001.5-2.8L14 9V3"/><path d="M8.5 15h7"/></svg>',
    enchant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/><circle cx="19" cy="4.5" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="0.9" fill="currentColor" stroke="none"/></svg>',
    trade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8h13M14 4l4 4-4 4"/><path d="M20 16H7M10 12l-4 4 4 4"/></svg>',
    // 환생
    rebirthshop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21c-4-2-7-6-7-10.5a7 7 0 0114 0C19 15 16 19 12 21z"/><path d="M12 21V9.5"/><path d="M8.5 13c1-1.8 2-2.7 3.5-2.7s2.5.9 3.5 2.7"/></svg>',
    // 소셜
    club: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6z"/><circle cx="12" cy="10" r="2"/><path d="M8.7 15.3c0-1.8 1.5-3.3 3.3-3.3s3.3 1.5 3.3 3.3"/></svg>',
    achievements: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 4h8v4a4 4 0 01-8 0z"/><path d="M8 5H5.5A2.5 2.5 0 008 7.5M16 5h2.5A2.5 2.5 0 0116 7.5"/><path d="M10 14h4v3h-4z"/><path d="M8 20.5h8"/></svg>',
    profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/></svg>',
    leaderboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.5 20V13M10 20V6.5M15.5 20V15M21 20v-6.5"/><path d="M3 20h18"/></svg>',
    // 기록
    logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="3" width="15" height="18" rx="1.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2.1 2.1M16.9 16.9L19 19M5 19l2.1-2.1M16.9 7.1L19 5"/></svg>',
  },
  // ── 헤더 리소스바/스탯(HP·에너지·스태미나·ATK·DEF·CRIT) + 스탯 포인트 뱃지. 화면에 항상
  //    떠 있는 곳이라 크기를 작게(13px) 잡고 라인만 최소한으로 그렸다. ──
  stat: {
    hp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-4.4-9.5-9A5.4 5.4 0 0112 6a5.4 5.4 0 019.5 6C19 16.6 12 21 12 21z"/></svg>',
    energy: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></svg>',
    stamina: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="9" width="16" height="6" rx="1.2"/><path d="M20.5 11v2" stroke-width="2.2"/><rect x="4.5" y="10.3" width="6" height="3.4" rx="0.6" fill="currentColor" stroke="none"/></svg>',
    atk: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M19 5L3 15l6 6z"/></svg>',
    def: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2.5l7.5 3.2v6.3c0 5.2-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.3-7.5-9.5V5.7z"/></svg>',
    crit: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l2 6 6 1-4.5 4 1.5 6-6-3.5L6 22l1.5-6L3 12l6-1z"/></svg>',
    statPoints: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3l9 16H3z"/></svg>',
  },
  // ── 전투 태세 선택(공격형/방어형/기습형) — Attack Sequence 모달의 3버튼용. 무기고 아이템
  //    아이콘과 겹치지 않게 "교차된 두 칼날 / 십자가 방패 / 잔상이 붙은 단검"으로 구분했다. ──
  stance: {
    aggressive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20L15 5l2 2L6 22z"/><path d="M20 20L9 5 7 7l11 15z"/></svg>',
    defensive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2.5l7.5 3.2v6.3c0 5.2-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.3-7.5-9.5V5.7z"/><path d="M12 8v8M8 12h8"/></svg>',
    ambush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 19L16.5 8.5l2 2L8.5 21z"/><path d="M3.5 15.5l1.8-1.8M3 11.8l2.6-2.6"/></svg>',
  },
};
