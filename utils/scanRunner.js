import pa11y from 'pa11y';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dns from 'dns/promises';
import net from 'net';

// Apply stealth plugin
puppeteer.use(StealthPlugin());

// Array of realistic user agents to rotate through
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

// Get a random user agent
const getRandomUserAgent = () => {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
};

// Helper to get a screenshot of an element with improved fallbacks
async function getElementScreenshot(page, selector, options = {}) {
    const {
        minSize = 10,
        maxAttempts = 3,
        viewportPadding = 20,
        includeParent = true
    } = options;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            // Try to find the element
            const element = await page.$(selector);
            if (!element) {
                console.log(`Element not found for selector: ${selector}`);
                return null;
            }

            // Get element's bounding box
            const box = await element.boundingBox();
            if (!box) {
                console.log(`No bounding box for selector: ${selector}`);
                return null;
            }

            // Check if element is too small
            if (box.width < minSize || box.height < minSize) {
                if (includeParent) {
                    // Try parent element if child is too small
                    const parent = await page.evaluateHandle(sel => {
                        const el = document.querySelector(sel);
                        return el?.parentElement;
                    }, selector);

                    if (parent) {
                        const parentBox = await parent.boundingBox();
                        if (parentBox && (parentBox.width > box.width || parentBox.height > box.height)) {
                            await parent.dispose();
                            return getElementScreenshot(page, `${selector} > ..`, { ...options, includeParent: false });
                        }
                        await parent.dispose();
                    }
                }
                console.log(`Element too small for selector: ${selector}`);
                return null;
            }

            // Scroll element into view with padding
            await page.evaluate((sel, padding) => {
                const el = document.querySelector(sel);
                if (el) {
                    const rect = el.getBoundingClientRect();
                    const scrollX = rect.left + window.scrollX - padding;
                    const scrollY = rect.top + window.scrollY - padding;
                    window.scrollTo(scrollX, scrollY);
                }
            }, selector, viewportPadding);

            // Wait for any animations to complete
            await new Promise(resolve => setTimeout(resolve, 100));

            // Highlight the element
            await page.evaluate(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.outline = '3px solid red';
                    el.style.outlineOffset = '2px';
                    el.style.zIndex = '9999';
                });
            }, selector);

            // Take screenshot with padding
            const screenshot = await page.screenshot({
                clip: {
                    x: Math.max(0, box.x - viewportPadding),
                    y: Math.max(0, box.y - viewportPadding),
                    width: box.width + (viewportPadding * 2),
                    height: box.height + (viewportPadding * 2)
                },
                encoding: 'base64'
            });

            // Remove highlight
            await page.evaluate(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.outline = '';
                    el.style.outlineOffset = '';
                    el.style.zIndex = '';
                });
            }, selector);

            await element.dispose();
            return `data:image/png;base64,${screenshot}`;
        } catch (error) {
            console.error(`Screenshot attempt ${attempt + 1} failed for ${selector}:`, error);
            if (attempt === maxAttempts - 1) {
                // On last attempt, try to capture the entire viewport
                try {
                    const fullScreenshot = await page.screenshot({
                        encoding: 'base64',
                        fullPage: false
                    });
                    return `data:image/png;base64,${fullScreenshot}`;
                } catch (e) {
                    console.error('Fallback viewport screenshot failed:', e);
                    return null;
                }
            }
        }
    }
    return null;
}

export const runScan = async (url, wcagLevel = 'AA') => {
    // SSRF protection: block internal/private IPs
    try {
        const { hostname } = new URL(url);
        const addresses = await dns.lookup(hostname, { all: true });
        for (const addr of addresses) {
            if (isPrivateIp(addr.address)) {
                throw new Error('Scanning internal/private IP addresses is not allowed for security reasons.');
            }
        }
    } catch (e) {
        if (e.code === 'ENOTFOUND') {
            throw new Error('Invalid or unreachable domain.');
        }
        throw e;
    }

    // First, check for Cloudflare using stealth browser
    const stealthBrowser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-field-trial-config',
            '--disable-ipc-flooding-protection',
            '--enable-features=NetworkService,NetworkServiceLogging',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
            '--no-default-browser-check',
            '--no-pings',
            '--password-store=basic',
            '--use-mock-keychain',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: 'new'
    });

    let isCloudflareProtected = false;

    try {
        const stealthPage = await stealthBrowser.newPage();
        
        // Enhanced stealth configuration
        await stealthPage.setViewport({ width: 1366, height: 768 });
        const userAgent = getRandomUserAgent();
        await stealthPage.setUserAgent(userAgent);
        
        // Set additional headers to appear more human-like
        await stealthPage.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9,en-GB;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'Cache-Control': 'max-age=0',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });

        // Remove webdriver property
        await stealthPage.evaluateOnNewDocument(() => {
            delete navigator.__proto__.webdriver;
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        // Add more realistic browser properties
        await stealthPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
            Object.defineProperty(navigator, 'permissions', {
                get: () => ({
                    query: async () => ({ state: 'granted' })
                }),
            });
        });

        await stealthPage.goto(url, { 
            waitUntil: 'domcontentloaded', 
            timeout: 90000 
        });

        // More realistic waiting and interactions
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 2000));
        
        // Simulate more human-like behavior
        await stealthPage.mouse.move(100 + Math.random() * 200, 100 + Math.random() * 200);
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
        await stealthPage.keyboard.press('ArrowDown');
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        
        // Scroll a bit
        await stealthPage.evaluate(() => {
            window.scrollTo(0, Math.random() * 100);
        });
        await new Promise(resolve => setTimeout(resolve, 1000));

        const pageContent = await stealthPage.content();
        const lowerContent = pageContent.toLowerCase();
        const bodyText = await stealthPage.evaluate(() => document.body && document.body.innerText ? document.body.innerText.trim() : '');
        
        isCloudflareProtected = (
            lowerContent.includes('cf-browser-verification') ||
            lowerContent.includes('attention required! | cloudflare') ||
            lowerContent.includes('challenge-form') ||
            lowerContent.includes('cloudflare ray id') ||
            lowerContent.includes('just a moment...') ||
            lowerContent.includes('checking your browser before accessing') ||
            lowerContent.includes('data-cf-settings') ||
            lowerContent.includes('data-cf-beacon') ||
            lowerContent.includes('ray id:') ||
            lowerContent.includes('please enable javascript and cookies to continue') ||
            /<meta[^>]+http-equiv=["']?refresh/i.test(pageContent) ||
            /<div[^>]+id=["']?cf-spinner/i.test(pageContent) ||
            /<div[^>]+class=["'][^"']*cf-[^"']*["']/i.test(pageContent) ||
            (/cf-spinner|cloudflare/i.test(pageContent) && bodyText.length < 20) ||
            (bodyText.length < 20 && pageContent.length < 2000)
        );

    } catch (e) {
        console.error('Stealth check failed:', e);
    } finally {
        await stealthBrowser.close();
    }

    if (isCloudflareProtected) {
        throw new Error('Cloudflare protection detected. Automated scans are not possible for this site. Please whitelist the Google Cloud Platform (GCP) IP range in your Cloudflare dashboard to allow scans.');
    }

    // Now run Pa11y with standard settings for accurate testing
    const pa11yStandard = wcagLevel === 'AAA' ? 'WCAG2AAA' : 'WCAG2AA';
    const axeTag = wcagLevel === 'AAA' ? 'wcag2aaa' : 'wcag2aa';
    
    let pa11yResult = null;
    let axeResults = null;
    let pa11yIssuesWithScreens = [];
    let axeViolationsWithScreens = [];
    let pa11yPassedWithScreens = [];

    // Run Pa11y with standard configuration
    try {
        pa11yResult = await pa11y(url, {
            chromeLaunchConfig: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ],
                headless: 'new'
            },
            includeNotices: true,
            includeWarnings: true,
            standard: pa11yStandard,
            includePassed: true,
            timeout: 90000
        });
    } catch (pa11yError) {
        console.error('Pa11y scan failed:', pa11yError);
        pa11yResult = {
            issues: [],
            passed: [],
            notices: [],
            warnings: [],
            error: pa11yError.message
        };
    }

    // Run axe-core separately for additional testing
    const browser = await puppeteer.launch({
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ],
        headless: 'new'
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

        // Take a screenshot of the initial viewport
        let pageScreenshot = null;
        try {
            pageScreenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
        } catch (e) {
            console.error('Failed to take page screenshot:', e);
        }

        // Inject axe-core and run it
        try {
            await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.2/axe.min.js' });
            axeResults = await page.evaluate(async (axeTag) => {
                return await window.axe.run(document, { 
                    resultTypes: ['violations', 'passes', 'incomplete'],
                    runOnly: {
                        type: 'tag',
                        values: [axeTag]
                    },
                    rules: {
                        'color-contrast': { enabled: true },
                        'document-title': { enabled: true },
                        'html-has-lang': { enabled: true },
                        'image-alt': { enabled: true },
                        'link-name': { enabled: true },
                        'meta-viewport': { enabled: true }
                    }
                });
            }, axeTag);
        } catch (axeError) {
            console.error('Axe-core test failed:', axeError);
            axeResults = {
                violations: [],
                passes: [],
                incomplete: [],
                error: axeError.message
            };
        }

        // Process Pa11y issues with screenshots
        pa11yIssuesWithScreens = await Promise.all(
            (pa11yResult.issues || []).map(async (issue) => {
                if (!issue.selector) return { ...issue, screenshot: null };
                const screenshot = await getElementScreenshot(page, issue.selector);
                return { ...issue, screenshot };
            })
        );

        // Process Pa11y passed tests WITHOUT screenshots
        pa11yPassedWithScreens = (pa11yResult.passed || []).map((passed) => ({
            ...passed,
            screenshot: null
        }));

        // Process Axe violations with screenshots
        axeViolationsWithScreens = await Promise.all(
            (axeResults.violations || []).map(async (violation) => {
                const nodesWithScreens = await Promise.all(
                    violation.nodes.map(async (node) => {
                        const selector = (node.target && node.target[0]) || null;
                        if (!selector) return { ...node, screenshot: null };
                        const screenshot = await getElementScreenshot(page, selector);
                        return { ...node, screenshot };
                    })
                );
                return { ...violation, nodes: nodesWithScreens };
            })
        );

        // Process Axe passes WITHOUT screenshots
        const axePassesWithScreens = (axeResults.passes || []).map((pass) => ({
            ...pass,
            nodes: pass.nodes.map((node) => ({ ...node, screenshot: null }))
        }));

        // Return all results with screenshots
        return {
            pa11y: { 
                ...pa11yResult, 
                issues: pa11yIssuesWithScreens,
                passed: pa11yPassedWithScreens
            },
            axe: { 
                ...axeResults, 
                violations: axeViolationsWithScreens,
                passes: axePassesWithScreens
            },
            pageScreenshot: pageScreenshot ? `data:image/png;base64,${pageScreenshot}` : null
        };

    } catch (e) {
        console.error('Scan error:', e);
        axeResults = axeResults || { error: e.message };
        return {
            pa11y: { ...pa11yResult, issues: pa11yIssuesWithScreens, passed: pa11yPassedWithScreens },
            axe: { ...axeResults, violations: axeViolationsWithScreens }
        };
    } finally {
        await browser.close();
    }
};

function isPrivateIp(ip) {
    // IPv4
    if (net.isIPv4(ip)) {
        return (
            ip.startsWith('10.') ||
            ip.startsWith('192.168.') ||
            ip.startsWith('127.') ||
            ip.startsWith('169.254.') ||
            (ip >= '172.16.0.0' && ip <= '172.31.255.255')
        );
    }
    // IPv6
    if (net.isIPv6(ip)) {
        return (
            ip === '::1' ||
            ip.startsWith('fc') ||
            ip.startsWith('fd')
        );
    }
    return false;
}
