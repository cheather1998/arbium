import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || ".env" });
// ---------- CONFIG ----------
const HEADLESS = process.argv.includes('--headless');

export { HEADLESS };