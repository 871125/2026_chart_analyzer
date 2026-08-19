"""자동 매매 봇 메인 루프 (bot/index.ts 이식, 멀티 심볼 공유 자본/증거금 풀 지원).

여러 심볼을 config.TRADING_OPTIONS.binance_symbols에 넣으면 하나의 공유
자본/증거금 풀 아래에서 함께 운용된다 (bot_py/backtest.py의
run_multi_symbol_backtest와 동일한 진입 규칙): 포지션이 없을 때는 먼저
신호(EP 터치)가 뜬 심볼이 우선 진입하고, 이미 포지션이 있는 상태에서 다른
심볼 신호가 뜨면 그 시점의 남은 가용 증거금으로 진입한다. max_positions도
심볼 구분 없이 전체 기준으로 공유된다.

실행: 저장소 루트에서 `python -m bot_py.main`
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import binance_client, config
from .engine import BinanceAPI, Box, Candle, ChartEngine, ScoreBreakdown
from .telegram_notifier import send_telegram_message

STATE_FILE = Path(__file__).resolve().parent / "state.json"

# 진입/청산 체결 방식. "maker"는 EP에 포스트온리 지정가 주문을 미리 걸어두고
# 익절도 TP 지정가로 처리한다(손절만 시장가). "taker"는 EP 터치 시 시장가 진입.
# config.TRADING_OPTIONS.entry_mode로 덮어쓸 수 있다.
ENTRY_MODE: str = getattr(config.TRADING_OPTIONS, "entry_mode", "maker")

pending_boxes: list[Box] = []
active_positions: list[Box] = []
open_positions: list[Box] = []
last_calculated_period: int = 0


def _box_from_dict(data: dict) -> Box:
    data = dict(data)
    data["score"] = ScoreBreakdown(**(data.get("score") or {}))
    return Box(**data)


def load_state() -> None:
    global pending_boxes, active_positions, open_positions, last_calculated_period
    try:
        if STATE_FILE.exists():
            parsed = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            pending_boxes = [_box_from_dict(b) for b in (parsed.get("pending_boxes") or [])][-5:]
            active_positions = [_box_from_dict(b) for b in (parsed.get("active_positions") or [])]
            open_positions = [_box_from_dict(b) for b in (parsed.get("open_positions") or [])]
            last_calculated_period = parsed.get("last_calculated_period", 0)
            print(
                f"[상태 복구 완료] 대기 타점: {len(pending_boxes)}개 / "
                f"오픈 포지션: {len(open_positions)}개 / 진입 이력(중복방지): {len(active_positions)}개"
            )
    except Exception as error:
        print(f"상태 파일 로드 실패. 빈 상태로 시작합니다. {error}")


def save_state() -> None:
    try:
        state = {
            "pending_boxes": [asdict(b) for b in pending_boxes],
            "active_positions": [asdict(b) for b in active_positions],
            "open_positions": [asdict(b) for b in open_positions],
            "last_calculated_period": last_calculated_period,
        }
        STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as error:
        print(f"상태 저장 중 오류 발생: {error}")


def _get_interval_seconds(interval: str) -> int:
    unit = interval[-1]
    value = int(interval[:-1])
    if unit == "m":
        return value * 60
    if unit == "h":
        return value * 60 * 60
    if unit == "d":
        return value * 24 * 60 * 60
    if unit == "w":
        return value * 7 * 24 * 60 * 60
    return 15 * 60


def run_bot() -> None:
    print("봇 시스템 부팅 완료, 초기화를 시작합니다...")
    load_state()

    binance_client.fetch_and_cache_exchange_info()

    for symbol in config.TRADING_OPTIONS.binance_symbols:
        try:
            binance_client.set_leverage(symbol, config.TRADING_OPTIONS.leverage)
        except Exception:
            send_telegram_message(
                f"[중요] 봇 부팅 중 {symbol} 레버리지 설정에 실패했습니다. "
                "거래를 시작하기 전에 바이낸스 웹사이트에서 직접 설정을 확인해주세요."
            )

    symbols_label = ", ".join(config.TRADING_OPTIONS.binance_symbols)
    boot_message = (
        "퀀트 자동 매매 봇 부팅 완료\n"
        f"- 거래 페어(공유 풀): {symbols_label}\n"
        f"- 레버리지: {config.TRADING_OPTIONS.leverage}x\n"
        f"- 진입 방식: {'지정가(메이커)' if ENTRY_MODE == 'maker' else '시장가(테이커)'}\n"
        f"- 차트 주기: {config.TRADING_OPTIONS.interval}\n"
        f"- Check 간격: {config.CHECK_INTERVAL_SEC}초\n"
        "=========================\n"
        "[복구된 상태]\n"
        f" - 오픈 포지션: {len(open_positions)}개\n"
        f" - 대기 타점: {len(pending_boxes)}개\n"
    )

    if pending_boxes:
        boot_message += "\n[대기 타점 목록]\n"
        boot_message += "\n".join(
            f" - [{b.symbol}] {b.direction.upper()} | EP: {b.ep:.2f}" for b in pending_boxes
        )
    elif open_positions:
        boot_message += "\n[오픈 포지션 목록]\n"
        boot_message += "\n".join(
            f" - [{p.symbol}] {p.direction.upper()} | 진입가: {(p.entered_price or 0):.2f} | 수량: {p.quantity}"
            for p in open_positions
        )
    else:
        boot_message += "- 대기 중인 타점이 없습니다."

    send_telegram_message(boot_message)

    check_market()
    while True:
        time.sleep(config.CHECK_INTERVAL_SEC)
        check_market()


def check_market() -> None:
    global pending_boxes, active_positions, open_positions, last_calculated_period
    state_changed = False

    try:
        now = time.time() * 1000
        interval_ms = _get_interval_seconds(config.TRADING_OPTIONS.interval) * 1000
        current_period = int(now // interval_ms)
        should_calc_boxes = current_period > last_calculated_period

        start_time_for_fetch: Optional[int] = None
        if should_calc_boxes and last_calculated_period == 0 and config.TRADING_OPTIONS.scan_start_date:
            scan_start = datetime.strptime(config.TRADING_OPTIONS.scan_start_date, "%Y-%m-%d")
            start_time_for_fetch = int(scan_start.replace(tzinfo=timezone.utc).timestamp() * 1000)

        latest_candles: dict[str, Candle] = {}
        latest_prices: dict[str, float] = {}
        new_pending_boxes: list[Box] = []

        for symbol in config.TRADING_OPTIONS.binance_symbols:
            candles, is_mock = BinanceAPI.fetch_klines(
                symbol,
                config.TRADING_OPTIONS.interval,
                start_time_for_fetch,
                None,
                1000 if should_calc_boxes else 2,
            )
            if not candles or is_mock:
                print(f"[{symbol}] 캔들 로드 실패, 이번 주기에는 건너뜁니다.")
                continue

            latest_candles[symbol] = candles[-1]
            latest_prices[symbol] = candles[-1].close

            if should_calc_boxes:
                engine = ChartEngine()
                detected_boxes = engine.process(
                    candles, config.TRADING_OPTIONS.interval, config.TRADING_OPTIONS.rr_ratio
                )
                for box in detected_boxes:
                    box.symbol = symbol
                    box.id = f"{symbol}:{box.id}"

                def _is_new(box: Box) -> bool:
                    is_pending = any(b.id == box.id for b in pending_boxes)
                    is_active = any(b.id == box.id for b in active_positions)
                    if is_pending or is_active or box.status != "active":
                        return False
                    if last_calculated_period > 0:
                        last_calc_time = last_calculated_period * interval_ms
                        if box.created_at < last_calc_time:
                            return False
                    return True

                new_pending_boxes.extend([b for b in detected_boxes if _is_new(b)][-5:])

        if not latest_candles:
            return

        if should_calc_boxes:
            alert_msg = "[주기 마감: 차트 분석 완료]\n"
            if new_pending_boxes:
                alert_msg += f"새로운 대기 타점(Pending) {len(new_pending_boxes)}개 감지\n=========================\n"
                for box in new_pending_boxes:
                    pending_boxes.append(box)
                    alert_msg += (
                        "[신규 타점 대기 중]\n"
                        f"- 심볼: {box.symbol}\n"
                        f"- 패턴: {box.archetype}\n"
                        f"- 방향: {box.direction.upper()}\n"
                        f"- 진입가(EP): {box.ep:.2f}\n"
                        f"- 손절가(SL): {box.sl:.2f}\n"
                        f"- 익절가(TP): {box.tp:.2f}\n"
                        "=========================\n"
                    )
            else:
                alert_msg += (
                    f"새로운 대기 타점이 없습니다.\n"
                    f"(현재 대기 중인 타점 유지: {len(pending_boxes)}개)\n=========================\n"
                )

            send_telegram_message(alert_msg)
            last_calculated_period = current_period
            state_changed = True

        state_changed = _process_pending_boxes(latest_candles, latest_prices) or state_changed
        state_changed = _process_open_positions(latest_prices) or state_changed

        if state_changed:
            save_state()
    except Exception as error:
        print(f"[에러] Market check error: {error}")


def _retire_box(box: Box, index: int) -> None:
    """대기 타점을 목록에서 빼고 중복 진입 방지 이력(active_positions)에 남긴다."""
    active_positions.append(box)
    if len(active_positions) > 50:
        active_positions.pop(0)
    pending_boxes.pop(index)


def _build_entry_plan(
    box: Box, reference_price: float
) -> tuple[Optional[dict[str, float]], Optional[str]]:
    """리스크 기반 포지션 규모를 계산한다. 진입 불가 시 (None, 사유)를 돌려준다.

    다른 심볼의 오픈 포지션이 이미 증거금을 쓰고 있으면 남은 가용 증거금 한도
    내로 포지션을 축소한다 (backtest.py의 run_multi_symbol_backtest와 동일한
    규칙: 최소 증거금 $10 미만이면 진입 스킵).
    """
    symbol_info = binance_client.get_symbol_info(box.symbol)
    leverage = config.TRADING_OPTIONS.leverage

    current_capital = config.TRADING_OPTIONS.capital
    try:
        current_capital = binance_client.get_account_balance("USDT")
    except Exception as balance_err:
        print(f"[잔고 조회 실패] 설정된 기본 CAPITAL(${current_capital})을 사용합니다: {balance_err}")

    available_margin = current_capital
    try:
        available_margin = binance_client.get_available_margin("USDT")
    except Exception as margin_err:
        print(f"[가용 증거금 조회 실패] 총 잔고(${available_margin})를 그대로 사용합니다: {margin_err}")

    risk_amount = current_capital * (config.TRADING_OPTIONS.risk_per_trade / 100)
    sl_percent = max(abs(box.ep - box.sl) / box.ep, 0.0001)
    ideal_pos_size_usd = risk_amount / sl_percent
    ideal_margin = ideal_pos_size_usd / leverage

    actual_margin = min(ideal_margin, available_margin)
    if actual_margin < 10:
        return None, (
            f"가용 증거금(${available_margin:.2f})이 부족합니다. 필요 증거금: ${ideal_margin:.2f}"
        )

    actual_pos_size_usd = actual_margin * leverage
    if actual_pos_size_usd < symbol_info["min_notional"]:
        return None, (
            f"계산된 포지션 규모(${actual_pos_size_usd:.2f})가 "
            f"바이낸스 최소 주문금액(${symbol_info['min_notional']})보다 작습니다."
        )

    quantity = round(actual_pos_size_usd / reference_price, symbol_info["quantity_precision"])
    if quantity <= 0:
        return None, "계산된 주문 수량이 0입니다."

    return (
        {
            "quantity": quantity,
            "margin": actual_margin,
            "notional": actual_pos_size_usd,
            "risk": actual_pos_size_usd * sl_percent,
        },
        None,
    )


def _reserved_slot_count() -> int:
    """EP에 지정가 주문을 걸어둔(=곧 포지션이 될) 대기 타점 수."""
    return sum(1 for b in pending_boxes if b.entry_order_id is not None)


def _place_tp_order(box: Box) -> None:
    """익절 지점에 포스트온리 지정가 청산 주문을 건다.

    실패해도 치명적이지 않다. tp_order_id가 None이면 _process_open_positions가
    기존과 동일하게 가격을 감시해 시장가로 청산한다.
    """
    position_side = "LONG" if box.direction == "long" else "SHORT"
    try:
        result = binance_client.place_limit_close_order(
            box.symbol, position_side, box.quantity or 0, box.tp
        )
        box.tp_order_id = result.get("orderId")
    except Exception as error:
        box.tp_order_id = None
        print(f"[TP 지정가 주문 실패] [{box.symbol}] {error} -> 가격 감시 후 시장가로 청산합니다.")


def _cancel_tp_order(box: Box) -> None:
    if box.tp_order_id is None:
        return
    try:
        binance_client.cancel_order(box.symbol, box.tp_order_id)
    except Exception as error:
        print(f"[TP 주문 취소 실패] [{box.symbol}] {error}")
    box.tp_order_id = None


def _process_pending_boxes(
    latest_candles: dict[str, Candle], latest_prices: dict[str, float]
) -> bool:
    if ENTRY_MODE == "maker":
        return _process_pending_boxes_maker(latest_candles, latest_prices)
    return _process_pending_boxes_taker(latest_candles, latest_prices)


def _process_pending_boxes_maker(
    latest_candles: dict[str, Candle], latest_prices: dict[str, float]
) -> bool:
    """EP에 포스트온리(GTX) 지정가 주문을 미리 걸어두고 체결을 기다린다.

    시장가 진입과 달리 EP에 정확히 체결되고 메이커 수수료만 낸다. 대신 가격이
    EP를 스치고 지나가면 체결되지 않을 수 있다 (백테스트 --entry-mode maker와
    같은 모델). 손절만은 지정가로 걸 수 없어 기존처럼 시장가로 처리한다.
    """
    global pending_boxes, active_positions, open_positions
    state_changed = False

    for i in range(len(pending_boxes) - 1, -1, -1):
        box = pending_boxes[i]
        current_candle = latest_candles.get(box.symbol)
        current_price = latest_prices.get(box.symbol)
        if current_candle is None or current_price is None:
            continue  # 이번 주기엔 해당 심볼 캔들을 못 받아옴 -> 다음 주기에 재시도

        hit_sl_before_entry = (box.direction == "long" and current_candle.low <= box.sl) or (
            box.direction == "short" and current_candle.high >= box.sl
        )

        # 1. 이미 EP에 주문을 걸어둔 타점 -> 체결 여부 확인
        if box.entry_order_id is not None:
            try:
                order = binance_client.get_order(box.symbol, box.entry_order_id)
            except Exception as api_err:
                print(f"[주문 조회 실패] [{box.symbol}] {api_err}")
                continue

            status = str(order.get("status"))
            filled_qty = float(order.get("executedQty") or 0)

            if status == "FILLED":
                avg_price = float(order.get("avgPrice") or box.ep)
                box.is_entered = True
                box.entered_at = int(time.time() * 1000)
                box.entered_price = avg_price
                box.quantity = filled_qty
                box.entry_order_id = None
                open_positions.append(box)
                _retire_box(box, i)
                _place_tp_order(box)
                send_telegram_message(
                    f"[지정가 체결] [{box.symbol}] {box.direction.upper()} 포지션 진입!\n"
                    f"진입가격: {avg_price:.2f} (EP: {box.ep:.2f})\n"
                    f"설정된 TP: {box.tp:.2f} / SL: {box.sl:.2f}\n"
                    f"주문수량: {filled_qty}\n"
                    f"TP 지정가 주문: {'접수됨' if box.tp_order_id else '실패(가격 감시로 대체)'}"
                )
                state_changed = True
                continue

            if hit_sl_before_entry:
                # 체결을 기다리는 사이 SL이 깨졌다 -> 주문 취소. 일부만 체결됐다면
                # 그 물량은 시장가로 즉시 정리한다.
                try:
                    binance_client.cancel_order(box.symbol, box.entry_order_id)
                except Exception as cancel_err:
                    print(f"[진입 주문 취소 실패] [{box.symbol}] {cancel_err}")
                box.entry_order_id = None

                if filled_qty > 0:
                    position_side = "LONG" if box.direction == "long" else "SHORT"
                    try:
                        binance_client.place_close_order(box.symbol, position_side, filled_qty)
                        send_telegram_message(
                            f"[타점 취소] [{box.symbol}] 체결 대기 중 SL 도달. "
                            f"부분 체결분 {filled_qty}을 시장가로 정리했습니다."
                        )
                    except Exception as close_err:
                        send_telegram_message(
                            f"[긴급] [{box.symbol}] 부분 체결분 {filled_qty} 정리 실패. "
                            f"수동 확인이 필요합니다!\n오류: {close_err}"
                        )
                else:
                    send_telegram_message(
                        f"[타점 취소] [{box.symbol}] 체결 전 SL 먼저 터치됨. 대상 EP: {box.ep:.2f}"
                    )

                _retire_box(box, i)
                state_changed = True
                continue

            if status in ("CANCELED", "EXPIRED", "REJECTED"):
                # GTX는 즉시 체결될 가격이면 거부된다 -> 주문 정보만 비우고 다음 주기 재시도
                box.entry_order_id = None
                state_changed = True

            continue  # NEW / PARTIALLY_FILLED는 계속 대기

        # 2. 아직 주문이 없는 타점
        if hit_sl_before_entry:
            send_telegram_message(
                f"[타점 취소] [{box.symbol}] 주문 접수 전 SL 먼저 터치됨. 대상 EP: {box.ep:.2f}"
            )
            _retire_box(box, i)
            state_changed = True
            continue

        try:
            position_count = binance_client.get_active_positions_count()
        except Exception as api_err:
            print(f"[Binance 포지션 개수 조회 실패]: {api_err}")
            continue

        # 지정가 주문은 EP 도달 전에 미리 걸어두므로, 걸어둔 주문도 자리를 차지한 것으로 센다.
        if position_count + _reserved_slot_count() >= config.TRADING_OPTIONS.max_positions:
            # 시장가 모드와 달리 타점을 폐기하지 않는다. 자리가 나면 다음 주기에 주문을 건다.
            print(f"[주문 보류] [{box.symbol}] 포지션/대기주문이 최대치입니다.")
            continue

        plan, skip_reason = _build_entry_plan(box, box.ep)
        if plan is None:
            print(f"[주문 보류] [{box.symbol}] {skip_reason}")
            continue

        side = "BUY" if box.direction == "long" else "SELL"
        try:
            order_result = binance_client.place_limit_entry_order(
                box.symbol, side, plan["quantity"], box.ep
            )
        except Exception as e:
            message = str(e)
            # -5022: 즉시 체결될 가격이라 GTX 주문이 거부됨 (현재가가 EP를 이미 지나침)
            if "-5022" in message or "-2010" in message:
                print(f"[주문 보류] [{box.symbol}] 현재가가 EP를 지나 메이커 주문이 거부됨. 다음 주기 재시도")
                continue
            send_telegram_message(
                f"[주문 실패] [{box.symbol}] Binance API 오류: {e}\n(해당 타점은 무한 재시도를 막기 위해 폐기됩니다)"
            )
            print(f"[Binance 주문 에러 상세]: {e}")
            _retire_box(box, i)
            state_changed = True
            continue

        box.entry_order_id = order_result.get("orderId")
        box.quantity = plan["quantity"]
        box.margin_used = plan["margin"]
        box.position_size = plan["notional"]
        box.risk_amount = plan["risk"]
        send_telegram_message(
            f"[지정가 주문 접수] [{box.symbol}] {box.direction.upper()}\n"
            f"EP(지정가): {box.ep:.2f} / TP: {box.tp:.2f} / SL: {box.sl:.2f}\n"
            f"주문수량: {plan['quantity']}\n"
            f"주문번호: {box.entry_order_id}"
        )
        state_changed = True

    return state_changed


def _process_pending_boxes_taker(
    latest_candles: dict[str, Candle], latest_prices: dict[str, float]
) -> bool:
    """기존 방식: EP 터치를 감지하면 시장가로 즉시 진입한다."""
    global pending_boxes, active_positions, open_positions
    state_changed = False

    for i in range(len(pending_boxes) - 1, -1, -1):
        box = pending_boxes[i]
        current_candle = latest_candles.get(box.symbol)
        current_price = latest_prices.get(box.symbol)
        if current_candle is None or current_price is None:
            continue  # 이번 주기엔 해당 심볼 캔들을 못 받아옴 -> 다음 주기에 재시도

        hit_sl_before_entry = (box.direction == "long" and current_candle.low <= box.sl) or (
            box.direction == "short" and current_candle.high >= box.sl
        )
        if hit_sl_before_entry:
            send_telegram_message(
                f"[타점 취소] [{box.symbol}] EP 도달 전 SL 먼저 터치됨. 대상 타점: {box.ep:.2f}"
            )
            _retire_box(box, i)
            state_changed = True
            continue

        should_enter = (box.direction == "long" and current_candle.low <= box.ep) or (
            box.direction == "short" and current_candle.high >= box.ep
        )
        if not should_enter:
            continue

        try:
            current_position_count = binance_client.get_active_positions_count()
        except Exception as api_err:
            print(f"[Binance 포지션 개수 조회 실패]: {api_err}")
            continue

        if current_position_count >= config.TRADING_OPTIONS.max_positions:
            send_telegram_message(
                f"[진입 스킵] [{box.symbol}] Binance 거래소에 유지 중인 포지션이 최대치"
                f"({config.TRADING_OPTIONS.max_positions}개)입니다."
            )
            _retire_box(box, i)
            state_changed = True
            continue

        plan, skip_reason = _build_entry_plan(box, current_price)
        if plan is None:
            send_telegram_message(f"[진입 스킵] [{box.symbol}] {skip_reason}")
            _retire_box(box, i)
            state_changed = True
            continue

        quantity = plan["quantity"]
        box.margin_used = plan["margin"]
        box.position_size = plan["notional"]
        box.risk_amount = plan["risk"]

        side = "BUY" if box.direction == "long" else "SELL"
        try:
            order_result = binance_client.place_entry_order(box.symbol, side, quantity)
            send_telegram_message(
                f"[주문 체결 성공] [{box.symbol}] {side} 포지션 진입!\n"
                f"진입가격: {current_price}\n"
                f"설정된 TP: {box.tp:.2f} / SL: {box.sl:.2f}\n"
                f"주문수량: {quantity}\n"
                f"주문번호: {order_result.get('orderId', '확인불가')}"
            )
            box.is_entered = True
            box.entered_at = int(time.time() * 1000)
            box.entered_price = current_price
            box.quantity = quantity

            open_positions.append(box)
            _retire_box(box, i)
            state_changed = True
        except Exception as e:
            send_telegram_message(
                f"[주문 실패] [{box.symbol}] Binance API 오류: {e}\n(해당 타점은 무한 재시도를 막기 위해 폐기됩니다)"
            )
            print(f"[Binance 주문 에러 상세]: {e}")
            _retire_box(box, i)
            state_changed = True

    return state_changed


def _process_open_positions(latest_prices: dict[str, float]) -> bool:
    global open_positions
    state_changed = False

    for i in range(len(open_positions) - 1, -1, -1):
        pos = open_positions[i]
        current_price = latest_prices.get(pos.symbol)
        if current_price is None:
            continue  # 이번 주기엔 해당 심볼 캔들을 못 받아옴 -> 다음 주기에 재시도

        # 1. TP를 지정가로 걸어둔 포지션은 그 주문의 체결 여부부터 확인한다.
        if pos.tp_order_id is not None:
            try:
                order = binance_client.get_order(pos.symbol, pos.tp_order_id)
            except Exception as api_err:
                print(f"[TP 주문 조회 실패] [{pos.symbol}] {api_err}")
            else:
                status = str(order.get("status"))
                if status == "FILLED":
                    send_telegram_message(
                        f"[TP 청산] [{pos.symbol}] {pos.direction.upper()} 포지션 종료 (지정가)\n"
                        f"진입가: {(pos.entered_price or 0):.2f}\n"
                        f"청산가: {float(order.get('avgPrice') or pos.tp):.2f}\n"
                        f"수량: {pos.quantity}"
                    )
                    pos.tp_order_id = None
                    open_positions.pop(i)
                    state_changed = True
                    continue
                if status in ("CANCELED", "EXPIRED", "REJECTED"):
                    # 주문이 사라졌으면 아래 가격 감시 로직이 시장가로 대신 처리한다.
                    pos.tp_order_id = None
                    state_changed = True

        # 2. 손절은 지정가로 걸 수 없으므로 가격을 감시해 시장가로 청산한다.
        #    TP 지정가 주문이 살아 있으면 익절은 그쪽에 맡기고 SL만 확인한다.
        is_resolved = False
        resolution_type: Optional[str] = None
        tp_is_resting = pos.tp_order_id is not None

        if pos.direction == "long":
            if current_price <= pos.sl:
                is_resolved, resolution_type = True, "SL"
            elif not tp_is_resting and current_price >= pos.tp:
                is_resolved, resolution_type = True, "TP"
        else:
            if current_price >= pos.sl:
                is_resolved, resolution_type = True, "SL"
            elif not tp_is_resting and current_price <= pos.tp:
                is_resolved, resolution_type = True, "TP"

        if is_resolved and pos.quantity:
            try:
                position_side = "LONG" if pos.direction == "long" else "SHORT"
                # 남아 있는 TP 지정가 주문을 먼저 취소해야 중복 청산이 나지 않는다.
                _cancel_tp_order(pos)
                binance_client.place_close_order(pos.symbol, position_side, pos.quantity)
                send_telegram_message(
                    f"[{resolution_type} 청산] [{pos.symbol}] {pos.direction.upper()} 포지션 종료 (시장가)\n"
                    f"진입가: {(pos.entered_price or 0):.2f}\n"
                    f"청산가: {current_price:.2f}\n"
                    f"수량: {pos.quantity}"
                )
                open_positions.pop(i)
                state_changed = True
            except Exception as e:
                send_telegram_message(
                    f"[청산 주문 실패] [{pos.symbol}] {pos.direction.upper()} 포지션 청산 중 오류 발생. "
                    f"수동 확인이 필요합니다!\n오류: {e}"
                )
                print(f"[청산 주문 에러 상세]: {e}")

    return state_changed


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    run_bot()
