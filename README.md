
# 🚀 BingX Live Trading System (Bot + Dashboard)

본 프로젝트는 BingX 선물 거래소에서 24시간 작동하는 **Python 기반의 무인 자동매매 봇(Backend)**과, 봇의 상태를 실시간으로 시각화해 주는 **React 기반의 라이브 대시보드(Frontend)**로 구성된 풀스택(Full-stack) 퀀트 트레이딩 시스템입니다.

## 🏗️ 1. 시스템 아키텍처 (System Architecture)

이 시스템은 '매매를 실행하는 두뇌(Python)'와 '현황을 보여주는 눈(React)'이 완벽하게 분리되어 작동합니다.

### 📂 디렉토리 구조 (추천)

```
my-trading-system/
├── backend/                  # 파이썬 봇 (두뇌)
│   ├── main.py               # 메인 트레이딩 루프 및 상태 관리
│   ├── bingx_api.py          # BingX 거래소 API 통신 모듈
│   ├── strategy.py           # 횡보 박스(Sideways Box) 타점 분석 엔진
│   ├── config.json           # 환경 설정 (API 키, 자본금, 슬랙 토큰 등)
│   └── bot_state.json        # ⭐️ 봇의 현재 잔고 및 포지션 상태 (DB 역할)
│
└── frontend/                 # 리액트 대시보드 (눈)
    ├── src/
    │   ├── App.tsx           # ⭐️ 라이브 모니터링 관제탑 UI (차트, 잔고, PnL)
    │   └── main.tsx
    ├── package.json
    └── vite.config.ts
```

### ⚙️ 데이터 흐름 (Data Flow)

1. **Python 봇 (`main.py`)**: 5분마다 BingX에서 캔들을 가져와 분석하고, 타점이 나오면 거래소에 주문(OCO SL/TP 포함)을 넣습니다. 주문 결과와 현재 잔고는 즉시 `bot_state.json` 파일에 덮어씁니다.
2. **로컬 파일 서버**: `bot_state.json` 파일을 브라우저가 읽을 수 있도록 8000번 포트에서 서빙(Serving)합니다.
3. **React 대시보드 (`App.tsx`)**: 5초에 한 번씩 `http://localhost:8000/bot_state.json` 을 찔러서 봇의 최신 상태를 가져오고, 바이낸스 API로 차트를 그려 화면에 미실현 손익(Unrealized PnL)과 타점 라인을 렌더링합니다.

## 🛡️ 2. 실전 투입용 핵심 안전장치 (Safety Features)

- **서버-사이드 OCO 청산**: 봇이 직접 청산하지 않고, 진입 시 거래소에 목표가(TP)와 손절가(SL)를 미리 세팅하여 서버 다운 시의 자산 증발 위험을 0%로 만들었습니다.
- **유령 포지션 스파이크 방어**: 봇이 쉬는 5분 사이에 꼬리로 TP/SL을 치고 온 경우를 추적하기 위해 1분봉 궤적을 샅샅이 스캔하여 내부 회계를 일치시킵니다.
- **Slack (Bot Token) 실시간 알림**: 타점 포착, 진입 성공, 청산 완료 및 시스템 에러 등 모든 중요 이벤트를 스마트폰 슬랙으로 즉각 전송합니다.

## 🚀 3. 상세 실행 가이드 (How to Run)

시스템을 가동하려면 총 **3개의 터미널** 을 띄워야 합니다. (VS Code의 터미널 분할 기능을 적극 권장합니다.)

### Step 1. 사전 준비 (Prerequisites)

- 파이썬 의존성 설치: `pip install requests`
- `backend/config.json` 파일에 본인의 BingX API Key, Secret Key, Slack Token(`xoxb-`), Slack Channel ID 입력.

### Step 2. 터미널 A: 파이썬 매매 봇 실행 (두뇌 가동)

`backend` 폴더로 이동하여 메인 봇을 실행합니다. 이 터미널은 24시간 내내 켜져 있어야 합니다.

```
cd backend
python main.py
```

> **성공 확인:** 슬랙으로 `✅ 실전 자동매매 봇(BingX) 라이브 모니터링 시작!` 메시지가 도착하면 정상입니다.

### Step 3. 터미널 B: 로컬 데이터 서버 실행 (연결 다리)

대시보드가 `bot_state.json` 을 읽어갈 수 있도록 **반드시 `backend` 폴더 내에서** 로컬 서버를 엽니다. 브라우저의 CORS(교차 출처 자원 공유) 에러를 막기 위해 Node.js의 `http-server` 사용을 권장합니다.

```
cd backend
npx http-server -p 8000 --cors
```
*(Node.js가 없다면 `python -m http.server 8000` 을 사용하되, 브라우저 환경에 따라 CORS 에러로 대시보드 연결이 안 될 수 있습니다.)*

### Step 4. 터미널 C: React 대시보드 띄우기 (눈 가동)

`frontend` 폴더로 이동하여 개발 서버를 실행합니다.

```
cd frontend
npm run dev
```

### Step 5. 모니터링 시작

브라우저에서 `http://localhost:5173` (Vite 기본 포트)에 접속합니다.

- 좌측 상단에 초록색 서버 아이콘(`Polling Active (5s)`)이 뜬다면 파이썬 봇과 완벽하게 동기화된 것입니다!
- 만약 주황색 `MOCK MODE` 배지가 떠 있다면, 터미널 B(데이터 서버)가 제대로 켜지지 않았거나 CORS 에러가 발생한 것이므로 터미널 B의 상태를 확인해 주세요.

## 🛠️ 4. 트러블슈팅 (Troubleshooting)

- **`channel_not_found` 에러 (Slack)**: `config.json` 의 채널명 대신 '채널 ID(예: C0123...)'를 사용하고, 해당 채널 채팅창에 `/invite @봇이름` 을 입력해 봇을 초대하세요.
- **`[Errno 11001] getaddrinfo failed` 에러**: 일시적인 인터넷 끊김입니다. 봇이 내장된 지수 백오프(Exponential Backoff) 로직으로 스스로 복구하므로 끄지 말고 기다리시면 됩니다.
- **대시보드에 PnL이 안 뜰 때**: 아직 봇이 타점을 찾지 못해 진입한 포지션이 없는 정상적인 대기 상태(`Waiting for signals...`)입니다.