const http = require('http');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CDP_PORT = 9222;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(__dirname, 'chrome_profile');

let browser = null;
let activePage = null;

// Kiểm tra cổng CDP của Chrome đã mở chưa
function checkCdpReady() {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

// Khởi chạy Chrome thật nếu chưa chạy
async function ensureChromeRunning() {
    const isRunning = await checkCdpReady();
    if (!isRunning) {
        console.log('[Chrome] Đang khởi chạy Google Chrome thật...');
        spawn(CHROME_PATH, [
            `--remote-debugging-port=${CDP_PORT}`,
            `--user-data-dir=${PROFILE_DIR}`,
            '--no-first-run',
            '--no-default-browser-check',
            'https://gemini.google.com/app'
        ], {
            detached: true,
            stdio: 'ignore'
        }).unref();

        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (await checkCdpReady()) {
                console.log('[Chrome] Google Chrome đã sẵn sàng!');
                break;
            }
        }
    }
}

// Kết nối Playwright tới tab Gemini
async function getGeminiPage() {
    await ensureChromeRunning();

    if (!browser || !browser.isConnected()) {
        console.log('[Playwright] Đang kết nối vào Chrome qua CDP...');
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    }

    const context = browser.contexts()[0];
    let page = context.pages().find((p) => p.url().includes('gemini.google.com'));

    if (!page) {
        page = context.pages()[0] || (await context.newPage());
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    }

    // Đợi ô nhập liệu xuất hiện
    await page.waitForSelector('div[contenteditable="true"]', { timeout: 30000 });
    activePage = page;
    return page;
}

// Hàm gửi câu hỏi và nhận câu trả lời từ Gemini
async function askGemini(prompt) {
    const page = await getGeminiPage();

    console.log(`[Gemini] Đang gửi prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
    const prevCount = await page.locator('model-response').count();

    // 1. Nhập prompt vào ô chat
    const input = page.locator('div[contenteditable="true"]').first();
    await input.click();
    await input.fill(prompt);
    await page.waitForTimeout(300);

    // 2. Click nút gửi hoặc ấn Enter
    const sendBtn = page.locator('button[aria-label*="Gửi tin nhắn"], button[aria-label*="Send message"]').first();
    if (await sendBtn.isVisible()) {
        await sendBtn.click();
    } else {
        await page.keyboard.press('Enter');
    }

    // 3. Chờ có model-response mới xuất hiện
    await page.waitForFunction((prev) => {
        return document.querySelectorAll('model-response').length > prev;
    }, prevCount, { timeout: 35000 });

    // 4. Chờ cho đến khi Gemini trả lời xong
    let lastText = '';
    let stableCount = 0;
    const maxWaitSeconds = 90; // tối đa 90 giây cho câu trả lời dài

    for (let i = 0; i < maxWaitSeconds; i++) {
        await page.waitForTimeout(1000);

        const isGenerating = await page.evaluate(() => {
            const stopBtn = document.querySelector('button[aria-label*="Dừng"], button[aria-label*="Stop"]');
            return !!stopBtn;
        });

        const currentText = await page.evaluate(() => {
            const resps = document.querySelectorAll('model-response');
            return resps.length > 0 ? resps[resps.length - 1].innerText.trim() : '';
        });

        if (!isGenerating && currentText.length > 0 && currentText === lastText) {
            stableCount++;
            if (stableCount >= 2) break; // Ổn định 2 giây liên tiếp -> hoàn thành
        } else {
            stableCount = 0;
            lastText = currentText;
        }
    }

    // 5. Trích xuất kết quả sạch
    const result = await page.evaluate(() => {
        const queries = document.querySelectorAll('user-query');
        const responses = document.querySelectorAll('model-response');

        const lastQuery = queries[queries.length - 1];
        const lastResp = responses[responses.length - 1];

        let q = lastQuery ? lastQuery.innerText.trim() : '';
        let r = lastResp ? lastResp.innerText.trim() : '';

        // Khử tiền tố "Bạn đã nói" & "Gemini đã nói"
        q = q.replace(/^(Bạn đã nói|You said)[\s\S]*?\n\n/i, '').trim();
        q = q.replace(/^(Bạn đã nói|You said)\s*/i, '').trim();
        r = r.replace(/^(Gemini đã nói|Gemini said)\s*/i, '').trim();

        return {
            query: q,
            response: r
        };
    });

    return result;
}

// Hàng đợi tuần tự (Queue) để tránh n8n gửi dồn dập bị xung đột
const queue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    const { prompt, resolve, reject, startTime } = queue.shift();

    try {
        const result = await askGemini(prompt);
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Gemini] Hoàn tất sau ${durationSec}s!`);
        resolve({
            success: true,
            prompt: result.query || prompt,
            response: result.response,
            duration: `${durationSec}s`
        });
    } catch (err) {
        console.error('[Gemini] Lỗi xử lý:', err.message);
        reject(err);
    } finally {
        isProcessing = false;
        // Tiếp tục xử lý request kế tiếp trong hàng đợi nếu có
        setImmediate(processQueue);
    }
}

function enqueuePrompt(prompt) {
    return new Promise((resolve, reject) => {
        queue.push({
            prompt,
            resolve,
            reject,
            startTime: Date.now()
        });
        processQueue();
    });
}

// Tạo HTTP Server cho n8n gọi
const server = http.createServer(async (req, res) => {
    // Header CORS cho n8n hoặc client khác
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // Endpoint kiểm tra trạng thái
    if (url.pathname === '/' || url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
            JSON.stringify({
                status: 'online',
                service: 'Gemini Web Local API',
                queueLength: queue.length,
                isProcessing
            })
        );
        return;
    }

    // Endpoint POST /ask: n8n gọi endpoint này
    if (url.pathname === '/ask' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            try {
                let parsed = {};
                try {
                    parsed = JSON.parse(body);
                } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Body phải là JSON hợp lệ: {"prompt": "..."}' }));
                    return;
                }

                const prompt = parsed.prompt || parsed.query || parsed.message;
                if (!prompt || typeof prompt !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Thiếu trường "prompt" trong JSON body.' }));
                    return;
                }

                console.log(`\n[API] Nhận request mới từ n8n (Hàng đợi hiện tại: ${queue.length})`);
                const result = await enqueuePrompt(prompt);

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(result, null, 2));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(
                    JSON.stringify({
                        success: false,
                        error: err.message
                    })
                );
            }
        });
        return;
    }

    // Đường dẫn không tồn tại
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, async () => {
    console.log(`====================================================`);
    console.log(`🚀 Gemini Web API Server đang chạy tại:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`👉 Endpoint cho n8n: POST http://localhost:${PORT}/ask`);
    console.log(`====================================================`);

    // Khởi tạo kết nối sẵn sàng với Chrome
    try {
        await getGeminiPage();
        console.log(`✓ Sẵn sàng nhận câu hỏi từ n8n!\n`);
    } catch (e) {
        console.log(`! Chờ kết nối Chrome: ${e.message}\n`);
    }
});
