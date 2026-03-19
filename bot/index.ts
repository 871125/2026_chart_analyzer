import { botConfig } from './config';
import { sendSlackMessage } from './slack';
import { placeOrderWithTPSL } from './bingx';
import { BinanceAPI, ChartEngine, Box } from './engine';

let pendingBoxes: Box[] = [];
let activePositions: Box[] = [];
let isProcessing: boolean = false; // 동시 실행 방지용 Lock

async function runBot() {
    console.log("🚀 봇 시스템 부팅 완료, 초기화를 시작합니다...");
    await sendSlackMessage(
        `🚀 퀀트 자동 매매 봇 부팅 완료\n` +
        `- 거래 페어: ${botConfig.TRADING_OPTIONS.BINGX_SYMBOL}\n` +
        `- 차트 주기: ${botConfig.TRADING_OPTIONS.INTERVAL}\n` +
        `- Check 간격: ${botConfig.CHECK_INTERVAL_MS / 1000}초`
    );

    // 지정된 주기마다 시장 상태 체크 함수 호출
    setInterval(checkMarket, botConfig.CHECK_INTERVAL_MS);
    checkMarket(); // 최초 부팅 즉시 1회 실행
}

async function checkMarket() {
    if (isProcessing) return; // 이전 주기의 처리가 안 끝났으면 스킵
    isProcessing = true;

    try {
        // 1. Binance로부터 OHLCV 최신 데이터 갱신 (Rate Limit 방지를 위해 최근 1000개만 조회)
        const { data, isMock } = await BinanceAPI.fetchKlines(
            botConfig.TRADING_OPTIONS.BINANCE_SYMBOL, 
            botConfig.TRADING_OPTIONS.INTERVAL, 
            undefined, // START_DATE부터 가져오는 페이징 부하 제거 
            undefined, 
            1000
        );

        if (!data || data.length === 0 || isMock) return;

        const currentCandle = data[data.length - 1];
        const currentPrice = data[data.length - 1].close;
        const engine = new ChartEngine();
        
        // 2. 코어 엔진을 통한 타점(Box) 검출
        const detectedBoxes = engine.process(data, botConfig.TRADING_OPTIONS.INTERVAL, botConfig.TRADING_OPTIONS.RR_RATIO);

        // 3. 신규 박스 감지 확인 및 슬랙 전송
        detectedBoxes.forEach(box => {
            const isPending = pendingBoxes.find(b => b.id === box.id);
            const isActive = activePositions.find(b => b.id === box.id);

            if (!isPending && !isActive && box.status === 'active') {
                pendingBoxes.push(box);
                sendSlackMessage(
                    `📦 [신규 타점 대기 중] ${box.archetype}\n` +
                    `방향: ${box.direction.toUpperCase()} \n` +
                    `진입가(EP): ${box.ep.toFixed(2)}\n` +
                    `손절가(SL): ${box.sl.toFixed(2)}\n` +
                    `익절가(TP): ${box.tp.toFixed(2)}`
                );
            }
        });

        // 4. [신규] 현재 보유 중인 포지션 청산(TP/SL) 모니터링 (로컬 배열 비우기)
        for (let i = activePositions.length - 1; i >= 0; i--) {
            const pos = activePositions[i];
            let isClosed = false;
            let isWin = false;

            // 빙엑스 거래소에는 이미 TP/SL이 걸려있으므로, 로컬에서도 최신 캔들 고/저점 기준으로 청산을 식별합니다.
            if (pos.direction === 'long') {
                if (currentCandle.low <= pos.sl) { isClosed = true; isWin = false; }
                else if (currentCandle.high >= pos.tp) { isClosed = true; isWin = true; }
            } else {
                if (currentCandle.high >= pos.sl) { isClosed = true; isWin = false; }
                else if (currentCandle.low <= pos.tp) { isClosed = true; isWin = true; }
            }

            if (isClosed) {
                sendSlackMessage(`🔔 [포지션 종료] ${pos.direction.toUpperCase()} 포지션이 ${isWin ? '익절(TP) 🎯' : '손절(SL) 💥'} 처리되었습니다.\n- 기준 진입가: ${pos.ep.toFixed(2)}`);
                activePositions.splice(i, 1); // 슬롯 확보
            }
        }

        // 5. 대기 중인(Pending) 타점의 진입(체결) 조건 달성 여부 확인
        for (let i = pendingBoxes.length - 1; i >= 0; i--) {
            const box = pendingBoxes[i];
            
            // [취소 예외 처리] 진입(EP) 전에 손절가(SL)를 먼저 터치해 차트가 붕괴된 경우 폐기 (Wick을 감안하여 High/Low 사용)
            const hitSlBeforeEntry = (box.direction === 'long' && currentCandle.low <= box.sl) || 
                                     (box.direction === 'short' && currentCandle.high >= box.sl);
            
            if (hitSlBeforeEntry) {
                sendSlackMessage(`⚠️ [타점 취소] EP 도달 전 SL 먼저 터치됨. 대상 타점: ${box.ep.toFixed(2)}`);
                pendingBoxes.splice(i, 1);
                continue;
            }

            // 진입가(EP) 도달 여부 확인 (종가 기준이 아닌 해당 주기 캔들의 저점/고점으로 확인하여 꼬리 체결도 캐치)
            const shouldEnter = (box.direction === 'long' && currentCandle.low <= box.ep) || 
                                (box.direction === 'short' && currentCandle.high >= box.ep);

            if (shouldEnter) {
                if (activePositions.length >= botConfig.TRADING_OPTIONS.MAX_POSITIONS) {
                    sendSlackMessage(`⚠️ [진입 스킵] 현재 유지 중인 포지션이 최대치(${botConfig.TRADING_OPTIONS.MAX_POSITIONS}개)입니다.`);
                    pendingBoxes.splice(i, 1);
                    continue;
                }

                const side = box.direction === 'long' ? 'BUY' : 'SELL';
                
                // 운용 자산 및 설정된 리스크 비율 기반 진입 수량(Quantity) 동적 계산
                const riskAmount = botConfig.TRADING_OPTIONS.CAPITAL * (botConfig.TRADING_OPTIONS.RISK_PER_TRADE / 100);
                const slPercent = Math.max(Math.abs(box.ep - box.sl) / box.ep, 0.0001); // 손절폭 비율
                const idealPosSizeUsd = riskAmount / slPercent; // 총 투입 포지션 규모 (USD)
                const quantity = Number((idealPosSizeUsd / currentPrice).toFixed(4)); // 실제 코인 수량 (거래소 규격에 맞게 소수점 4자리 절사)
                
                try {
                    // 6. BingX API를 통해 시장가 진입과 동시에 TP/SL 주문 접수
                    await placeOrderWithTPSL(botConfig.TRADING_OPTIONS.BINGX_SYMBOL, side, quantity, box.tp, box.sl);

                    sendSlackMessage(
                        `✅ [주문 체결 성공] ${side} 포지션 진입!\n` +
                        `진입가격: ${currentPrice}\n` +
                        `설정된 TP: ${box.tp.toFixed(2)} / SL: ${box.sl.toFixed(2)}\n` +
                        `주문수량: ${quantity}`
                    );
                    
                    box.isEntered = true;
                    activePositions.push(box);
                    pendingBoxes.splice(i, 1);
                } catch (e: any) {
                    sendSlackMessage(`❌ [주문 실패] BingX API 오류: ${e.message}`);
                }
            }
        }
    } catch (error) {
        console.error("[에러] Market check error:", error);
    } finally {
        isProcessing = false; // 실행 완료 후 Lock 해제
    }
}

runBot();