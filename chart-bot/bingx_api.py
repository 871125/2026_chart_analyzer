import json
import time
import hmac
import hashlib
import requests
from urllib.parse import urlencode

class BingXClient:
    def __init__(self, api_key: str, secret_key: str):
        self.api_key = api_key
        self.secret_key = secret_key
        self.base_url = "https://open-api.bingx.com"

    def _generate_signature(self, params: dict) -> str:
        query_string = urlencode(sorted(params.items()))
        return hmac.new(
            self.secret_key.encode('utf-8'),
            query_string.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()

    def _request(self, method: str, endpoint: str, params: dict = None, max_retries: int = 5):
        if params is None:
            params = {}
            
        for attempt in range(max_retries):
            try:
                params['timestamp'] = int(time.time() * 1000)
                params['signature'] = self._generate_signature(params)
                
                headers = {
                    'X-BX-APIKEY': self.api_key
                }
                
                url = f"{self.base_url}{endpoint}?{urlencode(params)}"
                response = requests.request(method, url, headers=headers, timeout=10)
                
                if response.status_code == 200:
                    return response.json()
                else:
                    raise Exception(f"BingX API Error [{response.status_code}]: {response.text}")
                    
            except Exception as e:
                if attempt == max_retries - 1:
                    print(f"❌ API 최대 재시도 횟수 초과: {e}")
                    raise e
                
                sleep_time = 2 ** attempt
                print(f"⚠️ API 호출 실패. {sleep_time}초 후 재시도... (Error: {e})")
                time.sleep(sleep_time)
                params.pop('signature', None)

    def get_contract_info(self, symbol: str) -> dict:
        res = self._request('GET', '/openApi/swap/v2/quote/contracts')
        for contract in res.get('data', []):
            if contract['symbol'] == symbol:
                return contract
        raise ValueError(f"심볼 {symbol}의 계약 정보를 찾을 수 없습니다.")

    def get_klines(self, symbol: str, interval: str, limit: int = 1000, start_time: int = None, end_time: int = None):
        params = {
            'symbol': symbol,
            'interval': interval,
            'limit': limit
        }
        if start_time: params['startTime'] = start_time
        if end_time: params['endTime'] = end_time
            
        res = self._request('GET', '/openApi/swap/v3/quote/klines', params)
        candles = []
        # BingX는 배열이 아닌 Dictionary 형태로 데이터를 반환하므로 Key 값으로 접근하도록 수정
        for row in res.get('data', []):
            candles.append({
                'open_time': int(row['time']),
                'open': float(row['open']),
                'close': float(row['close']),
                'high': float(row['high']),
                'low': float(row['low']),
                'volume': float(row['volume']),
                'is_bullish': float(row['close']) >= float(row['open'])
            })
        return candles

    def get_current_price(self, symbol: str) -> float:
        res = self._request('GET', '/openApi/swap/v2/quote/ticker', {'symbol': symbol})
        return float(res['data']['lastPrice'])

    def place_market_order(self, symbol: str, side: str, position_side: str, quantity: float, tp_price: float = None, sl_price: float = None):
        """시장가 주문 실행 (SL/TP 지정 추가)"""
        params = {
            'symbol': symbol,
            'side': side,
            'positionSide': position_side,
            'type': 'MARKET',
            'quantity': quantity
        }
        
        # BingX API 규격에 맞춰 JSON 문자열로 변환하여 첨부
        if tp_price:
            params['takeProfit'] = json.dumps({
                "type": "TAKE_PROFIT_MARKET",
                "stopPrice": float(tp_price),
                "workingType": "MARK_PRICE"
            })
        if sl_price:
            params['stopLoss'] = json.dumps({
                "type": "STOP_MARKET",
                "stopPrice": float(sl_price),
                "workingType": "MARK_PRICE"
            })
            
        return self._request('POST', '/openApi/swap/v2/trade/order', params)