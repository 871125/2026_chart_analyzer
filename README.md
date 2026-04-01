# 📈 Quantitative Chart Analyzer & Trading Bot

이 프로젝트는 **BingX 무기한 선물(Perpetual Futures) API**를 활용하여 차트의 '횡보 박스권(Sideways Box)' 돌파 전략을 시각적으로 백테스트하고, 실제 자동 매매까지 수행하는 종합 퀀트 트레이딩 시스템입니다.

## ✨ 주요 기능 (Features)

1. **React 기반 백테스트 시뮬레이터 (`/chart-analyzer`)**
   * **BingX Live Data**: 실시간 BingX 캔들 데이터를 불러와 차트에 렌더링합니다.
   * **시계열 백테스트 엔진**: 지정된 기간의 과거 데이터를 기반으로 횡보 박스를 탐지하고 가상의 포지션(롱/숏) 진입 및 청산을 시뮬레이션합니다.
   * **자금 관리(Money Management)**: 초기 자본금, 리스크(%), 레버리지, 최대 동시 진입 포지션 수를 설정하여 PnL 및 계좌 잔고(MDD)의 변화를 시각적으로 확인합니다.

2. **Node.js 자동 매매 봇 (`/bot`)**
   * **100% 자동화**: 설정된 차트 주기(예: 1h, 4h)마다 정각에 차트를 분석하여 신규 타점을 발굴합니다.
   * **BingX API 연동**: 타점 도달 시 지정된 리스크 비율에 맞춰 진입 수량을 자동 계산하고, 시장가 진입과 동시에 TP(익절) / SL(손절) 주문을 전송합니다.
   * **텔레그램 알림(Telegram Bot)**: 봇 부팅, 신규 타점 탐지, 진입(체결) 성공/실패, 타점 무효화 등의 핵심 이벤트를 실시간으로 메신저로 전송합니다.
   * **상태 복구(State Recovery)**: 봇이 예기치 않게 종료되더라도 `state.json`을 통해 대기 중인 타점을 기억하고 복구합니다.

## 🚀 설치 및 실행 방법 (Getting Started)

### 1. 환경 변수 설정 (`.env`)
봇 구동을 위해 루트 디렉토리에 `.env` 파일을 생성하고 아래 정보를 입력하세요.
```env
# BingX API Keys
BINGX_API_KEY=your_bingx_api_key_here
BINGX_API_SECRET=your_bingx_api_secret_here

# Telegram Bot Setup
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
```

### 2. 패키지 설치
```bash
# 백테스트 웹 UI 패키지 설치
cd chart-analyzer
npm install

# 트레이딩 봇 패키지 설치
cd ../bot
npm install
```

### 3. 애플리케이션 실행

**웹 UI (백테스트 시뮬레이터) 실행**
```bash
cd chart-analyzer
npm start
```
* 브라우저에서 `http://localhost:3000`으로 접속하여 차트를 확인합니다.

**트레이딩 봇 (실전 자동 매매) 실행**
```bash
cd bot
npm run start
# 또는 ts-node index.ts
```
* 봇이 부팅되면 텔레그램으로 부팅 성공 메시지와 대기 중인 타점 리스트가 전송됩니다.

## ⚠️ 주의사항 (Disclaimer)
* 본 시스템은 학습 및 연구 목적으로 제작되었습니다.
* 알고리즘 트레이딩은 원금 손실의 위험이 매우 높으므로, 반드시 **BingX 모의투자(Demo) 환경**이나 소액으로 충분한 검증을 거친 후 사용하시기 바랍니다.
* 레버리지 설정 및 리스크(Risk Per Trade) 관리에 각별히 주의하세요. 
* 예기치 않은 API 통신 장애나 거래소 점검 시 봇이 정상 작동하지 않을 수 있습니다.