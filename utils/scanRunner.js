import pa11y from 'pa11y';
import puppeteer from 'puppeteer';

export const runScan = async (url) => {
    // Run Pa11y
    const pa11yResult = await pa11y(url, {
        chromeLaunchConfig: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: 'new'
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