# Quantitative Chart Analyzer - 프로젝트 문서

본 문서는 Binance API를 활용하여 시장 데이터를 수집하고, 횡보 박스(Sideways Box) 전략을 기반으로 매매 타점을 분석 및 백테스트하는 **고급 정량적 차트 분석기 대시보드** 에 대한 상세 안내서입니다.

## 1. 핵심 아키텍처 및 기능 설명

이 애플리케이션은 크게 **[코어 엔진]**과 **[리액트 뷰(UI)]** 두 부분으로 나뉘며, 실제 트레이딩 환경과 동일한 **시계열 기반 백테스트 시뮬레이터(Chronological Backtester)**를 탑재하고 있습니다.

### 1.1. 코어 엔진 로직 (Core Engine)

시장 데이터를 분석하여 의미 있는 매매 타점(Zone)을 찾아내고, 상태를 추적하는 로직입니다.

- **`BinanceAPI` 클래스**

  - **역할:** 바이낸스 REST API(`/api/v3/klines`)를 호출하여 OHLCV 캔들 데이터를 가져옵니다.
  - **특징:** 최대 조회 제한(1,000개)을 극복하기 위해 `while` 루프를 사용한 **Pagination(페이지네이션)** 로직이 구현되어 있습니다. API Rate Limit 보호를 위해 지연(50ms)을 주며, 네트워크 오류 시 내장된 `Mock Data` 를 반환하는 Fallback 기능이 있습니다.
- **`Indicators` 클래스**

  - **역할:** RSI (Wilder's Smoothing), Regular Divergence(일반 다이버전스), 거래량 확장(Volume Expansion), 핀바(Pinbar) 및 장악형(Engulfing) 캔들 패턴 인식을 담당합니다.
- **`SidewaysBoxDetector` 클래스**

  - **역할:** 핵심 매매 전략인 '횡보 박스'를 감지합니다.
  - **로직:** 1. 캔들을 순회하며 박스의 상/하단(High/Low) 경계를 정의하고 돌파(Breakout)를 감지합니다.
2. 돌파 후 3캔들 동안 박스 내부 오더블록(OB)으로 재진입하지 않는지 유효성을 검사합니다.
3. 추세 지속형, 돌파 준비형, 변곡점 등 **아키타입(Archetype)**을 분류합니다.
4. 지표를 기반으로 점수(Score)를 매겨 기준점(70점) 이상인 타점만 필터링하고 R:R(Risk to Reward) 비율에 따라 EP, SL, TP를 계산합니다.
- **`ChartEngine` & 시계열 시뮬레이터**

  - **역할:** 미래 데이터를 참조하지 않고(Look-ahead bias 제거) 시간순으로 캔들을 순회하며 실시간 계좌 상태를 시뮬레이션합니다.
  - **주요 기능:**

    - **다중 포지션 제어 (`Max Pos`):** 설정한 최대 포지션 수를 초과하면 신규 타점을 취소(`Canceled: Max Pos`)합니다.
    - **레버리지 및 증거금 (`Margin`):** 고정 리스크(Fixed Fractional) 모델을 적용하여 필요한 총 진입 규모(`Pos`)를 구하고, 이를 레버리지로 나눈 실제 필요 증거금(`Margin`)을 계산합니다. 잔여 증거금이 부족하면 진입을 취소(`Canceled: No Margin`)합니다.
    - **논리적 오류 방지:** EP(진입가)에 도달하기 전에 SL(손절가)을 먼저 터치한 차트 붕괴 타점은 안전하게 진입을 취소(`Canceled: SL Hit First`)합니다.

### 1.2. 리액트 뷰 (React UI)

코어 엔진의 분석 결과를 시각화하고 사용자와 상호작용하는 프론트엔드 파트입니다.

- **동기화된 3중 Canvas 렌더링**

  - **Main Chart:** 캔들스틱, 횡보 박스, 박스 연장선, 진입(▲/▼) 및 청산(원형) 마커를 렌더링합니다. 취소된 박스는 흐린 점선으로 구분합니다.
  - **PNL Curve:** 누적 손익비(R 단위)의 변화를 그립니다.
  - **Equity Curve:** 초기 자본과 리스크(%) 기반의 복리 자산 변동($)을 그립니다.
  - *특징:* 마우스 휠(Zoom)과 드래그(Pan) 조작 시 세 차트의 X축(시간)이 완벽하게 동기화되어 움직입니다.
- **백테스팅 통계 및 데이터 테이블**

  - 차트 우측 상단에 실시간 **승률(Win Rate)**과 **최대 낙폭(MDD)**을 표시합니다.
  - 데이터 테이블에서는 각 거래의 상태(대기/진입/익절/손절/취소), **Invested (총 진입 규모 및 증거금)**, 자산 대비 손익률(%) 등을 상세히 확인할 수 있습니다.

## 2. 사용 및 설치 방법

본 프로젝트는 최신 React 및 Tailwind CSS(v3) 환경에서 동작하도록 설계되었습니다.

### 2.1. 프로젝트 셋업

터미널을 열고 아래 명령어들을 차례대로 실행합니다.

```
# 1. Vite를 사용하여 React + TypeScript 프로젝트 생성
npm create vite@latest chart-analyzer -- --template react-ts

# 2. 생성된 폴더로 이동 및 패키지 설치
cd chart-analyzer
npm install
npm install lucide-react

# 3. Tailwind CSS(v3) 및 PostCSS 설치 (v4 에러 방지)
npm install -D tailwindcss@3 postcss autoprefixer

# 4. Tailwind 설정 파일 초기화
npx tailwindcss init -p
```

### 2.2. 코드 덮어쓰기 및 설정

1. **Tailwind 설정:** `tailwind.config.js` 파일을 열고 아래 내용으로 교체합니다.

```
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

1. **CSS 설정:** `src/index.css` 파일의 모든 내용을 지우고 아래 내용을 입력합니다.

```
@tailwind base;
@tailwind components;
@tailwind utilities;
```

1. **앱 코드 적용:** 완성된 `ChartAnalyzerView.tsx` 파일의 전체 코드를 복사한 뒤, 로컬 프로젝트의 `src/App.tsx` 파일 내용을 모두 지우고 붙여넣습니다.

### 2.3. 앱 실행

```
npm run dev
```
브라우저에서 `http://localhost:5173` 에 접속하여 분석기 대시보드를 사용할 수 있습니다.

## 3. 프롬프트 업데이트 문서화 (Prompt History)

해당 코드를 처음부터 완성하기까지 사용된 논리적 지시(Prompt) 과정입니다.

### 단계 1: 코어 엔진 설계 및 API 연동

> "퀀트 차트 분석기 엔진의 TypeScript 코드를 작성해 줘. 바이낸스 API(/api/v3/klines)를 연동하여 OHLCV 데이터를 가져오고, 'sideways_box(횡보 박스)'라는 새로운 매매 패턴을 감지하는 로직을 구현해. 아키타입(Continuation, Breakout Prep, Turning Point)을 분류하고, 지표(RSI/다이버전스/거래량) 점수 70점 이상만 통과시켜. R:R(1:2) 비율 기반으로 EP, SL, TP를 계산해 줘."

### 단계 2: React 기반 시각화 대시보드 UI 구현

> "이전 코어 엔진을 시각적으로 보여주는 React 대시보드 컴포넌트를 만들어. HTML5 Canvas를 이용해 캔들스틱과 횡보 박스를 그리고, API 실패 시 내장된 Mock 데이터를 사용해 UI가 무조건 렌더링되게 해. 검출된 데이터는 테이블에 리스트업해 줘."

### 단계 3: 기간 설정, 페이징 및 누적 수익률(PNL) 차트

> "UI에 기간 설정 Date Picker를 추가해. API가 한 번에 1,000개만 가져오므로, 지정한 기간을 모두 조회할 때까지 `while` 문으로 Pagination을 수행해. 메인 차트 아래에 X축이 동기화된 누적 수익률(PNL Curve) 차트를 추가해 줘."

### 단계 4: 차트 Pan/Zoom 동기화 및 복리 자산(Equity) 시뮬레이션

> "마우스 휠로 Zoom-in/out, 드래그로 Pan 이동이 가능하게 만들어. 3개의 차트(Main, PNL, Equity)의 X축이 완벽히 동기화되게 해 줘. 초기 자본금과 리스크 비율(%)을 입력받아, 고정 리스크 포지션 사이징(Fixed Fractional)을 수행하는 Equity Curve 차트를 추가해 줘."

### 단계 5: 체결 논리 수정 및 차트 UI 디테일 폴리싱

> "가격이 EP(진입가)에 도달하여 '체결(Filled)'된 이후에만 TP/SL을 판단하도록 로직을 수정해. 박스 연장선은 청산 시점까지만 점선으로 그리고, 진입/청산 캔들에 매칭되는 식별 번호 마커(▲/▼, 원형)를 그려 줘."

### 단계 6: 시계열 백테스트 및 레버리지/마진 관리 (최종)

> "엔진을 시계열 기반으로 전면 개편해. 1. 최대 동시 유지 포지션 개수(Max Pos)를 제한해. 2. 레버리지(Leverage)를 설정받아, 진입 규모(Pos) 대비 실제 투입되는 증거금(Margin)을 계산하고 잔고 부족 시 진입을 취소해. 3. EP 도달 전 SL을 먼저 터치한 타점은 취소해. 각 취소 사유를 표에 명시하고, 전체 승률(Win Rate)과 MDD를 우측 상단에 표시해 줘."