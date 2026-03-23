/**
 * Minimize-safe DOM-level actions for Puppeteer.
 *
 * Standard Puppeteer methods like elementHandle.click() and elementHandle.type()
 * use coordinate-based mouse events (CDP Input.dispatchMouseEvent) which fail
 * when the browser window is minimized (coordinates become invalid/negative).
 *
 * These helpers use DOM-level operations that work regardless of window state.
 */

/**
 * DOM-level click — works even when browser is minimized.
 * Replaces: await element.click()
 */
async function safeClick(page, elementHandle) {
  await page.evaluate(el => el.click(), elementHandle);
}

/**
 * DOM-level focus + keyboard type — works even when browser is minimized.
 * Replaces: await element.type(text, { delay })
 *
 * Note: elementHandle.type() internally calls click() for focus (coordinate-based).
 * This version uses el.focus() (DOM-level) then page.keyboard.type().
 */
async function safeType(page, elementHandle, text, options = {}) {
  await page.evaluate(el => el.focus(), elementHandle);
  await page.keyboard.type(text, { delay: options.delay || 0 });
}

/**
 * DOM-level select-all + type — works even when browser is minimized.
 * Replaces: await element.click({ clickCount: 3 }); await element.type(text, { delay })
 */
async function safeClearAndType(page, elementHandle, text, options = {}) {
  await page.evaluate(el => { el.focus(); el.select(); }, elementHandle);
  await page.keyboard.type(text, { delay: options.delay || 0 });
}

export { safeClick, safeType, safeClearAndType };
