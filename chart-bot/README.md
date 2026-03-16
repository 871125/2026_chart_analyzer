
# BingX Quantitative Trading Bot (Python)

본 프로젝트는 횡보 박스(Sideways Box) 돌파 전략을 기반으로 **BingX 선물 거래소(Perpetual Swap)**에서 24시간 자동으로 매매를 수행하는 파이썬(Python) 기반의 알고리즘 트레이딩 봇입니다.

## 1. 시스템 아키텍처 및 주요 모듈

시스템은 역할에 따라 4개의 주요 파일로 모듈화되어 있으며, 실제 자본 운용을 위해 매우 보수적인 안전장치들이 겹겹이 적용되어 있습니다.

### 📁 파일 구조

1. **`config.json`**: API 키, Slack 설정, 트레이딩 환경설정(자본금, 레버리지, 리스크, 심볼 등)을 관리합니다.
2. **`bingx_api.py`**: BingX REST API 통신 및 서명(HMAC-SHA256) 모듈입니다. 일시적인 네트워크 오류에 대비한 **지수 백오프(Exponential Backoff)** 재시도 로직이 내장되어 있습니다.
3. **`strategy.py`**: 코어 분석 엔진입니다. 캔들스틱 데이터를 받아 각종 기술적 지표(RSI, Volume, Divergence, Pinbar 등)를 계산하고, 유효한 '횡보 박스' 타점을 반환합니다.
4. **`main.py`**: 메인 봇 실행기입니다. 5분(설정 가능) 주기로 시장을 감시하며 타점 진입 및 청산을 제어하고, Slack으로 실시간 알림을 발송합니다.

## 2. 🛡️ 핵심 매매 로직 및 안전장치 (Safety Mechanisms)

거액의 실전 자본 운용 시뮬레이션 및 라이브 환경을 위해 기존 백테스트의 한계를 극복한 고급 기능들이 탑재되어 있습니다.

### 2.1. 거래소 기반의 완벽한 손익금(PnL) 계산

- 단순한 마진 배수 연산이 아닌, **`(청산가격 - 실제 진입가격) × 보유 코인 수량`** 이라는 거래소의 실제 명목가치 산정 방식을 사용합니다.
- 발생한 달러($) 손익을 정확하게 추적하여 내부 자본금(`available_margin`)에 복리로 반영합니다.

### 2.2. 시장 붕괴(Gap-Down) 방어 로직

- 가격이 5분 주기의 감시 틈을 타서 타점(EP)을 스치고 이미 손절선(SL)을 뚫고 내려간 경우, 봇은 이를 진입 기회가 아닌 '차트 붕괴'로 판단합니다.
- 이미 망가진 타점에 진입하여 **주문과 동시에 확정 손실을 입는 대참사를 사전에 차단** 합니다.

### 2.3. 최소 주문 단위(Lot Size) 정밀도 호환

- 코인별로 존재하는 최소 주문 수량 규격(`tradeMinQuantity`)을 봇 부팅 시 자동으로 캐싱합니다.
- 내부 로직으로 구해진 정밀한 진입 물량(예: `0.1539999`)을 거래소 규격(`0.1539`)에 맞게 **버림(Truncate)** 처리하여 `Invalid Quantity` 주문 거절 에러를 방지합니다.

### 2.4. 미확정 캔들 배제 (Repainting 방지)

- 아직 진행 중인 최신 캔들은 실시간으로 가격이 변동하므로 거짓 타점을 유발할 수 있습니다.
- 봇은 수신한 데이터 중 아직 닫히지 않은 최신 캔들을 즉시 잘라내어(`[:-1]`), 타점이 나타났다 사라지는 리페인팅(Repainting) 현상을 방지합니다.

### 2.5. 상태 영구 보존 (Persistence)

- 봇이 진입/청산할 때마다 **`bot_state.json`** 파일에 현재 남은 자본금과 열려있는 포지션 정보를 기록합니다.
- 서버 재부팅 시에도 초기 자본금이 아닌 마지막으로 기록된 상태를 불러와 완벽하게 매매를 이어나갑니다.

## 3. 설치 및 실행 가이드 (Installation & Setup)

### Step 1. 요구 사항 및 패키지 설치

Python 3.8 이상 환경이 필요합니다. 터미널에서 `requests` 라이브러리를 설치합니다.

```
pip install requests
```

### Step 2. `config.json` 설정

프로젝트 루트 디렉토리에 `config.json` 파일을 생성하고 아래 양식에 맞게 본인의 정보를 입력합니다.

```
{
  "api": {
    "bingx_api_key": "YOUR_BINGX_API_KEY",
    "bingx_secret_key": "YOUR_BINGX_SECRET_KEY"
  },
  "slack": {
    "token": "xoxb-your-slack-bot-token",
    "channel": "#your-channel-name"
  },
  "trading": {
    "symbol": "BTC-USDT",
    "box_timeframe": "4h",
    "trade_check_interval_min": 5,
    "start_date": "2024-01-01",
    "initial_capital": 10000,
    "risk_per_trade_pct": 1.0,
    "leverage": 10,
    "rr_ratio": 2.0,
    "max_positions": 3
  }
}
```

### Step 3. 봇 실행 (Paper Trading Mode)

안전을 위해 기본 코드는 **주문 전송 부분이 주석 처리된 모의 매매(Paper Trading) 모드** 로 동작합니다.

```
python main.py
```

- 실행 즉시 지정된 Slack 채널로 시작 알림이 발송됩니다.
- 터미널 및 Slack을 통해 타점 감지, 모의 진입, 모의 청산 내역을 확인할 수 있습니다.

### Step 4. 실전 라이브 매매(Live Trading) 활성화

충분한 모의 테스트 후 실제 자금을 투입하려면 `main.py` 파일을 열고 다음을 수행하세요.

1. `run_bot()` 함수 내의 진입 검사 로직(3번 항목)에서 `bingx.place_market_order(...)` 부분의 주석을 해제합니다.
2. 청산 검사 로직(4번 항목)에서 실제 청산 주문 전송 로직의 주석을 해제합니다. (또는 빙엑스의 포지션 자동 TP/SL 기능을 세팅하도록 코드를 수정하여 활용할 수 있습니다.)

## 4. 프롬프트 히스토리 (Prompt Evolution)

이 시스템을 구축하기 위해 AI 어시스턴트와 협업한 논리적 지시 과정입니다.

1. **코어 엔진 및 UI 구축**: TypeScript로 바이낸스 API 연동, OHLCV 수집, 횡보 박스 아키타입 분류, 지표(RSI/거래량) 점수화, React UI 구현.
2. **시뮬레이션 및 시각화**: 마우스 Pan/Zoom, 동기화된 PNL/Equity Curve, 고정 리스크 포지션 사이징 적용.
3. **시계열 백테스트 강화**: 실전과 동일한 시계열 루프 전환, 잔여 증거금 추적, 최대 포지션 제한 로직 구현.
4. **Python 실전 봇 포팅 (현재)**: BingX 거래소 API 연결, 5분 Polling 시스템, Slack (Bot Token) 연동, 주문 정밀도(Lot Size) 캐싱, 리페인팅 및 차트 붕괴(SL 先 터치) 예외 처리 로직 적용.