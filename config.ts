export const botConfig = {
    // 1. API 및 Webhook Keys (운영 환경에서는 process.env 활용 권장)
    BINGX_API_KEY: process.env.BINGX_API_KEY || 'YOUR_BINGX_API_KEY',
    BINGX_SECRET_KEY: process.env.BINGX_SECRET_KEY || 'YOUR_BINGX_SECRET_KEY',
    SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || 'YOUR_SLACK_WEBHOOK_URL',

    // 2. 타이머 옵션
    CHECK_INTERVAL_MS: 1000 * 30, // 30초 단위로 가격 및 조건 체크

    // 3. 트레이딩 설정 옵션
    TRADING_OPTIONS: {
        BINANCE_SYMBOL: 'BTCUSDT',  // 데이터 수집용 심볼 (바이낸스)
        BINGX_SYMBOL: 'BTC-USDT',   // 실제 주문용 심볼 (빙엑스 표준)
        INTERVAL: '4h' as '1h' | '4h' | '1d',
        START_DATE: '2024-01-01',   // 박스 생성(데이터 수집) 시작 날짜
        
        LEVERAGE: 10,               // 레버리지 비율 (※참고: 빙엑스 앱/웹에서 미리 세팅해 두어야 주문 시 정상 작동됨)
        MAX_POSITIONS: 3,           // 최대 동시 유지 포지션 수
        RR_RATIO: 2.0,              // 손익비 (Risk to Reward)
        CAPITAL: 1000,              // 운용 자산 규모 (USDT 단위)
        RISK_PER_TRADE: 1.0,        // 1회 거래당 감수할 리스크 비율 (%) - 예: 1000달러의 1% = 10달러 손실 고정
    }
};