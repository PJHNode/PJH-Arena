# PJH Arena

PJH-Hub와 계정(아이디/비밀번호)만 공유하고, 사이트 자체는 독립적으로 운영되는 별도 프로젝트.

- 계정: `pjh-auth.chaostatix.workers.dev`를 PJH-Hub와 그대로 재사용 — 같은 아이디/비밀번호로 양쪽 다 로그인 가능.
  단, 세션(로그인 유지)은 도메인마다 localStorage에 따로 저장되므로 진짜 SSO는 아니고 "계정만 공유".
- 배포: `public/` 폴더를 Cloudflare Pages 프로젝트 `pjh-arena`로, `main` push마다 GitHub Actions가 자동 배포.

## 최초 1회 수동 설정 (필요)

1. Cloudflare Pages 프로젝트 생성 (로컬 wrangler 로그인 상태에서):
   ```
   npx wrangler pages project create pjh-arena --production-branch main
   ```
2. 이 저장소(PJH-Arena)의 GitHub Settings → Secrets and variables → Actions에 아래 두 개 등록:
   - `CLOUDFLARE_API_TOKEN` — Pages:Edit 권한 있는 토큰 (PJH-hub에서 쓰던 토큰 재사용 가능)
   - `CLOUDFLARE_ACCOUNT_ID` — `c31bb04e7cc014b454684a18f48031c4`

이후로는 `main`에 push만 하면 자동 배포됨(수동 wrangler 명령 불필요).
