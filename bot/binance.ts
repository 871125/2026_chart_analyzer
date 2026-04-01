import * as crypto from 'crypto';
import { botConfig } from './config';

const BASE_URL = 'https://fapi.binance.com'; // Binance Futures API URL

// 신규 추가: 거래소 정보를 캐싱하기 위한 객체
let exchangeInfoCache: any = null;

async function signedRequest(method: 'GET' | 'POST', endpoint: string, params: Record<string, any> = {}) {
    params.timestamp = Date.now();
    
    const queryString = new URLSearchParams(params).toString();

    const signature = crypto.createHmac('sha256', botConfig.BINANCE_SECRET_KEY)
        .update(queryString)
        .digest('hex');

    const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
        method: method,
        headers: { 
            'X-MBX-APIKEY': botConfig.BINANCE_API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    const responseData = await response.json();

    // batchOrders 성공 시에도 개별 주문 실패가 있을 수 있으므로, HTTP 상태와 별개로 응답 데이터를 확인합니다.
    if (!response.ok) {
        throw new Error(`Binance API 에러: 상태 ${response.status} - 코드: ${responseData.code}, 메시지: ${responseData.msg}`);
    }
    
    return responseData;
}

/**
 * Binance Futures API에서 거래소 정보를 가져와 캐싱합니다.
 * 여기에는 심볼별 가격/수량 정밀도, 최소 주문 금액 등의 정보가 포함됩니다.
 */
export async function fetchAndCacheExchangeInfo() {
    try {
        const response = await fetch(`${BASE_URL}/fapi/v1/exchangeInfo`);
        if (!response.ok) {
            throw new Error(`거래소 정보(exchangeInfo) 로드 실패: ${response.status}`);
        }
        exchangeInfoCache = await response.json();
        console.log("✅ [거래소 정보] 가격/수량 정밀도 및 최소 주문금액 정보 로드 완료");
    } catch (error: any) {
        console.error("❌ [거래소 정보] 거래소 정보를 가져오는 데 실패했습니다. 봇을 중지합니다.", error.message);
        // 거래소 정보 없이는 안전한 주문이 불가능하므로 프로세스 종료
        process.exit(1); 
    }
}

/**
 * 캐시된 거래소 정보에서 특정 심볼에 대한 정밀도 및 필터 정보를 가져옵니다.
 */
export function getSymbolInfo(symbol: string) {
    if (!exchangeInfoCache) {
        throw new Error("거래소 정보가 캐시되지 않았습니다. fetchAndCacheExchangeInfo()를 먼저 호출해야 합니다.");
    }
    const symbolInfo = exchangeInfoCache.symbols.find((s: any) => s.symbol === symbol);
    if (!symbolInfo) {
        throw new Error(`${symbol}에 대한 거래소 정보를 찾을 수 없습니다.`);
    }

    const priceFilter = symbolInfo.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    const lotSizeFilter = symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE');
    const minNotionalFilter = symbolInfo.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');

    if (!priceFilter || !lotSizeFilter || !minNotionalFilter) {
        throw new Error(`${symbol}에 대한 필수 필터(PRICE_FILTER, LOT_SIZE, MIN_NOTIONAL)를 찾을 수 없습니다.`);
    }

    // tickSize/stepSize를 기반으로 소수점 자릿수 계산 (e.g., 0.01 -> 2, 0.001 -> 3)
    const pricePrecision = Math.max(0, (priceFilter.tickSize.split('.')[1] || '').indexOf('1') + 1);
    const quantityPrecision = Math.max(0, (lotSizeFilter.stepSize.split('.')[1] || '').indexOf('1') + 1);

    return { pricePrecision, quantityPrecision, minNotional: parseFloat(minNotionalFilter.notional) };
}

/**
 * Binance Futures API를 사용하여 지정된 심볼의 레버리지를 설정합니다.
 */
export async function setLeverage(symbol: string, leverage: number) {
    try {
        const result = await signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
        console.log(`✅ [레버리지 설정] ${symbol}에 대한 레버리지가 ${leverage}x로 설정되었습니다.`);
        return result;
    } catch (error: any) {
        // 레버리지가 이미 해당 값으로 설정되어 있으면 에러가 발생할 수 있습니다 (e.g., code: -4046).
        // 이는 정상적인 동작일 수 있으므로 경고로 처리하고 계속 진행합니다.
        if (error.message && error.message.includes('-4046')) {
            console.warn(`⚠️ [레버리지 설정] ${symbol}의 레버리지가 이미 ${leverage}x로 설정되어 있습니다.`);
        } else {
            console.error(`❌ [레버리지 설정 실패] ${symbol}의 레버리지를 ${leverage}x로 설정하는 중 오류 발생:`, error.message);
            // 다른 심각한 오류는 다시 던져서 봇 부팅 과정에서 인지할 수 있도록 합니다.
            throw error; 
        }
    }
}

/**
 * Binance Futures API에 진입 주문(Market)과 동시에 TP(Take Profit), SL(Stop Loss)을 함께 전송합니다.
 * (batchOrders 엔드포인트를 사용)
 */
export async function placeOrderWithTPSL(
    symbol: string, 
    side: 'BUY' | 'SELL', 
    quantity: number, 
    takeProfit: number, 
    stopLoss: number
) {
    const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';

    // 동적으로 심볼 정보 가져오기
    const { pricePrecision, quantityPrecision } = getSymbolInfo(symbol);
    const orders = [
        // 1. Market Order for entry
        {
            symbol,
            side,
            type: 'MARKET',
            quantity: quantity.toFixed(quantityPrecision),
        },
        // 2. Stop Market for Stop Loss
        {
            symbol,
            side: oppositeSide,
            type: 'STOP_MARKET',
            stopPrice: stopLoss.toFixed(pricePrecision),
            closePosition: 'true',
        },
        // 3. Take Profit Market for Take Profit
        {
            symbol,
            side: oppositeSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: takeProfit.toFixed(pricePrecision),
            closePosition: 'true',
        }
    ];

    const params = {
        batchOrders: JSON.stringify(orders)
    };

    const result = await signedRequest('POST', '/fapi/v1/batchOrders', params);

    // batchOrders는 성공 시 각 주문 결과를 배열로 반환합니다.
    // 하나라도 실패하면 에러를 던집니다.
    if (Array.isArray(result)) {
        const failedOrder = result.find(o => o.code && o.code !== 0);
        if (failedOrder) {
            throw new Error(`개별 주문 실패 (코드: ${failedOrder.code}, 메시지: ${failedOrder.msg})`);
        }
    }
    
    return result;
}

/**
 * Binance API를 호출하여 현재 유지 중인 활성 포지션 개수를 반환합니다.
 */
export async function getActivePositionsCount(symbol: string): Promise<number> {
    const positions = await signedRequest('GET', '/fapi/v2/positionRisk', { symbol });
    
    if (!Array.isArray(positions)) {
        console.warn("Binance 포지션 정보가 배열이 아닙니다:", positions);
        return 0;
    }

    // 수량(positionAmt)의 절댓값이 0보다 큰 활성 포지션만 필터링하여 개수 반환
    const activePositions = positions.filter((pos: any) => Math.abs(Number(pos.positionAmt || 0)) > 0);
    return activePositions.length;
}