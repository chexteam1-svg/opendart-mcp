# OpenDART MCP 서버

금융감독원 전자공시(DART) OpenAPI 를 Claude 에서 쓰게 하는 MCP 서버. 2026-10-30 만듦.
공정위 가맹사업 MCP(`../ftc-franchise`)와 같은 틀이다.

## 설치·등록

| 항목 | 위치 |
|---|---|
| 코드 | `C:\Users\chext\mcp-servers\opendart` (`src/index.ts`, `src/catalog.ts`) |
| 인증키 | 윈도우 사용자 환경변수 `DART_API_KEY` — `set-dart-key.ps1` 로 등록 (입력이 화면에 안 보이고, 저장 전에 실제 조회로 검증) |
| 등록 | `88.AI Workspace\.mcp.json` 의 `opendart` + `.claude\settings.local.json` 의 `enabledMcpjsonServers` |
| 캐시 | `%LOCALAPPDATA%\opendart-mcp\corpCode.json` (회사 목록, 1주마다 새로 받음) |

## 원격 (claude.ai 웹·데스크톱 채팅·코워크) — 2026-10-30

| 항목 | 값 |
|---|---|
| 저장소 | https://github.com/chexteam1-svg/opendart-mcp (공개, 키 없음). **푸시하면 Render 가 자동 배포** |
| 호스팅 | Render 무료, 싱가포르, `render.yaml` Blueprint. 서비스 주소 `https://opendart-mcp-37uz.onrender.com` |
| 키 | Render 환경변수 `DART_API_KEY` (사용자가 Render 화면에서 직접 붙여넣음) |
| 커넥터 주소 | `https://opendart-mcp-37uz.onrender.com/mcp/<토큰>` — **주소 자체가 비밀번호**. 채팅·문서에 적지 말 것 |
| 상태 확인 | `https://opendart-mcp-37uz.onrender.com/healthz` (인증 없음, 키 값은 안 나옴) |

- 토큰 = `sha256("opendart-mcp:" + DART_API_KEY)` 16진수 앞 32자. Render 환경변수 `MCP_AUTH_TOKEN` 을 넣으면 그 값이 우선한다(주소를 바꾸고 싶을 때).
  이 PC 에 키가 있으니 같은 주소를 언제든 다시 계산할 수 있다 — Claude 에게 "커넥터 주소 클립보드에 넣어줘" 하면 된다.
- claude.ai 커넥터는 고정 헤더(Bearer)를 못 보내서 이 방식을 택했다. `Authorization: Bearer <토큰>` 으로 `/mcp` 를 부르는 것도 된다(Claude Code 등).
- 토큰이 없거나 틀리면 `404` 만 준다 (주소가 틀렸는지 토큰이 틀렸는지 구분해 주지 않음).
- ⚠️ `opendart-mcp.onrender.com`(접미사 없는 주소)은 **다른 사람의 파이썬 서버**다. 응답 머리 `x-render-origin-server: uvicorn` 으로 구분된다.
- 무료 플랜은 15분 안 쓰면 잠든다 — 그날 첫 호출이 30초~1분 느리다.

`src` 를 고치면 `npm run build` 하고 Claude Code 를 재시작해야 새 빌드가 뜬다. 원격은 `git push` 하면 Render 가 다시 빌드한다.
키는 `process.env` 에 없으면 레지스트리(HKCU\Environment)에서 직접 읽으므로, 키를 바꿔도 앱 재시작은 필요 없다.

## 도구 8개

| 도구 | 하는 일 |
|---|---|
| `dart_find_company` | 회사명·종목코드로 고유번호 찾기. 비상장 외감법인도 나온다 |
| `dart_get_company` | 기업개황 (대표·사업자번호·주소·설립일·결산월) |
| `dart_search_disclosures` | 공시 목록. 감사보고서는 `pblntf_ty="F"` |
| `dart_get_financials` | 재무제표 당기·전기·전전기 (`scope` main/full) |
| `dart_read_document` | 공시 원문 ZIP 을 풀어 글자로. `find="재무상태표"` 로 바로 이동 |
| `dart_list_apis` | 아래 80개 API 목록 |
| `dart_call_api` | 그 80개 중 아무거나 직접 호출 (최대주주·임원·배당·합병 등) |
| `dart_check_api_access` | 키·연결·캐시 점검. 이상하면 먼저 이것 |

모든 도구가 `company` 에 회사명을 그대로 받는다. 같은 이름이 여럿이면 후보를 보여주고 멈춘다.

## RealYoungk/opendart-mcp 와의 관계

[RealYoungk/opendart-mcp](https://github.com/RealYoungk/opendart-mcp) (MIT, Ver 0.1.0, 2026-02-20 이후 커밋 없음)의 장점인
**83개 API 전부**를 `src/catalog.ts` 로 가져왔다 (ZIP 을 주는 3개는 전용 도구로 대체해 80개).
그쪽 `get_corp_code`·`get_document` 는 ZIP 을 base64 로 통째 돌려줘서 Claude 가 읽지 못한다 — 여기서는 풀어서 준다.

## 함정

- **재무 API 는 사업보고서 제출 회사만** 있다(상장사·일부 큰 비상장사, 2015년 이후). 감사보고서만 내는 비상장 가맹본부는
  `dart_search_disclosures(pblntf_ty="F")` → `dart_read_document(find="재무상태표")` 로 원문을 읽어야 한다.
- 재무 API 금액은 **원** 단위다 (공정위 MCP 는 천원 — 섞지 말 것). 표에는 억원으로 줄여 보이고 json 은 원값 그대로.
- `status 013` 은 오류가 아니라 "조회된 데이터 없음"이다. 빈 결과로 돌려준다.
- 회사를 안 정한 공시검색은 기간이 최대 3개월이다.
- 하루 호출 한도 20,000건.
- **옛 공시는 XML 선언이 거짓말을 한다** — 삼성전자 2008 3분기(20081114000862)는 `encoding="utf-8"` 이라 적혀 있는데 내용은 EUC-KR 이다.
  선언을 믿으면 글자가 다 깨지고 `find` 가 아무것도 못 찾는다. 그래서 UTF-8 로 엄격히 풀어 보고 실패하면 EUC-KR 로 읽는다.
- 주요계정 API(`fnlttSinglAcnt`)는 **당기순이익을 같은 값으로 두 번** 내려준다(교촌 2025 ord 29·61). 표에서는 한 번만 보인다.
- '삼성' 처럼 짧은 이름은 이름이 딱 맞는 비상장 '주식회사 삼성' 이 따로 있다. 비슷한 이름의 상장사가 있으면 자동으로 고르지 않고 후보를 보여준다.
- 감사보고서 제목은 `재 무 상 태 표` 처럼 띄어 써 있고, 앞에 목차가 있다. `find` 는 띄어쓰기를 무시하고 목차(점선)를 건너뛰며 제목 줄을 먼저 고른다.

## 검증 기록 (2026-10-30, 실제 키)

- 회사 찾기: '교촌'→교촌에프앤비 00453284, '339770'→같은 회사, 전체 119,846개사 목록 캐시 13.3MB
- 재무(상장): 교촌에프앤비 2025 연결 매출 5,173.5억·영업이익 350.4억
- 재무(비상장): 제너시스비비큐 → "자료 없음" + 감사보고서 안내. 감사보고서(20260414001909) 원문에서 2025 매출 525,040,860,142원·영업이익 53,138,352,982원을 표 행으로 읽음
- 일부러 틀린 키(0×40) → 세 도구 모두 "등록되지 않은 키(status 010)" 로 안내
- 키 없이 → 연결 점검이 "미설정" 으로 안내

## 남은 일

1. **로컬 stdio 는 `88.AI Workspace` 폴더에서 연 Claude Code 세션에서만 보인다** (프로젝트 `.mcp.json` 등록). 다른 곳은 원격 커넥터로 쓴다.
2. ~~claude.ai 웹·휴대폰~~ → 2026-10-30 Render 원격으로 해결. Render 에서 외부 시험 통과(아래). claude.ai 커넥터 등록은 사용자가 화면에서 했는지 확인 필요.
3. ~~git 저장소 아님~~ → 2026-10-30 GitHub 공개 저장소로 올림.

## 원격 검증 기록 (2026-10-30, Render)

- `/healthz` 200, `keySet: true`
- 토큰 없이 `/mcp`·틀린 토큰 → 404 / 맞는 주소 → initialize 200, 도구 8개
- 교촌에프앤비 2025 매출 5,173.5억 (첫 호출 11.8초 — 회사 목록 13MB 받는 시간)
- BBQ 감사보고서 원문 영업이익 53,138,352,982 / 삼성전자 2008 옛 공시(EUC-KR) 글자 정상
