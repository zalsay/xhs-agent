/**
 * xhs_agent - 小红书发布代理 (CDP Stealth 模式)
 * 
 * 使用 CDP 连接模式避免自动化检测：
 * - navigator.webdriver = false
 * - 保留用户真实 Cookies、历史记录、插件
 * - 完全真实的浏览器指纹
 */

import { chromium, Browser, Page } from 'playwright';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as readline from 'readline';
import * as https from 'https';
import { spawn, ChildProcess } from 'child_process';

// ============================================================================
// CDP 配置
// ============================================================================

const CDP_PORT = 9222;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const USER_DATA_DIR = path.join(os.homedir(), '.auto-tauri', 'browser-profile');

// Chrome 可执行文件路径 (macOS + Windows)
const CHROME_PATHS = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
];

// Helper for logging
const log = (msg: string) => console.error(JSON.stringify({ type: 'log', message: `[XHS Agent] ${msg}`, timestamp: new Date().toISOString() }));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// CDP 浏览器管理
// ============================================================================

let chromeProcess: ChildProcess | null = null;

function getChromePath(): string | null {
    for (const chromePath of CHROME_PATHS) {
        if (fs.existsSync(chromePath)) {
            return chromePath;
        }
    }
    return null;
}

async function isCDPAvailable(): Promise<boolean> {
    try {
        const response = await fetch(`${CDP_ENDPOINT}/json/version`);
        return response.ok;
    } catch {
        return false;
    }
}

async function launchChrome(): Promise<void> {
    const chromePath = getChromePath();
    if (!chromePath) {
        throw new Error('Chrome 未找到，请安装 Google Chrome');
    }

    if (!fs.existsSync(USER_DATA_DIR)) {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    log(`正在启动 Chrome (CDP Stealth 模式)...`);
    log(`Chrome 路径: ${chromePath}`);
    log(`用户数据目录: ${USER_DATA_DIR}`);

    chromeProcess = spawn(chromePath, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
    ], {
        detached: true,
        stdio: 'ignore'
    });

    chromeProcess.unref();

    log(`等待 CDP 端口就绪...`);
    let retries = 0;
    const maxRetries = 20;
    while (retries < maxRetries) {
        if (await isCDPAvailable()) {
            log(`CDP 端口已就绪`);
            return;
        }
        await sleep(500);
        retries++;
    }

    throw new Error('Chrome 启动超时');
}

async function connectCDP(): Promise<Browser> {
    if (await isCDPAvailable()) {
        log(`检测到已运行的 Chrome，正在连接...`);
    } else {
        await launchChrome();
    }

    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    log(`已通过 CDP 连接到浏览器 (Stealth 模式)`);
    return browser;
}

async function getOrCreatePage(browser: Browser): Promise<Page> {
    const contexts = browser.contexts();

    if (contexts.length > 0) {
        const context = contexts[0];
        const pages = context.pages();
        if (pages.length > 0) {
            log(`使用现有页面`);
            return pages[0];
        }
        log(`在现有上下文中创建新页面`);
        return await context.newPage();
    }

    log(`创建新的浏览器上下文和页面`);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
    });
    return await context.newPage();
}

// ============================================================================
// 发布配置和辅助函数
// ============================================================================

interface PublishConfig {
    imagePaths?: string[];  // Array of image paths/URLs
    imagePath?: string;     // Single image path (backward compatibility)
    title: string;
    content: string;
    taskId?: string;
}

async function downloadImage(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download image: ${response.statusCode} ${response.statusMessage}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
}

// ============================================================================
// 主发布流程
// ============================================================================

async function runPublish(config: PublishConfig) {
    // Check if Chrome is installed
    const chromePath = getChromePath();
    if (!chromePath) {
        const isWindows = process.platform === 'win32';
        const installHint = isWindows
            ? '请访问 https://www.google.cn/chrome/ 下载安装 Chrome 浏览器'
            : '请访问 https://www.google.cn/chrome/ 下载安装 Chrome 浏览器，或运行: brew install --cask google-chrome';
        throw new Error(`未检测到 Chrome 浏览器。${installHint}`);
    }
    log(`Found Chrome at: ${chromePath}`);

    // Support both imagePaths (array) and imagePath (single) for backward compatibility
    let sourceImagePaths: string[] = [];
    if (config.imagePaths && config.imagePaths.length > 0) {
        sourceImagePaths = config.imagePaths;
        log(`Processing ${sourceImagePaths.length} images from imagePaths array`);
    } else if (config.imagePath) {
        sourceImagePaths = [config.imagePath];
        log(`Using single imagePath`);
    } else {
        throw new Error("Image path is required for XHS publish. Please provide imagePaths or imagePath.");
    }

    // Process all images (download URLs, decode base64, etc.)
    const actualImagePaths: string[] = [];
    const tmpDir = path.join(os.tmpdir(), 'auto-tauri-xhs');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    for (let i = 0; i < sourceImagePaths.length; i++) {
        const sourcePath = sourceImagePaths[i];
        let actualPath = sourcePath;

        log(`Processing image ${i + 1}/${sourceImagePaths.length}: ${sourcePath.substring(0, 50)}...`);

        if (sourcePath.startsWith('http')) {
            // Download from URL
            actualPath = path.join(tmpDir, `publish_${Date.now()}_${i}.png`);
            try {
                await downloadImage(sourcePath, actualPath);
                log(`Downloaded image ${i + 1}`);
            } catch (e: any) {
                throw new Error(`Failed to download image ${i + 1}: ${e.message}`);
            }
        } else if (sourcePath.startsWith('data:image')) {
            // Handle Base64 image
            try {
                const matches = sourcePath.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
                if (!matches || matches.length !== 3) {
                    throw new Error('Invalid Base64 image format');
                }

                const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
                const base64Data = matches[2];
                const buffer = Buffer.from(base64Data, 'base64');

                actualPath = path.join(tmpDir, `publish_base64_${Date.now()}_${i}.${ext}`);
                fs.writeFileSync(actualPath, buffer);
                log(`Saved Base64 image ${i + 1} to: ${actualPath}`);
            } catch (e: any) {
                throw new Error(`Failed to process Base64 image ${i + 1}: ${e.message}`);
            }
        }

        if (!fs.existsSync(actualPath)) {
            throw new Error(`Image file not found: ${actualPath}`);
        }

        actualImagePaths.push(actualPath);
    }

    log(`All ${actualImagePaths.length} images processed successfully`);

    log("Initializing CDP Stealth browser connection...");

    // 使用 CDP 连接模式
    const browser = await connectCDP();
    const page = await getOrCreatePage(browser);

    try {
        log("Navigating to Xiaohongshu Creator Center...");
        await page.goto('https://creator.xiaohongshu.com/publish/publish', { waitUntil: 'networkidle', timeout: 60000 });

        const checkPublishPage = () => page.url().includes('/publish/publish');

        if (!checkPublishPage()) {
            log("--- ACTION REQUIRED ---");
            log("Waiting for user to reach the Publish page...");

            const startTime = Date.now();
            while (!checkPublishPage()) {
                if (Date.now() - startTime > 120000) {
                    throw new Error("Timeout waiting for login. Please reach the publish page manually.");
                }
                try {
                    await page.waitForURL('**/publish/publish', { timeout: 5000 });
                } catch (e) {
                    if (!checkPublishPage()) {
                        log("Still waiting for you to reach the Publish page... (Please log in)");
                    }
                }
            }
            log("Target page detected! Proceeding...");
        }

        log("Looking for upload area...");
        const imageTab = page.getByText('上传图文', { exact: true }).first();
        if (await imageTab.isVisible()) {
            log("Clicking '上传图文' tab...");
            await imageTab.dispatchEvent('click');
            await page.waitForTimeout(2000);
        }

        // Upload ALL images at once using setInputFiles with array
        log(`Uploading ${actualImagePaths.length} images...`);
        const fileInput = page.locator('input[type=\"file\"]');
        await fileInput.waitFor({ state: 'attached', timeout: 30000 });
        await fileInput.setInputFiles(actualImagePaths);  // Upload all images at once

        // Initial wait for upload to start and process (longer for multiple images)
        const waitTime = Math.min(30 + (actualImagePaths.length - 1) * 5, 60); // Extra 10s per image, max 60s
        log(`Waiting ${waitTime} seconds for initial upload processing (${actualImagePaths.length} images)...`);
        await page.waitForTimeout(waitTime * 1000);

        // Then continue with polling loop (1 second intervals)
        // log("Continuing with upload status polling...");
        // const maxUploadWait = 60; // Max 60 seconds
        // for (let i = 0; i < maxUploadWait; i++) {
        //     await page.waitForTimeout(1000);

        //     // Check if upload progress indicator is still visible
        //     const uploadingIndicators = [
        //         page.locator('.upload-progress'),
        //         page.locator('[class*="uploading"]'),
        //         page.locator('[class*="progress"]'),
        //         page.getByText('上传中'),
        //         page.getByText('正在上传')
        //     ];

        //     let stillUploading = false;
        //     for (const indicator of uploadingIndicators) {
        //         try {
        //             if (await indicator.isVisible({ timeout: 200 })) {
        //                 stillUploading = true;
        //                 break;
        //             }
        //         } catch { }
        //     }

        //     if (!stillUploading && i >= 5) {
        //         // Wait at least 5 seconds, then check if upload is done
        //         log(`Upload appears complete after ${i + 1} seconds`);
        //         break;
        //     }

        //     if (i % 5 === 0) {
        //         log(`Upload waiting... ${i + 1}s elapsed`);
        //     }
        // }

        log("Filling title and content...");
        const titleInput = page.locator('input[placeholder*="标题"]');
        await titleInput.fill(config.title);

        const combinedContent = `${config.title}\n${config.content}`;
        const contentArea = page.locator('#post-textarea');
        if (await contentArea.count() > 0) {
            await contentArea.fill(combinedContent);
        } else {
            await page.keyboard.press('Tab');
            await page.keyboard.type(combinedContent);
        }

        log("Ready to publish!!!!!!");

        // Retry logic for publish button
        const maxRetries = 3;
        let publishSuccess = false;

        // log("Waiting 30 seconds for publish...");
        // await page.waitForTimeout(30000);

        for (let attempt = 1; attempt <= maxRetries && !publishSuccess; attempt++) {
            log(`Publish attempt ${attempt}/${maxRetries}...`);

            // Click publish button
            const publishButton = page.getByRole('button', { name: '发布', exact: true });
            const publishButtonFallback = page.getByText('发布', { exact: true });

            if (await publishButton.isVisible()) {
                await publishButton.click();
                log("Clicked main '发布' button");
            } else if (await publishButtonFallback.isVisible()) {
                await publishButtonFallback.click();
                log("Clicked fallback '发布' text button");
            } else {
                const publishNoteBtn = page.getByText('发布笔记', { exact: true });
                if (await publishNoteBtn.isVisible()) {
                    await publishNoteBtn.click();
                    log("Clicked '发布笔记' button");
                } else {
                    throw new Error("Publish button not found");
                }
            }

            log("Clicked publish button, checking for upload popup...");

            // Check for "图片上传中，请稍后" popup and wait if detected
            const uploadPopupMessages = ['图片上传中', '请稍后', '正在处理', '上传中'];
            let uploadPopupDetected = false;

            for (const msg of uploadPopupMessages) {
                try {
                    const popupEl = page.getByText(msg);
                    if (await popupEl.isVisible({ timeout: 1000 })) {
                        log(`Detected upload popup: "${msg}", waiting 3 seconds...`);
                        uploadPopupDetected = true;
                        await page.waitForTimeout(3000);

                        // Re-click publish button after waiting
                        log("Re-clicking publish button after upload popup...");
                        if (await publishButton.isVisible()) {
                            await publishButton.click();
                            log("Re-clicked main '发布' button");
                        } else if (await publishButtonFallback.isVisible()) {
                            await publishButtonFallback.click();
                            log("Re-clicked fallback '发布' text button");
                        }
                        break;
                    }
                } catch { }
            }

            log("Waiting for confirmation...");

            // Wait for success message or URL change
            try {
                log(`Current URL before waiting: ${page.url()}`);

                // Check each condition separately with logging
                const successPromises = [
                    page.getByText('发布成功').waitFor({ timeout: 8000 }).then(() => {
                        log("Detected: '发布成功' text appeared");
                        return 'text_success';
                    }),
                    page.getByText('发布笔记成功').waitFor({ timeout: 8000 }).then(() => {
                        log("Detected: '发布笔记成功' text appeared");
                        return 'text_note_success';
                    }),
                    page.waitForURL('**/note/**', { timeout: 8000 }).then(() => {
                        log(`Detected: URL changed to note page: ${page.url()}`);
                        return 'url_change';
                    })
                ];

                const result = await Promise.race(successPromises);
                log(`Success detected via: ${result}`);
                publishSuccess = true;
            } catch (e: any) {
                log(`Attempt ${attempt}: Success message not detected. Error: ${e.message}`);
                log(`Current URL after timeout: ${page.url()}`);

                // Try to capture visible text elements for debugging
                try {
                    const buttons = await page.locator('button').allTextContents();
                    log(`Visible buttons: ${buttons.slice(0, 10).join(', ')}`);
                } catch { }

                // Check for common success indicators we might have missed
                const additionalSuccessTexts = ['已发布', '成功', '发布完成', '笔记已发布'];
                for (const successText of additionalSuccessTexts) {
                    try {
                        const el = page.getByText(successText);
                        if (await el.isVisible({ timeout: 500 })) {
                            log(`Found alternative success text: "${successText}"`);
                            publishSuccess = true;
                            break;
                        }
                    } catch { }
                }

                if (!publishSuccess) {
                    // Check for error messages
                    const errorMessages = [
                        '发布失败',
                        '请稍后再试',
                        '网络错误',
                        '请先登录',
                        '内容违规',
                        '审核不通过'
                    ];

                    let errorDetected = false;
                    for (const errMsg of errorMessages) {
                        try {
                            const errorEl = page.getByText(errMsg);
                            if (await errorEl.isVisible({ timeout: 500 })) {
                                log(`Error message detected: ${errMsg}`);
                                errorDetected = true;
                                break;
                            }
                        } catch {
                            // Error element not found, continue
                        }
                    }

                    if (attempt < maxRetries) {
                        log(`Waiting 3 seconds before retry...`);
                        await page.waitForTimeout(3000);
                    } else {
                        // Final attempt failed, log page content for debugging
                        log("All attempts exhausted. Dumping page state...");
                        log(`Final URL: ${page.url()}`);

                        try {
                            const pageTitle = await page.title();
                            log(`Page title: ${pageTitle}`);
                        } catch { }

                        try {
                            const pageText = await page.innerText('body');
                            log(`Page Content (first 2000 chars):\n${pageText.substring(0, 2000)}`);
                        } catch (innerErr: any) {
                            log(`Failed to get page text: ${innerErr.message}`);
                        }
                    }
                }
            }
        }

        await page.waitForTimeout(2000);

        if (publishSuccess) {
            console.log(JSON.stringify({ taskId: config.taskId, status: 'success', data: { message: '发布成功！' } }));
        } else {
            console.log(JSON.stringify({ taskId: config.taskId, status: 'success', data: { message: '发布操作已执行，请检查小红书后台确认。' } }));
        }

    } catch (e: any) {
        log(`Error: ${e.message}`);
        console.log(JSON.stringify({ taskId: config.taskId, status: 'failed', data: { message: e.message } }));
    } finally {
        // 断开连接但不关闭浏览器
        log("Disconnecting from browser (browser remains open)...");
        await browser.close();
    }
}

// ============================================================================
// 主入口
// ============================================================================

async function main() {
    const args = process.argv.slice(2);

    // If no args, wait for stdin (JSON)
    if (args.length === 0) {
        const rl = readline.createInterface({
            input: process.stdin,
            terminal: false
        });

        for await (const line of rl) {
            if (line.trim()) {
                let config;
                try {
                    config = JSON.parse(line);
                } catch (e: any) {
                    console.error(JSON.stringify({ type: 'error', message: `Invalid JSON on stdin: ${e.message}` }));
                    process.exit(1);
                }

                try {
                    await runPublish(config);
                    break;
                } catch (e: any) {
                    log(`Execution error: ${e.message}`);
                    console.log(JSON.stringify({ taskId: config?.taskId, status: 'failed', error: e.message }));
                    process.exit(1);
                }
            }
        }
    } else {
        // Handle CLI args for backward compatibility
        const config: PublishConfig = {
            imagePath: args[0],
            title: args[1],
            content: args[2] || ''
        };
        await runPublish(config);
    }
}

main().catch(console.error);