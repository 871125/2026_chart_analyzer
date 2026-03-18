import React, { useState, useEffect, useRef } from 'react';
import { Activity, TrendingUp, TrendingDown, AlertCircle, RefreshCw, Box as BoxIcon, LineChart } from 'lucide-react';

// ==========================================
// 1. 코어 엔진 로직
// ==========================================

export type CandleInterval = '1h' | '4h' | '1d';
export type ZoneType = 'order_block' | 'volume_zone' | 'sideways_box';
export type StrategyStatus = 'active' | 'reacted' | 'invalidated' | 'canceled';

export interface Candle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
    isBullish: boolean;
}

export interface ScoreBreakdown {
    total: number;
    structure?: number;
    continuation?: number;
    breakoutPrep?: number;
    turningPoint?: number;
    insideBarBreakout?: number;
    engulfingBreakout?: number;
    pinbarReversal?: number;
    rsiExtreme?: number;
    regularDivergence?: number;
    volumeBonus?: number;
}

export interface Zone {
    id: string;
    type: ZoneType;
    startIndex: number;
    endIndex: number;
    direction: 'long' | 'short';
    score: ScoreBreakdown;
    status: StrategyStatus;
    createdAt: number; 
    createdIndex: number;
}

export interface Box extends Zone {
    type: 'sideways_box';
    archetype: 'continuation_box' | 'breakout_prep_box' | 'turning_point_base' | 'unknown';
    breakoutIndex: number;
    high: number;
    low: number;
    ep: number;      
    sl: number;      
    tp: number;      
    touchedAt?: number;
    resolvedAt?: number; 
    realizedPnl?: number;       
    realizedPnlPercent?: number; 
    isEntered?: boolean;        
    enteredAt?: number;         
    assetRoiPercent?: number;   
    positionSize?: number;      
    riskAmount?: number;        
    marginUsed?: number;        // 포지션 유지에 사용된 증거금
    skipReason?: 'max_positions' | 'no_margin' | 'sl_before_ep'; // 진입 취소 사유
}

class BinanceAPI {
    private static readonly BASE_URL = 'https://api.binance.com/api/v3';

    static async fetchKlines(symbol: string, interval: CandleInterval, startTime?: number, endTime?: number, limit = 1000): Promise<{data: Candle[], isMock: boolean}> {
        let allCandles: Candle[] = [];
        let currentStartTime = startTime;
        let fetchCount = 0;
        const MAX_FETCHES = 30; 
        
        try {
            while (fetchCount < MAX_FETCHES) {
                let url = `${this.BASE_URL}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
                if (currentStartTime) url += `&startTime=${currentStartTime}`;
                if (endTime) url += `&endTime=${endTime}`;
                
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Binance API error: ${response.statusText}`);
                
                const rawData: any[][] = await response.json();
                
                if (rawData.length === 0) break; 
                
                const data = rawData.map(row => {
                    const open = parseFloat(row[1]);
                    const close = parseFloat(row[4]);
                    return {
                        openTime: row[0],
                        open,
                        high: parseFloat(row[2]),
                        low: parseFloat(row[3]),
                        close,
                        volume: parseFloat(row[5]),
                        closeTime: row[6],
                        isBullish: close >= open
                    };
                });

                allCandles = allCandles.concat(data);

                const lastCandle = data[data.length - 1];
                
                if (endTime && lastCandle.closeTime >= endTime) break;
                if (rawData.length < limit) break;

                currentStartTime = lastCandle.closeTime + 1;
                fetchCount++;

                await new Promise(resolve => setTimeout(resolve, 50));
            }

            return { data: allCandles, isMock: false };
        } catch (error) {
            console.warn('API 호출 실패, Mock 데이터를 사용합니다.', error);
            return { data: this.generateMockData(interval), isMock: true };
        }
    }

    static generateMockData(interval: CandleInterval): Candle[] {
        const intervalMs = interval === '1h' ? 60 * 60 * 1000 : interval === '1d' ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
        const candles: Candle[] = [];
        let time = Date.now() - 100 * intervalMs; 
        
        for (let i = 0; i < 35; i++) {
            candles.push({ openTime: time, closeTime: time + 1000, open: 50, high: 55, low: 45, close: 52, isBullish: true, volume: 500 });
            time += intervalMs;
        }

        for (let i = 0; i < 7; i++) {
            const isBullish = i % 2 === 0;
            candles.push({ 
                openTime: time, closeTime: time + 1000,
                open: isBullish ? 98 : 102, close: isBullish ? 102 : 98,
                high: 105, low: 95, isBullish, volume: 1000 
            });
            time += intervalMs;
        }

        candles.push({ openTime: time, closeTime: time + 1000, open: 100, close: 110, high: 112, low: 99, isBullish: true, volume: 3000 });
        time += intervalMs;
        
        candles.push({ openTime: time, closeTime: time + 1000, open: 110, close: 114, low: 103, high: 115, isBullish: true, volume: 1000 }); time += intervalMs;
        candles.push({ openTime: time, closeTime: time + 1000, open: 114, close: 115, low: 104, high: 116, isBullish: true, volume: 1000 }); time += intervalMs;
        candles.push({ openTime: time, closeTime: time + 1000, open: 115, close: 116, low: 105, high: 117, isBullish: true, volume: 1000 }); time += intervalMs;

        for (let i = 0; i < 100; i++) {
            candles.push({ openTime: time, closeTime: time + 1000, open: 116 + i, close: 117 + i, high: 118 + i, low: 115 + i, isBullish: true, volume: 1000 });
            time += intervalMs;
        }
        return candles;
    }
}

class Indicators {
    static calculateRSI(candles: Candle[], period = 14): number[] {
        const rsi = new Array(candles.length).fill(0);
        if (candles.length <= period) return rsi;

        let avgGain = 0; let avgLoss = 0;
        for (let i = 1; i <= period; i++) {
            const change = candles[i].close - candles[i - 1].close;
            if (change > 0) avgGain += change; else avgLoss -= change;
        }
        avgGain /= period; avgLoss /= period;
        rsi[period] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-10))));

        for (let i = period + 1; i < candles.length; i++) {
            const change = candles[i].close - candles[i - 1].close;
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? -change : 0;
            avgGain = ((avgGain * (period - 1)) + gain) / period;
            avgLoss = ((avgLoss * (period - 1)) + loss) / period;
            rsi[i] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-10))));
        }
        return rsi;
    }

    static hasRegularDivergence(candles: Candle[], rsi: number[], index: number, isBullishBreakout: boolean): boolean {
        if (index < 10) return false;
        const isPivotLow = (idx: number) => {
            if (idx < 3 || idx > candles.length - 4) return false;
            const l = candles[idx].low;
            return l <= candles[idx-1].low && l <= candles[idx-2].low && l <= candles[idx-3].low &&
                   l <= candles[idx+1].low && l <= candles[idx+2].low && l <= candles[idx+3].low;
        };
        const isPivotHigh = (idx: number) => {
            if (idx < 3 || idx > candles.length - 4) return false;
            const h = candles[idx].high;
            return h >= candles[idx-1].high && h >= candles[idx-2].high && h >= candles[idx-3].high &&
                   h >= candles[idx+1].high && h >= candles[idx+2].high && h >= candles[idx+3].high;
        };

        const pivots: number[] = [];
        for (let i = index; i >= index - 30 && pivots.length < 2; i--) {
            if (isBullishBreakout ? isPivotLow(i) : isPivotHigh(i)) pivots.push(i);
        }
        if (pivots.length < 2) return false;
        const [recent, previous] = pivots;
        
        if (isBullishBreakout) return candles[recent].low < candles[previous].low && rsi[recent] > rsi[previous];
        else return candles[recent].high > candles[previous].high && rsi[recent] < rsi[previous];
    }

    static hasVolumeExpansion(candles: Candle[], currentIndex: number): boolean {
        if (currentIndex < 35) return false;
        let recentVol = 0; let pastVol = 0;
        for (let i = currentIndex - 4; i <= currentIndex; i++) recentVol += candles[i].volume;
        for (let i = currentIndex - 34; i <= currentIndex - 5; i++) pastVol += candles[i].volume;
        return recentVol > pastVol;
    }

    static isPinbar(candle: Candle): boolean {
        const body = Math.abs(candle.open - candle.close);
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        return (lowerWick >= 2 * body && upperWick <= 0.5 * body) || (upperWick >= 2 * body && lowerWick <= 0.5 * body);
    }

    static isEngulfing(prev: Candle, curr: Candle): boolean {
        if (prev.isBullish === curr.isBullish) return false;
        const prevBody = Math.abs(prev.open - prev.close);
        const currBody = Math.abs(curr.open - curr.close);
        const currTop = Math.max(curr.open, curr.close);
        const currBot = Math.min(curr.open, curr.close);
        const prevTop = Math.max(prev.open, prev.close);
        const prevBot = Math.min(prev.open, prev.close);
        return currBody > prevBody && currTop >= prevTop && currBot <= prevBot;
    }

    static isInsideBar(prev: Candle, curr: Candle): boolean {
        return curr.high <= prev.high && curr.low >= prev.low;
    }
}

class SidewaysBoxDetector {
    private readonly PASS_THRESHOLD = 70;

    public detect(candles: Candle[], interval: CandleInterval, rrRatio: number): Box[] {
        const boxes: Box[] = [];
        const rsi = Indicators.calculateRSI(candles);

        for (let i = 35; i < candles.length - 4; i++) {
            let high = candles[i].high; let low = candles[i].low;
            let bIndex = -1; let direction: 'long' | 'short' | null = null;

            for (let j = i + 1; j < candles.length - 3; j++) {
                if (candles[j].close > high) { bIndex = j; direction = 'long'; break; }
                if (candles[j].close < low) { bIndex = j; direction = 'short'; break; }
                high = Math.max(high, candles[j].high); low = Math.min(low, candles[j].low);
            }

            if (bIndex === -1 || !direction) continue;
            if (bIndex - i < 1) continue;
            if (!this.validatePreBreakReentry(candles, i, bIndex, direction)) continue;

            const archetype = this.determineArchetype(candles, i, bIndex, bIndex - i, interval, direction);
            if (archetype === 'unknown') continue;

            const score = this.calculateScore(candles, rsi, bIndex, archetype, direction);
            if (score.total < this.PASS_THRESHOLD) continue;

            const ep = (high + low) / 2;
            let sl: number, tp: number;
            
            if (direction === 'long') { sl = low; tp = ep + rrRatio * (ep - sl); }
            else { sl = high; tp = ep - rrRatio * (sl - ep); }

            boxes.push({
                id: `box_${candles[bIndex].openTime}`, type: 'sideways_box', archetype, direction,
                startIndex: i, endIndex: bIndex - 1, breakoutIndex: bIndex, createdIndex: bIndex + 3,
                createdAt: candles[bIndex + 3].openTime, high, low, ep, sl, tp, score, status: 'active'
            });
            i = bIndex; 
        }
        return boxes;
    }

    private validatePreBreakReentry(candles: Candle[], startIdx: number, bIndex: number, dir: 'long'|'short'): boolean {
        let obCandle: Candle | null = null;
        for (let k = bIndex - 1; k >= startIdx; k--) {
            if (candles[k].isBullish !== (dir === 'long')) { obCandle = candles[k]; break; }
        }
        if (!obCandle) return false;
        const obTop = Math.max(obCandle.open, obCandle.close);
        const obBot = Math.min(obCandle.open, obCandle.close);

        for (let k = bIndex + 1; k <= bIndex + 3; k++) {
            if (k >= candles.length) return false;
            if (candles[k].low <= obTop && candles[k].high >= obBot) return false;
        }
        return true;
    }

    private determineArchetype(candles: Candle[], startIdx: number, bIdx: number, len: number, interval: CandleInterval, dir: 'long'|'short'): Box['archetype'] {
        const c1 = candles[bIdx - 2]; const c2 = candles[bIdx - 1];
        if (len >= 10 && Indicators.hasVolumeExpansion(candles, bIdx - 1)) {
            let hasReversalSign = false;
            for(let k = startIdx; k < bIdx; k++) {
                if (Indicators.isPinbar(candles[k])) { hasReversalSign = true; break; }
                if (k > startIdx && Indicators.isEngulfing(candles[k-1], candles[k])) { hasReversalSign = true; break; }
            }
            if (hasReversalSign) return 'turning_point_base';
        }
        if (len >= 10 && c1 && c2 && c1.isBullish !== c2.isBullish && Indicators.isEngulfing(c1, c2)) return 'breakout_prep_box';
        if (interval === '1h' && len >= 10 && len <= 40) return 'continuation_box';
        if (interval === '4h' && len >= 5 && len <= 15) return 'continuation_box';
        if (interval === '1d' && len >= 1 && len <= 3) return 'continuation_box';
        return 'unknown';
    }

    private calculateScore(candles: Candle[], rsi: number[], bIdx: number, arch: string, dir: 'long'|'short'): ScoreBreakdown {
        const s: ScoreBreakdown = { total: 0, structure: 60 };
        s.total += 60;
        if (arch === 'continuation_box') { s.continuation = 10; s.total += 10; }
        if (arch === 'breakout_prep_box') { s.breakoutPrep = 15; s.total += 15; }
        if (arch === 'turning_point_base') { s.turningPoint = 20; s.total += 20; }
        if (Indicators.isInsideBar(candles[bIdx - 2], candles[bIdx - 1])) { s.insideBarBreakout = 5; s.total += 5; }
        if (Indicators.isEngulfing(candles[bIdx - 1], candles[bIdx])) { s.engulfingBreakout = 8; s.total += 8; }
        if (Indicators.isPinbar(candles[bIdx])) { s.pinbarReversal = 8; s.total += 8; }
        const currentRsi = rsi[bIdx];
        if (currentRsi <= 30 || currentRsi >= 70) { s.rsiExtreme = 8; s.total += 8; }
        if (Indicators.hasRegularDivergence(candles, rsi, bIdx, dir === 'long')) { s.regularDivergence = 12; s.total += 12; }
        if (Indicators.hasVolumeExpansion(candles, bIdx)) { s.volumeBonus = 10; s.total += 10; }
        return s;
    }
}

class ChartEngine {
    private detector = new SidewaysBoxDetector();

    public process(candles: Candle[], interval: CandleInterval, rrRatio: number): Box[] {
        let boxes = this.detector.detect(candles, interval, rrRatio);
        return this.dedupe(boxes); // 생명주기 관리(updateLifecycle)는 UI 단의 시계열 루프로 완전히 이관됨
    }

    private dedupe(boxes: Box[]): Box[] {
        const filtered: Box[] = [];
        for (const box of boxes) {
            const overlap = filtered.find(f => 
                f.direction === box.direction && 
                ((box.startIndex >= f.startIndex && box.startIndex <= f.endIndex) ||
                 (box.endIndex >= f.startIndex && box.endIndex <= f.endIndex))
            );
            
            if (!overlap) filtered.push(box);
            else if (box.startIndex < overlap.startIndex || (box.startIndex === overlap.startIndex && box.score.total > overlap.score.total)) {
                filtered[filtered.indexOf(overlap)] = box;
            }
        }
        return filtered;
    }
}

// ==========================================
// 2. 리액트 뷰 (UI 컴포넌트)
// ==========================================

export default function App() {
    const [symbol, setSymbol] = useState('BTCUSDT');
    const [interval, setInterval] = useState<CandleInterval>('4h');
    const [rrRatio, setRrRatio] = useState<number>(2.0); 
    
    // 트레이딩 설정 상태
    const [initialCapital, setInitialCapital] = useState<number>(10000);
    const [riskPerTrade, setRiskPerTrade] = useState<number>(1.0); 
    const [leverage, setLeverage] = useState<number>(10); // 기본 10배 레버리지
    const [maxPositions, setMaxPositions] = useState<number>(3); // 동시 유지 최대 포지션 수
    
    const [startDate, setStartDate] = useState(() => {
        const d = new Date();
        d.setMonth(d.getMonth() - 3);
        return d.toISOString().split('T')[0];
    });
    const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);

    const [rawCandles, setRawCandles] = useState<Candle[]>([]);
    const [boxes, setBoxes] = useState<Box[]>([]);
    const [pnlData, setPnlData] = useState<{time: number, pnl: number, equity: number}[]>([]);
    const [loading, setLoading] = useState(false);
    const [isMockData, setIsMockData] = useState(false);
    
    const [tradeStats, setTradeStats] = useState({ winRate: 0, mdd: 0, wins: 0, total: 0 });
    
    const [viewState, setViewState] = useState({ offset: 0, count: 200 });
    const interactionRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef({ isDragging: false, startX: 0, startOffset: 0 });

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const pnlCanvasRef = useRef<HTMLCanvasElement>(null);
    const equityCanvasRef = useRef<HTMLCanvasElement>(null);

    const fetchData = async () => {
        setLoading(true);
        try {
            const startMs = new Date(startDate).getTime();
            const endMs = new Date(endDate).getTime() + 86399999; 
            const { data, isMock } = await BinanceAPI.fetchKlines(symbol, interval, startMs, endMs, 1000);
            
            setRawCandles(data);
            setIsMockData(isMock);
            
            setViewState({ offset: 0, count: Math.min(200, data.length) });
        } catch (error) {
            console.error("Failed to load data", error);
        }
        setLoading(false);
    };

    // [핵심] 시계열 기반 백테스트 시뮬레이터 (다중 포지션 및 마진 추적)
    useEffect(() => {
        if (rawCandles.length === 0) return;
        const engine = new ChartEngine();
        const detectedBoxes = engine.process(rawCandles, interval, rrRatio);
        
        let currentEquity = initialCapital;
        let availableMargin = initialCapital;
        let totalR = 0;
        
        let peakEquity = initialCapital;
        let maxDrawdown = 0;

        const openPositions: Box[] = [];
        const pendingBoxes: Box[] = [...detectedBoxes];
        const finalBoxes: Box[] = []; // 처리가 끝난(청산/취소) 박스들을 모아두는 배열

        const curve = rawCandles.map(c => {
            
            // 1. 현재 오픈된 포지션 청산 여부(SL/TP 도달) 확인
            for (let i = openPositions.length - 1; i >= 0; i--) {
                const pos = openPositions[i];
                let isResolved = false;
                let isWin = false;

                if (pos.direction === 'long') {
                    if (c.low <= pos.sl) { isResolved = true; isWin = false; }
                    else if (c.high >= pos.tp) { isResolved = true; isWin = true; }
                } else {
                    if (c.high >= pos.sl) { isResolved = true; isWin = false; }
                    else if (c.low <= pos.tp) { isResolved = true; isWin = true; }
                }

                if (isResolved) {
                    const pnl = isWin ? (pos.riskAmount! * rrRatio) : -pos.riskAmount!;
                    currentEquity += pnl;
                    availableMargin += pos.marginUsed! + pnl; // 사용한 증거금 환원 + 손익 정산
                    totalR += isWin ? rrRatio : -1;
                    
                    pos.status = isWin ? 'reacted' : 'invalidated';
                    pos.resolvedAt = c.openTime;
                    pos.realizedPnl = pnl;
                    pos.realizedPnlPercent = (pnl / (currentEquity - pnl)) * 100;
                    pos.assetRoiPercent = isWin 
                        ? (pos.direction === 'long' ? ((pos.tp - pos.ep) / pos.ep) * 100 : ((pos.ep - pos.tp) / pos.ep) * 100)
                        : (pos.direction === 'long' ? ((pos.sl - pos.ep) / pos.ep) * 100 : ((pos.ep - pos.sl) / pos.ep) * 100);
                    
                    finalBoxes.push(pos);
                    openPositions.splice(i, 1);
                }
            }

            // 2. 대기 중인(Pending) 박스 중, 진입가(EP)에 오기 전에 손절가(SL)를 먼저 쳐버린 타점 취소
            for (let i = pendingBoxes.length - 1; i >= 0; i--) {
                const box = pendingBoxes[i];
                if (c.openTime < box.createdAt) continue; 
                
                let hitSlBeforeEntry = false;
                if (box.direction === 'long' && c.low <= box.sl) hitSlBeforeEntry = true;
                if (box.direction === 'short' && c.high >= box.sl) hitSlBeforeEntry = true;

                if (hitSlBeforeEntry) {
                    box.status = 'canceled';
                    box.skipReason = 'sl_before_ep';
                    box.resolvedAt = c.openTime;
                    finalBoxes.push(box);
                    pendingBoxes.splice(i, 1);
                }
            }

            // 3. 대기 중인(Pending) 박스 진입(EP 터치) 처리
            for (let i = pendingBoxes.length - 1; i >= 0; i--) {
                const box = pendingBoxes[i];
                if (c.openTime < box.createdAt) continue;

                let isHitEp = false;
                if (box.direction === 'long' && c.low <= box.ep) isHitEp = true;
                if (box.direction === 'short' && c.high >= box.ep) isHitEp = true;

                if (isHitEp) {
                    // 제한 조건 1: 최대 동시 포지션 개수 초과
                    if (openPositions.length >= maxPositions) {
                        box.status = 'canceled';
                        box.skipReason = 'max_positions';
                        box.resolvedAt = c.openTime;
                        finalBoxes.push(box);
                        pendingBoxes.splice(i, 1);
                        continue;
                    }

                    // 포지션 사이즈 및 레버리지 증거금 계산
                    const riskAmount = currentEquity * (riskPerTrade / 100);
                    const slPercent = Math.max(Math.abs(box.ep - box.sl) / box.ep, 0.0001);
                    const idealPosSize = riskAmount / slPercent;
                    const idealMargin = idealPosSize / leverage;
                    
                    // 제한 조건 2: 남은 증거금이 부족하면 진입 불가 (안전 마진 10달러 컷)
                    const actualMargin = Math.min(idealMargin, availableMargin);
                    if (actualMargin < 10) { 
                         box.status = 'canceled';
                         box.skipReason = 'no_margin';
                         box.resolvedAt = c.openTime;
                         finalBoxes.push(box);
                         pendingBoxes.splice(i, 1);
                         continue;
                    }

                    const actualPosSize = actualMargin * leverage;
                    const actualRisk = actualPosSize * slPercent;

                    // 포지션 진입 확정
                    box.isEntered = true;
                    box.enteredAt = c.openTime;
                    box.positionSize = actualPosSize;
                    box.marginUsed = actualMargin;
                    box.riskAmount = actualRisk;
                    
                    availableMargin -= actualMargin;
                    openPositions.push(box);
                    pendingBoxes.splice(i, 1);

                    // (옵션) 같은 캔들 내에서 진입과 동시에 청산(SL/TP) 도달 시 즉시 처리
                    let isResolvedNow = false;
                    let isWinNow = false;
                    if (box.direction === 'long') {
                        if (c.low <= box.sl) { isResolvedNow = true; isWinNow = false; }
                        else if (c.high >= box.tp) { isResolvedNow = true; isWinNow = true; }
                    } else {
                        if (c.high >= box.sl) { isResolvedNow = true; isWinNow = false; }
                        else if (c.low <= box.tp) { isResolvedNow = true; isWinNow = true; }
                    }

                    if (isResolvedNow) {
                        const pnl = isWinNow ? (box.riskAmount! * rrRatio) : -box.riskAmount!;
                        currentEquity += pnl;
                        availableMargin += box.marginUsed! + pnl; 
                        totalR += isWinNow ? rrRatio : -1;
                        
                        box.status = isWinNow ? 'reacted' : 'invalidated';
                        box.resolvedAt = c.openTime;
                        box.realizedPnl = pnl;
                        box.realizedPnlPercent = (pnl / (currentEquity - pnl)) * 100;
                        box.assetRoiPercent = isWinNow 
                            ? (box.direction === 'long' ? ((box.tp - box.ep) / box.ep) * 100 : ((box.ep - box.tp) / box.ep) * 100)
                            : (box.direction === 'long' ? ((box.sl - box.ep) / box.ep) * 100 : ((box.ep - box.sl) / box.ep) * 100);
                        
                        finalBoxes.push(box);
                        openPositions.pop(); // 방금 넣었던 포지션 바로 제거
                    }
                }
            }

            // MDD 트래킹
            if (currentEquity > peakEquity) peakEquity = currentEquity;
            const drawdown = ((peakEquity - currentEquity) / peakEquity) * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;

            return { time: c.openTime, pnl: totalR, equity: currentEquity };
        });

        // 렌더링을 위해 활성, 대기, 종료된 모든 박스 취합 후 시간순 정렬
        const allProcessedBoxes = [...finalBoxes, ...pendingBoxes, ...openPositions]
            .sort((a, b) => a.startIndex - b.startIndex);

        // 승률 통계 (진입 후 청산이 완료된 거래만 카운트)
        const closedTrades = allProcessedBoxes.filter(b => b.status === 'reacted' || b.status === 'invalidated');
        const wins = closedTrades.filter(b => b.status === 'reacted').length;
        const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

        setTradeStats({ winRate, mdd: maxDrawdown, wins, total: closedTrades.length });
        setBoxes(allProcessedBoxes);
        setPnlData(curve);
    }, [rawCandles, rrRatio, interval, initialCapital, riskPerTrade, leverage, maxPositions]);

    useEffect(() => {
        fetchData();
    }, [symbol, interval]);

    useEffect(() => {
        const el = interactionRef.current;
        if (!el) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            setViewState(prev => {
                if (rawCandles.length === 0) return prev;
                const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
                let newCount = Math.round(prev.count * zoomFactor);
                newCount = Math.max(30, Math.min(newCount, rawCandles.length)); 
                return { ...prev, count: newCount };
            });
        };

        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [rawCandles.length]);

    const handleMouseDown = (e: React.MouseEvent) => {
        dragRef.current = { isDragging: true, startX: e.clientX, startOffset: viewState.offset };
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!dragRef.current.isDragging || rawCandles.length === 0) return;
        const deltaX = e.clientX - dragRef.current.startX;
        
        const canvasWidth = interactionRef.current?.getBoundingClientRect().width || 800;
        const candleWidth = canvasWidth / viewState.count;
        const deltaCandles = Math.round(deltaX / candleWidth);
        
        setViewState(prev => {
            let newOffset = dragRef.current.startOffset + deltaCandles;
            newOffset = Math.max(0, Math.min(newOffset, rawCandles.length - prev.count));
            return { ...prev, offset: newOffset };
        });
    };

    const handleMouseUpOrLeave = () => {
        dragRef.current.isDragging = false;
    };

    useEffect(() => {
        if (!canvasRef.current || rawCandles.length === 0) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const { width, height } = canvas.getBoundingClientRect();
        canvas.width = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);

        const padding = { top: 40, bottom: 40, left: 20, right: 60 };
        const drawWidth = width - padding.left - padding.right;
        const drawHeight = height - padding.top - padding.bottom;

        const end = rawCandles.length - viewState.offset;
        const start = Math.max(0, end - viewState.count);
        
        const visibleCandles = rawCandles.slice(start, end);
        const visiblePnl = pnlData.slice(start, end);
        
        if (visibleCandles.length === 0) return;

        const candleWidth = drawWidth / visibleCandles.length;
        const spacing = candleWidth * 0.2;

        const maxPrice = Math.max(...visibleCandles.map(c => c.high));
        const minPrice = Math.min(...visibleCandles.map(c => c.low));
        const priceRange = maxPrice - minPrice || 1;

        const getY = (price: number) => padding.top + drawHeight - ((price - minPrice) / priceRange) * drawHeight;
        const getX = (index: number) => padding.left + index * candleWidth + spacing;

        // 1. 메인 차트 X축/Y축 그리기
        ctx.fillStyle = '#9ca3af';
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
        ctx.lineWidth = 1;
        ctx.font = '11px sans-serif';
        
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= 5; i++) {
            const price = maxPrice - (priceRange * (i / 5));
            const y = padding.top + (drawHeight * (i / 5));
            ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
            ctx.fillText(price.toFixed(2), width - padding.right + 5, y);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const xLabelCount = 6;
        for (let i = 0; i <= xLabelCount; i++) {
            const dataIndex = Math.floor((visibleCandles.length - 1) * (i / xLabelCount));
            if (!visibleCandles[dataIndex]) continue;
            const x = getX(dataIndex) + candleWidth / 2;
            const time = new Date(visibleCandles[dataIndex].openTime);
            const timeStr = `${time.getMonth() + 1}/${time.getDate()} ${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
            
            ctx.beginPath(); ctx.moveTo(x, padding.top); ctx.lineTo(x, height - padding.bottom + 5); ctx.stroke();
            ctx.fillText(timeStr, x, height - padding.bottom + 10);
        }

        // 2. 심플해진 박스 그리기 (취소된 박스 흐리게 표현, 점선 연장)
        boxes.forEach(box => {
            const relStartIdx = box.startIndex - start;
            const relEndIdx = box.endIndex - start;
            
            let relResolvedIdx = visibleCandles.length - 1; 
            if (box.resolvedAt) {
                const resolvedIdx = rawCandles.findIndex(c => c.openTime === box.resolvedAt);
                if (resolvedIdx !== -1) relResolvedIdx = resolvedIdx - start;
            }

            if (relResolvedIdx < 0 || relStartIdx >= visibleCandles.length) return;

            const yHigh = getY(box.high);
            const yLow = getY(box.low);
            const isCanceled = box.status === 'canceled';

            // [1] 박스 그리기
            if (relEndIdx >= 0 && relStartIdx < visibleCandles.length) {
                const xBoxStart = getX(Math.max(0, relStartIdx));
                const xBoxEnd = getX(Math.min(visibleCandles.length - 1, relEndIdx)) + candleWidth - spacing * 2;

                const bgAlpha = isCanceled ? 0.05 : 0.15;
                const borderAlpha = isCanceled ? 0.2 : 0.5;

                ctx.fillStyle = box.direction === 'long' ? `rgba(34, 197, 94, ${bgAlpha})` : `rgba(239, 68, 68, ${bgAlpha})`;
                ctx.fillRect(xBoxStart, yHigh, xBoxEnd - xBoxStart, yLow - yHigh);
                
                ctx.strokeStyle = box.direction === 'long' ? `rgba(34, 197, 94, ${borderAlpha})` : `rgba(239, 68, 68, ${borderAlpha})`;
                ctx.lineWidth = 1;
                if (isCanceled) ctx.setLineDash([2, 2]); // 취소된 박스는 테두리 점선 처리
                ctx.strokeRect(xBoxStart, yHigh, xBoxEnd - xBoxStart, yLow - yHigh);
                ctx.setLineDash([]);
            }

            // [2] 연장선 그리기 (취소되지 않은 정상 박스만)
            if (!isCanceled && relResolvedIdx > relEndIdx) {
                const xExtStart = relEndIdx < 0 ? getX(0) : getX(relEndIdx) + candleWidth - spacing * 2;
                const xExtEnd = relResolvedIdx >= visibleCandles.length ? getX(visibleCandles.length - 1) + candleWidth / 2 : getX(relResolvedIdx) + candleWidth / 2;
                
                ctx.beginPath();
                ctx.strokeStyle = box.direction === 'long' ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)';
                ctx.setLineDash([4, 4]);
                
                ctx.moveTo(xExtStart, yHigh);
                ctx.lineTo(xExtEnd, yHigh);
                
                ctx.moveTo(xExtStart, yLow);
                ctx.lineTo(xExtEnd, yLow);
                
                ctx.stroke();
                ctx.setLineDash([]);
            }
        });

        // 3. 캔들 그리기
        visibleCandles.forEach((candle, i) => {
            const x = getX(i);
            const yHigh = getY(candle.high);
            const yLow = getY(candle.low);
            const yOpen = getY(candle.open);
            const yClose = getY(candle.close);

            ctx.strokeStyle = candle.isBullish ? '#22c55e' : '#ef4444';
            ctx.fillStyle = candle.isBullish ? '#22c55e' : '#ef4444';
            
            ctx.beginPath(); ctx.moveTo(x + (candleWidth - spacing * 2) / 2, yHigh); ctx.lineTo(x + (candleWidth - spacing * 2) / 2, yLow); ctx.stroke();
            const rectY = Math.min(yOpen, yClose);
            const rectHeight = Math.max(Math.abs(yOpen - yClose), 1);
            ctx.fillRect(x, rectY, candleWidth - spacing * 2, rectHeight);
        });

        // 3-5. 타점(EP/Exit) 마커 및 숫자 그리기
        boxes.forEach((box, index) => {
            const tradeNum = (index + 1).toString();

            if (box.isEntered && box.enteredAt) {
                const entryIndex = visibleCandles.findIndex(c => c.openTime === box.enteredAt);
                if (entryIndex !== -1) {
                    const candle = visibleCandles[entryIndex];
                    const x = getX(entryIndex) + candleWidth / 2;
                    
                    ctx.beginPath();
                    ctx.font = 'bold 10px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    
                    if (box.direction === 'long') {
                        const y = getY(candle.low) + 8; 
                        ctx.fillStyle = '#22c55e'; 
                        ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 8); ctx.lineTo(x + 5, y + 8); ctx.fill();
                        ctx.fillText(tradeNum, x, y + 18); 
                    } else {
                        const y = getY(candle.high) - 8; 
                        ctx.fillStyle = '#ef4444'; 
                        ctx.moveTo(x, y); ctx.lineTo(x - 5, y - 8); ctx.lineTo(x + 5, y - 8); ctx.fill();
                        ctx.fillText(tradeNum, x, y - 18); 
                    }
                    ctx.closePath();
                }
            }

            if (box.status === 'reacted' || box.status === 'invalidated') {
                const exitIndex = visibleCandles.findIndex(c => c.openTime === box.resolvedAt);
                if (exitIndex !== -1) {
                    const candle = visibleCandles[exitIndex];
                    const x = getX(exitIndex) + candleWidth / 2;
                    
                    const isWin = box.status === 'reacted';
                    const exitColor = isWin ? '#3b82f6' : '#64748b'; 
                    const placeAbove = (box.direction === 'long' && isWin) || (box.direction === 'short' && !isWin);
                    
                    ctx.beginPath();
                    const y = placeAbove ? getY(candle.high) - 15 : getY(candle.low) + 15;
                    
                    ctx.fillStyle = exitColor;
                    ctx.arc(x, y, 7, 0, Math.PI * 2);
                    ctx.fill();
                    
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 9px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(tradeNum, x, y + 0.5); 
                    
                    ctx.closePath();
                }
            }
        });

        // 4. 동기화된 PNL 렌더링
        if (pnlCanvasRef.current && visiblePnl.length > 0) {
            const pnlCanvas = pnlCanvasRef.current;
            const pnlCtx = pnlCanvas.getContext('2d');
            if (!pnlCtx) return;

            const pnlRect = pnlCanvas.getBoundingClientRect();
            pnlCanvas.width = pnlRect.width;
            pnlCanvas.height = pnlRect.height;
            pnlCtx.clearRect(0, 0, pnlCanvas.width, pnlCanvas.height);

            const pnlPadding = { top: 20, bottom: 20, left: padding.left, right: padding.right };
            const pnlDrawHeight = pnlCanvas.height - pnlPadding.top - pnlPadding.bottom;

            const maxPnl = Math.max(...visiblePnl.map(d => d.pnl), 5);
            const minPnl = Math.min(...visiblePnl.map(d => d.pnl), -2);
            const pnlRange = maxPnl - minPnl || 1;

            const getPnlY = (val: number) => pnlPadding.top + pnlDrawHeight - ((val - minPnl) / pnlRange) * pnlDrawHeight;

            pnlCtx.fillStyle = '#9ca3af'; pnlCtx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
            pnlCtx.lineWidth = 1; pnlCtx.font = '11px sans-serif'; pnlCtx.textAlign = 'left'; pnlCtx.textBaseline = 'middle';

            const pnlSteps = 4; 
            for (let i = 0; i <= pnlSteps; i++) {
                const val = minPnl + (pnlRange * (i / pnlSteps));
                const y = getPnlY(val);
                pnlCtx.beginPath(); pnlCtx.moveTo(pnlPadding.left, y); pnlCtx.lineTo(pnlCanvas.width - pnlPadding.right, y); pnlCtx.stroke();
                pnlCtx.fillText(`${val > 0 ? '+' : ''}${val.toFixed(1)}R`, pnlCanvas.width - pnlPadding.right + 5, y);
            }

            for (let i = 0; i <= xLabelCount; i++) {
                const dataIndex = Math.floor((visibleCandles.length - 1) * (i / xLabelCount));
                if (!visibleCandles[dataIndex]) continue;
                const x = getX(dataIndex) + candleWidth / 2;
                pnlCtx.beginPath(); pnlCtx.moveTo(x, pnlPadding.top); pnlCtx.lineTo(x, pnlCanvas.height - pnlPadding.bottom); pnlCtx.stroke();
            }

            const zeroY = getPnlY(0);
            pnlCtx.beginPath(); pnlCtx.strokeStyle = '#64748b'; pnlCtx.setLineDash([4, 4]); pnlCtx.moveTo(pnlPadding.left, zeroY); pnlCtx.lineTo(pnlCanvas.width - pnlPadding.right, zeroY); pnlCtx.stroke(); pnlCtx.setLineDash([]);

            pnlCtx.beginPath(); pnlCtx.strokeStyle = '#3b82f6'; pnlCtx.lineWidth = 2; pnlCtx.lineJoin = 'round';
            visiblePnl.forEach((d, i) => {
                const x = getX(i) + candleWidth / 2;
                const y = getPnlY(d.pnl);
                if (i === 0) pnlCtx.moveTo(x, y); else pnlCtx.lineTo(x, y);
            });
            pnlCtx.stroke();

            const gradient = pnlCtx.createLinearGradient(0, pnlPadding.top, 0, pnlCanvas.height - pnlPadding.bottom);
            gradient.addColorStop(0, 'rgba(59, 130, 246, 0.3)'); gradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
            
            pnlCtx.lineTo(getX(visiblePnl.length - 1) + candleWidth / 2, zeroY);
            pnlCtx.lineTo(getX(0) + candleWidth / 2, zeroY);
            pnlCtx.closePath(); pnlCtx.fillStyle = gradient; pnlCtx.fill();
        }

        // 5. 동기화된 Equity 렌더링
        if (equityCanvasRef.current && visiblePnl.length > 0) {
            const eqCanvas = equityCanvasRef.current;
            const eqCtx = eqCanvas.getContext('2d');
            if (!eqCtx) return;

            const eqRect = eqCanvas.getBoundingClientRect();
            eqCanvas.width = eqRect.width;
            eqCanvas.height = eqRect.height;
            eqCtx.clearRect(0, 0, eqCanvas.width, eqCanvas.height);

            const eqPadding = { top: 20, bottom: 20, left: padding.left, right: padding.right };
            const eqDrawHeight = eqCanvas.height - eqPadding.top - eqPadding.bottom;

            const maxEq = Math.max(...visiblePnl.map(d => d.equity), initialCapital * 1.01);
            const minEq = Math.min(...visiblePnl.map(d => d.equity), initialCapital * 0.99);
            const eqRange = maxEq - minEq || 1;

            const getEqY = (val: number) => eqPadding.top + eqDrawHeight - ((val - minEq) / eqRange) * eqDrawHeight;

            eqCtx.fillStyle = '#9ca3af'; eqCtx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
            eqCtx.lineWidth = 1; eqCtx.font = '11px sans-serif'; eqCtx.textAlign = 'left'; eqCtx.textBaseline = 'middle';

            const eqSteps = 4; 
            for (let i = 0; i <= eqSteps; i++) {
                const val = minEq + (eqRange * (i / eqSteps));
                const y = getEqY(val);
                eqCtx.beginPath(); eqCtx.moveTo(eqPadding.left, y); eqCtx.lineTo(eqCanvas.width - eqPadding.right, y); eqCtx.stroke();
                eqCtx.fillText(`$${val.toFixed(0)}`, eqCanvas.width - eqPadding.right + 5, y);
            }

            for (let i = 0; i <= xLabelCount; i++) {
                const dataIndex = Math.floor((visibleCandles.length - 1) * (i / xLabelCount));
                if (!visibleCandles[dataIndex]) continue;
                const x = getX(dataIndex) + candleWidth / 2;
                eqCtx.beginPath(); eqCtx.moveTo(x, eqPadding.top); eqCtx.lineTo(x, eqCanvas.height - eqPadding.bottom); eqCtx.stroke();
            }

            const initY = getEqY(initialCapital);
            eqCtx.beginPath(); eqCtx.strokeStyle = '#64748b'; eqCtx.setLineDash([4, 4]); eqCtx.moveTo(eqPadding.left, initY); eqCtx.lineTo(eqCanvas.width - eqPadding.right, initY); eqCtx.stroke(); eqCtx.setLineDash([]);

            const isProfitable = visiblePnl[visiblePnl.length - 1].equity >= initialCapital;
            const lineColor = isProfitable ? '#10b981' : '#ef4444';
            
            eqCtx.beginPath(); eqCtx.strokeStyle = lineColor; eqCtx.lineWidth = 2; eqCtx.lineJoin = 'round';
            visiblePnl.forEach((d, i) => {
                const x = getX(i) + candleWidth / 2;
                const y = getEqY(d.equity);
                if (i === 0) eqCtx.moveTo(x, y); else eqCtx.lineTo(x, y);
            });
            eqCtx.stroke();

            const gradient = eqCtx.createLinearGradient(0, eqPadding.top, 0, eqCanvas.height - eqPadding.bottom);
            gradient.addColorStop(0, isProfitable ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'); 
            gradient.addColorStop(1, isProfitable ? 'rgba(16, 185, 129, 0.0)' : 'rgba(239, 68, 68, 0.0)');
            
            eqCtx.lineTo(getX(visiblePnl.length - 1) + candleWidth / 2, eqCanvas.height - eqPadding.bottom);
            eqCtx.lineTo(getX(0) + candleWidth / 2, eqCanvas.height - eqPadding.bottom);
            eqCtx.closePath(); eqCtx.fillStyle = gradient; eqCtx.fill();
        }

    }, [rawCandles, boxes, pnlData, viewState]);

    const currentPnl = pnlData.length > 0 ? pnlData[pnlData.length - 1].pnl : 0;
    const currentEquity = pnlData.length > 0 ? pnlData[pnlData.length - 1].equity : initialCapital;

    return (
        <div className="min-h-screen bg-slate-900 text-slate-200 p-6 font-sans">
            <div className="max-w-7xl mx-auto space-y-6">
                
                {/* 헤더 / 컨트롤 */}
                <div className="flex flex-col xl:flex-row justify-between items-center bg-slate-800 p-4 rounded-xl shadow-lg border border-slate-700 gap-4">
                    <div className="flex items-center space-x-3 w-full xl:w-auto">
                        <Activity className="w-8 h-8 text-blue-500 shrink-0" />
                        <div>
                            <h1 className="text-xl font-bold text-white flex items-center gap-3">
                                Quantitative Chart Analyzer
                                {isMockData ? (
                                    <span className="bg-orange-500/10 text-orange-400 px-2 py-0.5 rounded text-[10px] font-bold border border-orange-500/30 uppercase tracking-wider">Mock Data</span>
                                ) : (
                                    <span className="bg-green-500/10 text-green-400 px-2 py-0.5 rounded text-[10px] font-bold border border-green-500/30 uppercase tracking-wider">Live Binance</span>
                                )}
                            </h1>
                            <p className="text-sm text-slate-400">Advanced Chronological Backtester</p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 w-full xl:w-auto">
                        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
                            <option value="BTCUSDT">BTC/USDT</option>
                            <option value="ETHUSDT">ETH/USDT</option>
                            <option value="SOLUSDT">SOL/USDT</option>
                        </select>
                        <select value={interval} onChange={(e) => setInterval(e.target.value as CandleInterval)} className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
                            <option value="1h">1 Hour</option>
                            <option value="4h">4 Hours</option>
                            <option value="1d">1 Day</option>
                        </select>

                        <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-2 text-sm focus-within:border-blue-500">
                            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-transparent px-2 py-2 focus:outline-none text-slate-300 [&::-webkit-calendar-picker-indicator]:filter-[invert(1)]" />
                            <span className="text-slate-500">-</span>
                            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-transparent px-2 py-2 focus:outline-none text-slate-300 [&::-webkit-calendar-picker-indicator]:filter-[invert(1)]" />
                        </div>

                        {/* 시뮬레이션 설정 (Capital, Risk, Pos, Lev) */}
                        <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus-within:border-blue-500">
                            <span className="text-slate-400 mr-2 font-medium">Cap: $</span>
                            <input 
                                type="number" step="1000" min="100" 
                                value={initialCapital} 
                                onChange={(e) => setInitialCapital(parseFloat(e.target.value) || 10000)} 
                                className="bg-transparent w-20 text-center focus:outline-none text-white font-mono" 
                            />
                        </div>
                        <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus-within:border-blue-500">
                            <span className="text-slate-400 mr-2 font-medium">Risk: </span>
                            <input 
                                type="number" step="0.1" min="0.1" max="100" 
                                value={riskPerTrade} 
                                onChange={(e) => setRiskPerTrade(parseFloat(e.target.value) || 1.0)} 
                                className="bg-transparent w-12 text-center focus:outline-none text-white font-mono" 
                            />
                            <span className="text-slate-400 ml-1">%</span>
                        </div>
                        <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus-within:border-blue-500">
                            <span className="text-slate-400 mr-2 font-medium">Lev: </span>
                            <input 
                                type="number" step="1" min="1" max="100" 
                                value={leverage} 
                                onChange={(e) => setLeverage(parseFloat(e.target.value) || 10)} 
                                className="bg-transparent w-10 text-center focus:outline-none text-white font-mono" 
                            />
                            <span className="text-slate-400 ml-1">x</span>
                        </div>
                        <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus-within:border-blue-500" title="Max Concurrent Positions">
                            <span className="text-slate-400 mr-2 font-medium">Max Pos: </span>
                            <input 
                                type="number" step="1" min="1" max="20" 
                                value={maxPositions} 
                                onChange={(e) => setMaxPositions(parseFloat(e.target.value) || 3)} 
                                className="bg-transparent w-10 text-center focus:outline-none text-white font-mono" 
                            />
                        </div>

                        <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus-within:border-blue-500">
                            <span className="text-slate-400 mr-2 font-medium">R:R = 1 : </span>
                            <input 
                                type="number" step="0.1" min="0.5" max="10" 
                                value={rrRatio} 
                                onChange={(e) => setRrRatio(parseFloat(e.target.value) || 2.0)} 
                                className="bg-transparent w-10 text-center focus:outline-none text-white font-mono" 
                            />
                        </div>

                        <button onClick={fetchData} disabled={loading} className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 ml-auto xl:ml-0">
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                            <span>Scan Data</span>
                        </button>
                    </div>
                </div>

                {/* 차트 영역 (Pan/Zoom 마우스 상호작용 Wrapper) */}
                <div 
                    ref={interactionRef}
                    className="flex flex-col gap-4 cursor-grab active:cursor-grabbing relative"
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUpOrLeave}
                    onMouseLeave={handleMouseUpOrLeave}
                >
                    {/* 메인 캔들 차트 */}
                    <div className="bg-slate-800 rounded-xl shadow-lg border border-slate-700 overflow-hidden pointer-events-none">
                        <div className="p-4 border-b border-slate-700 flex justify-between items-center pointer-events-auto">
                            <h2 className="font-semibold text-slate-100 flex items-center gap-2">
                                <BoxIcon className="w-5 h-5 text-slate-400" /> 
                                {symbol} Chart View (Scroll to Zoom, Drag to Pan)
                            </h2>
                            <div className="flex items-center gap-4">
                                {loading && <span className="text-xs text-blue-400 animate-pulse">Fetching data & analyzing...</span>}
                                {!loading && tradeStats.total > 0 && (
                                    <div className="flex gap-3 text-sm font-mono">
                                        <div className="bg-slate-900/50 px-3 py-1 rounded border border-slate-700 flex items-center">
                                            <span className="text-slate-400 mr-2">Win Rate:</span> 
                                            <span className={`font-bold ${tradeStats.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                                                {tradeStats.winRate.toFixed(1)}%
                                            </span> 
                                            <span className="text-xs text-slate-500 ml-1">({tradeStats.wins}/{tradeStats.total})</span>
                                        </div>
                                        <div className="bg-slate-900/50 px-3 py-1 rounded border border-slate-700 flex items-center">
                                            <span className="text-slate-400 mr-2">MDD:</span> 
                                            <span className="font-bold text-red-400">-{tradeStats.mdd.toFixed(2)}%</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="w-full h-[450px] bg-slate-900 relative">
                            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* 누적 수익률(PNL) 차트 */}
                        <div className="bg-slate-800 rounded-xl shadow-lg border border-slate-700 overflow-hidden pointer-events-none">
                            <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-slate-800/50 pointer-events-auto">
                                <h2 className="font-semibold text-slate-100 flex items-center gap-2">
                                    <LineChart className="w-5 h-5 text-slate-400" /> 
                                    Synchronized PNL (R)
                                </h2>
                                <div className={`text-lg font-bold font-mono ${currentPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    Net: {currentPnl > 0 ? '+' : ''}{currentPnl.toFixed(1)}R
                                </div>
                            </div>
                            <div className="w-full h-[180px] bg-slate-900 relative">
                                <canvas ref={pnlCanvasRef} className="absolute inset-0 w-full h-full" />
                            </div>
                        </div>

                        {/* Equity(자산 변동) 차트 */}
                        <div className="bg-slate-800 rounded-xl shadow-lg border border-slate-700 overflow-hidden pointer-events-none">
                            <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-slate-800/50 pointer-events-auto">
                                <h2 className="font-semibold text-slate-100 flex items-center gap-2">
                                    <Activity className="w-5 h-5 text-slate-400" /> 
                                    Equity Curve ($)
                                </h2>
                                <div className="flex items-center gap-4">
                                    <div className="text-xs text-slate-400">
                                        Initial: ${initialCapital.toLocaleString()}
                                    </div>
                                    <div className={`text-lg font-bold font-mono ${currentEquity >= initialCapital ? 'text-green-400' : 'text-red-400'}`}>
                                        ${currentEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </div>
                                </div>
                            </div>
                            <div className="w-full h-[180px] bg-slate-900 relative">
                                <canvas ref={equityCanvasRef} className="absolute inset-0 w-full h-full" />
                            </div>
                        </div>
                    </div>
                </div>

                {/* 검출된 박스 결과 리스트 */}
                <div className="bg-slate-800 rounded-xl shadow-lg border border-slate-700 overflow-hidden">
                    <div className="p-4 border-b border-slate-700">
                        <h2 className="font-semibold text-slate-100 flex items-center gap-2">
                            <AlertCircle className="w-5 h-5 text-slate-400" /> 
                            Detected Zones ({boxes.length})
                        </h2>
                    </div>
                    <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-900/50 text-slate-400 sticky top-0 z-10">
                                <tr>
                                    <th className="p-4 font-medium w-12 text-center">#</th>
                                    <th className="p-4 font-medium">Date</th>
                                    <th className="p-4 font-medium">Type / Archetype</th>
                                    <th className="p-4 font-medium">Direction</th>
                                    <th className="p-4 font-medium">Levels (EP / SL / TP)</th>
                                    <th className="p-4 font-medium">Invested (Size)</th>
                                    <th className="p-4 font-medium">Status</th>
                                    <th className="p-4 font-medium">Profit / Loss</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-700/50">
                                {boxes.length === 0 ? (
                                    <tr>
                                        <td colSpan={8} className="p-8 text-center text-slate-500">
                                            No valid sideways boxes detected in the selected timeframe.
                                        </td>
                                    </tr>
                                ) : (
                                    [...boxes].reverse().map(box => {
                                        const tradeNum = boxes.indexOf(box) + 1;
                                        const isCanceled = box.status === 'canceled';
                                        
                                        return (
                                        <tr key={box.id} className={`transition-colors ${isCanceled ? 'opacity-40 hover:opacity-60 bg-slate-800/20' : 'hover:bg-slate-750/50'}`}>
                                            <td className="p-4 text-center">
                                                <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full font-bold text-xs ${isCanceled ? 'bg-slate-800 text-slate-500' : 'bg-slate-700 text-slate-300'}`}>
                                                    {tradeNum}
                                                </span>
                                            </td>
                                            <td className="p-4 text-slate-300">
                                                {new Date(box.createdAt).toLocaleDateString()}
                                                <div className="text-xs text-slate-500">
                                                    {new Date(box.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                </div>
                                            </td>
                                            <td className="p-4">
                                                <div className="font-medium text-slate-200">{box.type}</div>
                                                <div className="text-xs text-slate-400 mt-1">{box.archetype}</div>
                                            </td>
                                            <td className="p-4">
                                                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                                                    box.direction === 'long' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                                                }`}>
                                                    {box.direction === 'long' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                                    {box.direction.toUpperCase()}
                                                </span>
                                            </td>
                                            <td className="p-4 font-mono text-slate-300">
                                                <span className="text-blue-400">{box.ep.toFixed(2)}</span> / 
                                                <span className="text-red-400 mx-1">{box.sl.toFixed(2)}</span> / 
                                                <span className="text-green-400">{box.tp.toFixed(2)}</span>
                                            </td>
                                            <td className="p-4">
                                                {box.positionSize ? (
                                                    <div className="flex flex-col">
                                                        <div className="font-mono text-slate-200">
                                                            Pos: ${box.positionSize.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                                        </div>
                                                        <div className="text-[11px] text-slate-400 mt-0.5 whitespace-nowrap">
                                                            Margin: <span className="text-slate-300">${box.marginUsed?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <span className="text-slate-500">-</span>
                                                )}
                                            </td>
                                            <td className="p-4">
                                                {isCanceled ? (
                                                    <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-500 border border-slate-700/50">
                                                        {box.skipReason === 'max_positions' ? 'Canceled (Max Pos)' : 
                                                         box.skipReason === 'no_margin' ? 'Canceled (No Margin)' : 'Canceled (SL Hit First)'}
                                                    </span>
                                                ) : (
                                                    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ${
                                                        box.status === 'active' 
                                                            ? (box.isEntered ? 'bg-blue-500/20 text-blue-300' : 'bg-slate-500/20 text-slate-400 border border-slate-500/30')
                                                            : box.status === 'reacted' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'
                                                    }`}>
                                                        {box.status === 'reacted' ? `+${rrRatio}R (Win)` : box.status === 'invalidated' ? '-1R (Loss)' : (box.isEntered ? 'Filled (Active)' : 'Pending (Wait EP)')}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="p-4">
                                                {box.status === 'active' || isCanceled || box.realizedPnl === undefined ? (
                                                    <span className="text-slate-500">-</span>
                                                ) : (
                                                    <div className="flex flex-col">
                                                        <div className={`font-mono font-medium ${box.realizedPnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                            {box.realizedPnl > 0 ? '+' : ''}${box.realizedPnl.toFixed(2)}
                                                        </div>
                                                        <div className="text-[11px] text-slate-400 mt-1 whitespace-nowrap">
                                                            계좌: <span className={box.realizedPnlPercent! > 0 ? 'text-green-400' : 'text-red-400'}>
                                                                {box.realizedPnlPercent! > 0 ? '+' : ''}{box.realizedPnlPercent!.toFixed(2)}%
                                                            </span>
                                                        </div>
                                                        <div className="text-[11px] text-slate-400 whitespace-nowrap">
                                                            코인: <span className={box.assetRoiPercent! > 0 ? 'text-green-400' : 'text-red-400'}>
                                                                {box.assetRoiPercent! > 0 ? '+' : ''}{box.assetRoiPercent!.toFixed(2)}%
                                                            </span>
                                                        </div>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    )})
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

            </div>
        </div>
    );
}