"""자동 매매 봇 메인 루프 (bot/index.ts 이식).

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
from .engine import BinanceAPI, Box, ChartEngine, ScoreBreakdown
from .telegram_notifier import send_telegram_message

STATE_FILE = Path(__file__).resolve().parent / "state.json"

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

    try:
        binance_client.set_leverage(config.TRADING_OPTIONS.binance_symbol, config.TRADING_OPTIONS.leverage)
    except Exception:
        send_telegram_message(
            "[중요] 봇 부팅 중 레버리지 설정에 실패했습니다. 거래를 시작하기 전에 바이낸스 웹사이트에서 직접 설정을 확인해주세요."
        )

    boot_message = (
        "퀀트 자동 매매 봇 부팅 완료\n"
        f"- 거래 페어: {config.TRADING_OPTIONS.binance_symbol}\n"
        f"- 레버리지: {config.TRADING_OPTIONS.leverage}x\n"
        f"- 차트 주기: {config.TRADING_OPTIONS.interval}\n"
        f"- Check 간격: {config.CHECK_INTERVAL_SEC}초\n"
        "=========================\n"
        "[복구된 상태]\n"
        f" - 오픈 포지션: {len(open_positions)}개\n"
        f" - 대기 타점: {len(pending_boxes)}개\n"
    )

    if pending_boxes:
        boot_message += "\n[대기 타점 목록]\n"
        boot_message += "\n".join(f" - {b.direction.upper()} | EP: {b.ep:.2f}" for b in pending_boxes)
    elif open_positions:
        boot_message += "\n[오픈 포지션 목록]\n"
        boot_message += "\n".join(
            f" - {p.direction.upper()} | 진입가: {(p.entered_price or 0):.2f} | 수량: {p.quantity}"
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

        candles, is_mock = BinanceAPI.fetch_klines(
            config.TRADING_OPTIONS.binance_symbol,
            config.TRADING_OPTIONS.interval,
            start_time_for_fetch,
            None,
            1000 if should_calc_boxes else 2,
        )

        if not candles or is_mock:
            return

        current_candle = candles[-1]
        current_price = candles[-1].close

        if should_calc_boxes:
            engine = ChartEngine()
            detected_boxes = engine.process(
                candles, config.TRADING_OPTIONS.interval, config.TRADING_OPTIONS.rr_ratio
            )

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

            new_pending_boxes = [b for b in detected_boxes if _is_new(b)][-5:]

            alert_msg = "[주기 마감: 차트 분석 완료]\n"
            if new_pending_boxes:
                alert_msg += f"새로운 대기 타점(Pending) {len(new_pending_boxes)}개 감지\n=========================\n"
                for box in new_pending_boxes:
                    pending_boxes.append(box)
                    alert_msg += (
                        "[신규 타점 대기 중]\n"
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

        state_changed = _process_pending_boxes(current_candle, current_price) or state_changed
        state_changed = _process_open_positions(current_price) or state_changed

        if state_changed:
            save_state()
    except Exception as error:
        print(f"[에러] Market check error: {error}")


def _process_pending_boxes(current_candle, current_price: float) -> bool:
    global pending_boxes, active_positions, open_positions
    state_changed = False

    for i in range(len(pending_boxes) - 1, -1, -1):
        box = pending_boxes[i]

        hit_sl_before_entry = (box.direction == "long" and current_candle.low <= box.sl) or (
            box.direction == "short" and current_candle.high >= box.sl
        )
        if hit_sl_before_entry:
            send_telegram_message(f"[타점 취소] EP 도달 전 SL 먼저 터치됨. 대상 타점: {box.ep:.2f}")
            active_positions.append(box)
            if len(active_positions) > 50:
                active_positions.pop(0)
            pending_boxes.pop(i)
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
                f"[진입 스킵] Binance 거래소에 유지 중인 포지션이 최대치"
                f"({config.TRADING_OPTIONS.max_positions}개)입니다."
            )
            active_positions.append(box)
            if len(active_positions) > 50:
                active_positions.pop(0)
            pending_boxes.pop(i)
            state_changed = True
            continue

        side = "BUY" if box.direction == "long" else "SELL"
        symbol_info = binance_client.get_symbol_info(config.TRADING_OPTIONS.binance_symbol)
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

        # 다른 오픈 포지션이 이미 증거금을 쓰고 있으면, 남은 가용 증거금 한도 내로 포지션을 축소한다
        # (backtest.py의 시뮬레이션과 동일한 규칙: 최소 증거금 $10 미만이면 진입 스킵).
        actual_margin = min(ideal_margin, available_margin)
        if actual_margin < 10:
            send_telegram_message(
                f"[진입 스킵] 가용 증거금(${available_margin:.2f})이 부족합니다. "
                f"필요 증거금: ${ideal_margin:.2f}"
            )
            active_positions.append(box)
            if len(active_positions) > 50:
                active_positions.pop(0)
            pending_boxes.pop(i)
            state_changed = True
            continue

        actual_pos_size_usd = actual_margin * leverage

        if actual_pos_size_usd < symbol_info["min_notional"]:
            send_telegram_message(
                f"[진입 스킵] 계산된 포지션 규모(${actual_pos_size_usd:.2f})가 "
                f"바이낸스 최소 주문금액(${symbol_info['min_notional']})보다 작습니다."
            )
            active_positions.append(box)
            if len(active_positions) > 50:
                active_positions.pop(0)
            pending_boxes.pop(i)
            state_changed = True
            continue

        quantity = round(actual_pos_size_usd / current_price, symbol_info["quantity_precision"])
        box.margin_used = actual_margin
        box.position_size = actual_pos_size_usd
        box.risk_amount = actual_pos_size_usd * sl_percent

        try:
            order_result = binance_client.place_entry_order(
                config.TRADING_OPTIONS.binance_symbol, side, quantity
            )
            send_telegram_message(
                f"[주문 체결 성공] {side} 포지션 진입!\n"
                f"진입가격: {current_price}\n"
                f"설정된 TP: {box.tp:.2f} / SL: {box.sl:.2f}\n"
                f"주문수량: {quantity}\n"
                f"주문번호: {order_result.get('orderId', '확인불가')}"
            )
            box.is_entered = True
            box.entered_price = current_price
            box.quantity = quantity

            open_positions.append(box)
            active_positions.append(box)
            if len(active_positions) > 50:
                active_positions.pop(0)
            pending_boxes.pop(i)
            state_changed = True
        except Exception as e:
            send_telegram_message(
                f"[주문 실패] Binance API 오류: {e}\n(해당 타점은 무한 재시도를 막기 위해 폐기됩니다)"
            )
            print(f"[Binance 주문 에러 상세]: {e}")
            active_positions.append(box)
            if len(active_positions) > 50:
                active_positions.pop(0)
            pending_boxes.pop(i)
            state_changed = True

    return state_changed


def _process_open_positions(current_price: float) -> bool:
    global open_positions
    state_changed = False

    for i in range(len(open_positions) - 1, -1, -1):
        pos = open_positions[i]
        is_resolved = False
        resolution_type: Optional[str] = None

        if pos.direction == "long":
            if current_price <= pos.sl:
                is_resolved, resolution_type = True, "SL"
            elif current_price >= pos.tp:
                is_resolved, resolution_type = True, "TP"
        else:
            if current_price >= pos.sl:
                is_resolved, resolution_type = True, "SL"
            elif current_price <= pos.tp:
                is_resolved, resolution_type = True, "TP"

        if is_resolved and pos.quantity:
            try:
                position_side = "LONG" if pos.direction == "long" else "SHORT"
                binance_client.place_close_order(
                    config.TRADING_OPTIONS.binance_symbol, position_side, pos.quantity
                )
                send_telegram_message(
                    f"[{resolution_type} 청산] {pos.direction.upper()} 포지션 종료\n"
                    f"진입가: {(pos.entered_price or 0):.2f}\n"
                    f"청산가: {current_price:.2f}\n"
                    f"수량: {pos.quantity}"
                )
                open_positions.pop(i)
                state_changed = True
            except Exception as e:
                send_telegram_message(
                    f"[청산 주문 실패] {pos.direction.upper()} 포지션 청산 중 오류 발생. "
                    f"수동 확인이 필요합니다!\n오류: {e}"
                )
                print(f"[청산 주문 에러 상세]: {e}")

    return state_changed


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    run_bot()
