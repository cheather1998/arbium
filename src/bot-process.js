/**
 * Bot subprocess entry point for Electron.
 * Runs as a child process via fork(), communicates with Electron main process via IPC.
 */
import dotenv from 'dotenv';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mainWithMode } from './core/main.js';

// In Electron packaged mode, .env is in userData directory (passed via DOTENV_CONFIG_PATH)
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
puppeteer.use(StealthPlugin());

// Redirect console to send logs via IPC
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function sendLog(level, args) {
  const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  // Still write to stdout/stderr so Electron can capture it
  if (level === 'error') {
    originalError.apply(console, args);
  } else if (level === 'warn') {
    originalWarn.apply(console, args);
  } else {
    originalLog.apply(console, args);
  }
  // Also send structured message via IPC
  if (process.send) {
    process.send({ type: 'log', level, message });
  }
}

console.log = (...args) => sendLog('info', args);
console.error = (...args) => sendLog('error', args);
console.warn = (...args) => sendLog('warn', args);

// Send status updates to Electron
export function sendStatusUpdate(data) {
  if (process.send) {
    process.send({ type: 'status', data });
  }
}

// Listen for messages from Electron main process
process.on('message', async (msg) => {
  if (msg.type === 'start') {
    const { mode } = msg;
    console.log(`[BOT-PROCESS] Received start command for mode: ${JSON.stringify(mode)}`);

    try {
      await mainWithMode(mode);
    } catch (err) {
      console.error(`[BOT-PROCESS] Fatal error: ${err.message}`);
      console.error(err.stack);
    }
  } else if (msg.type === 'stop') {
    console.log('[BOT-PROCESS] Received stop command. Shutting down...');
    // Set global flag so shutdown handler skips position closing
    global.__FORCE_STOP__ = true;
    // Trigger SIGINT handler for graceful shutdown
    process.emit('SIGINT');
    // Give browsers more time to close (shutdown handler needs time)
    setTimeout(() => {
      if (process.send) {
        process.send({ type: 'stopped' });
      }
      process.exit(0);
    }, 8000);
  }
});

// Handle unexpected errors
process.on('uncaughtException', (err) => {
  console.error(`[BOT-PROCESS] Uncaught exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[BOT-PROCESS] Unhandled rejection: ${reason}`);
});
