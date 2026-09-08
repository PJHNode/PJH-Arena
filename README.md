# PJH Arena

사이버펑크 해커 컨셉 웹 게임. PJH-Hub와 계정(아이디/비밀번호)만 공유하고, 게임 자체(레벨/코인/전투)는
완전히 독립된 시스템으로 운영된다.

## 구조
- **public/** — 정적 프론트엔드(대시보드 SPA). Cloudflare Pages 프로젝트 `pjh-arena`로 배포.
- **worker/** — 백엔드 Cloudflare Worker `arena` (`arena.chaostatix.workers.dev`) + 전용 D1 `arena`.
  - 계정 인증만 PJH-Hub와 KV(SESSIONS/USERS)를 공유해서 세션을 검증한다(board-worker.js의
    verifyUser와 동일 계약) — 읽기 전용, 절대 쓰지 않음.
  - 레벨/XP/HP/에너지/스태미나/Pocket·Bank 코인/장비/전투 기록은 전부 이 Worker 소유의 D1에만
    저장되는 완전히 새로운 경제 시스템 — PJH-Hub의 XP/코인과는 무관.
- 계정: `pjh-auth.chaostatix.workers.dev`를 PJH-Hub와 그대로 재사용 — 같은 아이디/비밀번호로 양쪽 다 로그인 가능.
  단, 세션(로그인 유지)은 도메인마다 localStorage에 따로 저장되므로 진짜 SSO는 아니고 "계정만 공유".
- 배포: `public/`은 push마다 Cloudflare Pages로, `worker/`는 관련 파일이 바뀐 push에서만 Worker로
  각각 GitHub Actions가 자동 배포(두 워크플로우로 분리).

## 알려진 설계 결정 / 스펙과의 차이
- 상단 통합 위젯 바의 "금/달러, 채권"은 PJH-Hub의 기존 시세 위젯(`pjh-hub-news`)에 그 데이터가
  없어서(KOSPI/원달러/BTC만 존재) 뺐다. 추가하려면 news-worker.js에 새 소스를 붙이는 별도 작업 필요.
- 기본 ATK/DEF는 스펙에 수식이 없어 `10 + 레벨×2`로 임의 설정(장비 없이도 레벨업이 전투력에
  의미 있도록). 바꾸고 싶으면 worker/arena-worker.js의 `baseAtkFor`/`baseDefFor`만 고치면 됨.
- Hacking Jobs 카드는 스펙 보상표가 4단계(Low/Medium/High/Master)뿐이라 4개만 구현(레이아웃
  설명의 "6개"는 반영 안 함) — 추가 난이도가 필요하면 알려줄 것.

## 최초 1회 수동 설정 (필요)

1. Cloudflare Pages 프로젝트 생성 (로컬 wrangler 로그인 상태에서):
   ```
   npx wrangler pages project create pjh-arena --production-branch main
   ```
2. 이 저장소(PJH-Arena)의 GitHub Settings → Secrets and variables → Actions에 아래 두 개 등록:
   - `CLOUDFLARE_API_TOKEN` — Pages:Edit 권한 있는 토큰 (PJH-hub에서 쓰던 토큰 재사용 가능)
   - `CLOUDFLARE_ACCOUNT_ID` — `c31bb04e7cc014b454684a18f48031c4`

이후로는 `main`에 push만 하면 자동 배포됨(수동 wrangler 명령 불필요).
