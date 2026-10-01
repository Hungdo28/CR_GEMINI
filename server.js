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
    await page.waitForSelector('div.ql-editor, div[contenteditable="true"]', { timeout: 30000 });
    activePage = page;
    return page;
}

// Đảm bảo chọn đúng mô hình Gemini (mặc định: Flash)
async function ensureModel(page, targetModel = 'Flash') {
    try {
        const switchBtn = page.locator('button.input-area-switch, button[aria-label*="chọn chế độ"], button[aria-label*="mode selector"]').first();
        if (!await switchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            return false;
        }

        const currentText = (await switchBtn.innerText()).trim();

        // Kiểm tra nếu đã đúng model
        const targetLower = targetModel.toLowerCase();
        if (targetLower === 'flash') {
            if (currentText.toLowerCase() === 'flash' || (currentText.toLowerCase().includes('flash') && !currentText.toLowerCase().includes('lite'))) {
                return true;
            }
        } else if (currentText.toLowerCase().includes(targetLower)) {
            return true;
        }

        console.log(`[Gemini] Đang chuyển mô hình từ "${currentText}" sang "${targetModel}"...`);
        await switchBtn.click();
        await page.waitForTimeout(600);

        const switched = await page.evaluate((target) => {
            const items = Array.from(document.querySelectorAll('gem-menu-item, [role="menuitem"], .mat-mdc-menu-item'));
            const tLower = target.toLowerCase();
            let el = null;
            if (tLower === 'flash') {
                el = items.find(item => {
                    const txt = (item.innerText || '').toLowerCase();
                    return txt.includes('flash') && !txt.includes('lite');
                });
            } else if (tLower === 'flash-lite' || tLower === 'lite') {
                el = items.find(item => (item.innerText || '').toLowerCase().includes('lite'));
            } else if (tLower === 'pro') {
                el = items.find(item => (item.innerText || '').toLowerCase().includes('pro'));
            }
            if (el) {
                el.click();
                return true;
            }
            return false;
        }, targetModel);

        if (switched) {
            await page.waitForTimeout(600);
            const newText = (await switchBtn.innerText()).trim();
            console.log(`✓ [Gemini] Đã kích hoạt mô hình: "${newText}"`);
            return true;
        } else {
            await page.keyboard.press('Escape');
            return false;
        }
    } catch (e) {
        console.warn('[Gemini] Không thể đổi mô hình:', e.message);
        return false;
    }
}

// Hàm gửi câu hỏi và nhận câu trả lời từ Gemini
async function askGemini(prompt, options = {}) {
    const { newChat = false, maxWaitSeconds = 180, model = 'Flash' } = options;
    const page = await getGeminiPage();

    if (newChat) {
        console.log('[Gemini] Đang mở cuộc trò chuyện mới...');
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('div.ql-editor, div[contenteditable="true"]', { timeout: 30000 });
        await page.waitForTimeout(800);
    }

    // Đảm bảo đang chọn đúng mô hình yêu cầu (mặc định là Gemini Flash)
    await ensureModel(page, model);

    console.log(`[Gemini] Đang gửi nội dung (${prompt.length} ký tự)...`);
    const prevCount = await page.locator('model-response').count();

    // 1. Nhập prompt vào ô chat
    const input = page.locator('div.ql-editor, div[contenteditable="true"]').first();
    await input.click();
    await input.fill(prompt);
    await page.waitForTimeout(500);

    // 2. Click nút gửi hoặc ấn Enter
    const sendBtn = page.locator('button[aria-label*="Gửi tin nhắn"], button[aria-label*="Send message"], button[aria-label="Gửi"]').first();
    if (await sendBtn.isVisible()) {
        await sendBtn.click();
    } else {
        await page.keyboard.press('Enter');
    }

    console.log('[Gemini] Đã gửi lệnh, đang chờ phản hồi từ mô hình...');

    // 3. Chờ có model-response mới xuất hiện
    await page.waitForFunction((prev) => {
        return document.querySelectorAll('model-response').length > prev;
    }, prevCount, { timeout: 45000 });

    console.log('[Gemini] Mô hình đang sinh câu trả lời...');

    // 4. Chờ cho đến khi Gemini hoàn thành câu trả lời
    let lastText = '';
    let stableCount = 0;

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

    const { prompt, options, resolve, reject, startTime } = queue.shift();

    try {
        const result = await askGemini(prompt, options);
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
        let parsedData = null;
        try {
            // Loại bỏ markdown code block nếu có ```json ... ```
            const cleanText = result.response.replace(/```json/gi, '').replace(/```/g, '').trim();
            parsedData = JSON.parse(cleanText);
        } catch {
            // Không phải pure JSON, giữ nguyên null
        }

        resolve({
            success: true,
            prompt: result.query || prompt,
            response: result.response,
            data: parsedData,
            duration: `${durationSec}s`,
            timestamp: new Date().toISOString()
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

function enqueuePrompt(prompt, options = {}) {
    return new Promise((resolve, reject) => {
        queue.push({
            prompt,
            options,
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

    // Endpoint kiểm tra trạng thái & hướng dẫn n8n
    if (url.pathname === '/' || url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
            JSON.stringify({
                status: 'online',
                service: 'Gemini Bridge for n8n',
                endpoints: {
                    ask: {
                        method: 'POST',
                        url: '/ask',
                        description: 'Gửi prompt + tài liệu JSON để lấy câu trả lời từ Gemini',
                        exampleBody: {
                            prompt: 'Phân tích tài liệu này thành testcase cho tôi',
                            document: {
                                module: 'Thanh toán vé',
                                requirements: ['Xác nhận OTP', 'Giao dịch qua QR Fintwin']
                            },
                            newChat: true
                        }
                    }
                },
                queueLength: queue.length,
                isProcessing
            }, null, 2)
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
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Body phải là JSON hợp lệ. Ví dụ: {"prompt": "...", "document": {...}}'
                    }));
                    return;
                }

                let prompt = parsed.prompt || parsed.query || parsed.message || '';
                const documentData = parsed.document !== undefined ? parsed.document : (parsed.data !== undefined ? parsed.data : parsed.json);

                if (!prompt && documentData === undefined) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Thiếu dữ liệu! Cần cung cấp ít nhất "prompt" hoặc "document" trong JSON body.'
                    }));
                    return;
                }

                // Kết hợp prompt và tài liệu JSON thành một câu hỏi hoàn chỉnh cho Gemini
                let fullPrompt = '';
                if (typeof prompt === 'string' && prompt.trim()) {
                    fullPrompt = prompt.trim();
                }

                if (documentData !== undefined && documentData !== null) {
                    let formattedDoc = '';
                    if (typeof documentData === 'object') {
                        formattedDoc = JSON.stringify(documentData, null, 2);
                    } else {
                        formattedDoc = String(documentData);
                    }

                    if (fullPrompt) {
                        fullPrompt += '\n\n--- DỮ LIỆU TÀI LIỆU (JSON) ---\n```json\n' + formattedDoc + '\n```';
                    } else {
                        fullPrompt = 'Dưới đây là tài liệu được định dạng JSON. Hãy phân tích và trích xuất thông tin theo yêu cầu:\n\n```json\n' + formattedDoc + '\n```';
                    }
                }

                const options = {
                    newChat: !!parsed.newChat,
                    maxWaitSeconds: Number(parsed.timeout) || 180,
                    model: parsed.model || 'Flash'
                };

                console.log(`\n[API] Nhận request mới từ n8n (Hàng đợi: ${queue.length + 1}, newChat: ${options.newChat})`);
                const result = await enqueuePrompt(fullPrompt, options);

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

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`====================================================`);
    console.log(`🚀 Gemini Bridge for n8n đang chạy tại:`);
    console.log(`👉 Local:     http://localhost:${PORT}`);
    console.log(`👉 Cho n8n:   http://host.docker.internal:${PORT}/ask`);
    console.log(`👉 Tailscale: http://100.105.11.43:${PORT}/ask`);
    console.log(`====================================================`);

    // Khởi tạo kết nối sẵn sàng với Chrome
    try {
        await getGeminiPage();
        console.log(`✓ Sẵn sàng nhận câu hỏi & tài liệu JSON từ n8n!\n`);
    } catch (e) {
        console.log(`! Chờ kết nối Chrome: ${e.message}\n`);
    }
});
