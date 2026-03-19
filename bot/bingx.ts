import * as crypto from 'crypto';
import { botConfig } from './config';

const BASE_URL = 'https://open-api.bingx.com';

/**
 * BingX Perpetual Swap API에 진입 주문(Market)과 동시에 TP(Take Profit), SL(Stop Loss)을 함께 전송합니다.
 */
export async function placeOrderWithTPSL(
    symbol: string, 
    side: 'BUY' | 'SELL', 
    quantity: number, 
    takeProfit: number, 
    stopLoss: number
) {
    const timestamp = Date.now().toString();
    const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
    
    const paramObj: Record<string, string> = {
        positionSide: positionSide,
        quantity: quantity.toString(),
        side: side,
        stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: stopLoss, workingType: "MARK_PRICE" }),
        symbol: symbol,
        takeProfit: JSON.stringify({ type: "TAKE_PROFIT_MARKET", stopPrice: takeProfit, workingType: "MARK_PRICE" }),
        timestamp: timestamp,
        type: 'MARKET'
    };

    // 1. 파라미터 키를 알파벳 순으로 정렬 (BingX API 필수 요구사항)
    const sortedKeys = Object.keys(paramObj).sort();

    // 2. 서명(Signature) 생성용 원본 문자열 조립 (URL 인코딩 하지 않음!)
    const rawQueryString = sortedKeys.map(key => `${key}=${paramObj[key]}`).join('&');

    const signature = crypto.createHmac('sha256', botConfig.BINGX_SECRET_KEY)
        .update(rawQueryString)
        .digest('hex');

    // 3. 실제 HTTP 전송용 쿼리 스트링 조립 (특수문자 URL 인코딩 적용)
    const encodedQueryString = sortedKeys.map(key => `${key}=${encodeURIComponent(paramObj[key])}`).join('&');

    const url = `${BASE_URL}/openApi/swap/v2/trade/order?${encodedQueryString}&signature=${signature}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'X-BX-APIKEY': botConfig.BINGX_API_KEY }
    });
    
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`BingX 주문 에러: 상태 ${response.status} - 상세 내용: ${errorBody}`);
    }
    
    return response.json();
}