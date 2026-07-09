"""텔레그램 알림 전송 (bot/telegram.ts 이식)."""
from __future__ import annotations

import time

import requests

from . import config


def send_telegram_message(message: str, max_retries: int = 5) -> None:
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_CHAT_ID:
        print(f"[Telegram Mock] \n{message}")
        return

    url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(
                url,
                json={"chat_id": config.TELEGRAM_CHAT_ID, "text": message},
                timeout=15,
            )
            if not response.ok:
                raise RuntimeError(f"HTTP 상태 코드 에러: {response.status_code}")
            return
        except Exception as error:
            if attempt == max_retries:
                print(f"Telegram 메시지 전송 최종 실패 ({max_retries}회 재시도): {error}")
            else:
                print(f"Telegram 메시지 전송 실패 ({attempt}/{max_retries}회). 2초 후 재시도합니다...")
                time.sleep(2)
