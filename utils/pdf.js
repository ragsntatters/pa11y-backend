import puppeteer from 'puppeteer';

export const generatePDF = async (report) => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(\`
    <html><body>
      <h1>Accessibility Report</h1>
      <p>URL: \${report.url}</p>
      <pre>\${JSON.stringify(report.result, null, 2)}</pre>
    </body></html>
  \`);
  const pdf = await page.pdf({ format: 'A4' });
  await browser.close();
  return pdf;
};