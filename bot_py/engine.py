"""코어 차트 분석 엔진 (bot/engine.ts 이식)."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal, Optional

import requests

CandleInterval = Literal["1h", "4h", "1d"]
ZoneType = Literal["order_block", "volume_zone", "sideways_box"]
StrategyStatus = Literal["active", "reacted", "invalidated", "canceled"]
Archetype = Literal["continuation_box", "breakout_prep_box", "turning_point_base", "unknown"]
Direction = Literal["long", "short"]


@dataclass
class Candle:
    open_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: int
    is_bullish: bool


@dataclass
class ScoreBreakdown:
    total: int = 0
    structure: Optional[int] = None
    continuation: Optional[int] = None
    breakout_prep: Optional[int] = None
    turning_point: Optional[int] = None
    inside_bar_breakout: Optional[int] = None
    engulfing_breakout: Optional[int] = None
    pinbar_reversal: Optional[int] = None
    rsi_extreme: Optional[int] = None
    regular_divergence: Optional[int] = None
    volume_bonus: Optional[int] = None


@dataclass
class Box:
    id: str
    type: ZoneType
    archetype: Archetype
    start_index: int
    end_index: int
    direction: Direction
    score: ScoreBreakdown
    status: StrategyStatus
    created_at: int
    created_index: int
    breakout_index: int
    high: float
    low: float
    ep: float
    sl: float
    tp: float
    touched_at: Optional[int] = None
    resolved_at: Optional[int] = None
    realized_pnl: Optional[float] = None
    realized_pnl_percent: Optional[float] = None
    is_entered: bool = False
    entered_at: Optional[int] = None
    asset_roi_percent: Optional[float] = None
    position_size: Optional[float] = None
    risk_amount: Optional[float] = None
    margin_used: Optional[float] = None
    skip_reason: Optional[Literal["max_positions", "no_margin", "sl_before_ep"]] = None
    quantity: Optional[float] = None
    entered_price: Optional[float] = None


class BinanceAPI:
    BASE_URL = "https://api.binance.com/api/v3"

    @classmethod
    def fetch_klines(
        cls,
        symbol: str,
        interval: str,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
        limit: int = 1000,
    ) -> tuple[list[Candle], bool]:
        all_candles: list[Candle] = []
        current_start_time = start_time
        fetch_count = 0
        max_fetches = 30
        try:
            while fetch_count < max_fetches:
                params: dict[str, object] = {"symbol": symbol, "interval": interval, "limit": limit}
                if current_start_time:
                    params["startTime"] = current_start_time
                if end_time:
                    params["endTime"] = end_time
                response = requests.get(f"{cls.BASE_URL}/klines", params=params, timeout=15)
                if not response.ok:
                    raise RuntimeError(f"Binance API error: {response.status_code} {response.reason}")
                raw_data = response.json()
                if len(raw_data) == 0:
                    break
                data = [
                    Candle(
                        open_time=row[0],
                        open=float(row[1]),
                        high=float(row[2]),
                        low=float(row[3]),
                        close=float(row[4]),
                        volume=float(row[5]),
                        close_time=row[6],
                        is_bullish=float(row[4]) >= float(row[1]),
                    )
                    for row in raw_data
                ]
                all_candles.extend(data)
                last_candle = data[-1]
                if end_time and last_candle.close_time >= end_time:
                    break
                if len(raw_data) < limit:
                    break
                current_start_time = last_candle.close_time + 1
                fetch_count += 1
                time.sleep(0.05)
            return all_candles, False
        except Exception as error:
            print(f"API 호출 실패, 빈 배열을 반환합니다. {error}")
            return [], True


class Indicators:
    @staticmethod
    def calculate_rsi(candles: list[Candle], period: int = 14) -> list[float]:
        rsi = [0.0] * len(candles)
        if len(candles) <= period:
            return rsi
        avg_gain = 0.0
        avg_loss = 0.0
        for i in range(1, period + 1):
            change = candles[i].close - candles[i - 1].close
            if change > 0:
                avg_gain += change
            else:
                avg_loss -= change
        avg_gain /= period
        avg_loss /= period
        rsi[period] = 100 - (100 / (1 + (avg_gain / (avg_loss or 1e-10))))
        for i in range(period + 1, len(candles)):
            change = candles[i].close - candles[i - 1].close
            gain = change if change > 0 else 0
            loss = -change if change < 0 else 0
            avg_gain = ((avg_gain * (period - 1)) + gain) / period
            avg_loss = ((avg_loss * (period - 1)) + loss) / period
            rsi[i] = 100 - (100 / (1 + (avg_gain / (avg_loss or 1e-10))))
        return rsi

    @staticmethod
    def has_regular_divergence(
        candles: list[Candle], rsi: list[float], index: int, is_bullish_breakout: bool
    ) -> bool:
        if index < 10:
            return False

        def is_pivot_low(idx: int) -> bool:
            if idx < 3 or idx > len(candles) - 4:
                return False
            low = candles[idx].low
            return (
                low <= candles[idx - 1].low
                and low <= candles[idx - 2].low
                and low <= candles[idx - 3].low
                and low <= candles[idx + 1].low
                and low <= candles[idx + 2].low
                and low <= candles[idx + 3].low
            )

        def is_pivot_high(idx: int) -> bool:
            if idx < 3 or idx > len(candles) - 4:
                return False
            high = candles[idx].high
            return (
                high >= candles[idx - 1].high
                and high >= candles[idx - 2].high
                and high >= candles[idx - 3].high
                and high >= candles[idx + 1].high
                and high >= candles[idx + 2].high
                and high >= candles[idx + 3].high
            )

        pivots: list[int] = []
        i = index
        while i >= index - 30 and len(pivots) < 2:
            if is_pivot_low(i) if is_bullish_breakout else is_pivot_high(i):
                pivots.append(i)
            i -= 1

        if len(pivots) < 2:
            return False

        recent, previous = pivots
        if is_bullish_breakout:
            return candles[recent].low < candles[previous].low and rsi[recent] > rsi[previous]
        return candles[recent].high > candles[previous].high and rsi[recent] < rsi[previous]

    @staticmethod
    def has_volume_expansion(candles: list[Candle], current_index: int) -> bool:
        if current_index < 35:
            return False
        recent_vol = sum(c.volume for c in candles[current_index - 4 : current_index + 1])
        past_vol = sum(c.volume for c in candles[current_index - 34 : current_index - 4])
        return recent_vol > past_vol

    @staticmethod
    def is_pinbar(candle: Candle) -> bool:
        body = abs(candle.open - candle.close)
        upper_wick = candle.high - max(candle.open, candle.close)
        lower_wick = min(candle.open, candle.close) - candle.low
        return (lower_wick >= 2 * body and upper_wick <= 0.5 * body) or (
            upper_wick >= 2 * body and lower_wick <= 0.5 * body
        )

    @staticmethod
    def is_engulfing(prev: Candle, curr: Candle) -> bool:
        if prev.is_bullish == curr.is_bullish:
            return False
        prev_body = abs(prev.open - prev.close)
        curr_body = abs(curr.open - curr.close)
        return (
            curr_body > prev_body
            and max(curr.open, curr.close) >= max(prev.open, prev.close)
            and min(curr.open, curr.close) <= min(prev.open, prev.close)
        )

    @staticmethod
    def is_inside_bar(prev: Candle, curr: Candle) -> bool:
        return curr.high <= prev.high and curr.low >= prev.low


class SidewaysBoxDetector:
    PASS_THRESHOLD = 70

    def detect(self, candles: list[Candle], interval: str, rr_ratio: float) -> list[Box]:
        boxes: list[Box] = []
        rsi = Indicators.calculate_rsi(candles)
        i = 35
        while i < len(candles) - 4:
            high = candles[i].high
            low = candles[i].low
            b_index = -1
            direction: Optional[Direction] = None
            for j in range(i + 1, len(candles) - 3):
                if candles[j].close > high:
                    b_index, direction = j, "long"
                    break
                if candles[j].close < low:
                    b_index, direction = j, "short"
                    break
                high = max(high, candles[j].high)
                low = min(low, candles[j].low)

            if b_index == -1 or direction is None:
                i += 1
                continue
            if b_index - i < 1:
                i += 1
                continue
            if not self._validate_pre_break_reentry(candles, i, b_index, direction):
                i += 1
                continue
            archetype = self._determine_archetype(candles, i, b_index, b_index - i, interval, direction)
            if archetype == "unknown":
                i += 1
                continue
            score = self._calculate_score(candles, rsi, b_index, archetype, direction)
            if score.total < self.PASS_THRESHOLD:
                i += 1
                continue

            ep = (high + low) / 2
            if direction == "long":
                sl = low
                tp = ep + rr_ratio * (ep - sl)
            else:
                sl = high
                tp = ep - rr_ratio * (sl - ep)

            boxes.append(
                Box(
                    id=f"box_{candles[b_index].open_time}",
                    type="sideways_box",
                    archetype=archetype,
                    direction=direction,
                    start_index=i,
                    end_index=b_index - 1,
                    breakout_index=b_index,
                    created_index=b_index + 3,
                    created_at=candles[b_index + 3].open_time,
                    high=high,
                    low=low,
                    ep=ep,
                    sl=sl,
                    tp=tp,
                    score=score,
                    status="active",
                )
            )
            i = b_index + 1
        return boxes

    @staticmethod
    def _validate_pre_break_reentry(
        candles: list[Candle], start_idx: int, b_index: int, direction: Direction
    ) -> bool:
        ob_candle: Optional[Candle] = None
        for k in range(b_index - 1, start_idx - 1, -1):
            if candles[k].is_bullish != (direction == "long"):
                ob_candle = candles[k]
                break
        if ob_candle is None:
            return False
        for k in range(b_index + 1, b_index + 4):
            if k >= len(candles):
                return False
            if candles[k].low <= max(ob_candle.open, ob_candle.close) and candles[k].high >= min(
                ob_candle.open, ob_candle.close
            ):
                return False
        return True

    @staticmethod
    def _determine_archetype(
        candles: list[Candle], start_idx: int, b_idx: int, length: int, interval: str, direction: Direction
    ) -> Archetype:
        c1 = candles[b_idx - 2]
        c2 = candles[b_idx - 1]
        if length >= 10 and Indicators.has_volume_expansion(candles, b_idx - 1):
            has_reversal_sign = False
            for k in range(start_idx, b_idx):
                if Indicators.is_pinbar(candles[k]) or (
                    k > start_idx and Indicators.is_engulfing(candles[k - 1], candles[k])
                ):
                    has_reversal_sign = True
                    break
            if has_reversal_sign:
                return "turning_point_base"
        if length >= 10 and c1.is_bullish != c2.is_bullish and Indicators.is_engulfing(c1, c2):
            return "breakout_prep_box"
        if (
            (interval == "1h" and 10 <= length <= 40)
            or (interval == "4h" and 5 <= length <= 15)
            or (interval == "1d" and 1 <= length <= 3)
        ):
            return "continuation_box"
        return "unknown"

    @staticmethod
    def _calculate_score(
        candles: list[Candle], rsi: list[float], b_idx: int, arch: Archetype, direction: Direction
    ) -> ScoreBreakdown:
        s = ScoreBreakdown(total=60, structure=60)
        if arch == "continuation_box":
            s.continuation = 10
            s.total += 10
        if arch == "breakout_prep_box":
            s.breakout_prep = 15
            s.total += 15
        if arch == "turning_point_base":
            s.turning_point = 20
            s.total += 20
        if Indicators.is_inside_bar(candles[b_idx - 2], candles[b_idx - 1]):
            s.inside_bar_breakout = 5
            s.total += 5
        if Indicators.is_engulfing(candles[b_idx - 1], candles[b_idx]):
            s.engulfing_breakout = 8
            s.total += 8
        if Indicators.is_pinbar(candles[b_idx]):
            s.pinbar_reversal = 8
            s.total += 8
        if rsi[b_idx] <= 30 or rsi[b_idx] >= 70:
            s.rsi_extreme = 8
            s.total += 8
        if Indicators.has_regular_divergence(candles, rsi, b_idx, direction == "long"):
            s.regular_divergence = 12
            s.total += 12
        if Indicators.has_volume_expansion(candles, b_idx):
            s.volume_bonus = 10
            s.total += 10
        return s


class ChartEngine:
    def __init__(self) -> None:
        self._detector = SidewaysBoxDetector()

    def process(self, candles: list[Candle], interval: str, rr_ratio: float) -> list[Box]:
        return self._dedupe(self._detector.detect(candles, interval, rr_ratio))

    @staticmethod
    def _dedupe(boxes: list[Box]) -> list[Box]:
        filtered: list[Box] = []
        for box in boxes:
            overlap = next(
                (
                    f
                    for f in filtered
                    if f.direction == box.direction
                    and (
                        (box.start_index >= f.start_index and box.start_index <= f.end_index)
                        or (box.end_index >= f.start_index and box.end_index <= f.end_index)
                    )
                ),
                None,
            )
            if overlap is None:
                filtered.append(box)
            elif box.start_index < overlap.start_index or (
                box.start_index == overlap.start_index and box.score.total > overlap.score.total
            ):
                filtered[filtered.index(overlap)] = box
        return filtered
