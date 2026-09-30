const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(__dirname, 'chrome_profile');
const CDP_PORT = 9222;

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

async function launchRealChrome() {
    const isRunning = await checkCdpReady();
    if (isRunning) {
        console.log('✓ Đã kết nối với Google Chrome đang mở.');
        return;
    }

    console.log('Đang khởi động Google Chrome...');
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
            console.log('✓ Google Chrome đã sẵn sàng.');
            return;
        }
    }
    throw new Error('Không thể khởi chạy Google Chrome qua cổng 9222.');
}

(async () => {
    try {
        // 1. Kết nối hoặc khởi chạy Chrome thật
        await launchRealChrome();

        // 2. Kết nối Playwright tới Chrome qua CDP
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
        const defaultContext = browser.contexts()[0];

        let page = defaultContext.pages().find(p => p.url().includes('gemini.google.com'));
        if (!page) {
            page = defaultContext.pages()[0] || await defaultContext.newPage();
            await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        }

        console.log(`Đang truy cập trang: ${page.url()}`);
        console.log('Đang chờ nội dung câu hỏi & câu trả lời trong Gemini...');

        // Selector chuẩn của web component Gemini: user-query & model-response
        await page.waitForSelector('model-response', { timeout: 30000 });

        console.log('✓ Đã phát hiện tin nhắn! Đang trích xuất dữ liệu...');

        // 3. Trích xuất nội dung query và response mới nhất
        const data = await page.evaluate(() => {
            const queries = document.querySelectorAll('user-query');
            const responses = document.querySelectorAll('model-response');

            const lastQuery = queries[queries.length - 1];
            const lastResp = responses[responses.length - 1];

            if (!lastQuery && !lastResp) return null;

            let rawQuery = lastQuery ? lastQuery.innerText.trim() : "";
            let rawResponse = lastResp ? lastResp.innerText.trim() : "";

            // Xóa tiền tố "Bạn đã nói" / "You said" và đoạn preview bị lặp
            rawQuery = rawQuery.replace(/^(Bạn đã nói|You said)[\s\S]*?\n\n/i, '').trim();
            // Nếu không có đoạn ngắt \n\n thì xóa tiền tố thông thường
            rawQuery = rawQuery.replace(/^(Bạn đã nói|You said)\s*/i, '').trim();

            // Xóa tiền tố "Gemini đã nói" / "Gemini said"
            rawResponse = rawResponse.replace(/^(Gemini đã nói|Gemini said)\s*/i, '').trim();

            return {
                QUERRY: rawQuery,
                respone: rawResponse
            };
        });

        console.log('\n=== KẾT QUẢ TRÍCH XUẤT ===');
        console.log(JSON.stringify(data, null, 2));
        console.log('==========================\n');

        await browser.close();
    } catch (err) {
        console.error('Lỗi:', err.message);
    }
})();

