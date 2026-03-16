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
CONFIG_FILE = 'config.json'
STATE_FILE = 'bot_state.json'

with open(CONFIG_FILE, 'r') as f:
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
                    "text": f"🤖 *BingX Bot Alert*\n{formatted_msg}"
                }
            )
            response_data = response.json()
            if not response_data.get("ok"):
                print(f"Slack API 에러: {response_data.get('error')}")
        except Exception as e:
            print(f"Slack 전송 실패: {e}")

# 슬랙 인스턴스 생성
slack = SlackNotifier(slack_config['token'], slack_config['channel'])

# ==========================================
# 봇 상태 영구 저장 (Persistence) 로직
# ==========================================
def load_state() -> dict:
    """디스크에서 봇 상태를 불러옵니다."""
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
    """봇 상태를 디스크에 안전하게 저장합니다."""
    state_copy = state.copy()
    state_copy['known_boxes'] = list(state_copy['known_boxes'])
    with open(STATE_FILE, 'w') as f:
        json.dump(state_copy, f, indent=2)

bot_state = load_state()

# ==========================================
# 유틸리티 함수
# ==========================================
def truncate_quantity(qty: float, step_size: float) -> float:
    """거래소 규격에 맞게 수량의 소수점을 버림(Floor) 처리합니다."""
    if step_size >= 1:
        precision = 0
    else:
        precision = max(0, int(round(-math.log10(step_size))))
    truncated = math.floor(qty / step_size) * step_size
    return round(truncated, precision)

try:
    contract_info = bingx.get_contract_info(trade_config['symbol'])
    trade_step_size = float(contract_info.get('tradeMinQuantity', 0.0001))
    print(f"✅ 심볼 정보 로드 완료: {trade_config['symbol']} (최소 주문 단위: {trade_step_size})")
except Exception as e:
    print(f"❌ 계약 정보 로드 실패. 기본값 0.0001 사용. ({e})")
    trade_step_size = 0.0001

# ==========================================
# 메인 트레이딩 루프 로직
# ==========================================
def run_bot():
    print(f"--- 매매 로직 틱 실행 중 (잔여 증거금: ${bot_state['available_margin']:.2f}) ---")
    
    # 1. 4시간봉 데이터 조회
    candles_4h = bingx.get_klines(trade_config['symbol'], trade_config['box_timeframe'], limit=500)
    
    current_time_ms = int(time.time() * 1000)
    last_candle_open = candles_4h[-1]['open_time']
    timeframe_ms = 4 * 60 * 60 * 1000 # 4시간
    
    # 미확정 진행중 캔들 배제 (Repainting 방지)
    if last_candle_open + timeframe_ms > current_time_ms:
        candles_4h = candles_4h[:-1] 

    # 전략 엔진으로 박스 감지
    all_boxes = detector.detect(candles_4h, trade_config['box_timeframe'], trade_config['rr_ratio'])
    pending_boxes = [b for b in all_boxes if b['created_at'] > current_time_ms - (86400 * 1000 * 3)]

    # 2. 현재 시장가 조회
    current_price = bingx.get_current_price(trade_config['symbol'])
    state_changed = False
    
    # ==========================================
    # 3. 진입 대기 타점(Pending) 검사 로직
    # ==========================================
    for box in pending_boxes:
        if box['id'] in [p['id'] for p in bot_state['active_positions']]:
            continue 
            
        if box['id'] not in bot_state['known_boxes']:
            bot_state['known_boxes'].add(box['id'])
            state_changed = True
            slack.send_message(f"🔎 새로운 타점 포착!\n방향: {box['direction'].upper()}\nEP: {box['ep']:.2f} | SL: {box['sl']:.2f} | TP: {box['tp']:.2f}")

        # [안전장치 보완] EP 도달 검사 & SL 선도달 붕괴 검사
        is_hit_ep = False
        is_hit_sl_before = False
        
        if box['direction'] == 'long':
            if current_price <= box['sl']: 
                is_hit_sl_before = True
            elif current_price <= box['ep']: 
                is_hit_ep = True
        elif box['direction'] == 'short':
            if current_price >= box['sl']: 
                is_hit_sl_before = True
            elif current_price >= box['ep']: 
                is_hit_ep = True
        
        # 갭락/폭락으로 인해 EP 진입 전 SL구간을 이미 뚫고 내려간 경우 타점 폐기
        if is_hit_sl_before:
            continue

        if is_hit_ep:
            if len(bot_state['active_positions']) >= trade_config['max_positions']:
                continue # 동시 진입 제한
            
            # 리스크 기반 수량/증거금 계산
            risk_amount = bot_state['available_margin'] * (trade_config['risk_per_trade_pct'] / 100)
            sl_percent = max(abs(box['ep'] - box['sl']) / box['ep'], 0.0001)
            
            ideal_pos_size_usd = risk_amount / sl_percent
            ideal_coin_qty = ideal_pos_size_usd / current_price
            
            actual_qty = truncate_quantity(ideal_coin_qty, trade_step_size)
            actual_pos_size_usd = actual_qty * current_price
            actual_margin_req = actual_pos_size_usd / trade_config['leverage']

            if actual_margin_req > bot_state['available_margin'] or actual_qty <= 0:
                continue 
                
            # [안전장치 보완] 실제 API 주문 블록 추가 및 예외처리
            try:
                # TODO: 실제 라이브 매매 시 아래 주석을 해제하세요.
                # side = 'BUY' if box['direction'] == 'long' else 'SELL'
                # pos_side = 'LONG' if box['direction'] == 'long' else 'SHORT'
                # bingx.place_market_order(trade_config['symbol'], side, pos_side, actual_qty)
                pass # 테스트 시 에러 방지용 pass
            except Exception as e:
                slack.send_message(f"🚨 주문 실행 실패! 타점 취소됨.\n오류: {e}")
                continue # 주문 실패 시 내부 지갑/상태 업데이트 중단

            # 주문이 성공했을 때만 내부 상태 업데이트 수행
            box['status'] = 'active'
            box['entry_price_actual'] = current_price
            box['quantity'] = actual_qty
            box['margin_used'] = actual_margin_req
            
            bot_state['available_margin'] -= actual_margin_req
            bot_state['active_positions'].append(box)
            state_changed = True
            
            slack.send_message(f"🚀 포지션 진입 성공!\nID: {box['id']}\n방향: {box['direction'].upper()}\n체결가: {current_price:.2f}\n수량: {actual_qty} (증거금: ${actual_margin_req:.2f})")

    # ==========================================
    # 4. 활성 포지션(Active) 청산 검사 로직
    # ==========================================
    for pos in list(bot_state['active_positions']):
        is_resolved = False
        is_win = False
        
        if pos['direction'] == 'long':
            if current_price <= pos['sl']: is_resolved, is_win = True, False
            elif current_price >= pos['tp']: is_resolved, is_win = True, True
        else:
            if current_price >= pos['sl']: is_resolved, is_win = True, False
            elif current_price <= pos['tp']: is_resolved, is_win = True, True
            
        if is_resolved:
            result_str = "🟢 익절 (TP Hit)" if is_win else "🔴 손절 (SL Hit)"
            
            # [안전장치 보완] 실제 코인 수량과 가격 차이를 이용한 완벽한 PnL(손익) 계산
            pos_qty = pos['quantity']
            entry_price = pos['entry_price_actual']
            
            if pos['direction'] == 'long':
                pnl = (pos['tp'] - entry_price) * pos_qty if is_win else (pos['sl'] - entry_price) * pos_qty
            else:
                pnl = (entry_price - pos['tp']) * pos_qty if is_win else (entry_price - pos['sl']) * pos_qty

            try:
                # TODO: 실제 라이브 매매 청산 주문 (시장가 또는 거래소 자동 TP/SL 활용)
                # close_side = 'SELL' if pos['direction'] == 'long' else 'BUY'
                # pos_side = 'LONG' if pos['direction'] == 'long' else 'SHORT'
                # bingx.place_market_order(trade_config['symbol'], close_side, pos_side, pos_qty)
                pass
            except Exception as e:
                slack.send_message(f"🚨 청산 주문 실패! 수동 확인 요망.\n오류: {e}")
                continue # 청산 실패 시 루프 종료 (상태 유지)

            # 내부 지갑 자금 환원 (사용한 증거금 원금 + 발생한 확정 손익)
            bot_state['available_margin'] += (pos['margin_used'] + pnl)
            bot_state['active_positions'].remove(pos)
            state_changed = True
            
            slack.send_message(f"🏁 포지션 청산 완료!\n결과: {result_str}\n청산가: {current_price:.2f}\n순손익(PnL): ${pnl:.2f}\n현재 자본금: ${bot_state['available_margin']:.2f}")

    # 변경사항 디스크 동기화
    if state_changed:
        save_state(bot_state)

# ==========================================
# 실행 엔트리포인트
# ==========================================
if __name__ == "__main__":
    slack.send_message("✅ 실전 자동매매 봇(BingX) 모니터링 시작!")
    interval_sec = trade_config['trade_check_interval_min'] * 60
    
    while True:
        try:
            run_bot()
        except Exception as e:
            slack.send_message(f"⚠️ 봇 루프 실행 중 시스템 오류 발생:\n{e}")
        time.sleep(interval_sec)