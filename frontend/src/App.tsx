import React, { useState, useEffect, useRef } from 'react';
import { Activity, Clock, DollarSign, Crosshair, TrendingUp, TrendingDown, RefreshCw, Server, AlertTriangle, Play, Square } from 'lucide-react';

// ==========================================
// 1. 타입 정의 (Python 봇의 bot_state.json 규격)
// ==========================================
interface ActivePosition {
    id: string;
    direction: 'long' | 'short';
    archetype: string;
    created_at: number;
    ep: number;
    sl: number;
    tp: number;
    entry_price_actual: number;
    quantity: number;
    margin_used: number;
    status: string;
}

interface BotState {
    available_margin: number;
    active_positions: ActivePosition[];
    known_boxes: string[];
    last_updated?: number;
}

interface Candle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    isBullish: boolean;
}

// ==========================================
// 2. 라이브 모니터링 대시보드 컴포넌트
// ==========================================
export default function LiveBotDashboard() {
    // 봇 상태
    const [botState, setBotState] = useState<BotState | null>(null);
    const [currentPrice, setCurrentPrice] = useState<number>(0);
    const [candles, setCandles] = useState<Candle[]>([]);
    
    // UI 상태
    const [isPolling, setIsPolling] = useState(true);
    const [lastFetchTime, setLastFetchTime] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [useMockData, setUseMockData] = useState(false);

    // 모바일 등 화면 크기 변경 감지용 (Canvas 리렌더링 목적)
    const [windowSize, setWindowSize] = useState({ width: 0, height: 0 });

    const canvasRef = useRef<HTMLCanvasElement>(null);

    // ==========================================
    // 데이터 페칭 로직 (Polling)
    // ==========================================
    const fetchLiveData = async () => {
        try {
            setError(null);

            // 1. 현재 시장가 및 차트 데이터 가져오기 (시각화용으로 Binance API 사용 - CORS 이슈 회피)
            const symbol = 'BTCUSDT'; 
            const klinesRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`);
            const klinesData = await klinesRes.json();
            
            const parsedCandles: Candle[] = klinesData.map((row: any[]) => ({
                openTime: row[0],
                open: parseFloat(row[1]),
                high: parseFloat(row[2]),
                low: parseFloat(row[3]),
                close: parseFloat(row[4]),
                isBullish: parseFloat(row[4]) >= parseFloat(row[1])
            }));
            
            setCandles(parsedCandles);
            const latestPrice = parsedCandles[parsedCandles.length - 1].close;
            setCurrentPrice(latestPrice);

            // 2. Python 봇의 상태(bot_state.json) 가져오기
            // 실제 환경에서는 로컬 웹서버(예: http://localhost:8000/bot_state.json)에서 가져옵니다.
            let stateData: BotState;
            
            if (useMockData) {
                // 파이썬 봇 서버가 연결되지 않았을 때 UI 확인용 Mock Data
                stateData = generateMockBotState(latestPrice);
            } else {
                try {
                    // Python 폴더에서 python -m http.server 8000 실행 시 접근 가능
                    const stateRes = await fetch(`http://${window.location.hostname}:8000/bot_state.json`, { cache: "no-store" });
                    if (!stateRes.ok) throw new Error("서버 응답 오류");
                    stateData = await stateRes.json();
                } catch (e) {
                    console.warn("로컬 봇 서버에 연결할 수 없어 임시 데이터(Mock) 모드로 전환합니다.");
                    setUseMockData(true);
                    stateData = generateMockBotState(latestPrice);
                }
            }

            stateData.last_updated = Date.now();
            setBotState(stateData);
            setLastFetchTime(new Date());

        } catch (err: any) {
            setError(err.message || '데이터를 불러오는 데 실패했습니다.');
            setIsPolling(false); // 심각한 에러 시 폴링 중지
        }
    };

    // 자동 폴링 (5초마다 갱신)
    useEffect(() => {
        fetchLiveData(); // 초기 로드
        let intervalId: any;
        
        if (isPolling) {
            intervalId = setInterval(fetchLiveData, 5000); // 5초 주기
        }
        
        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [isPolling, useMockData]);

    // 화면 리사이즈 감지
    useEffect(() => {
        const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener('resize', handleResize);
        handleResize(); // 초기화
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // ==========================================
    // 차트 렌더링 로직 (Canvas)
    // ==========================================
    useEffect(() => {
        if (!canvasRef.current || candles.length === 0) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // 부모 요소 크기에 맞춰 캔버스 해상도 재설정 (모바일 대응)
        const { width, height } = canvas.parentElement!.getBoundingClientRect();
        canvas.width = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);

        const padding = { top: 20, bottom: 20, left: 10, right: 60 }; // 모바일 공간 절약을 위해 패딩 축소
        const drawWidth = width - padding.left - padding.right;
        const drawHeight = height - padding.top - padding.bottom;

        // Y축 스케일 계산
        const maxPrice = Math.max(...candles.map(c => c.high)) * 1.002;
        const minPrice = Math.min(...candles.map(c => c.low)) * 0.998;
        const priceRange = maxPrice - minPrice || 1;

        const getY = (price: number) => padding.top + drawHeight - ((price - minPrice) / priceRange) * drawHeight;
        
        const candleWidth = drawWidth / candles.length;
        const spacing = candleWidth * 0.2;
        const getX = (index: number) => padding.left + index * candleWidth + spacing;

        // 1. 배경 그리드 및 Y축 가격 텍스트
        ctx.fillStyle = '#9ca3af';
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.3)';
        ctx.lineWidth = 1;
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        
        for (let i = 0; i <= 5; i++) {
            const price = maxPrice - (priceRange * (i / 5));
            const y = padding.top + (drawHeight * (i / 5));
            ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
            ctx.fillText(price.toFixed(1), width - padding.right + 5, y);
        }

        // 2. 캔들스틱 그리기
        candles.forEach((candle, i) => {
            const x = getX(i);
            const yHigh = getY(candle.high);
            const yLow = getY(candle.low);
            const yOpen = getY(candle.open);
            const yClose = getY(candle.close);

            ctx.strokeStyle = candle.isBullish ? '#10b981' : '#ef4444'; // Emerald / Red
            ctx.fillStyle = candle.isBullish ? '#10b981' : '#ef4444';
            
            // 꼬리
            ctx.beginPath(); 
            ctx.moveTo(x + (candleWidth - spacing * 2) / 2, yHigh); 
            ctx.lineTo(x + (candleWidth - spacing * 2) / 2, yLow); 
            ctx.stroke();
            
            // 몸통
            const rectY = Math.min(yOpen, yClose);
            const rectHeight = Math.max(Math.abs(yOpen - yClose), 1);
            ctx.fillRect(x, rectY, candleWidth - spacing * 2, rectHeight);
        });

        // 3. 현재 활성 포지션 가이드라인 그리기 (SL, EP, TP)
        if (botState?.active_positions) {
            botState.active_positions.forEach(pos => {
                const yEp = getY(pos.entry_price_actual);
                const ySl = getY(pos.sl);
                const yTp = getY(pos.tp);
                
                const drawLine = (y: number, color: string, label: string) => {
                    if (y < 0 || y > height) return; // 화면 밖
                    ctx.beginPath();
                    ctx.strokeStyle = color;
                    ctx.setLineDash([5, 5]);
                    ctx.lineWidth = 2;
                    ctx.moveTo(padding.left, y);
                    ctx.lineTo(width - padding.right, y);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    
                    // 라벨 박스
                    ctx.fillStyle = color;
                    ctx.fillRect(width - padding.right, y - 10, 60, 20);
                    ctx.fillStyle = '#fff';
                    ctx.textAlign = 'center';
                    ctx.font = 'bold 10px sans-serif';
                    ctx.fillText(label, width - padding.right + 30, y);
                };

                // 진입 방향에 따른 색상 구분
                const isLong = pos.direction === 'long';
                drawLine(yEp, '#3b82f6', `EP (Pos)`); // Blue
                drawLine(yTp, '#10b981', `TP`);       // Green
                drawLine(ySl, '#ef4444', `SL`);       // Red
                
                // PnL 영역 반투명 하이라이트
                const currentY = getY(currentPrice);
                ctx.fillStyle = isLong 
                    ? (currentPrice > pos.entry_price_actual ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)')
                    : (currentPrice < pos.entry_price_actual ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)');
                
                ctx.fillRect(padding.left, Math.min(yEp, currentY), drawWidth, Math.abs(yEp - currentY));
            });
        }

        // 4. 현재가 라인 (실시간 펄스 느낌)
        const currentY = getY(currentPrice);
        ctx.beginPath();
        ctx.strokeStyle = '#f59e0b'; // Amber
        ctx.lineWidth = 1;
        ctx.moveTo(padding.left, currentY);
        ctx.lineTo(width - padding.right, currentY);
        ctx.stroke();
        
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(width - padding.right, currentY - 10, 60, 20);
        ctx.fillStyle = '#1e293b'; // slate-800
        ctx.textAlign = 'center';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(currentPrice.toFixed(1), width - padding.right + 30, currentY);

    }, [candles, currentPrice, botState, windowSize]); // windowSize 의존성 추가

    // ==========================================
    // 파생 데이터 계산 (미실현 손익 등)
    // ==========================================
    let totalUnrealizedPnL = 0;
    
    if (botState && botState.active_positions) {
        botState.active_positions.forEach(pos => {
            const isLong = pos.direction === 'long';
            const priceDiff = isLong ? (currentPrice - pos.entry_price_actual) : (pos.entry_price_actual - currentPrice);
            const unrealized = priceDiff * pos.quantity;
            totalUnrealizedPnL += unrealized;
        });
    }

    const totalEquity = (botState?.available_margin || 0) + 
                        (botState?.active_positions.reduce((sum, pos) => sum + pos.margin_used, 0) || 0) + 
                        totalUnrealizedPnL;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 p-2 sm:p-4 md:p-6 pb-12 font-sans overflow-x-hidden">
            <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
                
                {/* 1. 상단 관제탑 헤더 */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-900 border border-slate-800 rounded-2xl p-4 md:p-5 shadow-2xl gap-4">
                    <div className="flex items-center gap-3 md:gap-4">
                        <div className="relative flex h-10 w-10 md:h-12 md:w-12 items-center justify-center rounded-xl bg-slate-800 border border-slate-700 shrink-0">
                            {isPolling ? (
                                <>
                                    <Server className="w-5 h-5 md:w-6 md:h-6 text-emerald-400 z-10" />
                                    <span className="absolute inline-flex h-full w-full rounded-xl bg-emerald-400 opacity-20 animate-ping"></span>
                                </>
                            ) : (
                                <Server className="w-5 h-5 md:w-6 md:h-6 text-slate-500" />
                            )}
                        </div>
                        <div>
                            <h1 className="text-lg md:text-xl font-bold text-white flex items-center gap-2 flex-wrap">
                                Bot Live Monitor
                                {useMockData && <span className="text-[10px] bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded border border-orange-500/30">MOCK</span>}
                            </h1>
                            <div className="flex items-center gap-2 md:gap-3 text-xs md:text-sm mt-1 text-slate-400">
                                <span className="flex items-center gap-1">
                                    <Clock className="w-3.5 h-3.5 shrink-0" />
                                    {lastFetchTime ? lastFetchTime.toLocaleTimeString() : 'Waiting...'}
                                </span>
                                <span className={`flex items-center gap-1 font-medium ${isPolling ? 'text-emerald-400' : 'text-slate-500'}`}>
                                    <Activity className="w-3.5 h-3.5 shrink-0" />
                                    {isPolling ? 'Active (5s)' : 'Stopped'}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 w-full md:w-auto">
                        <button 
                            onClick={() => setIsPolling(!isPolling)}
                            className={`flex-1 md:flex-none flex items-center justify-center gap-2 px-3 py-2.5 md:px-4 md:py-2 rounded-lg font-medium transition-all text-sm md:text-base ${
                                isPolling 
                                ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700' 
                                : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                            }`}
                        >
                            {isPolling ? <Square className="w-4 h-4 shrink-0" /> : <Play className="w-4 h-4 shrink-0" />}
                            {isPolling ? 'Stop Feed' : 'Start Feed'}
                        </button>
                        <button 
                            onClick={fetchLiveData}
                            className="p-2.5 md:p-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 transition-colors shrink-0"
                            title="Force Refresh"
                        >
                            <RefreshCw className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* 에러 경고창 */}
                {error && (
                    <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 md:p-4 rounded-xl flex items-center gap-3">
                        <AlertTriangle className="w-5 h-5 shrink-0" />
                        <p className="text-xs md:text-sm">{error}</p>
                    </div>
                )}

                {/* 2. 자산 현황 요약 카드 (모바일 2x2 최적화) */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 md:p-5 shadow-lg flex flex-col justify-center">
                        <div className="text-slate-400 text-xs md:text-sm font-medium mb-1 flex items-center gap-1.5 md:gap-2 truncate">
                            <DollarSign className="w-3.5 h-3.5 shrink-0" /> Total Equity
                        </div>
                        <div className="text-lg sm:text-xl md:text-2xl font-bold font-mono text-white truncate">
                            ${totalEquity.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2})}
                        </div>
                    </div>
                    
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 md:p-5 shadow-lg flex flex-col justify-center">
                        <div className="text-slate-400 text-xs md:text-sm font-medium mb-1 truncate">Margin</div>
                        <div className="text-base sm:text-lg md:text-xl font-bold font-mono text-slate-300 truncate">
                            ${botState?.available_margin.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2}) || '0.00'}
                        </div>
                    </div>

                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 md:p-5 shadow-lg relative overflow-hidden flex flex-col justify-center">
                        <div className="text-slate-400 text-xs md:text-sm font-medium mb-1 truncate">Unrealized PnL</div>
                        <div className={`text-lg sm:text-xl md:text-2xl font-bold font-mono z-10 relative truncate ${totalUnrealizedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {totalUnrealizedPnL > 0 ? '+' : ''}${totalUnrealizedPnL.toFixed(2)}
                        </div>
                        <div className={`absolute -right-4 -bottom-4 w-16 h-16 md:w-24 md:h-24 rounded-full blur-2xl opacity-20 ${totalUnrealizedPnL >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}></div>
                    </div>

                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 md:p-5 shadow-lg flex flex-col justify-center">
                        <div className="text-slate-400 text-xs md:text-sm font-medium mb-1 flex items-center gap-1.5 md:gap-2 truncate">
                            <Crosshair className="w-3.5 h-3.5 shrink-0" /> Positions
                        </div>
                        <div className="text-lg sm:text-xl md:text-2xl font-bold font-mono text-blue-400 truncate">
                            {botState?.active_positions.length || 0} <span className="text-xs md:text-sm text-slate-500 font-sans">/ 3</span>
                        </div>
                    </div>
                </div>

                {/* 3. 라이브 차트 영역 */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-1 shadow-lg overflow-hidden">
                    <div className="px-3 md:px-4 py-2.5 md:py-3 border-b border-slate-800 flex justify-between items-center">
                        <div className="font-semibold text-sm md:text-base text-slate-200 flex items-center gap-2">
                            <Activity className="w-4 h-4 text-slate-400 shrink-0" />
                            <span className="truncate">BTC/USDT (15m)</span>
                        </div>
                        <div className="text-[10px] md:text-xs font-mono px-2 py-1 rounded bg-slate-800 text-slate-400 border border-slate-700 shrink-0">
                            MARK: <span className="text-amber-400 font-bold">{currentPrice.toFixed(2)}</span>
                        </div>
                    </div>
                    {/* 모바일에서는 차트 높이를 약간 줄여 공간 확보 */}
                    <div className="w-full h-[260px] md:h-[350px] relative">
                        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
                    </div>
                </div>

                {/* 4. 활성 포지션(Active Positions) 테이블 */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-lg overflow-hidden">
                    <div className="px-4 py-3 md:px-5 md:py-4 border-b border-slate-800">
                        <h2 className="font-semibold text-sm md:text-base text-slate-200">Current Open Positions</h2>
                    </div>
                    {/* 모바일 가로 스크롤 최적화 */}
                    <div className="overflow-x-auto touch-pan-x">
                        <table className="w-full text-left text-xs md:text-sm whitespace-nowrap">
                            <thead className="bg-slate-950/50 text-slate-400">
                                <tr>
                                    <th className="px-3 md:px-5 py-2.5 md:py-3 font-medium">Symbol / ID</th>
                                    <th className="px-3 md:px-5 py-2.5 md:py-3 font-medium">Direction</th>
                                    <th className="px-3 md:px-5 py-2.5 md:py-3 font-medium">Entry Price</th>
                                    <th className="px-3 md:px-5 py-2.5 md:py-3 font-medium">Size (Margin)</th>
                                    <th className="px-3 md:px-5 py-2.5 md:py-3 font-medium">Unrealized PnL</th>
                                    <th className="px-3 md:px-5 py-2.5 md:py-3 font-medium">Targets</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                                {!botState || botState.active_positions.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="px-3 md:px-5 py-8 md:py-10 text-center text-slate-500 whitespace-normal">
                                            No active positions at the moment.<br className="md:hidden" /> Waiting for signals...
                                        </td>
                                    </tr>
                                ) : (
                                    botState.active_positions.map((pos) => {
                                        const isLong = pos.direction === 'long';
                                        const priceDiff = isLong ? (currentPrice - pos.entry_price_actual) : (pos.entry_price_actual - currentPrice);
                                        const uPnl = priceDiff * pos.quantity;
                                        const uPnlPercent = (uPnl / pos.margin_used) * 100;

                                        return (
                                            <tr key={pos.id} className="hover:bg-slate-800/50 transition-colors">
                                                <td className="px-3 md:px-5 py-3 md:py-4">
                                                    <div className="font-bold text-slate-200">BTC-USDT</div>
                                                    <div className="text-[10px] md:text-xs text-slate-500 font-mono mt-0.5">{pos.id}</div>
                                                </td>
                                                <td className="px-3 md:px-5 py-3 md:py-4">
                                                    <span className={`inline-flex items-center gap-1 px-2 py-1 md:px-2.5 md:py-1 rounded-full text-[10px] md:text-xs font-bold ${
                                                        isLong ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                                                    }`}>
                                                        {isLong ? <TrendingUp className="w-3 h-3 md:w-3.5 md:h-3.5" /> : <TrendingDown className="w-3 h-3 md:w-3.5 md:h-3.5" />}
                                                        {pos.direction.toUpperCase()}
                                                    </span>
                                                </td>
                                                <td className="px-3 md:px-5 py-3 md:py-4 font-mono text-slate-300">
                                                    ${pos.entry_price_actual.toFixed(2)}
                                                </td>
                                                <td className="px-3 md:px-5 py-3 md:py-4">
                                                    <div className="font-mono text-slate-200">{pos.quantity}</div>
                                                    <div className="text-[10px] md:text-xs text-slate-500 mt-0.5">Mg: ${pos.margin_used.toFixed(2)}</div>
                                                </td>
                                                <td className="px-3 md:px-5 py-3 md:py-4">
                                                    <div className={`font-mono font-bold text-sm md:text-base ${uPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                        {uPnl > 0 ? '+' : ''}${uPnl.toFixed(2)}
                                                    </div>
                                                    <div className={`text-[10px] md:text-xs mt-0.5 ${uPnl >= 0 ? 'text-emerald-500/70' : 'text-red-500/70'}`}>
                                                        {uPnl > 0 ? '+' : ''}{uPnlPercent.toFixed(2)}%
                                                    </div>
                                                </td>
                                                <td className="px-3 md:px-5 py-3 md:py-4 font-mono text-[10px] md:text-sm">
                                                    <div className="flex flex-col gap-1">
                                                        <div className="text-emerald-400 flex justify-between w-24 md:w-32"><span>TP:</span> <span>{pos.tp.toFixed(0)}</span></div>
                                                        <div className="text-red-400 flex justify-between w-24 md:w-32"><span>SL:</span> <span>{pos.sl.toFixed(0)}</span></div>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

            </div>
        </div>
    );
}

// ==========================================
// 테스트용 임시 데이터 생성 함수 (Mock)
// ==========================================
function generateMockBotState(currentPrice: number): BotState {
    // 현재 시장가 기준으로 약간의 손익이 발생한 가짜 포지션 생성
    return {
        available_margin: 8750.50,
        known_boxes: ['box_123', 'box_124'],
        active_positions: [
            {
                id: 'box_mock_1',
                direction: 'long',
                archetype: 'continuation_box',
                created_at: Date.now() - 3600000,
                ep: currentPrice - 200, // 롱 진입가 (현재 수익중)
                sl: currentPrice - 1000,
                tp: currentPrice + 1600,
                entry_price_actual: currentPrice - 200,
                quantity: 0.15,
                margin_used: 1000,
                status: 'active'
            },
            {
                id: 'box_mock_2',
                direction: 'short',
                archetype: 'turning_point_base',
                created_at: Date.now() - 7200000,
                ep: currentPrice - 150, // 숏 진입가 (현재 손실중)
                sl: currentPrice + 800,
                tp: currentPrice - 2050,
                entry_price_actual: currentPrice - 150,
                quantity: 0.05,
                margin_used: 250,
                status: 'active'
            }
        ]
    };
}