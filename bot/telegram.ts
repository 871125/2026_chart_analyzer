import { botConfig } from './config';

export async function sendTelegramMessage(message: string, maxRetries = 5) {
    // 토큰이나 Chat ID가 설정되지 않았을 경우 터미널 로그로만 남김
    if (!botConfig.TELEGRAM_BOT_TOKEN || !botConfig.TELEGRAM_CHAT_ID) {
        console.log(`[Telegram Mock] \n${message}`);
        return;
    }

    const url = `https://api.telegram.org/bot${botConfig.TELEGRAM_BOT_TOKEN}/sendMessage`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: botConfig.TELEGRAM_CHAT_ID, text: message })
            });

            if (!response.ok) {
                throw new Error(`HTTP 상태 코드 에러: ${response.status}`);
            }
            
            return; // 전송 성공 시 루프를 빠져나가고 함수 종료
        } catch (error) {
            if (attempt === maxRetries) {
                console.error(`❌ Telegram 메시지 전송 최종 실패 (${maxRetries}회 재시도):`, error);
            } else {
                console.warn(`⚠️ Telegram 메시지 전송 실패 (${attempt}/${maxRetries}회). 2초 후 재시도합니다...`);
                // 다음 재시도 전 2초 대기
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
}