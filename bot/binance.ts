import * as crypto from 'crypto';
import { botConfig } from './config';

const BASE_URL = 'https://fapi.binance.com';

/**
 * Binance USD-M Futures API에 진입 주문(Market)과 동시에 TP(Take Profit), SL(Stop Loss)을 함께 전송합니다.
 * (Binance 선물은 단일 주문에 TP/SL을 포함할 수 없어 batchOrders 엔드포인트를 사용합니다)
 */
export async function placeOrderWithTPSL(
    symbol: string, 
    side: 'BUY' | 'SELL', 
    quantity: number, 
    takeProfit: number, 
    stopLoss: number
) {
    const timestamp = Date.now().toString();
    const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
    const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
    
    const orders = [
        {
            symbol: symbol,
            side: side,
            positionSide: positionSide,
            type: 'MARKET',
            quantity: quantity.toString()
        },
        {
            symbol: symbol,
            side: oppositeSide,
            positionSide: positionSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: takeProfit.toString(),
            closePosition: "true"
        },
        {
            symbol: symbol,
            side: oppositeSide,
            positionSide: positionSide,
            type: 'STOP_MARKET',
            stopPrice: stopLoss.toString(),
            closePosition: "true"
        }
    ];

    const rawQueryString = `batchOrders=${encodeURIComponent(JSON.stringify(orders))}&timestamp=${timestamp}`;

    // HMAC SHA256 서명
    const signature = crypto.createHmac('sha256', botConfig.BINANCE_SECRET_KEY)
        .update(rawQueryString)
        .digest('hex');

    const url = `${BASE_URL}/fapi/v1/batchOrders?${rawQueryString}&signature=${signature}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 
            'X-MBX-APIKEY': botConfig.BINANCE_API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded' 
        }
    });
    
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Binance 주문 에러: 상태 ${response.status} - 상세 내용: ${errorBody}`);
    }
    
    const json = await response.json();
    
    // batchOrders는 배열로 응답을 반환하므로 첫 번째 주문(진입)의 결과를 주로 확인합니다.
    const entryResult = Array.isArray(json) ? json[0] : json;
    if (entryResult.code && entryResult.code < 0) {
         throw new Error(`API 응답 에러 (코드: ${entryResult.code}, 메시지: ${entryResult.msg})`);
    }
    
    // index.ts 코드와의 호환성을 위해 code 0을 반환하도록 래핑
    return { code: 0, data: { orderId: entryResult.orderId }, msg: "success", raw: json };
}

/**
 * Binance API를 호출하여 현재 유지 중인 활성 포지션 개수를 반환합니다.
 */
export async function getActivePositionsCount(symbol: string): Promise<number> {
    const timestamp = Date.now().toString();
    const rawQueryString = `symbol=${symbol}&timestamp=${timestamp}`;

    const signature = crypto.createHmac('sha256', botConfig.BINANCE_SECRET_KEY)
        .update(rawQueryString)
        .digest('hex');

    const url = `${BASE_URL}/fapi/v2/positionRisk?${rawQueryString}&signature=${signature}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': botConfig.BINANCE_API_KEY }
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`상태 ${response.status} - ${errorBody}`);
    }

    const json = await response.json();
    
    if (json.code && json.code < 0) {
        throw new Error(`API 응답 에러 (코드: ${json.code}, 메시지: ${json.msg})`);
    }

    const positions = Array.isArray(json) ? json : [];
    // positionAmt의 절댓값이 0보다 큰 활성 포지션만 카운트 (Hedge 모드에서는 LONG/SHORT 객체가 각각 내려오므로 둘 다 감지됨)
    return positions.filter((pos: any) => Math.abs(Number(pos.positionAmt || 0)) > 0).length;
}