import math
from typing import List, Dict

class Indicators:
    @staticmethod
    def calculate_rsi(candles: List[Dict], period: int = 14) -> List[float]:
        rsi = [0.0] * len(candles)
        if len(candles) <= period:
            return rsi

        avg_gain = 0.0
        avg_loss = 0.0

        for i in range(1, period + 1):
            change = candles[i]['close'] - candles[i - 1]['close']
            if change > 0: avg_gain += change
            else: avg_loss -= change
            
        avg_gain /= period
        avg_loss /= period
        
        rsi[period] = 100.0 - (100.0 / (1.0 + (avg_gain / (avg_loss or 1e-10))))

        for i in range(period + 1, len(candles)):
            change = candles[i]['close'] - candles[i - 1]['close']
            gain = change if change > 0 else 0.0
            loss = -change if change < 0 else 0.0

            avg_gain = ((avg_gain * (period - 1)) + gain) / period
            avg_loss = ((avg_loss * (period - 1)) + loss) / period
            rsi[i] = 100.0 - (100.0 / (1.0 + (avg_gain / (avg_loss or 1e-10))))
            
        return rsi

    @staticmethod
    def has_volume_expansion(candles: List[Dict], idx: int) -> bool:
        if idx < 35: return False
        recent_vol = sum(c['volume'] for c in candles[idx-4 : idx+1])
        past_vol = sum(c['volume'] for c in candles[idx-34 : idx-4])
        return recent_vol > past_vol

    @staticmethod
    def is_pinbar(c: Dict) -> bool:
        body = abs(c['open'] - c['close'])
        upper_wick = c['high'] - max(c['open'], c['close'])
        lower_wick = min(c['open'], c['close']) - c['low']
        return (lower_wick >= 2 * body and upper_wick <= 0.5 * body) or \
               (upper_wick >= 2 * body and lower_wick <= 0.5 * body)

    @staticmethod
    def is_engulfing(prev: Dict, curr: Dict) -> bool:
        if prev['is_bullish'] == curr['is_bullish']: return False
        prev_body = abs(prev['open'] - prev['close'])
        curr_body = abs(curr['open'] - curr['close'])
        curr_top = max(curr['open'], curr['close'])
        curr_bot = min(curr['open'], curr['close'])
        prev_top = max(prev['open'], prev['close'])
        prev_bot = min(prev['open'], prev['close'])
        return curr_body > prev_body and curr_top >= prev_top and curr_bot <= prev_bot

class SidewaysBoxDetector:
    def __init__(self, pass_threshold=70):
        self.pass_threshold = pass_threshold

    def detect(self, candles: List[Dict], interval: str, rr_ratio: float) -> List[Dict]:
        boxes = []
        rsi = Indicators.calculate_rsi(candles)

        i = 35
        while i < len(candles) - 4:
            high = candles[i]['high']
            low = candles[i]['low']
            b_idx = -1
            direction = None

            for j in range(i + 1, len(candles) - 3):
                if candles[j]['close'] > high:
                    b_idx, direction = j, 'long'
                    break
                if candles[j]['close'] < low:
                    b_idx, direction = j, 'short'
                    break
                high = max(high, candles[j]['high'])
                low = min(low, candles[j]['low'])

            if b_idx == -1 or not direction or (b_idx - i < 1):
                i += 1
                continue

            if not self._validate_pre_break(candles, i, b_idx, direction):
                i += 1
                continue

            arch = self._get_archetype(candles, i, b_idx, interval)
            if arch == 'unknown':
                i += 1
                continue

            score = self._calc_score(candles, rsi, b_idx, arch, direction)
            if score < self.pass_threshold:
                i += 1
                continue

            ep = (high + low) / 2
            if direction == 'long':
                sl = low
                tp = ep + rr_ratio * (ep - sl)
            else:
                sl = high
                tp = ep - rr_ratio * (sl - ep)

            boxes.append({
                'id': f"box_{candles[b_idx]['open_time']}",
                'direction': direction,
                'archetype': arch,
                'created_at': candles[b_idx + 3]['open_time'],
                'ep': ep,
                'sl': sl,
                'tp': tp,
                'score': score,
                'status': 'pending'
            })
            i = b_idx
            
        return boxes

    def _validate_pre_break(self, candles, start_idx, b_idx, direction):
        ob_candle = None
        for k in range(b_idx - 1, start_idx - 1, -1):
            if candles[k]['is_bullish'] != (direction == 'long'):
                ob_candle = candles[k]
                break
        if not ob_candle: return False
        
        ob_top = max(ob_candle['open'], ob_candle['close'])
        ob_bot = min(ob_candle['open'], ob_candle['close'])

        for k in range(b_idx + 1, b_idx + 4):
            if k >= len(candles): return False
            if candles[k]['low'] <= ob_top and candles[k]['high'] >= ob_bot:
                return False
        return True

    def _get_archetype(self, candles, start_idx, b_idx, interval):
        length = b_idx - start_idx
        if length >= 10 and Indicators.has_volume_expansion(candles, b_idx - 1):
            return 'turning_point_base'
        if interval == '4h' and 5 <= length <= 15:
            return 'continuation_box'
        return 'unknown'

    def _calc_score(self, candles, rsi, b_idx, arch, direction):
        score = 60
        if arch == 'continuation_box': score += 10
        if arch == 'turning_point_base': score += 20
        if Indicators.is_pinbar(candles[b_idx]): score += 8
        if rsi[b_idx] <= 30 or rsi[b_idx] >= 70: score += 8
        if Indicators.has_volume_expansion(candles, b_idx): score += 10
        return score