"""과거 데이터 기반 백테스트 시뮬레이터.

chart-analyzer/src/App.tsx의 시계열 시뮬레이터(마진/레버리지 추적, 다중 포지션,
승률/MDD 계산)를 그대로 이식한 것입니다. bot_py/engine.py의 ChartEngine으로
타점을 탐지한 뒤, 캔들을 시간순으로 재생하며 진입/청산을 시뮬레이션합니다.

실행 예시 (저장소 루트에서):
    python -m bot_py.backtest --symbol BTCUSDT --interval 4h \
        --start 2026-01-01 --end 2026-07-01 --capital 10000 \
        --risk 1.0 --leverage 10 --max-positions 3 --rr 2.0
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone

from .engine import BinanceAPI, Box, Candle, ChartEngine


@dataclass
class EquityPoint:
    time: int
    pnl: float
    equity: float


@dataclass
class BacktestResult:
    boxes: list[Box]
    curve: list[EquityPoint]
    win_rate: float
    mdd: float
    wins: int
    total: int
    final_equity: float


@dataclass(frozen=True)
class CostModel:
    """체결 비용 모델. 모든 값은 명목 규모(position_size) 대비 %.

    진입/청산 각 구간의 수수료와 슬리피지를 따로 잡는다. 지정가(메이커) 진입은
    수수료가 싸고 EP에 정확히 체결되므로 진입 슬리피지가 0이지만, 손절은 지정가로
    낼 수 없어 시장가(테이커) + 슬리피지가 그대로 남는다.
    """

    entry_fee_pct: float = 0.0
    exit_fee_win_pct: float = 0.0
    exit_fee_loss_pct: float = 0.0
    entry_slippage_pct: float = 0.0
    exit_slippage_pct: float = 0.0

    @classmethod
    def taker(cls, fee_pct: float = 0.05, slippage_pct: float = 0.0) -> "CostModel":
        """현행: 진입/청산 모두 시장가."""
        return cls(fee_pct, fee_pct, fee_pct, slippage_pct, slippage_pct)

    @classmethod
    def maker_entry(
        cls, maker_pct: float = 0.02, taker_pct: float = 0.05, slippage_pct: float = 0.0
    ) -> "CostModel":
        """지정가 진입 + TP 지정가 청산 + SL 시장가 청산.

        SL은 스탑 주문이라 메이커가 될 수 없으므로 손절 시에만 테이커 수수료와
        슬리피지를 부담한다.
        """
        return cls(
            entry_fee_pct=maker_pct,
            exit_fee_win_pct=maker_pct,
            exit_fee_loss_pct=taker_pct,
            entry_slippage_pct=0.0,
            exit_slippage_pct=slippage_pct,
        )


def _interval_to_ms(interval: str) -> int:
    """'4h' 같은 주기 문자열을 밀리초로 바꾼다."""
    unit = interval[-1]
    value = int(interval[:-1])
    factor = {"m": 60, "h": 60 * 60, "d": 24 * 60 * 60, "w": 7 * 24 * 60 * 60}.get(unit, 15 * 60)
    return value * factor * 1000


def _apply_stop_filter(boxes: list[Box], min_stop_pct: float) -> tuple[list[Box], list[Box]]:
    """손절폭(|EP-SL|/EP)이 min_stop_pct 미만인 타점을 걸러낸다.

    좁은 박스는 노이즈에 손절당하기 쉬운 데다, 리스크 기반 사이징 특성상
    명목 규모가 커져 수수료가 리스크 대비 과도하게 붙는다.
    """
    if min_stop_pct <= 0:
        return list(boxes), []
    kept: list[Box] = []
    rejected: list[Box] = []
    for box in boxes:
        stop_pct = abs(box.ep - box.sl) / box.ep * 100
        if stop_pct < min_stop_pct:
            box.status = "canceled"
            box.skip_reason = "stop_too_tight"
            rejected.append(box)
        else:
            kept.append(box)
    return kept, rejected


def _resolve_pnl_and_roi(
    box: Box,
    is_win: bool,
    rr_ratio: float,
    costs: CostModel = CostModel(),
) -> float:
    """실현 손익 계산. 수수료/슬리피지는 명목 규모(position_size)에 비례해 차감한다."""
    pnl = (box.risk_amount * rr_ratio) if is_win else -box.risk_amount
    notional = box.position_size or 0.0
    exit_fee = costs.exit_fee_win_pct if is_win else costs.exit_fee_loss_pct
    pnl -= notional * (costs.entry_fee_pct + exit_fee) / 100
    pnl -= notional * (costs.entry_slippage_pct + costs.exit_slippage_pct) / 100
    if is_win:
        box.asset_roi_percent = (
            ((box.tp - box.ep) / box.ep) * 100
            if box.direction == "long"
            else ((box.ep - box.tp) / box.ep) * 100
        )
    else:
        box.asset_roi_percent = (
            ((box.sl - box.ep) / box.ep) * 100
            if box.direction == "long"
            else ((box.ep - box.sl) / box.ep) * 100
        )
    return pnl


def run_backtest(
    candles: list[Candle],
    interval: str,
    rr_ratio: float,
    initial_capital: float,
    risk_per_trade: float,
    leverage: float,
    max_positions: int,
    min_stop_pct: float = 0.0,
    max_pending_candles: int = 0,
    costs: CostModel = CostModel(),
    max_same_direction: int | None = None,
    intrabar: str = "loss",
) -> BacktestResult:
    interval_ms = _interval_to_ms(interval)
    engine = ChartEngine()
    detected_boxes = engine.process(candles, interval, rr_ratio)

    current_equity = initial_capital
    available_margin = initial_capital
    total_r = 0.0

    peak_equity = initial_capital
    max_drawdown = 0.0

    open_positions: list[Box] = []
    pending_boxes, rejected_boxes = _apply_stop_filter(detected_boxes, min_stop_pct)
    final_boxes: list[Box] = list(rejected_boxes)

    curve: list[EquityPoint] = []

    for c in candles:
        # 1. 오픈 포지션의 SL/TP 도달 여부 확인 후 청산
        for i in range(len(open_positions) - 1, -1, -1):
            pos = open_positions[i]
            is_resolved = False
            is_win = False

            if pos.direction == "long":
                if c.low <= pos.sl:
                    is_resolved, is_win = True, False
                elif c.high >= pos.tp:
                    is_resolved, is_win = True, True
            else:
                if c.high >= pos.sl:
                    is_resolved, is_win = True, False
                elif c.low <= pos.tp:
                    is_resolved, is_win = True, True

            if is_resolved:
                pnl = _resolve_pnl_and_roi(pos, is_win, rr_ratio, costs)
                current_equity += pnl
                available_margin += pos.margin_used + pnl
                total_r += rr_ratio if is_win else -1

                pos.status = "reacted" if is_win else "invalidated"
                pos.resolved_at = c.open_time
                pos.realized_pnl = pnl
                pos.realized_pnl_percent = (pnl / (current_equity - pnl)) * 100

                final_boxes.append(pos)
                open_positions.pop(i)

        # 2-0. 생성 후 오래 대기한 박스는 폐기한다. 백테스트상 20봉 이내에 진입한
        # 타점이 수익의 대부분을 만들고, 오래 묵은 타점은 승률/기대값이 모두 낮다.
        if max_pending_candles:
            for i in range(len(pending_boxes) - 1, -1, -1):
                box = pending_boxes[i]
                if c.open_time - box.created_at > max_pending_candles * interval_ms:
                    box.status = "canceled"
                    box.skip_reason = "expired"
                    box.resolved_at = c.open_time
                    final_boxes.append(box)
                    pending_boxes.pop(i)

        # 2. 대기 중인 박스 중 EP 도달 전 SL을 먼저 터치한 경우 취소
        for i in range(len(pending_boxes) - 1, -1, -1):
            box = pending_boxes[i]
            if c.open_time < box.created_at:
                continue

            # 롱은 sl < ep, 숏은 sl > ep 이므로 SL을 찍은 캔들은 반드시 EP도 찍은
            # 캔들이다. 즉 이 분기는 "EP와 SL이 한 캔들 안에서 모두 닿은" 경우이며,
            # 5초 폴링으로 EP 터치 즉시 시장가 진입하는 실봇에서는 진입 후 손절로
            # 끝난다. intrabar="loss"(기본)는 이를 패배로 계상하고,
            # "skip"은 거래 자체가 없었던 것으로 보는 기존(낙관적) 동작이다.
            if intrabar != "skip":
                continue

            hit_sl_before_entry = (box.direction == "long" and c.low <= box.sl) or (
                box.direction == "short" and c.high >= box.sl
            )
            if hit_sl_before_entry:
                box.status = "canceled"
                box.skip_reason = "sl_before_ep"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)

        # 3. 대기 중인 박스가 EP(진입가)에 도달하면 진입 처리
        for i in range(len(pending_boxes) - 1, -1, -1):
            box = pending_boxes[i]
            if c.open_time < box.created_at:
                continue

            is_hit_ep = (box.direction == "long" and c.low <= box.ep) or (
                box.direction == "short" and c.high >= box.ep
            )
            if not is_hit_ep:
                continue

            if len(open_positions) >= max_positions:
                box.status = "canceled"
                box.skip_reason = "max_positions"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)
                continue

            if max_same_direction is not None and (
                sum(1 for p in open_positions if p.direction == box.direction)
                >= max_same_direction
            ):
                box.status = "canceled"
                box.skip_reason = "same_direction_cap"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)
                continue

            risk_amount = current_equity * (risk_per_trade / 100)
            sl_percent = max(abs(box.ep - box.sl) / box.ep, 0.0001)
            ideal_pos_size = risk_amount / sl_percent
            ideal_margin = ideal_pos_size / leverage

            actual_margin = min(ideal_margin, available_margin)
            if actual_margin < 10:
                box.status = "canceled"
                box.skip_reason = "no_margin"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)
                continue

            actual_pos_size = actual_margin * leverage
            actual_risk = actual_pos_size * sl_percent

            box.is_entered = True
            box.entered_at = c.open_time
            box.position_size = actual_pos_size
            box.margin_used = actual_margin
            box.risk_amount = actual_risk

            available_margin -= actual_margin
            open_positions.append(box)
            pending_boxes.pop(i)

            # 같은 캔들 안에서 진입과 동시에 SL/TP에 도달하면 즉시 청산 처리
            is_resolved_now = False
            is_win_now = False
            if box.direction == "long":
                if c.low <= box.sl:
                    is_resolved_now, is_win_now = True, False
                elif c.high >= box.tp:
                    is_resolved_now, is_win_now = True, True
            else:
                if c.high >= box.sl:
                    is_resolved_now, is_win_now = True, False
                elif c.low <= box.tp:
                    is_resolved_now, is_win_now = True, True

            if is_resolved_now:
                pnl = _resolve_pnl_and_roi(box, is_win_now, rr_ratio, costs)
                current_equity += pnl
                available_margin += box.margin_used + pnl
                total_r += rr_ratio if is_win_now else -1

                box.status = "reacted" if is_win_now else "invalidated"
                box.resolved_at = c.open_time
                box.realized_pnl = pnl
                box.realized_pnl_percent = (pnl / (current_equity - pnl)) * 100

                final_boxes.append(box)
                open_positions.pop()  # 방금 추가한 포지션을 즉시 제거

        # MDD 트래킹
        if current_equity > peak_equity:
            peak_equity = current_equity
        drawdown = ((peak_equity - current_equity) / peak_equity) * 100
        if drawdown > max_drawdown:
            max_drawdown = drawdown

        curve.append(EquityPoint(time=c.open_time, pnl=total_r, equity=current_equity))

    all_processed_boxes = sorted(
        final_boxes + pending_boxes + open_positions, key=lambda b: b.start_index
    )
    closed_trades = [b for b in all_processed_boxes if b.status in ("reacted", "invalidated")]
    wins = sum(1 for b in closed_trades if b.status == "reacted")
    win_rate = (wins / len(closed_trades) * 100) if closed_trades else 0.0

    return BacktestResult(
        boxes=all_processed_boxes,
        curve=curve,
        win_rate=win_rate,
        mdd=max_drawdown,
        wins=wins,
        total=len(closed_trades),
        final_equity=current_equity,
    )


def run_multi_symbol_backtest(
    symbol_candles: dict[str, list[Candle]],
    interval: str,
    rr_ratio: float,
    initial_capital: float,
    risk_per_trade: float,
    leverage: float,
    max_positions: int,
    min_stop_pct: float = 0.0,
    max_pending_candles: int = 0,
    reserve_slots: bool = False,
    costs: CostModel = CostModel(),
    max_same_direction: int | None = None,
    intrabar: str = "loss",
) -> BacktestResult:
    """여러 심볼이 하나의 공유 자본/증거금 풀을 놓고 경쟁하는 백테스트.

    포지션이 하나도 없을 때는 먼저 신호(EP 터치)가 발생한 심볼이 우선 진입하고,
    이미 포지션이 있는 상태에서 다른 심볼의 신호가 뜨면 그 시점의 남은 가용
    증거금 한도 내에서 진입한다. max_positions도 심볼 구분 없이 전체 기준으로
    공유된다.
    """
    interval_ms = _interval_to_ms(interval)
    candles_by_time: dict[str, dict[int, Candle]] = {}
    pending_boxes: list[Box] = []

    for symbol, candles in symbol_candles.items():
        candles_by_time[symbol] = {c.open_time: c for c in candles}
        engine = ChartEngine()
        detected = engine.process(candles, interval, rr_ratio)
        for box in detected:
            box.symbol = symbol
            box.id = f"{symbol}:{box.id}"  # 심볼 간 id 충돌(같은 open_time) 방지
        pending_boxes.extend(detected)

    pending_boxes, rejected_boxes = _apply_stop_filter(pending_boxes, min_stop_pct)

    all_times = sorted(set().union(*(ct.keys() for ct in candles_by_time.values())))

    current_equity = initial_capital
    available_margin = initial_capital
    total_r = 0.0
    peak_equity = initial_capital
    max_drawdown = 0.0

    open_positions: list[Box] = []
    # reserve_slots=True면 실봇의 지정가 모드처럼, EP에 주문을 걸어둔 타점도
    # max_positions 슬롯을 차지한다 (거래소가 미체결 주문에도 증거금을 묶기 때문).
    armed_ids: set[str] = set()
    final_boxes: list[Box] = list(rejected_boxes)
    curve: list[EquityPoint] = []

    for t in all_times:
        for i in range(len(open_positions) - 1, -1, -1):
            pos = open_positions[i]
            c = candles_by_time[pos.symbol].get(t)
            if c is None:
                continue
            is_resolved = False
            is_win = False
            if pos.direction == "long":
                if c.low <= pos.sl:
                    is_resolved, is_win = True, False
                elif c.high >= pos.tp:
                    is_resolved, is_win = True, True
            else:
                if c.high >= pos.sl:
                    is_resolved, is_win = True, False
                elif c.low <= pos.tp:
                    is_resolved, is_win = True, True

            if is_resolved:
                pnl = _resolve_pnl_and_roi(pos, is_win, rr_ratio, costs)
                current_equity += pnl
                available_margin += pos.margin_used + pnl
                total_r += rr_ratio if is_win else -1
                pos.status = "reacted" if is_win else "invalidated"
                pos.resolved_at = c.open_time
                pos.realized_pnl = pnl
                pos.realized_pnl_percent = (pnl / (current_equity - pnl)) * 100
                final_boxes.append(pos)
                open_positions.pop(i)

        if max_pending_candles:
            for i in range(len(pending_boxes) - 1, -1, -1):
                box = pending_boxes[i]
                if t - box.created_at > max_pending_candles * interval_ms:
                    box.status = "canceled"
                    box.skip_reason = "expired"
                    box.resolved_at = t
                    armed_ids.discard(box.id)
                    final_boxes.append(box)
                    pending_boxes.pop(i)

        if reserve_slots:
            # 자리가 남는 만큼 EP에 주문을 걸어둔다. 실봇(_process_pending_boxes_maker)이
            # 대기 목록을 뒤에서부터 훑으므로 여기서도 신규 타점부터 주문을 건다.
            for box in reversed(pending_boxes):
                if len(open_positions) + len(armed_ids) >= max_positions:
                    break
                if box.id not in armed_ids and t >= box.created_at:
                    armed_ids.add(box.id)

        for i in range(len(pending_boxes) - 1, -1, -1):
            box = pending_boxes[i]
            c = candles_by_time[box.symbol].get(t)
            if c is None or t < box.created_at:
                continue
            # 롱은 sl < ep, 숏은 sl > ep 이므로 SL을 찍은 캔들은 반드시 EP도 찍은
            # 캔들이다. 즉 이 분기는 "EP와 SL이 한 캔들 안에서 모두 닿은" 경우이며,
            # 5초 폴링으로 EP 터치 즉시 시장가 진입하는 실봇에서는 진입 후 손절로
            # 끝난다. intrabar="loss"(기본)는 이를 패배로 계상하고,
            # "skip"은 거래 자체가 없었던 것으로 보는 기존(낙관적) 동작이다.
            if intrabar != "skip":
                continue

            hit_sl_before_entry = (box.direction == "long" and c.low <= box.sl) or (
                box.direction == "short" and c.high >= box.sl
            )
            if hit_sl_before_entry:
                box.status = "canceled"
                box.skip_reason = "sl_before_ep"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)

        for i in range(len(pending_boxes) - 1, -1, -1):
            box = pending_boxes[i]
            c = candles_by_time[box.symbol].get(t)
            if c is None or t < box.created_at:
                continue

            is_hit_ep = (box.direction == "long" and c.low <= box.ep) or (
                box.direction == "short" and c.high >= box.ep
            )
            if not is_hit_ep:
                continue

            if reserve_slots and box.id not in armed_ids:
                # 주문을 걸어두지 못한 타점은 EP가 와도 체결될 수 없다.
                box.status = "canceled"
                box.skip_reason = "no_resting_order"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)
                continue

            if len(open_positions) >= max_positions:
                box.status = "canceled"
                box.skip_reason = "max_positions"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)
                continue

            if max_same_direction is not None and (
                sum(1 for p in open_positions if p.direction == box.direction)
                >= max_same_direction
            ):
                box.status = "canceled"
                box.skip_reason = "same_direction_cap"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)
                continue

            risk_amount = current_equity * (risk_per_trade / 100)
            sl_percent = max(abs(box.ep - box.sl) / box.ep, 0.0001)
            ideal_pos_size = risk_amount / sl_percent
            ideal_margin = ideal_pos_size / leverage

            actual_margin = min(ideal_margin, available_margin)
            if actual_margin < 10:
                box.status = "canceled"
                box.skip_reason = "no_margin"
                box.resolved_at = c.open_time
                final_boxes.append(box)
                pending_boxes.pop(i)
                continue

            actual_pos_size = actual_margin * leverage
            actual_risk = actual_pos_size * sl_percent

            box.is_entered = True
            box.entered_at = c.open_time
            box.position_size = actual_pos_size
            box.margin_used = actual_margin
            box.risk_amount = actual_risk

            available_margin -= actual_margin
            armed_ids.discard(box.id)
            open_positions.append(box)
            pending_boxes.pop(i)

            is_resolved_now = False
            is_win_now = False
            if box.direction == "long":
                if c.low <= box.sl:
                    is_resolved_now, is_win_now = True, False
                elif c.high >= box.tp:
                    is_resolved_now, is_win_now = True, True
            else:
                if c.high >= box.sl:
                    is_resolved_now, is_win_now = True, False
                elif c.low <= box.tp:
                    is_resolved_now, is_win_now = True, True

            if is_resolved_now:
                pnl = _resolve_pnl_and_roi(box, is_win_now, rr_ratio, costs)
                current_equity += pnl
                available_margin += box.margin_used + pnl
                total_r += rr_ratio if is_win_now else -1
                box.status = "reacted" if is_win_now else "invalidated"
                box.resolved_at = c.open_time
                box.realized_pnl = pnl
                box.realized_pnl_percent = (pnl / (current_equity - pnl)) * 100
                final_boxes.append(box)
                open_positions.pop()

        if current_equity > peak_equity:
            peak_equity = current_equity
        drawdown = ((peak_equity - current_equity) / peak_equity) * 100
        if drawdown > max_drawdown:
            max_drawdown = drawdown

        curve.append(EquityPoint(time=t, pnl=total_r, equity=current_equity))

    all_processed_boxes = sorted(
        final_boxes + pending_boxes + open_positions,
        key=lambda b: (b.symbol or "", b.start_index),
    )
    closed_trades = [b for b in all_processed_boxes if b.status in ("reacted", "invalidated")]
    wins = sum(1 for b in closed_trades if b.status == "reacted")
    win_rate = (wins / len(closed_trades) * 100) if closed_trades else 0.0

    return BacktestResult(
        boxes=all_processed_boxes,
        curve=curve,
        win_rate=win_rate,
        mdd=max_drawdown,
        wins=wins,
        total=len(closed_trades),
        final_equity=current_equity,
    )


def _to_ms(date_str: str, end_of_day: bool = False) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    ms = int(dt.timestamp() * 1000)
    return ms + 86_399_999 if end_of_day else ms


def _parse_args() -> argparse.Namespace:
    from . import config

    parser = argparse.ArgumentParser(description="과거 데이터 기반 백테스트 실행")
    parser.add_argument(
        "--symbol",
        default=",".join(config.TRADING_OPTIONS.binance_symbols),
        help="쉼표로 구분해 여러 심볼 지정 시 공유 자본/증거금 풀로 통합 백테스트 (예: BTCUSDT,SOLUSDT)",
    )
    parser.add_argument("--interval", default=config.TRADING_OPTIONS.interval)
    parser.add_argument("--start", required=True, help="조회 시작일 YYYY-MM-DD")
    parser.add_argument(
        "--end",
        default=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        help="조회 종료일 YYYY-MM-DD (기본값: 오늘)",
    )
    parser.add_argument("--capital", type=float, default=config.TRADING_OPTIONS.capital)
    parser.add_argument(
        "--risk", type=float, default=config.TRADING_OPTIONS.risk_per_trade, help="1회 거래당 리스크 (%%)"
    )
    parser.add_argument("--leverage", type=float, default=config.TRADING_OPTIONS.leverage)
    parser.add_argument("--max-positions", type=int, default=config.TRADING_OPTIONS.max_positions)
    parser.add_argument("--rr", type=float, default=config.TRADING_OPTIONS.rr_ratio, help="손익비 (Risk-Reward)")
    parser.add_argument(
        "--min-stop-pct",
        type=float,
        default=0.0,
        help="최소 손절폭 필터(%%). 손절폭이 이 값보다 좁은 타점은 진입하지 않는다 (0=필터 없음)",
    )
    parser.add_argument(
        "--reserve-slots",
        choices=("on", "off"),
        default="on",
        help="on이면 EP에 걸어둔 지정가 주문도 max-positions 슬롯을 차지한다 "
        "(실봇의 지정가 모드와 동일). 멀티 심볼 모드에서만 적용된다",
    )
    parser.add_argument(
        "--max-pending-candles",
        type=int,
        default=0,
        help="타점 생성 후 이 봉수 안에 EP를 못 만나면 폐기한다 (0=만료 없음)",
    )
    parser.add_argument(
        "--entry-mode",
        choices=("taker", "maker"),
        default="taker",
        help="taker=현행 시장가 진입/청산, maker=지정가 진입 + TP 지정가 청산 (SL은 시장가 유지)",
    )
    parser.add_argument(
        "--fee-rate",
        type=float,
        default=0.0,
        help="테이커 편도 수수료율(%%). entry-mode=maker면 손절 청산에만 적용된다",
    )
    parser.add_argument(
        "--maker-fee-rate",
        type=float,
        default=0.02,
        help="메이커 편도 수수료율(%%). entry-mode=maker일 때 진입/TP청산에 적용",
    )
    parser.add_argument(
        "--slippage-pct",
        type=float,
        default=0.0,
        help="편도 슬리피지(%%). 진입/청산 각각 불리하게 체결된다고 가정한다",
    )
    parser.add_argument(
        "--intrabar",
        choices=("loss", "skip"),
        default="loss",
        help="한 캔들 안에서 EP와 SL이 모두 닿았을 때의 처리. loss=진입 후 손절로 계상(기본, 실봇 동작에 가까움), skip=거래 없음으로 처리(기존 낙관적 동작)",
    )
    parser.add_argument(
        "--max-same-direction",
        type=int,
        default=None,
        help="같은 방향(롱/숏)으로 동시에 보유할 최대 포지션 수. 상관 심볼 동시 진입을 막는다",
    )
    return parser.parse_args()


def _build_costs(args: argparse.Namespace) -> CostModel:
    if args.entry_mode == "maker":
        return CostModel.maker_entry(args.maker_fee_rate, args.fee_rate, args.slippage_pct)
    return CostModel.taker(args.fee_rate, args.slippage_pct)


def _print_result(result: BacktestResult, capital: float) -> None:
    net = result.final_equity - capital
    print("=========================")
    print(f"최종 자산: ${result.final_equity:,.2f} (시작: ${capital:,.2f}, 순손익 {net:+,.2f} / {net / capital * 100:+.2f}%)")
    print(f"승률: {result.win_rate:.2f}% ({result.wins}/{result.total})")
    print(f"MDD: {result.mdd:.2f}%")
    print(f"감지된 타점 수: {len(result.boxes)}개")
    skipped = Counter(b.skip_reason for b in result.boxes if b.skip_reason)
    if skipped:
        print("스킵 사유: " + ", ".join(f"{k} {v}건" for k, v in skipped.most_common()))
    print("=========================")


def main() -> None:
    args = _parse_args()
    symbols = [s.strip() for s in args.symbol.split(",") if s.strip()]

    start_ms = _to_ms(args.start)
    end_ms = _to_ms(args.end, end_of_day=True)

    symbol_candles: dict[str, list[Candle]] = {}
    for symbol in symbols:
        print(f"[백테스트] {symbol} {args.interval} | {args.start} ~ {args.end} 캔들 로딩 중...")
        candles, is_mock = BinanceAPI.fetch_klines(symbol, args.interval, start_ms, end_ms, 1000)
        if not candles:
            print(f"{symbol}: 캔들 데이터를 가져오지 못했습니다.")
            return
        if is_mock:
            print(f"{symbol}: 경고 - API 호출 실패로 빈 데이터가 반환되었습니다.")
            return
        print(f"{symbol}: 캔들 {len(candles)}개 로드 완료.")
        symbol_candles[symbol] = candles

    if len(symbols) == 1:
        print("백테스트 실행 중...")
        result = run_backtest(
            symbol_candles[symbols[0]],
            args.interval,
            args.rr,
            args.capital,
            args.risk,
            args.leverage,
            args.max_positions,
            min_stop_pct=args.min_stop_pct,
            max_pending_candles=args.max_pending_candles,
            costs=_build_costs(args),
            max_same_direction=args.max_same_direction,
            intrabar=args.intrabar,
        )
        _print_result(result, args.capital)
        return

    print(f"공유 자본/증거금 풀로 {len(symbols)}개 심볼 통합 백테스트 실행 중 (max_positions={args.max_positions}는 전체 공유)...")
    result = run_multi_symbol_backtest(
        symbol_candles,
        args.interval,
        args.rr,
        args.capital,
        args.risk,
        args.leverage,
        args.max_positions,
        min_stop_pct=args.min_stop_pct,
        max_pending_candles=args.max_pending_candles,
        reserve_slots=args.reserve_slots == "on",
        costs=_build_costs(args),
        max_same_direction=args.max_same_direction,
        intrabar=args.intrabar,
    )
    _print_result(result, args.capital)

    print("[심볼별 내역]")
    for symbol in symbols:
        symbol_boxes = [b for b in result.boxes if b.symbol == symbol]
        closed = [b for b in symbol_boxes if b.status in ("reacted", "invalidated")]
        wins = sum(1 for b in closed if b.status == "reacted")
        win_rate = (wins / len(closed) * 100) if closed else 0.0
        pnl = sum(b.realized_pnl or 0.0 for b in closed)
        print(
            f"  {symbol}: 거래 {wins}/{len(closed)} (승률 {win_rate:.2f}%), "
            f"순손익 {pnl:+,.2f}, 감지 타점 {len(symbol_boxes)}개"
        )
    print("=========================")


if __name__ == "__main__":
    import sys

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
