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


def _resolve_pnl_and_roi(box: Box, is_win: bool, rr_ratio: float) -> float:
    pnl = (box.risk_amount * rr_ratio) if is_win else -box.risk_amount
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
) -> BacktestResult:
    engine = ChartEngine()
    detected_boxes = engine.process(candles, interval, rr_ratio)

    current_equity = initial_capital
    available_margin = initial_capital
    total_r = 0.0

    peak_equity = initial_capital
    max_drawdown = 0.0

    open_positions: list[Box] = []
    pending_boxes: list[Box] = list(detected_boxes)
    final_boxes: list[Box] = []

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
                pnl = _resolve_pnl_and_roi(pos, is_win, rr_ratio)
                current_equity += pnl
                available_margin += pos.margin_used + pnl
                total_r += rr_ratio if is_win else -1

                pos.status = "reacted" if is_win else "invalidated"
                pos.resolved_at = c.open_time
                pos.realized_pnl = pnl
                pos.realized_pnl_percent = (pnl / (current_equity - pnl)) * 100

                final_boxes.append(pos)
                open_positions.pop(i)

        # 2. 대기 중인 박스 중 EP 도달 전 SL을 먼저 터치한 경우 취소
        for i in range(len(pending_boxes) - 1, -1, -1):
            box = pending_boxes[i]
            if c.open_time < box.created_at:
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
                pnl = _resolve_pnl_and_roi(box, is_win_now, rr_ratio)
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


def _to_ms(date_str: str, end_of_day: bool = False) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    ms = int(dt.timestamp() * 1000)
    return ms + 86_399_999 if end_of_day else ms


def _parse_args() -> argparse.Namespace:
    from . import config

    parser = argparse.ArgumentParser(description="과거 데이터 기반 백테스트 실행")
    parser.add_argument("--symbol", default=config.TRADING_OPTIONS.binance_symbol)
    parser.add_argument("--interval", default=config.TRADING_OPTIONS.interval)
    parser.add_argument("--start", required=True, help="조회 시작일 YYYY-MM-DD")
    parser.add_argument(
        "--end",
        default=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        help="조회 종료일 YYYY-MM-DD (기본값: 오늘)",
    )
    parser.add_argument("--capital", type=float, default=config.TRADING_OPTIONS.capital)
    parser.add_argument(
        "--risk", type=float, default=config.TRADING_OPTIONS.risk_per_trade, help="1회 거래당 리스크 (%)"
    )
    parser.add_argument("--leverage", type=float, default=config.TRADING_OPTIONS.leverage)
    parser.add_argument("--max-positions", type=int, default=config.TRADING_OPTIONS.max_positions)
    parser.add_argument("--rr", type=float, default=config.TRADING_OPTIONS.rr_ratio, help="손익비 (Risk-Reward)")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()

    start_ms = _to_ms(args.start)
    end_ms = _to_ms(args.end, end_of_day=True)

    print(f"[백테스트] {args.symbol} {args.interval} | {args.start} ~ {args.end} 캔들 로딩 중...")
    candles, is_mock = BinanceAPI.fetch_klines(args.symbol, args.interval, start_ms, end_ms, 1000)

    if not candles:
        print("캔들 데이터를 가져오지 못했습니다.")
        return
    if is_mock:
        print("경고: API 호출 실패로 빈 데이터가 반환되었습니다.")
        return

    print(f"캔들 {len(candles)}개 로드 완료. 백테스트 실행 중...")
    result = run_backtest(
        candles,
        args.interval,
        args.rr,
        args.capital,
        args.risk,
        args.leverage,
        args.max_positions,
    )

    print("=========================")
    print(f"최종 자산: ${result.final_equity:,.2f} (시작: ${args.capital:,.2f})")
    print(f"승률: {result.win_rate:.2f}% ({result.wins}/{result.total})")
    print(f"MDD: {result.mdd:.2f}%")
    print(f"감지된 타점 수: {len(result.boxes)}개")
    print("=========================")


if __name__ == "__main__":
    import sys

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
