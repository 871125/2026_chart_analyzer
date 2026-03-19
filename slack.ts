import { botConfig } from './config';

export async function sendSlackMessage(message: string) {
    // Webhook URL이 설정되지 않았을 경우 터미널 로그로만 남김
    if (!botConfig.SLACK_WEBHOOK_URL || botConfig.SLACK_WEBHOOK_URL.includes('YOUR_SLACK')) {
        console.log(`[Slack Mock] ${message}`);
        return;
    }

    try {
        await fetch(botConfig.SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message })
        });
    } catch (error) {
        console.error('Slack 메시지 전송 실패:', error);
    }
}