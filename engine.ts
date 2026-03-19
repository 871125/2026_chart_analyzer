export type CandleInterval = '1h' | '4h' | '1d';
export type ZoneType = 'order_block' | 'volume_zone' | 'sideways_box';
export type StrategyStatus = 'active' | 'reacted' | 'invalidated' | 'canceled';

export interface Candle {
    openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number; isBullish: boolean;
}

export interface ScoreBreakdown {
    total: number; structure?: number; continuation?: number; breakoutPrep?: number; turningPoint?: number;
    insideBarBreakout?: number; engulfingBreakout?: number; pinbarReversal?: number; rsiExtreme?: number; regularDivergence?: number; volumeBonus?: number;
}

export interface Zone {
    id: string; type: ZoneType; startIndex: number; endIndex: number; direction: 'long' | 'short'; score: ScoreBreakdown; status: StrategyStatus; createdAt: number; createdIndex: number;
}

export interface Box extends Zone {
    type: 'sideways_box'; archetype: 'continuation_box' | 'breakout_prep_box' | 'turning_point_base' | 'unknown';
    breakoutIndex: number; high: number; low: number; ep: number; sl: number; tp: number; touchedAt?: number; resolvedAt?: number; realizedPnl?: number; realizedPnlPercent?: number; isEntered?: boolean; enteredAt?: number; assetRoiPercent?: number; positionSize?: number; riskAmount?: number; marginUsed?: number; skipReason?: 'max_positions' | 'no_margin' | 'sl_before_ep';
}

export class BinanceAPI {
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
                    const open = parseFloat(row[1]); const close = parseFloat(row[4]);
                    return { openTime: row[0], open, high: parseFloat(row[2]), low: parseFloat(row[3]), close, volume: parseFloat(row[5]), closeTime: row[6], isBullish: close >= open };
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
            console.warn('API 호출 실패, 빈 배열을 반환합니다.', error);
            return { data: [], isMock: true };
        }
    }
}

export class Indicators {
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
            const gain = change > 0 ? change : 0; const loss = change < 0 ? -change : 0;
            avgGain = ((avgGain * (period - 1)) + gain) / period; avgLoss = ((avgLoss * (period - 1)) + loss) / period;
            rsi[i] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-10))));
        }
        return rsi;
    }
    static hasRegularDivergence(candles: Candle[], rsi: number[], index: number, isBullishBreakout: boolean): boolean {
        if (index < 10) return false;
        const isPivotLow = (idx: number) => {
            if (idx < 3 || idx > candles.length - 4) return false;
            const l = candles[idx].low; return l <= candles[idx-1].low && l <= candles[idx-2].low && l <= candles[idx-3].low && l <= candles[idx+1].low && l <= candles[idx+2].low && l <= candles[idx+3].low;
        };
        const isPivotHigh = (idx: number) => {
            if (idx < 3 || idx > candles.length - 4) return false;
            const h = candles[idx].high; return h >= candles[idx-1].high && h >= candles[idx-2].high && h >= candles[idx-3].high && h >= candles[idx+1].high && h >= candles[idx+2].high && h >= candles[idx+3].high;
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
        const prevBody = Math.abs(prev.open - prev.close); const currBody = Math.abs(curr.open - curr.close);
        return currBody > prevBody && Math.max(curr.open, curr.close) >= Math.max(prev.open, prev.close) && Math.min(curr.open, curr.close) <= Math.min(prev.open, prev.close);
    }
    static isInsideBar(prev: Candle, curr: Candle): boolean {
        return curr.high <= prev.high && curr.low >= prev.low;
    }
}

export class SidewaysBoxDetector {
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
            if (direction === 'long') { sl = low; tp = ep + rrRatio * (ep - sl); } else { sl = high; tp = ep - rrRatio * (sl - ep); }
            boxes.push({ id: `box_${candles[bIndex].openTime}`, type: 'sideways_box', archetype, direction, startIndex: i, endIndex: bIndex - 1, breakoutIndex: bIndex, createdIndex: bIndex + 3, createdAt: candles[bIndex + 3].openTime, high, low, ep, sl, tp, score, status: 'active' });
            i = bIndex; 
        }
        return boxes;
    }
    private validatePreBreakReentry(candles: Candle[], startIdx: number, bIndex: number, dir: 'long'|'short'): boolean {
        let obCandle: Candle | null = null;
        for (let k = bIndex - 1; k >= startIdx; k--) { if (candles[k].isBullish !== (dir === 'long')) { obCandle = candles[k]; break; } }
        if (!obCandle) return false;
        for (let k = bIndex + 1; k <= bIndex + 3; k++) {
            if (k >= candles.length) return false;
            if (candles[k].low <= Math.max(obCandle.open, obCandle.close) && candles[k].high >= Math.min(obCandle.open, obCandle.close)) return false;
        }
        return true;
    }
    private determineArchetype(candles: Candle[], startIdx: number, bIdx: number, len: number, interval: CandleInterval, dir: 'long'|'short'): Box['archetype'] {
        const c1 = candles[bIdx - 2]; const c2 = candles[bIdx - 1];
        if (len >= 10 && Indicators.hasVolumeExpansion(candles, bIdx - 1)) {
            let hasReversalSign = false;
            for(let k = startIdx; k < bIdx; k++) { if (Indicators.isPinbar(candles[k]) || (k > startIdx && Indicators.isEngulfing(candles[k-1], candles[k]))) { hasReversalSign = true; break; } }
            if (hasReversalSign) return 'turning_point_base';
        }
        if (len >= 10 && c1 && c2 && c1.isBullish !== c2.isBullish && Indicators.isEngulfing(c1, c2)) return 'breakout_prep_box';
        if ((interval === '1h' && len >= 10 && len <= 40) || (interval === '4h' && len >= 5 && len <= 15) || (interval === '1d' && len >= 1 && len <= 3)) return 'continuation_box';
        return 'unknown';
    }
    private calculateScore(candles: Candle[], rsi: number[], bIdx: number, arch: string, dir: 'long'|'short'): ScoreBreakdown {
        const s: ScoreBreakdown = { total: 60, structure: 60 };
        if (arch === 'continuation_box') { s.continuation = 10; s.total += 10; }
        if (arch === 'breakout_prep_box') { s.breakoutPrep = 15; s.total += 15; }
        if (arch === 'turning_point_base') { s.turningPoint = 20; s.total += 20; }
        if (Indicators.isInsideBar(candles[bIdx - 2], candles[bIdx - 1])) { s.insideBarBreakout = 5; s.total += 5; }
        if (Indicators.isEngulfing(candles[bIdx - 1], candles[bIdx])) { s.engulfingBreakout = 8; s.total += 8; }
        if (Indicators.isPinbar(candles[bIdx])) { s.pinbarReversal = 8; s.total += 8; }
        if (rsi[bIdx] <= 30 || rsi[bIdx] >= 70) { s.rsiExtreme = 8; s.total += 8; }
        if (Indicators.hasRegularDivergence(candles, rsi, bIdx, dir === 'long')) { s.regularDivergence = 12; s.total += 12; }
        if (Indicators.hasVolumeExpansion(candles, bIdx)) { s.volumeBonus = 10; s.total += 10; }
        return s;
    }
}

export class ChartEngine {
    private detector = new SidewaysBoxDetector();
    public process(candles: Candle[], interval: CandleInterval, rrRatio: number): Box[] {
        return this.dedupe(this.detector.detect(candles, interval, rrRatio));
    }
    private dedupe(boxes: Box[]): Box[] {
        const filtered: Box[] = [];
        for (const box of boxes) {
            const overlap = filtered.find(f => f.direction === box.direction && ((box.startIndex >= f.startIndex && box.startIndex <= f.endIndex) || (box.endIndex >= f.startIndex && box.endIndex <= f.endIndex)));
            if (!overlap) filtered.push(box);
            else if (box.startIndex < overlap.startIndex || (box.startIndex === overlap.startIndex && box.score.total > overlap.score.total)) { filtered[filtered.indexOf(overlap)] = box; }
        }
        return filtered;
    }
}