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
    
    // BingX V2 Swap API 파라미터 (동시 TP/SL 지원 규격)
    const params = new URLSearchParams({
        symbol: symbol,
        side: side,
        positionSide: positionSide,
        type: 'MARKET',
        quantity: quantity.toString(),
        takeProfit: JSON.stringify({ type: "TAKE_PROFIT_MARKET", stopPrice: takeProfit, workingType: "MARK_PRICE" }),
        stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: stopLoss, workingType: "MARK_PRICE" }),
        timestamp: timestamp
    });

    const signature = crypto.createHmac('sha256', botConfig.BINGX_SECRET_KEY)
        .update(params.toString())
        .digest('hex');

    const url = `${BASE_URL}/openApi/swap/v2/trade/order?${params.toString()}&signature=${signature}`;

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