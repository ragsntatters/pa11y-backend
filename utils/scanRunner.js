import pa11y from 'pa11y';
export const runScan = async (url) => await pa11y(url);