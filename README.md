# Capture Website

웹사이트 기능 분석을 위한 자동화 도구
- 스크린샷 자동 캡처
- 네트워크 요청(XHR/Fetch) 자동 추출
- curl 명령어로 자동 변환

## 환경 설정

### Node.js 버전

이 프로젝트는 Node.js 20(LTS)을 사용합니다. [nvm](https://github.com/nvm-sh/nvm)으로 버전을 관리하세요.

```bash
# 설치 가능한 버전 확인
nvm ls

# 프로젝트에 맞는 버전으로 전환 (.nvmrc 기준)
nvm use

# 해당 버전이 없는 경우 설치 후 전환
nvm install
```

## 설치

```bash
nvm use
npm install
```

## 사용법

### 🔴 Recording 모드 (수동 조작 → 자동 캡처)

URL만 넘기면 브라우저가 열립니다. 직접 조작 후 터미널에서 Enter를 누르면 스크린샷 + curl이 저장됩니다.

```bash
node record.js <url> [출력명]

# 예시
node record.js https://example.com my-session
npm run record https://example.com my-session
```

결과물은 `capture-results/<출력명>/` 에 저장됩니다:
- `screenshot.png` — 최종 화면 전체 스크린샷
- `requests.json` — 캡처된 XHR/Fetch 요청 상세
- `requests.curl.sh` — 재현 가능한 curl 명령어 스크립트

---

### ⚙️ 자동화 모드 (시나리오 기반)

### 1. 설정 파일 생성

```bash
cp capture-config.example.json capture-config.json
```

설정 파일을 프로젝트에 맞게 수정하세요.

### 2. 실행

```bash
npm run capture capture-config.json
# 또는
node capture-website.js capture-config.json
```

### 3. 결과 확인

`capture-results/` 디렉토리에 다음 파일들이 생성됩니다:

- `시나리오명.png` - 전체 페이지 스크린샷
- `시나리오명.json` - 네트워크 요청/응답 상세 정보
- `시나리오명.curl.sh` - 재현 가능한 curl 명령어들
- `_summary.json` - 전체 실행 결과 요약

## 설정 파일 구조

```json
{
  "outputDir": "./capture-results",
  "headless": false,
  "scenarios": [
    {
      "name": "시나리오명",
      "url": "https://example.com",
      "cookies": [
        {
          "name": "SESSION",
          "value": "your-session-value",
          "domain": "example.com",
          "path": "/"
        }
      ],
      "actions": [
        { "type": "wait", "ms": 1000 },
        { "type": "fill", "selector": "input[name='query']", "value": "검색어" },
        { "type": "click", "selector": "button.submit" },
        { "type": "waitForSelector", "selector": ".results" }
      ],
      "waitMs": 2000
    }
  ]
}
```

### 액션 타입

- `wait`: 지정된 시간(ms) 대기
- `fill`: 입력 필드에 값 입력
- `click`: 요소 클릭
- `waitForSelector`: 특정 요소가 나타날 때까지 대기

## 예시

```bash
# 테스트 실행
npm test

# 실제 설정으로 실행
npm run capture my-config.json
```
