import dotenv from 'dotenv';
dotenv.config();
// ---------- CONFIG ----------
const HEADLESS = process.argv.includes('--headless');

export { HEADLESS };