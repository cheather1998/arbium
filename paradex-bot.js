import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import { main } from './src/core/main.js';

// Load environment variables
dotenv.config();

// Configure Puppeteer with Stealth plugin
puppeteer.use(StealthPlugin());




main().catch(console.error);

