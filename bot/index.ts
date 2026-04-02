import { botConfig } from './config';
import { sendTelegramMessage } from './telegram';
import { placeEntryOrder, placeCloseOrder, getActivePositionsCount, setLeverage, fetchAndCacheExchangeInfo, getSymbolInfo } from './binance';
import { BinanceAPI, ChartEngine, Box } from './engine';
import * as fs from 'fs';
import * as path from 'path';

let pendingBoxes: Box[] = [];
let activePositions: Box[] = [];
let openPositions: Box[] = []; // 실제 거래소에 오픈되어 있는 포지션 목록
let isProcessing: boolean = false; // 동시 실행 방지용 Lock
let lastCalculatedPeriod: number = 0; // 마지막으로 계산된 주기(Period) 번호

// 루트 디렉토리 기준 bot/state.json 파일에 저장
const STATE_FILE = path.join(process.cwd(), 'bot', 'state.json');

async function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf-8');
            const parsed = JSON.parse(data);
            // 기존에 너무 많이 저장된 박스가 있다면 스팸 방지를 위해 최근 5개만 로드
            pendingBoxes = (parsed.pendingBoxes || []).slice(-5);
            activePositions = parsed.activePositions || [];
            openPositions = parsed.openPositions || [];
            lastCalculatedPeriod = parsed.lastCalculatedPeriod || 0;
            console.log(`✅ [상태 복구 완료] 대기 타점: ${pendingBoxes.length}개 / 오픈 포지션: ${openPositions.length}개 / 진입 이력(중복방지): ${activePositions.length}개`);
        }
    } catch (e) {
        console.error("⚠️ 상태 파일 로드 실패. 빈 상태로 시작합니다.", e);
    }
}

async function saveState() {
    try {
        const state = { pendingBoxes, activePositions, openPositions, lastCalculatedPeriod };
        await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
        console.error("⚠️ 상태 저장 중 오류 발생:", e);
    }
}

// INTERVAL 문자열을 밀리초(ms) 단위로 변환하는 헬퍼 함수
function getIntervalMs(interval: string): number {
    const unit = interval.slice(-1);
    const value = parseInt(interval.slice(0, -1));
    switch (unit) {
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        case 'w': return value * 7 * 24 * 60 * 60 * 1000;
        default: return 15 * 60 * 1000; // 기본값 15분
    }
}

async function runBot() {
    console.log("🚀 봇 시스템 부팅 완료, 초기화를 시작합니다...");
    await loadState(); // 부팅 시 저장된 상태 복구

    // 봇 부팅 시 거래소 정보 로드 (가장 먼저 실행되어야 함)
    await fetchAndCacheExchangeInfo();

    // 봇 부팅 시 레버리지 설정
    try {
        await setLeverage(botConfig.TRADING_OPTIONS.BINANCE_SYMBOL, botConfig.TRADING_OPTIONS.LEVERAGE);
    } catch (e) {
        // setLeverage 내부에서 이미 에러를 처리하고, 심각한 경우에만 던지므로
        // 여기서 봇을 중지하거나 추가적인 처리를 할 수 있습니다.
        // 지금은 에러 메시지를 보내고 계속 진행합니다.
        await sendTelegramMessage(`🚨 [중요] 봇 부팅 중 레버리지 설정에 실패했습니다. 거래를 시작하기 전에 바이낸스 웹사이트에서 직접 설정을 확인해주세요.`);
    }

    let bootMessage = (
        `🚀 퀀트 자동 매매 봇 부팅 완료\n` +
        `- 거래 페어: ${botConfig.TRADING_OPTIONS.BINANCE_SYMBOL}\n` +
        `- 레버리지: ${botConfig.TRADING_OPTIONS.LEVERAGE}x\n` +
        `- 차트 주기: ${botConfig.TRADING_OPTIONS.INTERVAL}\n` +
        `- Check 간격: ${botConfig.CHECK_INTERVAL_MS / 1000}초\n` +
        `=========================\n` +
        `📋 *[복구된 상태]*\n` +
        ` • 오픈 포지션: ${openPositions.length}개\n` +
        ` • 대기 타점: ${pendingBoxes.length}개\n`
    );

    if (pendingBoxes.length > 0) {
        bootMessage += `\n*[대기 타점 목록]*\n`
        bootMessage += pendingBoxes.map(b => ` • ${b.direction.toUpperCase()} | EP: ${b.ep.toFixed(2)}`).join('\n');
    } else if (openPositions.length > 0) {
        bootMessage += `\n*[오픈 포지션 목록]*\n`
        bootMessage += openPositions.map(p => ` • ${p.direction.toUpperCase()} | 진입가: ${p.enteredPrice?.toFixed(2)} | 수량: ${p.quantity}`).join('\n');
    } else {
        bootMessage += `• 대기 중인 타점이 없습니다.`;
    }
    
    await sendTelegramMessage(bootMessage);

    // 지정된 주기마다 시장 상태 체크 함수 호출
    setInterval(checkMarket, botConfig.CHECK_INTERVAL_MS);
    checkMarket(); // 최초 부팅 즉시 1회 실행
}

async function checkMarket() {
    if (isProcessing) return; // 이전 주기의 처리가 안 끝났으면 스킵
    isProcessing = true;
    let stateChanged = false; // 이번 주기에 상태가 변경되었는지 추적

    try {
        const now = Date.now();
        const intervalMs = getIntervalMs(botConfig.TRADING_OPTIONS.INTERVAL);
        
        // 현재 시간을 밀리초 단위 주기로 나누어 현재 주기(Period) 계산 (UTC 기준 정각 동기화)
        const currentPeriod = Math.floor(now / intervalMs);
        
        // 정해진 INTERVAL 주기(정각)가 변경된 경우에만 박스(타점) 재계산
        const shouldCalcBoxes = currentPeriod > lastCalculatedPeriod;

        // 봇 최초 실행 시(lastCalculatedPeriod=0)에만 SCAN_START_DATE부터 전체 데이터를 가져오고,
        // 그 이후 주기적인 박스 재계산 시에는 최신 1000개 캔들만 사용합니다.
        const startTimeForFetch = (shouldCalcBoxes && lastCalculatedPeriod === 0 && botConfig.TRADING_OPTIONS.SCAN_START_DATE)
            ? new Date(botConfig.TRADING_OPTIONS.SCAN_START_DATE).getTime()
            : undefined;

        const { data, isMock } = await BinanceAPI.fetchKlines(
            botConfig.TRADING_OPTIONS.BINANCE_SYMBOL, 
            botConfig.TRADING_OPTIONS.INTERVAL, 
            startTimeForFetch,
            undefined, 
            shouldCalcBoxes ? 1000 : 2
        );

        if (!data || data.length === 0 || isMock) return;

        const currentCandle = data[data.length - 1];
        const currentPrice = data[data.length - 1].close;
        
        // 2. 캔들 주기(INTERVAL)에 맞춰 코어 엔진을 통한 타점(Box) 검출 실행
        if (shouldCalcBoxes) {
            const engine = new ChartEngine();
            const detectedBoxes = engine.process(data, botConfig.TRADING_OPTIONS.INTERVAL, botConfig.TRADING_OPTIONS.RR_RATIO);
            
            // 3. 엔진이 찾은 타점 중 이미 진입/취소 처리된 이력(activePositions)이 없고, 
            // 대기열(pendingBoxes)에도 없는 '완전 신규' Pending 타점만 추출
            const newPendingBoxes = detectedBoxes.filter(box => {
                const isPending = pendingBoxes.find(b => b.id === box.id);
                const isActive = activePositions.find(b => b.id === box.id);
                if (isPending || isActive || box.status !== 'active') return false;

                // 주기적인 재계산 시, 1000개 캔들 내의 과거 타점이 이력(50개 제한)에서 밀려나
                // 다시 신규로 감지되는 현상("전체 시간 계산")을 완벽히 방지합니다.
                // 이전 계산 주기 시점 이후에 확정된 진짜 신규 타점만 통과시킵니다.
                if (lastCalculatedPeriod > 0) {
                    const lastCalcTime = lastCalculatedPeriod * intervalMs;
                    if (box.createdAt < lastCalcTime) {
                        return false;
                    }
                }
                return true;
            }).slice(-5); // 혹시 모를 대량 알람 방지를 위해 최대 5개까지만 허용

            // 주기 마감 시 신규 타점이 없더라도 분석 완료 알림 전송 (생존 신고)
            let alertMsg = `🔍 *[주기 마감: 차트 분석 완료]*\n`;
            if (newPendingBoxes.length > 0) {
                alertMsg += `새로운 대기 타점(Pending) ${newPendingBoxes.length}개 감지\n=========================\n`;
                newPendingBoxes.forEach(box => {
                    pendingBoxes.push(box);
                    alertMsg += `📦 *[신규 타점 대기 중]*\n• 패턴: ${box.archetype}\n• 방향: ${box.direction.toUpperCase()} \n• 진입가(EP): ${box.ep.toFixed(2)}\n• 손절가(SL): ${box.sl.toFixed(2)}\n• 익절가(TP): ${box.tp.toFixed(2)}\n=========================\n`;
                });
            } else {
                alertMsg += `새로운 대기 타점이 없습니다.\n(현재 대기 중인 타점 유지: ${pendingBoxes.length}개)\n=========================\n`;
            }
            
            sendTelegramMessage(alertMsg);
            
            lastCalculatedPeriod = currentPeriod; // 타점 계산 주기 갱신
            stateChanged = true;
        }

        // 4. 대기 중인(Pending) 타점의 진입(체결) 조건 달성 여부 확인 (TP/SL 청산은 거래소에서 처리)
        for (let i = pendingBoxes.length - 1; i >= 0; i--) {
            const box = pendingBoxes[i];
            
            // [취소 예외 처리] 진입(EP) 전에 손절가(SL)를 먼저 터치해 차트가 붕괴된 경우 폐기 (Wick을 감안하여 High/Low 사용)
            const hitSlBeforeEntry = (box.direction === 'long' && currentCandle.low <= box.sl) || 
                                     (box.direction === 'short' && currentCandle.high >= box.sl);
            
            if (hitSlBeforeEntry) {
                sendTelegramMessage(`⚠️ [타점 취소] EP 도달 전 SL 먼저 터치됨. 대상 타점: ${box.ep.toFixed(2)}`);
                activePositions.push(box); // 중복 감지 방지를 위해 이력에 추가
                if (activePositions.length > 50) activePositions.shift();
                pendingBoxes.splice(i, 1);
                stateChanged = true;
                continue;
            }

            // 진입가(EP) 도달 여부 확인 (종가 기준이 아닌 해당 주기 캔들의 저점/고점으로 확인하여 꼬리 체결도 캐치)
            const shouldEnter = (box.direction === 'long' && currentCandle.low <= box.ep) || 
                                (box.direction === 'short' && currentCandle.high >= box.ep);

            if (shouldEnter) {
                // Binance API로 현재 거래소에 유지 중인 실제 포지션 개수 조회
                let currentPositionCount = 0;
                try {
                    currentPositionCount = await getActivePositionsCount();
                } catch (apiErr: any) {
                    console.error("[Binance 포지션 개수 조회 실패]:", apiErr.message);
                    continue; // API 오류 시 안전을 위해 진입을 스킵하고 다음 주기에 재시도
                }

                if (currentPositionCount >= botConfig.TRADING_OPTIONS.MAX_POSITIONS) {
                    sendTelegramMessage(`⚠️ [진입 스킵] Binance 거래소에 유지 중인 포지션이 최대치(${botConfig.TRADING_OPTIONS.MAX_POSITIONS}개)입니다.`);
                    activePositions.push(box); // 중복 감지 방지를 위해 이력에 추가
                    if (activePositions.length > 50) activePositions.shift();
                    pendingBoxes.splice(i, 1);
                    stateChanged = true;
                    continue;
                }

                const side = box.direction === 'long' ? 'BUY' : 'SELL';
                
                // 심볼 정보(최소 주문금액, 정밀도 등) 가져오기
                const symbolInfo = getSymbolInfo(botConfig.TRADING_OPTIONS.BINANCE_SYMBOL);

                // 운용 자산 및 설정된 리스크 비율 기반 진입 수량(Quantity) 동적 계산
                const riskAmount = botConfig.TRADING_OPTIONS.CAPITAL * (botConfig.TRADING_OPTIONS.RISK_PER_TRADE / 100);
                const slPercent = Math.max(Math.abs(box.ep - box.sl) / box.ep, 0.0001); // 손절폭 비율
                const idealPosSizeUsd = riskAmount / slPercent; // 총 투입 포지션 규모 (USD)

                // 최소 주문 금액(minNotional) 체크
                if (idealPosSizeUsd < symbolInfo.minNotional) {
                    sendTelegramMessage(`ℹ️ [진입 스킵] 계산된 포지션 규모($${idealPosSizeUsd.toFixed(2)})가 바이낸스 최소 주문금액($${symbolInfo.minNotional})보다 작습니다.`);
                    // 이 타점은 자본금이 늘어나지 않는 이상 계속 실패할 것이므로 폐기 처리
                    activePositions.push(box); 
                    if (activePositions.length > 50) activePositions.shift();
                    pendingBoxes.splice(i, 1);
                    stateChanged = true;
                    continue;
                }

                // API에서 가져온 동적 수량 정밀도 적용
                const quantity = Number((idealPosSizeUsd / currentPrice).toFixed(symbolInfo.quantityPrecision));

                try {
                    // 6. Binance API를 통해 시장가 진입과 동시에 TP/SL 주문 접수
                    const orderResult = await placeEntryOrder(botConfig.TRADING_OPTIONS.BINANCE_SYMBOL, side, quantity);

                    sendTelegramMessage(
                        `✅ [주문 체결 성공] ${side} 포지션 진입!\n` +
                        `진입가격: ${currentPrice}\n` +
                        `설정된 TP: ${box.tp.toFixed(2)} / SL: ${box.sl.toFixed(2)}\n` +
                        `주문수량: ${quantity}\n` +
                        `주문번호: ${orderResult?.orderId || '확인불가'}`
                    );
                    
                    box.isEntered = true;
                    box.enteredPrice = currentPrice; // 실제 진입 가격 저장
                    box.quantity = quantity; // 실제 주문 수량 저장

                    openPositions.push(box); // 활성 포지션 목록에 추가
                    activePositions.push(box);
                    if (activePositions.length > 50) activePositions.shift(); // 재진입 방지용 이력 유지 (최대 50개)
                    pendingBoxes.splice(i, 1);
                    stateChanged = true;
                } catch (e: any) {
                    sendTelegramMessage(`❌ [주문 실패] Binance API 오류: ${e.message}\n(해당 타점은 무한 재시도를 막기 위해 폐기됩니다)`);
                    console.error("[Binance 주문 에러 상세]:", e);
                    activePositions.push(box); // 무한 에러 루프 방지를 위해 이력에 추가
                    if (activePositions.length > 50) activePositions.shift();
                    pendingBoxes.splice(i, 1); // 에러 발생 시 대기열에서 확실히 제거
                    stateChanged = true;
                }
            }
        }
        
        // 5. 현재 오픈된 포지션들의 SL/TP 도달 여부 체크
        for (let i = openPositions.length - 1; i >= 0; i--) {
            const pos = openPositions[i];
            let isResolved = false;
            let resolutionType: 'TP' | 'SL' | null = null;

            // 롱 포지션: 현재가가 SL보다 낮거나, TP보다 높으면 청산
            if (pos.direction === 'long') {
                if (currentPrice <= pos.sl) { isResolved = true; resolutionType = 'SL'; }
                else if (currentPrice >= pos.tp) { isResolved = true; resolutionType = 'TP'; }
            } 
            // 숏 포지션: 현재가가 SL보다 높거나, TP보다 낮으면 청산
            else {
                if (currentPrice >= pos.sl) { isResolved = true; resolutionType = 'SL'; }
                else if (currentPrice <= pos.tp) { isResolved = true; resolutionType = 'TP'; }
            }

            if (isResolved && pos.quantity) {
                try {
                    const positionSide = pos.direction === 'long' ? 'LONG' : 'SHORT';
                    await placeCloseOrder(botConfig.TRADING_OPTIONS.BINANCE_SYMBOL, positionSide, pos.quantity);

                    sendTelegramMessage(
                        `✅ *[${resolutionType} 청산]* ${pos.direction.toUpperCase()} 포지션 종료\n` +
                        `진입가: ${pos.enteredPrice?.toFixed(2)}\n` +
                        `청산가: ${currentPrice.toFixed(2)}\n` +
                        `수량: ${pos.quantity}`
                    );

                    openPositions.splice(i, 1); // 오픈 포지션 목록에서 제거
                    stateChanged = true;

                } catch (e: any) {
                    sendTelegramMessage(`🚨 *[청산 주문 실패]* ${pos.direction.toUpperCase()} 포지션 청산 중 오류 발생. 수동 확인이 필요합니다!\n오류: ${e.message}`);
                    console.error("[청산 주문 에러 상세]:", e);
                    // 청산에 실패했으므로, 다음 주기에서 재시도하기 위해 목록에서 제거하지 않음
                }
            }
        }

        // 상태 변경점이 하나라도 있다면 JSON 파일에 덮어쓰기
        if (stateChanged) {
            await saveState();
        }
    } catch (error) {
        console.error("[에러] Market check error:", error);
    } finally {
        isProcessing = false; // 실행 완료 후 Lock 해제
    }
}

runBot();