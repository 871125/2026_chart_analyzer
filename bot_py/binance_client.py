"""바이낸스 선물(Futures) API 클라이언트 (bot/binance.ts 이식)."""
from __future__ import annotations

import hashlib
import hmac
import sys
import time
import urllib.parse
from typing import Any, Optional

import requests

from . import config

BASE_URL = "https://fapi.binance.com"

_exchange_info_cache: Optional[dict] = None


def _signed_request(method: str, endpoint: str, params: Optional[dict[str, Any]] = None) -> Any:
    params = dict(params or {})
    params["timestamp"] = int(time.time() * 1000)

    query_string = urllib.parse.urlencode(params)
    signature = hmac.new(
        config.BINANCE_SECRET_KEY.encode(), query_string.encode(), hashlib.sha256
    ).hexdigest()

    url = f"{BASE_URL}{endpoint}?{query_string}&signature={signature}"
    headers = {
        "X-MBX-APIKEY": config.BINANCE_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    response = requests.request(method, url, headers=headers, timeout=15)
    response_data = response.json()

    if not response.ok:
        raise RuntimeError(
            f"Binance API 에러: 상태 {response.status_code} - "
            f"코드: {response_data.get('code')}, 메시지: {response_data.get('msg')}"
        )
    return response_data


def fetch_and_cache_exchange_info() -> None:
    global _exchange_info_cache
    try:
        response = requests.get(f"{BASE_URL}/fapi/v1/exchangeInfo", timeout=15)
        if not response.ok:
            raise RuntimeError(f"거래소 정보(exchangeInfo) 로드 실패: {response.status_code}")
        _exchange_info_cache = response.json()
        print("[거래소 정보] 가격/수량 정밀도 및 최소 주문금액 정보 로드 완료")
    except Exception as error:
        print(f"[거래소 정보] 거래소 정보를 가져오는 데 실패했습니다. 봇을 중지합니다. {error}")
        sys.exit(1)


def get_symbol_info(symbol: str) -> dict[str, float]:
    if _exchange_info_cache is None:
        raise RuntimeError(
            "거래소 정보가 캐시되지 않았습니다. fetch_and_cache_exchange_info()를 먼저 호출해야 합니다."
        )

    symbol_info = next((s for s in _exchange_info_cache["symbols"] if s["symbol"] == symbol), None)
    if symbol_info is None:
        raise RuntimeError(f"{symbol}에 대한 거래소 정보를 찾을 수 없습니다.")

    price_filter = next((f for f in symbol_info["filters"] if f["filterType"] == "PRICE_FILTER"), None)
    lot_size_filter = next((f for f in symbol_info["filters"] if f["filterType"] == "LOT_SIZE"), None)
    min_notional_filter = next(
        (f for f in symbol_info["filters"] if f["filterType"] == "MIN_NOTIONAL"), None
    )
    if not price_filter or not lot_size_filter or not min_notional_filter:
        raise RuntimeError(f"{symbol}에 대한 필수 필터(PRICE_FILTER, LOT_SIZE, MIN_NOTIONAL)를 찾을 수 없습니다.")

    def precision_from_step(step: str) -> int:
        frac = step.split(".")[1] if "." in step else ""
        return max(0, frac.find("1") + 1)

    return {
        "price_precision": precision_from_step(price_filter["tickSize"]),
        "quantity_precision": precision_from_step(lot_size_filter["stepSize"]),
        "min_notional": float(min_notional_filter["notional"]),
    }


def set_leverage(symbol: str, leverage: int) -> Optional[Any]:
    try:
        result = _signed_request("POST", "/fapi/v1/leverage", {"symbol": symbol, "leverage": leverage})
        print(f"[레버리지 설정] {symbol}에 대한 레버리지가 {leverage}x로 설정되었습니다.")
        return result
    except Exception as error:
        message = str(error)
        if "-4046" in message:
            print(f"[레버리지 설정] {symbol}의 레버리지가 이미 {leverage}x로 설정되어 있습니다.")
            return None
        print(f"[레버리지 설정 실패] {symbol}의 레버리지를 {leverage}x로 설정하는 중 오류 발생: {message}")
        raise


def place_entry_order(symbol: str, side: str, quantity: float) -> Any:
    position_side = "LONG" if side == "BUY" else "SHORT"
    info = get_symbol_info(symbol)
    qty_string = f"{quantity:.{info['quantity_precision']}f}"
    return _signed_request(
        "POST",
        "/fapi/v1/order",
        {
            "symbol": symbol,
            "side": side,
            "positionSide": position_side,
            "type": "MARKET",
            "quantity": qty_string,
        },
    )


def place_close_order(symbol: str, position_side: str, quantity: float) -> Any:
    side = "SELL" if position_side == "LONG" else "BUY"
    info = get_symbol_info(symbol)
    qty_string = f"{quantity:.{info['quantity_precision']}f}"
    return _signed_request(
        "POST",
        "/fapi/v1/order",
        {
            "symbol": symbol,
            "side": side,
            "positionSide": position_side,
            "type": "MARKET",
            "quantity": qty_string,
        },
    )


def get_active_positions_count() -> int:
    positions = _signed_request("GET", "/fapi/v2/positionRisk")
    if not isinstance(positions, list):
        print(f"Binance 포지션 정보가 배열이 아닙니다: {positions}")
        return 0
    return sum(1 for pos in positions if abs(float(pos.get("positionAmt", 0) or 0)) > 0)


def get_account_balance(asset: str = "USDT") -> float:
    try:
        balances = _signed_request("GET", "/fapi/v2/balance")
        if not isinstance(balances, list):
            raise RuntimeError("잔고 정보가 올바른 배열 형태가 아닙니다.")
        target = next((b for b in balances if b.get("asset") == asset), None)
        return float(target["balance"]) if target else 0.0
    except Exception as error:
        raise RuntimeError(f"계좌 잔고 조회 실패: {error}") from error
