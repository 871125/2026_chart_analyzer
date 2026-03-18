import os
import json
import math
import time
import datetime
import requests
from bingx_api import BingXClient
from strategy import SidewaysBoxDetector

# ==========================================
# 환경 설정 및 초기화
# ==========================================
# 현재 파이썬 스크립트 파일이 위치한 폴더의 절대 경로를 가져옵니다. (Windows/Linux 모두 완벽 호환)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG_FILE = os.path.join(BASE_DIR, 'config.json')
STATE_FILE = os.path.join(BASE_DIR, 'bot_state.json')

# Windows 환경 호환성을 위해 encoding='utf-8'을 명시합니다.
with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
    config = json.load(f)

api_config = config['api']
trade_config = config['trading']
slack_config = config['slack']

bingx = BingXClient(api_config['bingx_api_key'], api_config['bingx_secret_key'])
detector = SidewaysBoxDetector()

# ==========================================
# Slack 알림 클래스
# ==========================================
class SlackNotifier:
    def __init__(self, token: str, channel: str):
        self.token = token
        self.channel = channel

    def send_message(self, msg: str):
        current_time = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        formatted_msg = f"[{current_time}]\n{msg}"
        print(f"[Slack] {formatted_msg}")
        
        try:
            response = requests.post(
                "https://slack.com/api/chat.postMessage",
                headers={"Authorization": "Bearer " + self.token},
                data={
                    "channel": self.channel,
                    "text": f"🤖 *BingX Live Bot*\n{formatted_msg}"
                }
            )
            response_data = response.json()
            if not response_data.get("ok"):
                print(f"Slack API 에러: {response_data.get('error')}")
        except Exception as e:
            print(f"Slack 전송 실패: {e}")

slack = SlackNotifier(slack_config['token'], slack_config['channel'])

# ==========================================
# 봇 상태 영구 저장 (Persistence) 로직
# ==========================================
def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r') as f:
            state = json.load(f)
            state['known_boxes'] = set(state.get('known_boxes', []))
            return state
    return {
        'active_positions': [], 
        'known_boxes': set(),
        'available_margin': trade_config['initial_capital']
    }

def save_state(state: dict):
    state_copy = state.copy()
    state_copy['known_boxes'] = list(state_copy['known_boxes'])
    with open(STATE_FILE, 'w') as f:
        json.dump(state_copy, f, indent=2)

bot_state = load_state()
save_state(bot_state)

# ==========================================
# 데이터 정밀도 유틸리티 (에러 방지)
# ==========================================
def truncate_quantity(qty: float, step_size: float) -> float:
    """수량을 거래소 최소 단위에 맞춰 버림(Floor) 처리"""
    if step_size >= 1:
        precision = 0
    else:
        precision = max(0, int(round(-math.log10(step_size))))
    truncated = math.floor(qty / step_size) * step_size
    return round(truncated, precision)

def format_price(price: float) -> float:
    """가격을 안전한 소수점 단위로 반올림하여 Invalid Price 에러 방지"""
    return round(price, 4)

# 부팅 시 심볼 규격 캐싱
try:
    contract_info = bingx.get_contract_info(trade_config['symbol'])
    trade_step_size = float(contract_info.get('tradeMinQuantity', 0.0001))
    print(f"✅ 심볼 정보 로드 완료: {trade_config['symbol']} (최소 주문 단위: {trade_step_size})")
except Exception as e:
    print(f"❌ 계약 정보 로드 실패. 기본값 0.0001 사용. ({e})")
    trade_step_size = 0.0001

# ==========================================
# 캔들 과거 데이터 조회 유틸리티 (Pagination)
# ==========================================
def fetch_all_candles_since(symbol: str, interval: str, start_date_str: str) -> list:
    """config에 명시된 start_date부터 현재까지의 모든 캔들을 가져옵니다."""
    start_date_dt = datetime.datetime.strptime(start_date_str, "%Y-%m-%d")
    start_time_ms = int(start_date_dt.timestamp() * 1000)
    current_time_ms = int(time.time() * 1000)
    
    all_candles = []
    limit = 1000
    
    while start_time_ms < current_time_ms:
        try:
            candles = bingx.get_klines(symbol, interval, limit=limit, start_time=start_time_ms)
            if not candles:
                break
            
            all_candles.extend(candles)
            # 다음 API 호출을 위해 마지막 캔들의 오픈 시간 + 1ms로 갱신
            start_time_ms = candles[-1]['open_time'] + 1
            
            # 가져온 캔들 수가 limit보다 작으면 최신 데이터까지 모두 가져온 것
            if len(candles) < limit:
                break
        except Exception as e:
            print(f"⚠️ 캔들 데이터 로드 중 오류 발생: {e}")
            time.sleep(1)
            
    # 캔들 중복 제거 및 시간순 정렬 보장
    unique_candles = {c['open_time']: c for c in all_candles}
    return [unique_candles[k] for k in sorted(unique_candles.keys())]

# ==========================================
# 메인 트레이딩 루프 로직
# ==========================================
def run_bot():
    print(f"--- 매매 로직 틱 실행 중 (잔여 증거금: ${bot_state['available_margin']:.2f}) ---")
    
    # 1. 설정된 타임프레임 데이터 조회 (config의 start_date 기준 전체 스캔)
    interval_str = trade_config['box_timeframe']
    candles_data = fetch_all_candles_since(trade_config['symbol'], interval_str, trade_config['start_date'])
    current_time_ms = int(time.time() * 1000)
    
    # 미확정 캔들 배제 (리페인팅 방지 로직 동적 적용)
    interval_ms = 4 * 60 * 60 * 1000 # default fallback
    if interval_str.endswith('h'): interval_ms = int(interval_str[:-1]) * 60 * 60 * 1000
    elif interval_str.endswith('d'): interval_ms = int(interval_str[:-1]) * 24 * 60 * 60 * 1000
    elif interval_str.endswith('m'): interval_ms = int(interval_str[:-1]) * 60 * 1000
        
    if candles_data[-1]['open_time'] + interval_ms > current_time_ms:
        candles_data = candles_data[:-1] 

    all_boxes = detector.detect(candles_data, interval_str, trade_config['rr_ratio'])
    expiration_days = trade_config.get('pending_box_expiration_days', 3)
    limit_time = current_time_ms - (86400 * 1000 * expiration_days)

    pending_boxes = []
    
    # 생성 이후 ~ 직전 캔들까지의 흐름을 스캔하여 이미 타점을 스치고 간 박스 필터링 (뒷북 진입 방지)
    historical_candles = candles_data[:-1] if len(candles_data) > 0 else []
    
    for box in all_boxes:
        if box['created_at'] < limit_time:
            continue
            
        subsequent_candles = [c for c in historical_candles if c['open_time'] >= box['created_at']]
        
        is_already_reacted = False
        for c in subsequent_candles:
            # SL 또는 EP 터치 확인 (이미 과거에 기회가 지나갔거나 무효화된 박스)
            if box['direction'] == 'long':
                if c['low'] <= box['sl'] or c['low'] <= box['ep']:
                    is_already_reacted = True
                    break
            elif box['direction'] == 'short':
                if c['high'] >= box['sl'] or c['high'] >= box['ep']:
                    is_already_reacted = True
                    break
                
        if not is_already_reacted:
            pending_boxes.append(box)

    # 프론트엔드 차트 시각화를 위해 상태 객체에 pending_boxes 주입 및 강제 저장 플래그 활성화
    bot_state['pending_boxes'] = pending_boxes
    state_changed = True

    # 2. 최근 1분봉 데이터 스캔 (스파이크/꼬리 감지용)
    # 봇이 쉬는 5분 동안 가격이 TP/SL을 치고 왔는지 확인하기 위해 최근 10분간의 High/Low를 수집합니다.
    recent_1m_candles = bingx.get_klines(trade_config['symbol'], "1m", limit=10)
    highest_price_recent = max(c['high'] for c in recent_1m_candles)
    lowest_price_recent = min(c['low'] for c in recent_1m_candles)
    
    # 진입(Market Order)은 무조건 '현재 순간'의 가격으로 판단해야 슬리피지를 막을 수 있습니다.
    current_price = bingx.get_current_price(trade_config['symbol'])
    
    state_changed = False
    
    # ------------------------------------------
    # 3. 진입 대기 타점(Pending) 검사 로직
    # ------------------------------------------
    for box in pending_boxes:
        if box['id'] in [p['id'] for p in bot_state['active_positions']]: continue 
            
        if box['id'] not in bot_state['known_boxes']:
            bot_state['known_boxes'].add(box['id'])
            state_changed = True
            slack.send_message(f"🔎 새로운 타점 포착!\n방향: {box['direction'].upper()}\nEP: {box['ep']:.2f} | SL: {box['sl']:.2f} | TP: {box['tp']:.2f}")

        # 붕괴 검사: EP 도달 전, 이미 꼬리로 SL을 뚫고 내려간 최악의 타점은 무효화 (보수적 접근)
        is_hit_sl_before = False
        if box['direction'] == 'long' and lowest_price_recent <= box['sl']: is_hit_sl_before = True
        if box['direction'] == 'short' and highest_price_recent >= box['sl']: is_hit_sl_before = True
        if is_hit_sl_before: continue

        # 진입 검사: 현재 가격이 EP를 돌파/터치 했는가?
        is_hit_ep = False
        if box['direction'] == 'long' and current_price <= box['ep']: is_hit_ep = True
        elif box['direction'] == 'short' and current_price >= box['ep']: is_hit_ep = True
        
        if is_hit_ep:
            if len(bot_state['active_positions']) >= trade_config['max_positions']: continue
            
            # 리스크 기반 진입 수량 및 필요 증거금 계산
            risk_amount = bot_state['available_margin'] * (trade_config['risk_per_trade_pct'] / 100)
            sl_percent = max(abs(box['ep'] - box['sl']) / box['ep'], 0.0001)
            
            ideal_pos_size_usd = risk_amount / sl_percent
            ideal_coin_qty = ideal_pos_size_usd / current_price
            
            actual_qty = truncate_quantity(ideal_coin_qty, trade_step_size)
            actual_pos_size_usd = actual_qty * current_price
            actual_margin_req = actual_pos_size_usd / trade_config['leverage']

            if actual_margin_req > bot_state['available_margin'] or actual_qty <= 0: continue 
                
            # 라이브 API 주문 실행 (SL/TP 동시 발송)
            try:
                # TODO: 실제 돈이 들어가는 라이브 매매 시 아래의 주석을 해제하세요!
                side = 'BUY' if box['direction'] == 'long' else 'SELL'
                pos_side = 'LONG' if box['direction'] == 'long' else 'SHORT'
                bingx.place_market_order(
                    symbol=trade_config['symbol'], 
                    side=side, 
                    position_side=pos_side, 
                    quantity=actual_qty,
                    tp_price=format_price(box['tp']),  # 안전한 포맷팅 적용
                    sl_price=format_price(box['sl'])
                )
                pass 
            except Exception as e:
                slack.send_message(f"🚨 주문 실행 실패! 타점 취소됨.\n오류: {e}")
                continue 

            box['status'] = 'active'
            box['entry_price_actual'] = current_price
            box['quantity'] = actual_qty
            box['margin_used'] = actual_margin_req
            
            bot_state['available_margin'] -= actual_margin_req
            bot_state['active_positions'].append(box)
            state_changed = True
            
            slack.send_message(f"🚀 포지션 진입 성공!\nID: {box['id']}\n방향: {box['direction'].upper()}\n체결가: {current_price:.2f}\n수량: {actual_qty} (증거금: ${actual_margin_req:.2f})\n✅ 거래소 SL/TP OCO 주문 세팅 완료.")

    # ------------------------------------------
    # 4. 활성 포지션(Active) 청산 검사 로직 (Spike-Proof)
    # ------------------------------------------
    for pos in list(bot_state['active_positions']):
        hit_sl = False
        hit_tp = False
        
        # 봇이 자는 동안 고가/저가가 TP나 SL을 꼬리로 건드렸는지 완벽 추적
        if pos['direction'] == 'long':
            if lowest_price_recent <= pos['sl']: hit_sl = True
            if highest_price_recent >= pos['tp']: hit_tp = True
        else:
            if highest_price_recent >= pos['sl']: hit_sl = True
            if lowest_price_recent <= pos['tp']: hit_tp = True
            
        # 극한의 변동성으로 5분 내에 위아래를 다 쳤을 경우 보수적으로 SL(손실)로 간주
        if hit_sl and hit_tp:
            is_resolved, is_win = True, False
        elif hit_sl:
            is_resolved, is_win = True, False
        elif hit_tp:
            is_resolved, is_win = True, True
        else:
            is_resolved = False

        if is_resolved:
            result_str = "🟢 익절 (TP Hit)" if is_win else "🔴 손절 (SL Hit)"
            
            # 실제 체결된 가격과 수량 기준 PnL 정확도 향상
            pos_qty = pos['quantity']
            entry_price = pos['entry_price_actual']
            
            if pos['direction'] == 'long':
                pnl = (pos['tp'] - entry_price) * pos_qty if is_win else (pos['sl'] - entry_price) * pos_qty
            else:
                pnl = (entry_price - pos['tp']) * pos_qty if is_win else (entry_price - pos['sl']) * pos_qty

            bot_state['available_margin'] += (pos['margin_used'] + pnl)
            bot_state['active_positions'].remove(pos)
            state_changed = True
            
            slack.send_message(f"🏁 포지션 청산 감지 (거래소 자동 청산 완료)\n결과: {result_str}\n순손익(PnL): ${pnl:.2f}\n현재 자본금: ${bot_state['available_margin']:.2f}")

    if state_changed:
        save_state(bot_state)

if __name__ == "__main__":
    slack.send_message("✅ 실전 자동매매 봇(BingX) 라이브 모니터링 시작!")
    interval_sec = trade_config['trade_check_interval_min'] * 60
    
    while True:
        try:
            run_bot()
        except Exception as e:
            slack.send_message(f"⚠️ 봇 루프 실행 중 시스템 오류 발생:\n{e}")
        time.sleep(interval_sec)