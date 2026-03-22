import { botConfig } from './config';

export async function sendTelegramMessage(message: string) {
    // 토큰이나 Chat ID가 설정되지 않았을 경우 터미널 로그로만 남김
    if (!botConfig.TELEGRAM_BOT_TOKEN || !botConfig.TELEGRAM_CHAT_ID) {
        console.log(`[Telegram Mock] \n${message}`);
        return;
    }

    const url = `https://api.telegram.org/bot${botConfig.TELEGRAM_BOT_TOKEN}/sendMessage`;

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: botConfig.TELEGRAM_CHAT_ID, text: message })
        });
    } catch (error) {
        console.error('Telegram 메시지 전송 실패:', error);
    }
}