
# BingX Live Quantitative Trading Bot (Python)

본 프로젝트는 횡보 박스(Sideways Box) 돌파 전략을 기반으로 **BingX 선물 거래소(Perpetual Swap)**에서 실전 라이브 매매를 수행하기 위해 극도로 보수적인 안전장치가 적용된 파이썬 알고리즘 트레이딩 봇입니다.

## 1. 🛡️ 실전 투입을 위한 5대 핵심 안전장치 (Critical Safeties)

큰 자본금을 운용할 때 발생할 수 있는 모든 엣지 케이스(Edge Cases)를 방어하도록 코어 로직이 설계되었습니다.

### 1) 유령 포지션(Ghost Position) 방지 로직

- **이유:** 봇이 5분 간격(Polling)으로 잠든 사이, 가격이 위아래로 거칠게 움직이며 TP나 SL을 '꼬리'로 치고 다시 원상복구되는 경우가 잦습니다.
- **해결:** 단순히 현재 순간의 가격(`current_price`)만 보지 않고, **과거 5분간의 1분봉 고가/저가(Highest/Lowest) 궤적을 샅샅이 스캔** 합니다. 거래소 단에서 이미 체결된 OCO 주문을 놓치지 않고 100% 잡아내어 내부 회계를 완벽히 일치시킵니다.

### 2) 거래소 OCO(One-Cancels-the-Other) 네이티브 청산

- **이유:** 봇이 직접 수익/손실을 판단해서 청산 API를 쏘는 방식은, 봇 서버가 정전되거나 다운되었을 때 자산이 무방비로 방치되는 대형 사고를 유발합니다.
- **해결:** 시장가 진입 주문(`place_market_order`) 시, API 페이로드에 **목표가(Take Profit)와 손절가(Stop Loss)를 JSON 형태로 묶어서 동시에 전송** 합니다. 서버가 죽더라도 리스크 제어는 BingX 거래소 엔진이 확실하게 보장합니다.

### 3) 붕괴 타점 무효화 (Anti-Flash Crash)

- **이유:** 비트코인이 순간적으로 폭락하여 진입가(EP)를 뚫고 이미 손절가(SL) 라인까지 무너뜨린 상태일 수 있습니다.
- **해결:** EP 터치 여부를 검사하기 전에, 먼저 1분봉 궤적이 SL을 먼저 건드렸는지(`is_hit_sl_before`) 최우선으로 검사합니다. 무너진 타점은 진입 없이 즉시 휴지통에 폐기합니다.

### 4) 실 체결 기반 100% 정밀 PnL 회계

- 백테스트용 단순 배수 계산(`Margin * Leverage * RR`)을 완전히 버렸습니다.
- 롱(Long): `(TP/SL - 진입가) * 코인수량`, 숏(Short): `(진입가 - TP/SL) * 코인수량` 이라는 **선물 거래소의 실제 PnL 산정 공식** 을 사용하여 복리(`available_margin`) 스냅샷의 오차를 0으로 만들었습니다.

### 5) 데이터 정밀도 자동 규격화 (Format Integrity)

- 거래소마다 허용하는 '최소 주문 수량(Step Size)'과 '가격 소수점(Tick Size)'이 엄격하게 정해져 있습니다.
- 부팅 시 해당 코인의 스펙을 가져와 수량은 안전하게 버림(`truncate_quantity`) 처리하고, TP/SL 가격은 포맷팅(`format_price`)하여 `Invalid API Request` 로 인한 기회 손실을 막습니다.

## 2. 파일 구조 (Architecture)

1. **`config.json`**: API 키, Slack 채널/토큰, 자본금, 레버리지, 리스크 등을 제어합니다.
2. **`bingx_api.py`**: BingX REST API 통신 및 서명 생성, **지수 백오프(Exponential Backoff)** 오류 자동 재시도.
3. **`strategy.py`**: OHLCV 기반 횡보 박스(Sideways Box) 추출 엔진.
4. **`main.py`**: 메인 무한 루프, 포지션 추적, Slack (Bot Token) 연동, 봇 상태 보존(`bot_state.json`).

## 3. 설치 및 실행 가이드 (Quick Start)

### Step 1. 요구 사항 및 패키지 설치

Python 3.8 이상 환경이 필요하며, 장기 구동을 위해 클라우드(AWS EC2 등) 환경을 권장합니다.

```
pip install requests
```

### Step 2. `config.json` 설정

프로젝트 루트 디렉토리에 `config.json` 을 생성하고 본인의 정보를 입력합니다.

```
{
  "api": {
    "bingx_api_key": "YOUR_API_KEY",
    "bingx_secret_key": "YOUR_SECRET_KEY"
  },
  "slack": {
    "token": "xoxb-your-slack-bot-token",
    "channel": "#channel-name"
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

### Step 3. 모의 투자(Paper Trading) 모드 테스트

자산을 잃을 위험 없이 먼저 알림이 잘 오는지, 로직이 맞게 돌아가는지 테스트합니다. 기본 코드는 매매 API 호출이 안전하게 주석 처리되어 있습니다.

```
python main.py
```
Slack으로 봇 시작 알림과 타점 감지 내역이 전송되는지 확인합니다.

### Step 4. 🔥 실전 라이브 매매(Live Trading) 가동

모의 운영을 통해 확신이 생기면, `main.py` 파일의 **`# TODO: 실제 돈이 들어가는 라이브 매매`** 라인 아래에 있는 `bingx.place_market_order(...)` 함수의 주석을 해제합니다.

재실행 시 실제 API를 통해 돈이 투입되며, 거래소에 TP/SL이 OCO 조건부 주문으로 자동 세팅됩니다!