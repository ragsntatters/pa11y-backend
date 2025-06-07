import pa11y from 'pa11y';
import puppeteer from 'puppeteer';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export const runScan = async (url) => {
    // Run Pa11y
    const pa11yResult = await pa11y(url, {
        chromeLaunchConfig: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: 'new'
        },
        page: async (page) => {
            await page.setUserAgent(USER_AGENT);
        },
        includeNotices: true,
        includeWarnings: true,
        standard: 'WCAG2AA'
    });

    // Run axe-core
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: 'new'
    });
    let axeResults = null;
    try {
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        // Inject axe-core
        await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.2/axe.min.js' });
        axeResults = await page.evaluate(async () => {
            return await window.axe.run(document, { resultTypes: ['violations', 'incomplete'] });
        });
    } catch (e) {
        axeResults = { error: e.message };
    } finally {
        await browser.close();
    }

    // Return both results
    return {
        pa11y: pa11yResult,
        axe: axeResults
    };
};
