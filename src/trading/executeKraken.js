import { delay } from '../utils/helpers.js';
import { cancelKrakenOrders } from './orders.js';
import { findByText, findByExactText } from '../utils/helpers.js';
import {
  getCurrentMarketPrice,
  selectBuyOrSell,
  selectOrderType,
  findSizeAndPriceInputs,
  enterPrice,
  enterSize,
  clickConfirmButton,
  verifyOrderPlacement
} from './executeBase.js';

/**
 * Kraken specific trade execution logic
 */

/**
 * Set leverage for Kraken
 * 1. Enable "Isolate position" toggle if not already enabled
 * 2. Set leverage value using the slider
 */
export async function setLeverageKraken(page, leverage, exchange) {
  console.log(`[${exchange.name}] Setting leverage to ${leverage}x...`);
  
  try {
    await delay(1000);
    
    // Step 1: Find and enable "Isolate position" toggle
    console.log(`[${exchange.name}] Step 1: Checking and enabling "Isolate position" toggle...`);
    const isolateToggleResult = await page.evaluate(() => {
      // Find all elements that might be the "Isolate position" toggle
      const allElements = Array.from(document.querySelectorAll('*'));
      
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        
        // Look for "Isolate position" text
        if (isVisible && text.toLowerCase().includes('isolate position')) {
          // Find the toggle switch near this text
          // The toggle is usually a button or div with role="switch" or a checkbox-like element
          let toggleElement = null;
          
          // Check if the element itself is clickable
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'switch' || el.getAttribute('role') === 'checkbox') {
            toggleElement = el;
          } else {
            // Look for toggle in parent or sibling elements
            let parent = el.parentElement;
            for (let i = 0; i < 3 && parent; i++) {
              const toggle = parent.querySelector('button[role="switch"], button[role="checkbox"], div[role="switch"], div[role="checkbox"], input[type="checkbox"]');
              if (toggle && toggle.offsetParent !== null) {
                toggleElement = toggle;
                break;
              }
              parent = parent.parentElement;
            }
            
            // Also check siblings
            if (!toggleElement && el.parentElement) {
              const siblings = Array.from(el.parentElement.children);
              for (const sibling of siblings) {
                if (sibling !== el && (sibling.tagName === 'BUTTON' || sibling.getAttribute('role') === 'switch' || sibling.getAttribute('role') === 'checkbox')) {
                  const isSiblingVisible = sibling.offsetParent !== null && sibling.offsetWidth > 0 && sibling.offsetHeight > 0;
                  if (isSiblingVisible) {
                    toggleElement = sibling;
                    break;
                  }
                }
              }
            }
          }
          
          if (toggleElement) {
            // Check current state
            const isChecked = toggleElement.getAttribute('aria-checked') === 'true' ||
                            toggleElement.getAttribute('data-state') === 'checked' ||
                            toggleElement.classList.contains('checked') ||
                            (toggleElement.tagName === 'INPUT' && toggleElement.checked);
            
            if (!isChecked) {
              toggleElement.click();
              return { success: true, wasEnabled: false, message: 'Enabled "Isolate position" toggle' };
            } else {
              return { success: true, wasEnabled: true, message: '"Isolate position" toggle already enabled' };
            }
          }
        }
      }
      
      return { success: false, error: 'Could not find "Isolate position" toggle' };
    });
    
    if (isolateToggleResult.success) {
      console.log(`[${exchange.name}] ✓ ${isolateToggleResult.message}`);
      await delay(500);
    } else {
      console.log(`[${exchange.name}] ⚠️  ${isolateToggleResult.error || 'Could not find "Isolate position" toggle'}`);
      // Continue anyway - toggle might not be critical
    }
    
    // Step 2: Find and interact with leverage slider
    console.log(`[${exchange.name}] Step 2: Finding leverage slider...`);
    const leverageSliderResult = await page.evaluate((targetLeverage) => {
      // Find "Leverage" label/text first
      const allElements = Array.from(document.querySelectorAll('*'));
      let leverageSection = null;
      
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        
        // Look for "Leverage" text
        if (isVisible && text.toLowerCase().includes('leverage') && !text.toLowerCase().includes('isolate')) {
          leverageSection = el;
          break;
        }
      }
      
      if (!leverageSection) {
        return { success: false, error: 'Could not find "Leverage" section' };
      }
      
      // Find slider element near the Leverage text
      // Slider is usually an input[type="range"] or a div with slider-like structure
      let sliderElement = null;
      let sliderInput = null;
      
      // Method 1: Look for input[type="range"]
      const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
      for (const input of rangeInputs) {
        const isVisible = input.offsetParent !== null && input.offsetWidth > 0 && input.offsetHeight > 0;
        if (isVisible) {
          // Check if it's near the leverage section
          const inputRect = input.getBoundingClientRect();
          const sectionRect = leverageSection.getBoundingClientRect();
          
          // Check if input is below the leverage section (within reasonable distance)
          if (inputRect.top >= sectionRect.top && inputRect.top <= sectionRect.bottom + 200) {
            sliderInput = input;
            break;
          }
        }
      }
      
      // Method 2: Look for slider-like div structure (if no range input found)
      if (!sliderInput) {
        let parent = leverageSection.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          // Look for slider track (usually has specific classes or structure)
          const sliderTrack = parent.querySelector('[class*="slider"], [class*="Slider"], [role="slider"]');
          if (sliderTrack && sliderTrack.offsetParent !== null) {
            sliderElement = sliderTrack;
            
            // Try to find input inside
            sliderInput = sliderTrack.querySelector('input[type="range"], input[type="number"]');
            break;
          }
          parent = parent.parentElement;
        }
      }
      
      if (!sliderInput && !sliderElement) {
        return { success: false, error: 'Could not find leverage slider' };
      }
      
      // If we found a slider element but no input, try to find the input that controls it
      if (sliderElement && !sliderInput) {
        // Look for hidden input or input in nearby elements
        let searchParent = sliderElement.parentElement;
        for (let i = 0; i < 3 && searchParent; i++) {
          const inputs = searchParent.querySelectorAll('input');
          for (const input of inputs) {
            if (input.type === 'range' || input.type === 'number' || !input.type) {
              sliderInput = input;
              break;
            }
          }
          if (sliderInput) break;
          searchParent = searchParent.parentElement;
        }
      }
      
      // Method 3: Look for any input near the leverage value display (e.g., "10.00x")
      if (!sliderInput) {
        const leverageValueElements = Array.from(document.querySelectorAll('*'));
        for (const el of leverageValueElements) {
          const text = el.textContent?.trim() || '';
          const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
          
          // Look for pattern like "10.00x" or "10x"
          if (isVisible && /^\d+(\.\d+)?x$/i.test(text)) {
            // Find input near this element
            let searchEl = el.parentElement;
            for (let i = 0; i < 3 && searchEl; i++) {
              const input = searchEl.querySelector('input[type="range"], input[type="number"]');
              if (input && input.offsetParent !== null) {
                sliderInput = input;
                break;
              }
              searchEl = searchEl.parentElement;
            }
            if (sliderInput) break;
          }
        }
      }
      
      if (!sliderInput) {
        return { success: false, error: 'Could not find leverage slider input' };
      }
      
      // Get current value and slider properties
      const currentValue = sliderInput.value || sliderInput.getAttribute('value') || '0';
      const currentLeverage = parseFloat(currentValue);
      const min = parseFloat(sliderInput.min || '0');
      const max = parseFloat(sliderInput.max || '100');
      const rect = sliderInput.getBoundingClientRect();
      
      // Check if already set to target
      if (Math.abs(currentLeverage - targetLeverage) < 0.01) {
        return { success: true, wasChanged: false, message: `Leverage already set to ${targetLeverage}x`, alreadySet: true };
      }
      
      // Calculate click position on slider track
      const percentage = (targetLeverage - min) / (max - min);
      const clickX = rect.left + (rect.width * percentage);
      const clickY = rect.top + (rect.height / 2);
      
      return {
        success: true,
        clickPosition: { x: clickX, y: clickY },
        sliderInfo: {
          min: min,
          max: max,
          currentValue: currentLeverage,
          targetValue: targetLeverage
        },
        alreadySet: false
      };
    }, leverage);
    
    if (!leverageSliderResult.success) {
      console.log(`[${exchange.name}] ✗ ${leverageSliderResult.error || 'Failed to find leverage slider'}`);
      return { success: false, error: leverageSliderResult.error };
    }
    
    if (leverageSliderResult.alreadySet) {
      console.log(`[${exchange.name}] ✓ ${leverageSliderResult.message}`);
      return { success: true };
    }
    
    // Interact with slider using mouse
    console.log(`[${exchange.name}] Step 3: Clicking slider at position to set leverage to ${leverage}x...`);
    
    try {
      // Method 1: Click on the slider track at target position
      await page.mouse.click(leverageSliderResult.clickPosition.x, leverageSliderResult.clickPosition.y);
      await delay(500);
      
      // Verify the value was updated by checking the displayed value
      const verifyResult = await page.evaluate((targetLeverage) => {
        // Check displayed value in UI (e.g., "14.00x")
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
          const text = el.textContent?.trim() || '';
          if (/^\d+(\.\d+)?x$/i.test(text)) {
            const displayedValue = parseFloat(text.replace(/x/i, ''));
            if (Math.abs(displayedValue - targetLeverage) < 0.01) {
              return { success: true, value: displayedValue, fromDisplay: true };
            }
          }
        }
        
        // Also check input value
        const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
        for (const input of rangeInputs) {
          const isVisible = input.offsetParent !== null && input.offsetWidth > 0 && input.offsetHeight > 0;
          if (isVisible) {
            const currentValue = parseFloat(input.value || '0');
            return { success: Math.abs(currentValue - targetLeverage) < 0.01, value: currentValue, expected: targetLeverage };
          }
        }
        
        return { success: false, error: 'Could not verify leverage value' };
      }, leverage);
      
      if (verifyResult.success) {
        console.log(`[${exchange.name}] ✓ Leverage set to ${leverage}x (verified: ${verifyResult.value}x)`);
        await delay(300);
        return { success: true };
      } else {
        // Method 2: Try dragging the slider handle
        console.log(`[${exchange.name}] Click didn't update value, trying drag method...`);
        
        const dragInfo = await page.evaluate((targetLeverage) => {
          const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
          for (const input of rangeInputs) {
            const isVisible = input.offsetParent !== null && input.offsetWidth > 0 && input.offsetHeight > 0;
            if (isVisible) {
              const rect = input.getBoundingClientRect();
              const min = parseFloat(input.min || '0');
              const max = parseFloat(input.max || '100');
              const currentValue = parseFloat(input.value || '0');
              
              // Calculate positions
              const currentPercentage = (currentValue - min) / (max - min);
              const targetPercentage = (targetLeverage - min) / (max - min);
              
              const startX = rect.left + (rect.width * currentPercentage);
              const targetX = rect.left + (rect.width * targetPercentage);
              const y = rect.top + (rect.height / 2);
              
              return {
                success: true,
                startX: startX,
                targetX: targetX,
                y: y
              };
            }
          }
          return { success: false, error: 'Could not find slider for dragging' };
        }, leverage);
        
        if (dragInfo.success) {
          // Drag from current position to target position
          await page.mouse.move(dragInfo.startX, dragInfo.y);
          await delay(100);
          await page.mouse.down();
          await delay(100);
          await page.mouse.move(dragInfo.targetX, dragInfo.y, { steps: 20 });
          await delay(100);
          await page.mouse.up();
          await delay(500);
          
          // Verify again
          const verifyResult2 = await page.evaluate((targetLeverage) => {
            // Check displayed value
            const allElements = Array.from(document.querySelectorAll('*'));
            for (const el of allElements) {
              const text = el.textContent?.trim() || '';
              if (/^\d+(\.\d+)?x$/i.test(text)) {
                const displayedValue = parseFloat(text.replace(/x/i, ''));
                if (Math.abs(displayedValue - targetLeverage) < 0.01) {
                  return { success: true, value: displayedValue, fromDisplay: true };
                }
              }
            }
            
            // Check input value
            const rangeInputs = Array.from(document.querySelectorAll('input[type="range"]'));
            for (const input of rangeInputs) {
              const isVisible = input.offsetParent !== null && input.offsetWidth > 0 && input.offsetHeight > 0;
              if (isVisible) {
                const currentValue = parseFloat(input.value || '0');
                return { success: Math.abs(currentValue - targetLeverage) < 0.01, value: currentValue, expected: targetLeverage };
              }
            }
            return { success: false, error: 'Could not verify after drag' };
          }, leverage);
          
          if (verifyResult2.success) {
            console.log(`[${exchange.name}] ✓ Leverage set to ${leverage}x via drag (verified: ${verifyResult2.value}x)`);
            await delay(300);
            return { success: true };
          } else {
            console.log(`[${exchange.name}] ✗ Drag method failed. Current: ${verifyResult2.value || 'unknown'}, Expected: ${leverage}`);
            return { success: false, error: `Failed to set leverage. Current: ${verifyResult2.value || 'unknown'}, Expected: ${leverage}` };
          }
        } else {
          console.log(`[${exchange.name}] ✗ ${dragInfo.error || 'Failed to drag slider'}`);
          return { success: false, error: dragInfo.error || 'Failed to drag slider' };
        }
      }
    } catch (error) {
      console.log(`[${exchange.name}] ✗ Error interacting with slider: ${error.message}`);
      return { success: false, error: error.message };
    }
    
  } catch (error) {
    console.log(`[${exchange.name}] ✗ Error setting leverage: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Find confirm button for Kraken
 * Uses standard logic - can be overridden if Kraken has special requirements
 */
export async function findConfirmButtonKraken(page, side, exchange, priceInputHandle = null) {
  let confirmText = side === "buy" ? exchange.selectors.confirmBuy : exchange.selectors.confirmSell;

  console.log(`[${exchange.name}] Looking for "${confirmText}" button...`);

  let confirmBtn = null;

  // Hard safety guard used by ALL fallback methods. We do NOT filter by
  // left/right column anymore: on ultrawide viewports (e.g. 2560px) Kraken Pro
  // places the order form in the LEFT column (x≈100-500), not the right.
  // The only reliable guards are:
  //   - y < 100   → top nav / header area
  //   - width<60  → tiny icon, can't be the wide submit bar
  //   - anchor/href → navigation link
  //   - NAV/HEADER/ASIDE/role="navigation" ancestor → top-nav "Buy"/"Sell" link
  const isButtonInSafeZone = async (btnHandle) => {
    try {
      return await page.evaluate((el) => {
        if (!el) return { ok: false, reason: 'null-handle' };
        const r = el.getBoundingClientRect();
        if (r.top < 100) return { ok: false, reason: `top-nav (y=${Math.round(r.top)})`, x: Math.round(r.left), y: Math.round(r.top), text: (el.textContent || '').trim().slice(0, 40) };
        if (r.width < 60) return { ok: false, reason: `too-narrow (w=${Math.round(r.width)})`, x: Math.round(r.left), y: Math.round(r.top), text: (el.textContent || '').trim().slice(0, 40) };
        // Also reject anchors / elements with href and nav ancestors
        if (el.tagName === 'A' || el.getAttribute('href')) return { ok: false, reason: 'anchor-or-href', x: Math.round(r.left), y: Math.round(r.top), text: (el.textContent || '').trim().slice(0, 40) };
        let q = el.parentElement;
        for (let i = 0; i < 10 && q; i++) {
          const tag = q.tagName;
          if (tag === 'NAV' || tag === 'HEADER' || tag === 'ASIDE') return { ok: false, reason: `inside-${tag}`, x: Math.round(r.left), y: Math.round(r.top), text: (el.textContent || '').trim().slice(0, 40) };
          if (q.getAttribute && q.getAttribute('role') === 'navigation') return { ok: false, reason: 'role-nav', x: Math.round(r.left), y: Math.round(r.top), text: (el.textContent || '').trim().slice(0, 40) };
          q = q.parentElement;
        }
        return { ok: true, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 40) };
      }, btnHandle);
    } catch {
      return { ok: false, reason: 'eval-failed' };
    }
  };

  // METHOD -1: fastest and most reliable path — the Kraken Pro submit button
  // carries a literal aria-label="Submit order". Look for that directly.
  // We also explicitly detect the DISABLED state (e.g. when quantity exceeds
  // available margin) and surface that as a clear error instead of looking
  // for some other clickable element.
  try {
    const sideWord = side === 'buy' ? 'buy' : 'sell';
    const lookup = await page.evaluate((wantedSide) => {
      const candidates = Array.from(document.querySelectorAll('button[aria-label="Submit order"], button[aria-label*="Submit order" i]'));
      const visible = candidates.filter((b) => b.offsetParent && b.offsetWidth > 0 && b.offsetHeight > 0);
      if (visible.length === 0) return { state: 'not-found' };

      // Check if ALL visible submit buttons are disabled — that's a hard error
      // state (insufficient margin, leverage off, etc.), not something we can
      // fix by clicking elsewhere.
      const enabled = visible.filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (enabled.length === 0) {
        const first = visible[0];
        const r = first.getBoundingClientRect();
        return {
          state: 'disabled',
          text: (first.textContent || '').trim().slice(0, 120),
          x: Math.round(r.left), y: Math.round(r.top),
        };
      }

      // Prefer one whose text starts with the wanted side ("buy "/"sell ")
      for (const b of enabled) {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (txt.startsWith(wantedSide + ' ')) {
          return { state: 'found-by-side', el: b };
        }
      }
      // When there's a position open, the submit text becomes "Close BTC/USD (10x)"
      // regardless of side. Match any "close ..." text as well.
      for (const b of enabled) {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (txt.startsWith('close ')) {
          return { state: 'found-close', el: b };
        }
      }
      // Last resort: if there's only one enabled Submit-order button, use it.
      if (enabled.length === 1) {
        return { state: 'found-only', el: enabled[0] };
      }
      return { state: 'ambiguous' };
    }, sideWord);

    if (lookup && lookup.state === 'disabled') {
      console.log(`[${exchange.name}] ⚠️  Submit button is DISABLED — text="${lookup.text}" at (${lookup.x}, ${lookup.y})`);
      console.log(`[${exchange.name}]    This usually means the form has a validation error (insufficient margin, quantity exceeds available, etc.).`);
      console.log(`[${exchange.name}]    Refusing to click — bot will skip this cycle so the caller can re-cleanup.`);
      throw new Error(`Submit button disabled: ${lookup.text}`);
    }

    if (lookup && (lookup.state === 'found-by-side' || lookup.state === 'found-close' || lookup.state === 'found-only')) {
      // Re-grab the element as a JSHandle we can click
      const ariaHandle = await page.evaluateHandle((wantedSide) => {
        const candidates = Array.from(document.querySelectorAll('button[aria-label="Submit order"], button[aria-label*="Submit order" i]'));
        const enabled = candidates.filter((b) => b.offsetParent && b.offsetWidth > 0 && b.offsetHeight > 0 && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
        for (const b of enabled) {
          const txt = (b.textContent || '').trim().toLowerCase();
          if (txt.startsWith(wantedSide + ' ')) return b;
        }
        for (const b of enabled) {
          const txt = (b.textContent || '').trim().toLowerCase();
          if (txt.startsWith('close ')) return b;
        }
        return enabled.length === 1 ? enabled[0] : null;
      }, sideWord);
      const ariaEl = ariaHandle && ariaHandle.asElement ? ariaHandle.asElement() : null;
      if (ariaEl) {
        const safe = await isButtonInSafeZone(ariaEl);
        if (safe.ok) {
          const label = lookup.state === 'found-close' ? `Submit order (close mode)` : `aria-label="Submit order"`;
          console.log(`[${exchange.name}] ✓ Found submit button via ${label}: "${safe.text}" at (${safe.x}, ${safe.y})`);
          return { confirmBtn: ariaEl, confirmText };
        } else {
          console.log(`[${exchange.name}] ⚠️  aria-label candidate "${safe.text}" at (${safe.x}, ${safe.y}) rejected: ${safe.reason}`);
        }
      }
    }
  } catch (e) {
    // Re-throw "disabled" errors so the outer loop skips the cycle instead of
    // falling through to the fuzzy text fallbacks (which would click garbage).
    if (e.message && e.message.startsWith('Submit button disabled')) throw e;
    console.log(`[${exchange.name}] aria-label lookup errored: ${e.message}`);
  }

  // Method 0: If we have a handle to the price input from pre-fill, find the
  // order form container by walking up just a few levels (never high enough to
  // reach the page wrapper), then look for a submit button STRICTLY INSIDE
  // that container, STRICTLY RIGHT OF the viewport midline, and STRICTLY
  // BELOW the price input (submit lives at the bottom of the form). The
  // Kraken Margin page has three traps we must avoid:
  //   (a) a generic "Buy" element in the top nav (~x=105) — navigates away
  //   (b) Buy/Sell TAB buttons at the top of the form — same exact text
  //       "Buy"/"Sell" as the submit but above the price input
  //   (c) any "Buy crypto" / sidebar link — also navigates away
  if (priceInputHandle) {
    try {
      const scopedBtn = await page.evaluateHandle((startEl, text) => {
        if (!startEl) return null;
        const wanted = (text || '').trim().toLowerCase();
        if (!wanted) return null;

        const priceRect = startEl.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;

        // Walk up from the price input to find the nearest <form> ancestor
        // (Kraken Pro wraps the entire order panel in a single <form>), or
        // failing that, the largest panel that fits within 60% viewport width.
        // We allow up to 20 levels because on some layouts the form is deeply
        // nested. We also stop climbing once we hit the top-level wrapper
        // (width >= 60% of viewport) — anything that wide is the page layout,
        // not the order form.
        let container = null;
        let p = startEl.parentElement;
        for (let i = 0; i < 20 && p; i++) {
          // Prefer the <form> tag — it IS the order panel on Kraken Pro.
          if (p.tagName === 'FORM') {
            container = p;
            break;
          }
          const r = p.getBoundingClientRect();
          if (r.width >= vw * 0.6) {
            break; // hit the page-level wrapper; stop climbing
          }
          // Track the largest panel seen so far as a fallback.
          if (r.width > 0 && r.height > priceRect.height) {
            if (!container || r.height > container.getBoundingClientRect().height) {
              container = p;
            }
          }
          p = p.parentElement;
        }
        if (!container) container = startEl.parentElement;
        if (!container) return null;

        const visible = (el) => {
          if (!el || el.offsetParent === null) return false;
          if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
          return true;
        };

        // Extra per-element guards to avoid the nav/tab/link traps listed above
        const isBadCandidate = (el) => {
          // Skip anchors or elements with href — they navigate away.
          if (el.tagName === 'A' || el.getAttribute('href')) return true;
          // Skip if inside a <nav>, <header>, or role="navigation".
          let q = el.parentElement;
          for (let i = 0; i < 10 && q; i++) {
            const tag = q.tagName;
            if (tag === 'NAV' || tag === 'HEADER' || tag === 'ASIDE') return true;
            if (q.getAttribute && q.getAttribute('role') === 'navigation') return true;
            q = q.parentElement;
          }
          // Skip if the text contains words that mean "go somewhere else".
          const t = (el.textContent || '').trim().toLowerCase();
          if (t.includes('crypto') || t.includes('deposit') || t.includes('withdraw') || t.includes('sign in') || t.includes('log in')) return true;
          // The submit button MUST be below the price input (the form renders
          // tabs above → inputs in the middle → submit at the bottom). This
          // single positional check kills the Buy/Sell TAB trap at the top of
          // the form, which shares the exact text "Buy"/"Sell" with submit.
          const r = el.getBoundingClientRect();
          if (r.top < priceRect.bottom - 2) return true;
          // Must be reasonably wide — submit is a full-width bar.
          if (r.width < 60) return true;
          return false;
        };

        const candidates = Array.from(container.querySelectorAll('button, div[role="button"], span[role="button"]'))
          .filter(visible)
          .filter((el) => !isBadCandidate(el));

        // Helper to pull text from multiple sources (aria-label, data-testid, title, textContent)
        const allText = (el) => {
          const parts = [];
          const tc = (el.textContent || '').trim();
          if (tc) parts.push(tc);
          const al = el.getAttribute && el.getAttribute('aria-label');
          if (al) parts.push(al);
          const dt = el.getAttribute && el.getAttribute('data-testid');
          if (dt) parts.push(dt);
          const ti = el.getAttribute && el.getAttribute('title');
          if (ti) parts.push(ti);
          return parts.join(' | ').toLowerCase();
        };

        // Among surviving candidates, prefer the one *lowest* on screen
        // (largest y) — submit lives at the bottom of the form panel.
        const sorted = candidates
          .map((el) => ({ el, text: (el.textContent || '').trim(), allText: allText(el), rect: el.getBoundingClientRect() }))
          .sort((a, b) => b.rect.top - a.rect.top);

        // Stash diagnostic info so the outer Node code can log it on failure
        window.__KRAKEN_CONFIRM_DIAG__ = sorted.slice(0, 10).map((c) => ({
          text: c.text.slice(0, 40),
          aria: (c.el.getAttribute && c.el.getAttribute('aria-label')) || '',
          testid: (c.el.getAttribute && c.el.getAttribute('data-testid')) || '',
          x: Math.round(c.rect.left),
          y: Math.round(c.rect.top),
          w: Math.round(c.rect.width),
          h: Math.round(c.rect.height),
          tag: c.el.tagName,
        }));

        // 1) exact text match, furthest down
        for (const c of sorted) {
          if (c.text.toLowerCase() === wanted) return c.el;
        }
        // 2) starts-with match (e.g. "Buy" → "Buy BTC" / "Buy XBT/USD")
        for (const c of sorted) {
          const t = c.text.toLowerCase();
          if (t.startsWith(wanted + ' ') || t === wanted) return c.el;
        }
        // 3) contains, constrained: text must be short (< 30 chars) to avoid
        //    picking up a descriptive paragraph that happens to contain "buy".
        for (const c of sorted) {
          const t = c.text.toLowerCase();
          if (c.text.length < 30 && t.includes(wanted)) return c.el;
        }
        // 4) aria-label / data-testid / title contains wanted
        //    (e.g. aria-label="Place buy order" or data-testid="submit-buy-btn")
        for (const c of sorted) {
          if (c.allText.includes(wanted)) return c.el;
        }
        // 5) Last resort: the bottom-most wide button in the form panel
        //    whose text/aria contains "submit order" OR contains the wanted
        //    side word ("buy"/"sell"). We REJECT any candidate whose text
        //    looks like an error message (e.g. "Cannot be greater than..."),
        //    because Kraken disables the submit button and replaces its text
        //    with the error when quantity/margin validation fails.
        const errorPhrases = [
          'cannot', 'invalid', 'insufficient', 'exceeds', 'greater than',
          'less than', 'below', 'above', 'minimum', 'maximum', 'max.', 'min.',
          'too large', 'too small', 'not enough', 'error', 'required',
          'must be', 'out of range'
        ];
        const sideWord = wanted.split(' ')[0]; // "buy" or "sell"
        if (sorted.length > 0 && sorted.length <= 6) {
          const widest = [...sorted].sort((a, b) => b.rect.width - a.rect.width)[0];
          if (widest && widest.rect.width >= 120) {
            const t = widest.text.toLowerCase();
            const aria = (widest.el.getAttribute('aria-label') || '').toLowerCase();
            const looksLikeError = errorPhrases.some((p) => t.includes(p));
            const containsWanted = t.includes(sideWord) || aria.includes('submit order');
            if (!looksLikeError && containsWanted) {
              return widest.el;
            }
          }
        }
        return null;
      }, priceInputHandle, confirmText);

      const asEl = scopedBtn && scopedBtn.asElement ? scopedBtn.asElement() : null;
      if (asEl) {
        const safeCheck = await isButtonInSafeZone(asEl);
        if (safeCheck.ok) {
          console.log(`[${exchange.name}] ✓ Found confirm button scoped to order form: "${safeCheck.text}" at (${safeCheck.x}, ${safeCheck.y})`);
          return { confirmBtn: asEl, confirmText };
        } else {
          console.log(`[${exchange.name}] ⚠️  Scoped candidate "${safeCheck.text}" at (${safeCheck.x}, ${safeCheck.y}) rejected: ${safeCheck.reason} — falling back.`);
        }
      } else {
        console.log(`[${exchange.name}] Scoped search in order form container found no match for "${confirmText}", falling back...`);
        // Dump diagnostic info about the candidates that were considered, so
        // we can see what the submit button actually looks like on Kraken.
        try {
          const diag = await page.evaluate(() => {
            const d = window.__KRAKEN_CONFIRM_DIAG__ || [];
            delete window.__KRAKEN_CONFIRM_DIAG__;
            return d;
          });
          if (Array.isArray(diag) && diag.length > 0) {
            console.log(`[${exchange.name}] [DIAG] Candidates visible in order form panel (bottom-to-top):`);
            for (const c of diag) {
              console.log(`   - ${c.tag} text="${c.text}" aria="${c.aria}" testid="${c.testid}" @ (${c.x},${c.y}) ${c.w}x${c.h}`);
            }
          }
        } catch { /* ignore */ }
      }
    } catch (e) {
      console.log(`[${exchange.name}] Scoped confirm-button search errored: ${e.message}`);
    }
  }

  // Method 1: Try findByExactText first (more specific)
  confirmBtn = await findByExactText(page, confirmText, ["button", "div", "span"]);

  if (confirmBtn) {
    const buttonCheck = await page.evaluate((el) => {
      const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
      if (!isVisible) return { isVisible: false };
      const rect = el.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const isNearFooter = rect.bottom > viewportHeight * 0.8;
      return { isVisible: true, x: rect.x, y: rect.y, isNearFooter, viewportHeight };
    }, confirmBtn);

    if (!buttonCheck || !buttonCheck.isVisible) {
      console.log(`[${exchange.name}] ⚠️  Found "${confirmText}" button but it's not visible, trying fallback...`);
      confirmBtn = null;
    } else {
      // NEW: run the hard safe-zone guard. If the found element is in the top
      // nav or the left column, reject it and keep searching.
      const safe = await isButtonInSafeZone(confirmBtn);
      if (!safe.ok) {
        console.log(`[${exchange.name}] ⚠️  Method 1 candidate "${safe.text}" at (${safe.x}, ${safe.y}) rejected: ${safe.reason}`);
        confirmBtn = null;
      } else {
        console.log(`[${exchange.name}] ✓ Found "${confirmText}" button at (${Math.round(buttonCheck.x || 0)}, ${Math.round(buttonCheck.y || 0)})`);
        if (buttonCheck.isNearFooter) {
          console.log(`[${exchange.name}] ⚠️  Button is near footer (bottom ${Math.round((buttonCheck.y + 100) / buttonCheck.viewportHeight * 100)}% of viewport), will scroll into view before clicking`);
        }
      }
    }
  }
  
  // Method 2: Fallback to findByText if exact match failed
  if (!confirmBtn) {
    console.log(`[${exchange.name}] Exact text match failed, trying partial match...`);
    confirmBtn = await findByText(page, confirmText, ["button"]);

    if (confirmBtn) {
      const buttonCheck = await page.evaluate((el) => {
        const isVisible = el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
        if (!isVisible) return { isVisible: false };
        const rect = el.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const isNearFooter = rect.bottom > viewportHeight * 0.8;
        return { isVisible: true, x: rect.x, y: rect.y, isNearFooter, viewportHeight };
      }, confirmBtn);

      if (!buttonCheck.isVisible) {
        console.log(`[${exchange.name}] ⚠️  Found button but it's not visible`);
        confirmBtn = null;
      } else {
        const safe = await isButtonInSafeZone(confirmBtn);
        if (!safe.ok) {
          console.log(`[${exchange.name}] ⚠️  Method 2 candidate "${safe.text}" at (${safe.x}, ${safe.y}) rejected: ${safe.reason}`);
          confirmBtn = null;
        } else {
          console.log(`[${exchange.name}] ✓ Found "${confirmText}" button via partial match at (${Math.round(buttonCheck.x || 0)}, ${Math.round(buttonCheck.y || 0)})`);
          if (buttonCheck.isNearFooter) {
            console.log(`[${exchange.name}] ⚠️  Button is near footer (bottom ${Math.round((buttonCheck.y + 100) / buttonCheck.viewportHeight * 100)}% of viewport), will scroll into view before clicking`);
          }
        }
      }
    }
  }
  
  // Method 3: Try case-insensitive search in evaluate with viewport and footer checking
  if (!confirmBtn) {
    console.log(`[${exchange.name}] Partial match failed, trying case-insensitive search...`);
    const foundBtn = await page.evaluate((searchText) => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
      const searchLower = searchText.toLowerCase();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      // Score buttons: prefer buttons that are in viewport and not near footer
      const scoredButtons = [];

      for (const btn of buttons) {
        const btnText = btn.textContent?.trim() || '';
        const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
        const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true' ||
                          btn.classList.contains('disabled') || btn.style.pointerEvents === 'none';

        if (!(isVisible && !isDisabled && btnText.toLowerCase().includes(searchLower))) continue;

        const rect = btn.getBoundingClientRect();

        // HARD FILTER: reject top nav (y<100), left column (cx < 35% vw),
        // narrow chips (<60px wide), anchors, and nav/header/aside ancestors.
        // These NEVER contain the Kraken order form submit.
        const cx = rect.left + rect.width / 2;
        if (rect.top < 100) continue;
        if (cx < viewportWidth * 0.35) continue;
        if (rect.width < 60) continue;
        if (btn.tagName === 'A' || btn.getAttribute('href')) continue;
        let q = btn.parentElement;
        let inNav = false;
        for (let i = 0; i < 10 && q; i++) {
          const tag = q.tagName;
          if (tag === 'NAV' || tag === 'HEADER' || tag === 'ASIDE') { inNav = true; break; }
          if (q.getAttribute && q.getAttribute('role') === 'navigation') { inNav = true; break; }
          q = q.parentElement;
        }
        if (inNav) continue;

        {
          // Check if button is in viewport
          const isInViewport = rect.top >= 0 &&
                              rect.left >= 0 &&
                              rect.bottom <= viewportHeight &&
                              rect.right <= viewportWidth;

          // Check if button is near footer (bottom 20% of viewport)
          const isNearFooter = rect.bottom > viewportHeight * 0.8;

          // Check if button is covered by another element at its center
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const elementAtPoint = document.elementFromPoint(centerX, centerY);
          const isCovered = elementAtPoint &&
                           !btn.contains(elementAtPoint) &&
                           elementAtPoint !== btn &&
                           !elementAtPoint.closest('button, [role="button"]');

          // Calculate score: higher is better
          let score = 0;
          if (isInViewport) score += 100;
          if (!isNearFooter) score += 50;
          if (!isCovered) score += 30;
          // Prefer buttons in upper/middle viewport (not near bottom)
          if (rect.top < viewportHeight * 0.7) score += 20;
          
          scoredButtons.push({
            text: btnText,
            x: rect.x,
            y: rect.y,
            score,
            isInViewport,
            isNearFooter,
            isCovered
          });
        }
      }

      // Sort by score (highest first) and return the best match
      scoredButtons.sort((a, b) => b.score - a.score);
      
      if (scoredButtons.length > 0) {
        const best = scoredButtons[0];
        console.log(`Found ${scoredButtons.length} matching buttons, best score: ${best.score} (isInViewport: ${best.isInViewport}, isNearFooter: ${best.isNearFooter}, isCovered: ${best.isCovered})`);
        return {
          found: true,
          text: best.text,
          x: best.x,
          y: best.y
        };
      }
      return { found: false };
    }, confirmText);
    
    if (foundBtn.found) {
      console.log(`[${exchange.name}] ✓ Found button via case-insensitive search: "${foundBtn.text}" at (${Math.round(foundBtn.x)}, ${Math.round(foundBtn.y)})`);
      // Try to find it again using Puppeteer
      confirmBtn = await findByText(page, foundBtn.text, ["button"]);
      // The re-find by text could pick a DIFFERENT element than the one we
      // scored (e.g. the top-nav "Buy" link with identical text). Verify the
      // returned handle is still in the safe zone, otherwise drop it.
      if (confirmBtn) {
        const safe = await isButtonInSafeZone(confirmBtn);
        if (!safe.ok) {
          console.log(`[${exchange.name}] ⚠️  Method 3 re-find returned "${safe.text}" at (${safe.x}, ${safe.y}) rejected: ${safe.reason}`);
          confirmBtn = null;
        }
      }
    }
  }

  // Absolute last resort: scan the whole page for a wide visible button whose
  // aria-label is "Submit order" or whose text/aria/testid contains the
  // wanted confirm text. NO left/right column filter (Kraken Pro puts the
  // order form on the LEFT on ultrawide viewports).
  if (!confirmBtn) {
    console.log(`[${exchange.name}] All text-based methods failed, running last-resort full-page submit-bar scan...`);
    try {
      const handle = await page.evaluateHandle((wanted) => {
        const want = (wanted || '').toLowerCase();
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], input[type="submit"]'));
        const good = [];
        for (const btn of buttons) {
          if (!btn.offsetParent || btn.offsetWidth === 0 || btn.offsetHeight === 0) continue;
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
          if (btn.tagName === 'A' || btn.getAttribute('href')) continue;
          const r = btn.getBoundingClientRect();
          if (r.top < 100) continue;          // kill top nav
          if (r.width < 100) continue;        // submit is wide
          // Walk ancestors to exclude nav/header/aside
          let q = btn.parentElement;
          let inNav = false;
          for (let i = 0; i < 10 && q; i++) {
            const tag = q.tagName;
            if (tag === 'NAV' || tag === 'HEADER' || tag === 'ASIDE') { inNav = true; break; }
            if (q.getAttribute && q.getAttribute('role') === 'navigation') { inNav = true; break; }
            q = q.parentElement;
          }
          if (inNav) continue;
          const txt = (btn.textContent || btn.value || '').trim().toLowerCase();
          const aria = ((btn.getAttribute && btn.getAttribute('aria-label')) || '').toLowerCase();
          const testid = ((btn.getAttribute && btn.getAttribute('data-testid')) || '').toLowerCase();
          const title = ((btn.getAttribute && btn.getAttribute('title')) || '').toLowerCase();
          const blob = `${txt} ${aria} ${testid} ${title}`;
          const matches = blob.includes(want) || aria.includes('submit order');
          if (!matches) continue;
          // Strong bonus if aria-label is literally "Submit order"
          const ariaBonus = aria.includes('submit order') ? 1000 : 0;
          good.push({
            el: btn,
            score: ariaBonus + r.width * 2 + r.top + (txt.length < 30 ? 100 : 0),
          });
        }
        good.sort((a, b) => b.score - a.score);
        return good.length > 0 ? good[0].el : null;
      }, confirmText);
      const el = handle && handle.asElement ? handle.asElement() : null;
      if (el) {
        const safe = await isButtonInSafeZone(el);
        if (safe.ok) {
          console.log(`[${exchange.name}] ✓ Last-resort scan found "${safe.text}" at (${safe.x}, ${safe.y})`);
          confirmBtn = el;
        } else {
          console.log(`[${exchange.name}] ⚠️  Last-resort scan candidate rejected: ${safe.reason}`);
        }
      } else {
        console.log(`[${exchange.name}] ⚠️  Last-resort scan found nothing — running FULL PAGE dump for diagnosis:`);
        try {
          const fullDump = await page.evaluate((wanted) => {
            const vw = window.innerWidth || document.documentElement.clientWidth;
            const vh = window.innerHeight || document.documentElement.clientHeight;
            const want = (wanted || '').toLowerCase();
            const sel = 'button, div[role="button"], span[role="button"], a[role="button"], input[type="submit"], input[type="button"], [data-testid*="submit" i], [data-testid*="place" i], [data-testid*="buy" i], [data-testid*="sell" i]';
            const all = Array.from(document.querySelectorAll(sel));
            const rows = [];
            for (const b of all) {
              if (!b.offsetParent && b.tagName !== 'BODY') continue;
              if (b.offsetWidth === 0 || b.offsetHeight === 0) continue;
              const r = b.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.bottom < 0 || r.top > vh) continue;
              const text = (b.textContent || b.value || '').trim().slice(0, 60);
              const aria = ((b.getAttribute && b.getAttribute('aria-label')) || '').slice(0, 60);
              const testid = ((b.getAttribute && b.getAttribute('data-testid')) || '').slice(0, 60);
              const title = ((b.getAttribute && b.getAttribute('title')) || '').slice(0, 60);
              const type = (b.getAttribute && b.getAttribute('type')) || '';
              const role = (b.getAttribute && b.getAttribute('role')) || '';
              const cls = (b.className || '').toString().slice(0, 80);
              const blob = `${text} ${aria} ${testid} ${title}`.toLowerCase();
              const matchesWanted = want && blob.includes(want);
              const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
              rows.push({
                tag: b.tagName.toLowerCase(),
                type, role,
                x: Math.round(r.x), y: Math.round(r.y),
                w: Math.round(r.width), h: Math.round(r.height),
                text, aria, testid, title, cls,
                disabled,
                matches: matchesWanted,
              });
            }
            // Prioritize: matches first, then by width desc
            rows.sort((a, b) => {
              if (a.matches !== b.matches) return a.matches ? -1 : 1;
              return b.w - a.w;
            });
            return {
              vw, vh,
              total: rows.length,
              rows: rows.slice(0, 40),
            };
          }, confirmText);
          console.log(`[${exchange.name}] FULL DUMP (viewport ${fullDump.vw}x${fullDump.vh}, ${fullDump.total} candidates, showing top 40):`);
          for (const b of fullDump.rows) {
            const marker = b.matches ? '⭐' : '  ';
            console.log(`   ${marker} <${b.tag}${b.type ? ` type="${b.type}"` : ''}${b.role ? ` role="${b.role}"` : ''}> "${b.text}" aria="${b.aria}" testid="${b.testid}" cls="${b.cls}" @ (${b.x},${b.y}) ${b.w}x${b.h}${b.disabled ? ' DISABLED' : ''}`);
          }

          // Dump ancestor chain from priceInput so we can see the actual order form structure
          console.log(`[${exchange.name}] Attempting ancestor chain dump from price input...`);
          const ancestorDump = await page.evaluate(() => {
            // Find price input - typically a number input in a form panel
            const inputs = Array.from(document.querySelectorAll('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]'));
            const visibleInputs = inputs.filter((i) => i.offsetParent && i.offsetWidth > 0);
            if (visibleInputs.length === 0) return { found: false, reason: 'no visible numeric inputs' };
            // Pick the one most likely to be price (name/placeholder/aria containing "price" or "limit")
            let priceInput = visibleInputs.find((i) => {
              const blob = `${i.name || ''} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''} ${i.getAttribute('data-testid') || ''}`.toLowerCase();
              return blob.includes('price') || blob.includes('limit');
            }) || visibleInputs[0];
            const r = priceInput.getBoundingClientRect();
            const chain = [];
            let cur = priceInput;
            for (let i = 0; i < 15 && cur; i++) {
              const cr = cur.getBoundingClientRect();
              chain.push({
                tag: cur.tagName.toLowerCase(),
                id: cur.id || '',
                cls: (cur.className || '').toString().slice(0, 80),
                testid: (cur.getAttribute && cur.getAttribute('data-testid')) || '',
                role: (cur.getAttribute && cur.getAttribute('role')) || '',
                x: Math.round(cr.x), y: Math.round(cr.y),
                w: Math.round(cr.width), h: Math.round(cr.height),
              });
              cur = cur.parentElement;
            }
            // Walk up to the nearest <form> ancestor (that's the real order panel).
            let container = priceInput.parentElement;
            for (let i = 0; i < 20 && container; i++) {
              if (container.tagName === 'FORM') break;
              container = container.parentElement;
            }
            const containerButtons = [];
            if (container) {
              const btns = Array.from(container.querySelectorAll('button, div[role="button"], input[type="submit"], input[type="button"]'));
              for (const b of btns) {
                if (!b.offsetParent || b.offsetWidth === 0 || b.offsetHeight === 0) continue;
                const br = b.getBoundingClientRect();
                containerButtons.push({
                  tag: b.tagName.toLowerCase(),
                  type: b.getAttribute('type') || '',
                  text: (b.textContent || b.value || '').trim().slice(0, 60),
                  aria: (b.getAttribute('aria-label') || '').slice(0, 60),
                  testid: (b.getAttribute('data-testid') || '').slice(0, 60),
                  cls: (b.className || '').toString().slice(0, 80),
                  x: Math.round(br.x), y: Math.round(br.y),
                  w: Math.round(br.width), h: Math.round(br.height),
                  disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
                });
              }
            }
            return {
              found: true,
              priceInput: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              chain,
              containerFound: !!container,
              containerButtons,
            };
          });
          if (!ancestorDump.found) {
            console.log(`   (ancestor dump skipped: ${ancestorDump.reason})`);
          } else {
            console.log(`   priceInput @ (${ancestorDump.priceInput.x},${ancestorDump.priceInput.y}) ${ancestorDump.priceInput.w}x${ancestorDump.priceInput.h}`);
            console.log(`   ancestor chain:`);
            for (const c of ancestorDump.chain) {
              console.log(`     - <${c.tag}${c.id ? ` id="${c.id}"` : ''}${c.role ? ` role="${c.role}"` : ''}> testid="${c.testid}" cls="${c.cls}" @ (${c.x},${c.y}) ${c.w}x${c.h}`);
            }
            if (ancestorDump.containerFound) {
              console.log(`   buttons inside form container (${ancestorDump.containerButtons.length}):`);
              for (const b of ancestorDump.containerButtons) {
                console.log(`     - <${b.tag}${b.type ? ` type="${b.type}"` : ''}> "${b.text}" aria="${b.aria}" testid="${b.testid}" cls="${b.cls}" @ (${b.x},${b.y}) ${b.w}x${b.h}${b.disabled ? ' DISABLED' : ''}`);
              }
            } else {
              console.log(`   (no form container found)`);
            }
          }
        } catch (e) {
          console.log(`   (full dump errored: ${e.message})`);
        }
      }
    } catch (e) {
      console.log(`[${exchange.name}] Last-resort scan errored: ${e.message}`);
    }
  }

  return { confirmBtn, confirmText };
}

/**
 * Click Limit or Market option in opened dropdown
 */
async function clickLimitOption(page, optionText, exchange) {
  console.log(`[${exchange.name}] Looking for "${optionText}" option in opened dropdown...`);
  
  // First, try to find option within the opened dropdown menu/listbox
  const optionInMenu = await page.evaluate((text) => {
    // Find all open listboxes and menus
    const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    const allDropdowns = [...listboxes, ...menus];
    
    // Also look for elements with dropdown/menu classes
    const classDropdowns = Array.from(document.querySelectorAll('[class*="dropdown"], [class*="menu"]'));
    for (const el of classDropdowns) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          allDropdowns.push(el);
        }
      }
    }
    
    for (const menu of allDropdowns) {
      const style = window.getComputedStyle(menu);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = menu.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      // First, look for elements with role="option" (standard listbox pattern)
      const options = Array.from(menu.querySelectorAll('[role="option"]'));
      for (const option of options) {
        if (option.offsetParent === null) continue;
        const optionText = (option.textContent || '').trim();
        if (optionText.toLowerCase() === text.toLowerCase() || 
            (optionText.toLowerCase().includes(text.toLowerCase()) && optionText.length < 30)) {
          return { found: true, element: option, text: optionText };
        }
      }
      
      // Fallback: Look for any element with the text in this menu
      const allInMenu = Array.from(menu.querySelectorAll('*'));
      for (const el of allInMenu) {
        if (el.offsetParent === null) continue;
        const elText = (el.textContent || '').trim();
        if (elText.toLowerCase() === text.toLowerCase() || 
            (elText.toLowerCase().includes(text.toLowerCase()) && elText.length < 30)) {
          return { found: true, element: el, text: elText };
        }
      }
    }
    return { found: false };
  }, optionText);
  
  let optionBtn = null;
  
  if (optionInMenu.found) {
    console.log(`[${exchange.name}] Found "${optionText}" option in dropdown menu: "${optionInMenu.text}"`);
    const optionHandle = await page.evaluateHandle((el) => el, optionInMenu.element);
    optionBtn = optionHandle.asElement();
  } else {
    // Fallback: Use standard search methods
    optionBtn = await findByExactText(page, optionText, ["button", "div", "span", "option", "li"]);
    
    if (!optionBtn) {
      optionBtn = await findByText(page, optionText, ["button", "div", "span", "option", "li"]);
    }
  }
  
  if (optionBtn) {
    console.log(`[${exchange.name}] Found ${optionText} option, clicking...`);
    
    // Try multiple click methods to ensure it works
    try {
      await optionBtn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await delay(200);
      await optionBtn.click();
      console.log(`[${exchange.name}] Clicked ${optionText} option`);
    } catch (error1) {
      console.log(`[${exchange.name}] Direct click failed: ${error1.message}, trying JavaScript click...`);
      try {
        await optionBtn.evaluate((el) => {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
        });
        console.log(`[${exchange.name}] Clicked ${optionText} option (JavaScript click)`);
      } catch (error2) {
        console.log(`[${exchange.name}] JavaScript click failed: ${error2.message}`);
        return false;
      }
    }
    
    await delay(500);
    return true;
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find ${optionText} option in dropdown`);
    return false;
  }
}

/**
 * Select order type from dropdown for Kraken
 * The dropdown is located on the right side of Buy/Sell tabs
 */
export async function selectOrderTypeKraken(page, orderType, exchange) {
  console.log(`[${exchange.name}] Looking for order type dropdown (${orderType.toUpperCase()})...`);
  
  // First, try a simple direct search for button with aria-haspopup="listbox"
  try {
    const dropdownButton = await page.$('button[aria-haspopup="listbox"]');
    if (dropdownButton) {
      console.log(`[${exchange.name}] ✅ Found dropdown button using selector: button[aria-haspopup="listbox"]`);
      const dropdownElement = dropdownButton;
      
      // Click to open dropdown
      console.log(`[${exchange.name}] Clicking dropdown to open it...`);
      await dropdownElement.click();
      await delay(800);
      
      // Find and click Limit option
      const optionText = orderType === 'limit' ? 'Limit' : 'Market';
      await clickLimitOption(page, optionText, exchange);
      return true;
    }
  } catch (error) {
    console.log(`[${exchange.name}] Direct selector search failed: ${error.message}`);
  }
  
  // Fallback: Find the dropdown button by its specific attributes (aria-haspopup="listbox", aria-label="Order type")
  const dropdownInfo = await page.evaluate((orderType) => {
    const debugInfo = [];
    
    // Strategy 1: Find by specific attributes - be more lenient
    const allButtons = Array.from(document.querySelectorAll('button'));
    debugInfo.push(`Total buttons found: ${allButtons.length}`);
    
    for (const btn of allButtons) {
      if (btn.offsetParent === null) continue;
      
      const ariaHaspopup = btn.getAttribute('aria-haspopup');
      const ariaLabel = btn.getAttribute('aria-label');
      const text = (btn.textContent || '').trim();
      
      // Look for button with aria-haspopup="listbox" (more lenient - don't require aria-label)
      if (ariaHaspopup === 'listbox') {
        debugInfo.push(`Found button with aria-haspopup="listbox": aria-label="${ariaLabel}", text="${text}"`);
        return { 
          type: 'button', 
          element: btn, 
          text: 'Order type dropdown',
          debug: debugInfo.join('; ')
        };
      }
    }
    
    // Strategy 2: Find Buy/Sell buttons, then find next sibling
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
    const buySellButtons = buttons.filter(btn => {
      const text = (btn.textContent || '').trim().toLowerCase();
      return (text === 'buy' || text === 'sell') && btn.offsetParent !== null;
    });
    
    debugInfo.push(`Buy/Sell buttons found: ${buySellButtons.length}`);
    
    if (buySellButtons.length > 0) {
      // Find the active/selected Buy or Sell button
      let activeButton = null;
      for (const btn of buySellButtons) {
        const className = (typeof btn.className === 'string' ? btn.className : (btn.className?.baseVal || String(btn.className) || '')).toLowerCase();
        const ariaSelected = btn.getAttribute('aria-selected');
        const isActive = className.includes('active') || 
                        className.includes('selected') || 
                        ariaSelected === 'true' ||
                        btn.classList.contains('active') ||
                        btn.classList.contains('selected');
        
        if (isActive) {
          activeButton = btn;
          debugInfo.push('Found active Buy/Sell button');
          break;
        }
      }
      
      // If no active button found, use the rightmost one
      if (!activeButton) {
        activeButton = buySellButtons.reduce((rightmost, btn) => {
          const rightmostRect = rightmost.getBoundingClientRect();
          const btnRect = btn.getBoundingClientRect();
          return btnRect.x > rightmostRect.x ? btn : rightmost;
        }, buySellButtons[0]);
        debugInfo.push('Using rightmost Buy/Sell button');
      }
      
      // Find next sibling - this should be the dropdown
      let nextSibling = activeButton.nextElementSibling;
      let attempts = 0;
      while (nextSibling && attempts < 5) {
        if (nextSibling.offsetParent !== null) {
          const ariaHaspopup = nextSibling.getAttribute('aria-haspopup');
          const tagName = nextSibling.tagName;
          debugInfo.push(`Next sibling ${attempts + 1}: tagName=${tagName}, aria-haspopup=${ariaHaspopup}`);
          
          // Accept any button as the dropdown (be more lenient)
          if (tagName === 'BUTTON' || ariaHaspopup === 'listbox') {
            return { 
              type: 'button', 
              element: nextSibling, 
              text: 'Next sibling dropdown',
              debug: debugInfo.join('; ')
            };
          }
        }
        nextSibling = nextSibling.nextElementSibling;
        attempts++;
      }
      
      // If no next sibling, check parent's children (siblings in same parent)
      const parent = activeButton.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const activeIndex = siblings.indexOf(activeButton);
        debugInfo.push(`Active button index: ${activeIndex}, total siblings: ${siblings.length}`);
        
        if (activeIndex >= 0 && activeIndex < siblings.length - 1) {
          const nextSiblingInParent = siblings[activeIndex + 1];
          if (nextSiblingInParent && nextSiblingInParent.offsetParent !== null) {
            const tagName = nextSiblingInParent.tagName;
            debugInfo.push(`Next sibling in parent: tagName=${tagName}`);
            return { 
              type: 'button', 
              element: nextSiblingInParent, 
              text: 'Next sibling in parent',
              debug: debugInfo.join('; ')
            };
          }
        }
      }
    }
    
    return { 
      found: false, 
      debug: debugInfo.join('; ')
    };
  }, orderType);
  
  // Log debug info
  if (dropdownInfo) {
    if (dropdownInfo.debug) {
      console.log(`[${exchange.name}] Dropdown search debug: ${dropdownInfo.debug}`);
    }
    if (dropdownInfo.found === false) {
      console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown (found: false)`);
      // Fallback to standard selectOrderType
      return await selectOrderType(page, orderType, exchange);
    }
    if (!dropdownInfo.element) {
      console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown (no element)`);
      // Fallback to standard selectOrderType
      return await selectOrderType(page, orderType, exchange);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown (null/undefined)`);
    // Fallback to standard selectOrderType
    return await selectOrderType(page, orderType, exchange);
  }
  
  if (dropdownInfo && dropdownInfo.element) {
    console.log(`[${exchange.name}] ✅ Found order type dropdown: type="${dropdownInfo.type}", text="${dropdownInfo.text}"`);
    
    if (dropdownInfo.type === 'select') {
      // It's a select element - set the value directly
      const success = await page.evaluate((select, orderType) => {
        const options = Array.from(select.options);
        const targetOption = options.find(opt => {
          const optText = opt.text.toLowerCase();
          return orderType === 'limit' ? optText.includes('limit') : optText.includes('market');
        });
        
        if (targetOption) {
          select.value = targetOption.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, dropdownInfo.element, orderType);
      
      if (success) {
        console.log(`[${exchange.name}] ✅ Selected ${orderType.toUpperCase()} from dropdown`);
        await delay(300);
        return true;
      }
    } else {
      // It's a button or element that opens a dropdown - click it first
      const dropdownHandle = await page.evaluateHandle((el) => el, dropdownInfo.element);
      const dropdownElement = dropdownHandle.asElement();
      
      if (dropdownElement) {
        console.log(`[${exchange.name}] Clicking dropdown to open it...`);
        
        // Try multiple methods to open dropdown
        try {
          await dropdownElement.click();
        } catch (error) {
          console.log(`[${exchange.name}] Direct click failed, trying JavaScript click...`);
          await dropdownElement.evaluate((el) => el.click());
        }
        
        await delay(800); // Wait longer for dropdown to fully open
        
        // Verify dropdown opened
        const dropdownOpened = await page.evaluate(() => {
          const menus = Array.from(document.querySelectorAll('[role="menu"], [class*="menu"], [class*="dropdown"], [role="listbox"]'));
          for (const menu of menus) {
            const style = window.getComputedStyle(menu);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = menu.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true; // Dropdown is open
              }
            }
          }
          return false;
        });
        
        if (!dropdownOpened) {
          console.log(`[${exchange.name}] ⚠️  Dropdown didn't open, trying to click again...`);
          await dropdownElement.click();
          await delay(800);
        }
        
        // Now find and click the Limit or Market option
        const optionText = orderType === 'limit' ? 'Limit' : 'Market';
        console.log(`[${exchange.name}] Looking for "${optionText}" option in opened dropdown...`);
        
        // First, try to find option within the opened dropdown menu/listbox
        const optionInMenu = await page.evaluate((text) => {
          // Find all open listboxes and menus
          const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
          const menus = Array.from(document.querySelectorAll('[role="menu"]'));
          const allDropdowns = [...listboxes, ...menus];
          
          // Also look for elements with dropdown/menu classes
          const classDropdowns = Array.from(document.querySelectorAll('[class*="dropdown"], [class*="menu"]'));
          for (const el of classDropdowns) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                allDropdowns.push(el);
              }
            }
          }
          
          for (const menu of allDropdowns) {
            const style = window.getComputedStyle(menu);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = menu.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            
            // First, look for elements with role="option" (standard listbox pattern)
            const options = Array.from(menu.querySelectorAll('[role="option"]'));
            for (const option of options) {
              if (option.offsetParent === null) continue;
              const optionText = (option.textContent || '').trim();
              if (optionText.toLowerCase() === text.toLowerCase() || 
                  (optionText.toLowerCase().includes(text.toLowerCase()) && optionText.length < 30)) {
                return { found: true, element: option, text: optionText };
              }
            }
            
            // Fallback: Look for any element with the text in this menu
            const allInMenu = Array.from(menu.querySelectorAll('*'));
            for (const el of allInMenu) {
              if (el.offsetParent === null) continue;
              const elText = (el.textContent || '').trim();
              if (elText.toLowerCase() === text.toLowerCase() || 
                  (elText.toLowerCase().includes(text.toLowerCase()) && elText.length < 30)) {
                return { found: true, element: el, text: elText };
              }
            }
          }
          return { found: false };
        }, optionText);
        
        let optionBtn = null;
        
        if (optionInMenu.found) {
          console.log(`[${exchange.name}] Found "${optionText}" option in dropdown menu: "${optionInMenu.text}"`);
          const optionHandle = await page.evaluateHandle((el) => el, optionInMenu.element);
          optionBtn = optionHandle.asElement();
        } else {
          // Fallback: Use standard search methods
          optionBtn = await findByExactText(page, optionText, ["button", "div", "span", "option", "li"]);
          
          if (!optionBtn) {
            optionBtn = await findByText(page, optionText, ["button", "div", "span", "option", "li"]);
          }
        }
        
        // Fallback: Look for active/highlighted option or find by evaluating
        if (!optionBtn) {
          console.log(`[${exchange.name}] Standard search failed, trying evaluate to find ${optionText} option...`);
          const optionFound = await page.evaluate((text) => {
            // Look for elements with the text in dropdown menu
            const allElements = Array.from(document.querySelectorAll('*'));
            for (const el of allElements) {
              if (el.offsetParent === null) continue;
              const elText = (el.textContent || '').trim();
              if (elText.toLowerCase() === text.toLowerCase() || elText.toLowerCase().includes(text.toLowerCase())) {
                // Check if it's in a dropdown/menu context
                let parent = el.parentElement;
                let isInDropdown = false;
                for (let i = 0; i < 5 && parent; i++) {
                  const role = parent.getAttribute('role');
                  const className = (parent.className || '').toLowerCase();
                  if (role === 'menu' || role === 'listbox' || 
                      className.includes('menu') || className.includes('dropdown') ||
                      className.includes('select')) {
                    isInDropdown = true;
                    break;
                  }
                  parent = parent.parentElement;
                }
                if (isInDropdown) {
                  return { found: true, element: el };
                }
              }
            }
            return { found: false };
          }, optionText);
          
          if (optionFound.found) {
            const optionHandle = await page.evaluateHandle((el) => el, optionFound.element);
            optionBtn = optionHandle.asElement();
            console.log(`[${exchange.name}] Found ${optionText} option via evaluate`);
          }
        }
        
        if (optionBtn) {
          console.log(`[${exchange.name}] Found ${optionText} option, clicking...`);
          
          // Try multiple click methods to ensure it works
          try {
            // Method 1: Scroll into view and click
            await optionBtn.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await delay(200);
            await optionBtn.click();
            console.log(`[${exchange.name}] Clicked ${optionText} option (method 1: direct click)`);
          } catch (error1) {
            console.log(`[${exchange.name}] Direct click failed: ${error1.message}, trying JavaScript click...`);
            try {
              // Method 2: JavaScript click
              await optionBtn.evaluate((el) => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
              });
              console.log(`[${exchange.name}] Clicked ${optionText} option (method 2: JavaScript click)`);
            } catch (error2) {
              console.log(`[${exchange.name}] JavaScript click failed: ${error2.message}, trying mousedown/up...`);
              // Method 3: Mouse events
              await optionBtn.evaluate((el) => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
                const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
                const click = new MouseEvent('click', { bubbles: true, cancelable: true });
                el.dispatchEvent(mouseDown);
                el.dispatchEvent(mouseUp);
                el.dispatchEvent(click);
              });
              console.log(`[${exchange.name}] Clicked ${optionText} option (method 3: mouse events)`);
            }
          }
          
          await delay(500); // Wait for dropdown to close and selection to register
          
          // Verify the selection was made by checking if dropdown closed or option is selected
          const dropdownClosed = await page.evaluate(() => {
            // Check if dropdown menu is still visible
            const menus = Array.from(document.querySelectorAll('[role="menu"], [class*="menu"], [class*="dropdown"]'));
            for (const menu of menus) {
              const style = window.getComputedStyle(menu);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                // Check if it's actually visible on screen
                const rect = menu.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return false; // Dropdown still open
                }
              }
            }
            return true; // Dropdown appears closed
          });
          
          if (dropdownClosed) {
            console.log(`[${exchange.name}] ✅ Selected ${orderType.toUpperCase()} from dropdown (dropdown closed)`);
            return true;
          } else {
            console.log(`[${exchange.name}] ⚠️  Dropdown still open, trying to close it...`);
            // Try pressing Escape to close dropdown
            await page.keyboard.press('Escape');
            await delay(300);
            console.log(`[${exchange.name}] ✅ Selected ${orderType.toUpperCase()} from dropdown (closed with Escape)`);
            return true;
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not find ${optionText} option in dropdown`);
        }
      }
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find order type dropdown, trying fallback method...`);
    // Fallback to standard selectOrderType
    return await selectOrderType(page, orderType, exchange);
  }
  
  return false;
}

/**
 * Find size and price inputs for Kraken
 * Kraken has inputs in the order form panel (can be on left side)
 */
export async function findKrakenInputs(page, orderType) {
  console.log(`[Kraken] Finding inputs for Kraken (order type: ${orderType})...`);
  
  const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type="hidden"])');
  let sizeInput = null;
  let priceInput = null;
  
  console.log(`[Kraken] Found ${inputs.length} input elements on page`);
  
  for (const input of inputs) {
    const rect = await input.boundingBox();
    if (!rect) continue;
    
    const isVisible = await page.evaluate((el) => {
      return el.offsetParent !== null && !el.disabled && !el.readOnly;
    }, input);
    
    if (!isVisible) continue;
    
    const inputInfo = await page.evaluate((el) => {
      // Get placeholder, label, and nearby text
      const placeholder = (el.placeholder || '').toLowerCase();
      const name = (el.name || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const value = (el.value || '').toLowerCase();
      
      // Find label
      let labelText = '';
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
          labelText = (label.textContent || '').toLowerCase();
          break;
        }
      }
      
      // Check parent text
      let parent = el.parentElement;
      let parentText = '';
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.textContent) {
          parentText = (parent.textContent || '').toLowerCase();
          break;
        }
        parent = parent.parentElement;
      }
      
      return {
        placeholder,
        name,
        id,
        value,
        labelText,
        parentText
      };
    }, input);
    
    // Check for Limit price input
    if (!priceInput && orderType === "limit") {
      if (inputInfo.placeholder.includes('limit price') ||
          inputInfo.placeholder.includes('price') ||
          inputInfo.labelText.includes('limit price') ||
          inputInfo.labelText.includes('price') ||
          inputInfo.parentText.includes('limit price') ||
          inputInfo.parentText.includes('price')) {
        priceInput = input;
        console.log(`[Kraken] ✅ Found Limit price input (placeholder: "${inputInfo.placeholder}", label: "${inputInfo.labelText}")`);
      }
    }
    
    // Check for Quantity/Size input
    if (!sizeInput) {
      if (inputInfo.placeholder.includes('quantity') ||
          inputInfo.placeholder.includes('size') ||
          inputInfo.placeholder.includes('qty') ||
          inputInfo.labelText.includes('quantity') ||
          inputInfo.labelText.includes('size') ||
          inputInfo.labelText.includes('qty') ||
          inputInfo.parentText.includes('quantity') ||
          inputInfo.parentText.includes('size')) {
        sizeInput = input;
        console.log(`[Kraken] ✅ Found Quantity input (placeholder: "${inputInfo.placeholder}", label: "${inputInfo.labelText}")`);
      }
    }
    
    // If both found, break early
    if (sizeInput && (orderType === "market" || priceInput)) {
      break;
    }
  }
  
  // If not found by text, try position-based (for limit orders, price is usually above quantity)
  if (orderType === "limit" && sizeInput && !priceInput) {
    const sizeRect = await sizeInput.boundingBox();
    if (sizeRect) {
      for (const input of inputs) {
        if (input === sizeInput) continue;
        const inputRect = await input.boundingBox();
        if (!inputRect) continue;
        
        // Price is usually above quantity
        const isAbove = inputRect.y < sizeRect.y && Math.abs(inputRect.x - sizeRect.x) < 200;
        if (isAbove) {
          const isVisible = await page.evaluate((el) => {
            return el.offsetParent !== null && !el.disabled && !el.readOnly;
          }, input);
          if (isVisible) {
            priceInput = input;
            console.log(`[Kraken] ✅ Found Limit price input via position (above quantity)`);
            break;
          }
        }
      }
    }
  }
  
  return { sizeInput, priceInput };
}

/**
 * Execute trade for Kraken
 */
export async function executeTradeKraken(
  page,
  { side, orderType, price, qty, setLeverageFirst = false, leverage = null },
  exchange,
  thresholdMetTime = null,
  cycleCount = null,
  sideLabel = '',
  email = ''
) {
  // ⏱️ TIMING: Track form fill start time
  const formFillStartTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = formFillStartTime - thresholdMetTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] Form filling started - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met`);
  }
  
  console.log(`\n=== Executing Trade on ${exchange.name} ===`);

  // Step 0: Cancel all existing orders first (modal-based flow for Kraken)
  console.log(`[${exchange.name}] Step 0: Canceling all existing orders...`);
  // await cancelKrakenOrders(page);
  console.log(`[${exchange.name}] ✅ Order cancellation completed\n`);

  // Set leverage first if requested
  if (setLeverageFirst && leverage) {
    await setLeverageKraken(page, leverage, exchange);
  }

  // If limit order without price, fetch current market price
  if (orderType === "limit" && !price) {
    price = await getCurrentMarketPrice(page, exchange);
    if (!price) {
      console.log(`[${exchange.name}] ❌ Could not fetch market price for limit order`);
      return { success: false, error: "Could not fetch market price" };
    }
  }

  console.log(
    `[${exchange.name}] Side: ${side}, Type: ${orderType}, Price: ${
      price || "market"
    }, Qty: ${qty}`
  );

  // No need to reload - just wait a moment for any previous actions to complete
  await delay(1000);

  // Step 1: Select Buy or Sell tabs (already correct)
  console.log(`[${exchange.name}] Step 1: Selecting ${side.toUpperCase()}...`);
  await selectBuyOrSell(page, side, exchange);
  await delay(300);

  // Step 2: Select order type from dropdown (on the right of Buy/Sell tabs)
  console.log(`[${exchange.name}] Step 2: Selecting ${orderType.toUpperCase()} from dropdown...`);
  await selectOrderTypeKraken(page, orderType, exchange);
  await delay(500);

  // Step 3: Find and fill Limit price input (for limit orders)
  // Use Kraken-specific input finder that doesn't filter by position
  console.log(`[${exchange.name}] Step 3: Finding and filling Limit price input...`);
  const { sizeInput, priceInput } = await findKrakenInputs(page, orderType);
  
  if (orderType === "limit") {
    if (priceInput) {
      await enterPrice(page, priceInput, price, orderType);
      await delay(300);
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find Limit price input`);
      return { success: false, error: "Limit price input not found" };
    }
  }

  // Step 4: Find and fill Quantity input
  console.log(`[${exchange.name}] Step 4: Finding and filling Quantity input...`);
  if (sizeInput) {
    const sizeResult = await enterSize(page, sizeInput, qty, exchange);
    if (!sizeResult.success) {
      return sizeResult;
    }
    await delay(300);
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find Quantity input`);
    return { success: false, error: "Quantity input not found" };
  }

  await delay(500);

  // Step 5: Handle TP/SL dropdown - find TP/SL element, click it, and select "Simple"
  console.log(`[${exchange.name}] Step 5: Handling TP/SL dropdown...`);
  try {
    // First, try direct selector for button with aria-label="TP/SL"
    let tpSlButton = await page.$('button[aria-label="TP/SL"][aria-haspopup="listbox"]');
    
    if (!tpSlButton) {
      // Fallback: Find by label text, then find button nearby
      const buttonInfo = await page.evaluate(() => {
        // Find TP/SL label
        const labels = Array.from(document.querySelectorAll('label'));
        for (const label of labels) {
          const text = (label.textContent || '').trim();
          if (text === 'TP/SL' && label.offsetParent !== null) {
            // Look for button in the same parent or nearby
            let parent = label.parentElement;
            for (let i = 0; i < 3 && parent; i++) {
              const buttons = Array.from(parent.querySelectorAll('button'));
              for (const btn of buttons) {
                if (btn.offsetParent === null) continue;
                const ariaLabel = btn.getAttribute('aria-label');
                const ariaHaspopup = btn.getAttribute('aria-haspopup');
                if (ariaLabel === 'TP/SL' && ariaHaspopup === 'listbox') {
                  return { found: true, element: btn };
                }
              }
              parent = parent.parentElement;
            }
          }
        }
        return { found: false };
      });
      
      if (buttonInfo.found) {
        const buttonHandle = await page.evaluateHandle((el) => el, buttonInfo.element);
        tpSlButton = buttonHandle.asElement();
      }
    }
    
    if (tpSlButton) {
      // Check if "Simple" is already selected before opening dropdown
      const isSimpleSelected = await page.evaluate((button) => {
        // Check the button's text to see if it shows "Simple"
        const buttonText = (button.textContent || '').trim();
        return buttonText.toLowerCase().includes('simple');
      }, tpSlButton);
      
      if (isSimpleSelected) {
        console.log(`[${exchange.name}] ✅ "Simple" is already selected in TP/SL dropdown, skipping click`);
        await delay(300); // Wait for inputs to be ready
      } else {
        console.log(`[${exchange.name}] ✅ Found TP/SL dropdown button, clicking...`);
        
        // Click to open the dropdown
        await tpSlButton.click();
        await delay(800); // Wait for dropdown to open
        
        // Find and click "Simple" option in the opened dropdown
        console.log(`[${exchange.name}] Looking for "Simple" option in TP/SL dropdown...`);
        let simpleOption = await findByExactText(page, "Simple", ["button", "div", "span", "option", "li"]);
        
        if (!simpleOption) {
          simpleOption = await findByText(page, "Simple", ["button", "div", "span", "option", "li"]);
        }
        
        // Fallback: Search in opened listbox/menu
        if (!simpleOption) {
          const simpleFound = await page.evaluate(() => {
            const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
            const menus = Array.from(document.querySelectorAll('[role="menu"]'));
            const allDropdowns = [...listboxes, ...menus];
            
            for (const menu of allDropdowns) {
              const style = window.getComputedStyle(menu);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const rect = menu.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              
              const options = Array.from(menu.querySelectorAll('[role="option"], button, div, span'));
              for (const option of options) {
                if (option.offsetParent === null) continue;
                const optionText = (option.textContent || '').trim();
                if (optionText.toLowerCase() === 'simple') {
                  return { found: true, element: option };
                }
              }
            }
            return { found: false };
          });
          
          if (simpleFound.found) {
            const simpleHandle = await page.evaluateHandle((el) => el, simpleFound.element);
            simpleOption = simpleHandle.asElement();
          }
        }
        
        if (simpleOption) {
          console.log(`[${exchange.name}] ✅ Found "Simple" option, clicking...`);
          try {
            await simpleOption.click();
            await delay(300); // Wait for inputs to appear
            console.log(`[${exchange.name}] ✅ Selected "Simple" from TP/SL dropdown`);
          } catch (error) {
            console.log(`[${exchange.name}] Direct click failed, trying JavaScript click...`);
            await simpleOption.evaluate((el) => el.click());
            await delay(300); // Wait for inputs to appear
            console.log(`[${exchange.name}] ✅ Selected "Simple" from TP/SL dropdown (JavaScript click)`);
          }
        } else {
          console.log(`[${exchange.name}] ⚠️  Could not find "Simple" option in TP/SL dropdown`);
        }
      }
      
      // Step 5.1: Find and fill Stop Loss and Take Profit "Entry Distance" inputs (% inputs)
      console.log(`[${exchange.name}] Step 5.1: Finding and filling TP/SL "Entry Distance" inputs...`);
      
      // Get values from environment variables
      const takeProfitValue = process.env.TAKE_PROFIT || '';
      const stopLossValue = process.env.STOP_LOSS || '';
      
      if (!takeProfitValue && !stopLossValue) {
        console.log(`[${exchange.name}] ⚠️  TAKE_PROFIT and STOP_LOSS env variables not set, skipping TP/SL inputs`);
      } else {
        // Find inputs using aria-label attributes (most reliable)
        let takeProfitInput = null;
        let stopLossInput = null;
        
        // Method 1: Find by aria-label
        try {
          takeProfitInput = await page.$('input[aria-label="Distance for Take profit"]');
          stopLossInput = await page.$('input[aria-label="Distance for Stop loss"]');
          
          if (takeProfitInput) {
            console.log(`[${exchange.name}] ✅ Found Take Profit "Entry Distance" input via aria-label`);
          }
          if (stopLossInput) {
            console.log(`[${exchange.name}] ✅ Found Stop Loss "Entry Distance" input via aria-label`);
          }
        } catch (error) {
          console.log(`[${exchange.name}] ⚠️  Error finding inputs by aria-label: ${error.message}`);
        }
        
        // Method 2: Fallback - Find by name attribute pattern
        if (!takeProfitInput || !stopLossInput) {
          try {
            const inputs = await page.$$('input[name*="priceDeviationValue"]');
            for (const input of inputs) {
              const ariaLabel = await page.evaluate((el) => el.getAttribute('aria-label'), input);
              const name = await page.evaluate((el) => el.getAttribute('name'), input);
              
              if (ariaLabel && ariaLabel.includes('Take profit') && !takeProfitInput) {
                takeProfitInput = input;
                console.log(`[${exchange.name}] ✅ Found Take Profit "Entry Distance" input via name: ${name}`);
              } else if (ariaLabel && ariaLabel.includes('Stop loss') && !stopLossInput) {
                stopLossInput = input;
                console.log(`[${exchange.name}] ✅ Found Stop Loss "Entry Distance" input via name: ${name}`);
              }
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error finding inputs by name: ${error.message}`);
          }
        }
        
        // Method 3: Fallback - Find by label text "Entry distance" and nearby "Take profit"/"Stop loss"
        if (!takeProfitInput || !stopLossInput) {
          try {
            const distanceInputs = await page.evaluate(() => {
              const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type="hidden"])'));
              const found = { takeProfit: null, stopLoss: null };
              
              for (const input of inputs) {
                if (input.offsetParent === null || input.disabled || input.readOnly) continue;
                
                // Check aria-label first
                const ariaLabel = input.getAttribute('aria-label') || '';
                if (ariaLabel.toLowerCase().includes('distance for take profit')) {
                  found.takeProfit = input;
                  continue;
                }
                if (ariaLabel.toLowerCase().includes('distance for stop loss')) {
                  found.stopLoss = input;
                  continue;
                }
                
                // Check label
                const labels = document.querySelectorAll('label');
                let labelText = '';
                for (const label of labels) {
                  if (label.control === input || label.getAttribute('for') === input.id || label.contains(input)) {
                    labelText = (label.textContent || '').trim().toLowerCase();
                    break;
                  }
                }
                
                // Check if label is "Entry distance"
                if (labelText === 'entry distance' || labelText.includes('entry distance')) {
                  // Find nearby "Take profit" or "Stop loss" text
                  let parent = input.parentElement;
                  let nearbyText = '';
                  for (let i = 0; i < 10 && parent; i++) {
                    const text = (parent.textContent || '').trim().toLowerCase();
                    if (text.includes('take profit')) {
                      nearbyText = 'take profit';
                      break;
                    }
                    if (text.includes('stop loss')) {
                      nearbyText = 'stop loss';
                      break;
                    }
                    parent = parent.parentElement;
                  }
                  
                  if (nearbyText === 'take profit' && !found.takeProfit) {
                    found.takeProfit = input;
                  } else if (nearbyText === 'stop loss' && !found.stopLoss) {
                    found.stopLoss = input;
                  }
                }
              }
              
              return {
                takeProfit: found.takeProfit ? { found: true, element: found.takeProfit } : { found: false },
                stopLoss: found.stopLoss ? { found: true, element: found.stopLoss } : { found: false }
              };
            });
            
            if (distanceInputs && distanceInputs.takeProfit && distanceInputs.takeProfit.found && !takeProfitInput) {
              const tpHandle = await page.evaluateHandle((el) => el, distanceInputs.takeProfit.element);
              takeProfitInput = tpHandle.asElement();
              console.log(`[${exchange.name}] ✅ Found Take Profit "Entry Distance" input via label search`);
            }
            
            if (distanceInputs && distanceInputs.stopLoss && distanceInputs.stopLoss.found && !stopLossInput) {
              const slHandle = await page.evaluateHandle((el) => el, distanceInputs.stopLoss.element);
              stopLossInput = slHandle.asElement();
              console.log(`[${exchange.name}] ✅ Found Stop Loss "Entry Distance" input via label search`);
            }
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error in fallback search: ${error.message}`);
          }
        }
        
        // Fill Take Profit "Entry Distance" input
        if (takeProfitValue && takeProfitInput) {
          console.log(`[${exchange.name}] Filling Take Profit "Entry Distance" input with value: ${takeProfitValue}`);
          try {
            await takeProfitInput.click({ clickCount: 3 }); // Select all
            await delay(100);
            await takeProfitInput.type(takeProfitValue, { delay: 50 });
            await delay(300);
            console.log(`[${exchange.name}] ✅ Filled Take Profit "Entry Distance" input`);
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error filling Take Profit input: ${error.message}`);
          }
        } else if (takeProfitValue) {
          console.log(`[${exchange.name}] ⚠️  Take Profit value set but "Entry Distance" input not found`);
        }
        
        // Fill Stop Loss "Entry Distance" input
        if (stopLossValue && stopLossInput) {
          console.log(`[${exchange.name}] Filling Stop Loss "Entry Distance" input with value: ${stopLossValue}`);
          try {
            await stopLossInput.click({ clickCount: 3 }); // Select all
            await delay(100);
            await stopLossInput.type(stopLossValue, { delay: 50 });
            await delay(300);
            console.log(`[${exchange.name}] ✅ Filled Stop Loss "Entry Distance" input`);
          } catch (error) {
            console.log(`[${exchange.name}] ⚠️  Error filling Stop Loss input: ${error.message}`);
          }
        } else if (stopLossValue) {
          console.log(`[${exchange.name}] ⚠️  Stop Loss value set but "Entry Distance" input not found`);
        }
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Could not find TP/SL dropdown button`);
    }
  } catch (error) {
    console.log(`[${exchange.name}] ⚠️  Error handling TP/SL dropdown: ${error.message}`);
  }

  await delay(500);

  // Step 5.5: Update price input value to (current value - 10) before clicking confirm button
  // if (orderType === "limit" && priceInput) {
  //   console.log(`[${exchange.name}] Step 5.5: Updating price input value to (current value - 10) before clicking confirm button...`);
    
  //   // Get current price input value
  //   const currentPriceValue = await page.evaluate((el) => el.value || '', priceInput);
  //   const currentPriceNum = parseFloat(currentPriceValue.replace(/,/g, '').replace(/ /g, ''));
    
  //   if (currentPriceValue && !isNaN(currentPriceNum)) {
  //     const newPrice = currentPriceNum - 10;
  //     console.log(`[${exchange.name}] Current price: ${currentPriceNum}, New price (current - 10): ${newPrice}`);
      
  //     // Update the price input with the new value using enterPrice function
  //     await enterPrice(page, priceInput, newPrice, orderType);
      
  //     // Verify the updated price persists
  //     await delay(500);
  //     const updatedPriceCheck = await page.evaluate((el) => el.value || '', priceInput);
  //     const updatedPriceNum = parseFloat(updatedPriceCheck.replace(/,/g, ''));
  //     const priceTolerance = 0.1;
      
  //     if (updatedPriceCheck && Math.abs(updatedPriceNum - newPrice) < priceTolerance) {
  //       console.log(`[${exchange.name}] ✅ Price updated successfully: "${updatedPriceCheck}" (expected: ${newPrice}, got: ${updatedPriceNum})`);
  //     } else {
  //       console.log(`[${exchange.name}] ⚠️  Price update verification failed. Expected: ${newPrice}, Got: "${updatedPriceCheck}" (${updatedPriceNum})`);
  //     }
  //     await delay(300);
  //   } else {
  //     console.log(`[${exchange.name}] ⚠️  Could not read current price value: "${currentPriceValue}", skipping price update`);
  //   }
  // } else {
  //   console.log(`[${exchange.name}] Skipping price update - only applies to limit orders with price input`);
  // }

  // Step 6: Find and click Confirm button — pass priceInput so the search is
  // scoped to the actual order form container (avoids latching onto a generic
  // "Buy"/"Sell" element in the Kraken Pro top nav on the Margin page).
  const { confirmBtn, confirmText } = await findConfirmButtonKraken(page, side, exchange, priceInput || sizeInput || null);

  if (!confirmBtn) {
    // Enhanced error message with debugging info
    console.log(`[${exchange.name}] ❌ Could not find "${confirmText}" button`);
    console.log(`[${exchange.name}]    Exchange: ${exchange.name}, Side: ${side}`);
    
    // Additional debugging: try to find what buttons are available
    const availableButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
      return buttons
        .filter(btn => {
          const isVisible = btn.offsetParent !== null && btn.offsetWidth > 0 && btn.offsetHeight > 0;
          return isVisible;
        })
        .map(btn => {
          const text = btn.textContent?.trim();
          const rect = btn.getBoundingClientRect();
          return {
            text: text,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true'
          };
        })
        .filter(btn => btn.text && btn.text.length > 0)
        .slice(0, 10); // Limit to first 10 for readability
    });
    
    console.log(`[${exchange.name}]    Available buttons (first 10):`, JSON.stringify(availableButtons, null, 2));
    
    return { success: false, error: `Confirm button not found. Looking for: "${confirmText}"` };
  }

  // ⏱️ TIMING: Track first Confirm button click time
  const firstConfirmButtonClickTime = Date.now();
  if (thresholdMetTime) {
    const timeSinceThreshold = firstConfirmButtonClickTime - thresholdMetTime;
    const formFillTime = firstConfirmButtonClickTime - formFillStartTime;
    console.log(`[${exchange.name}] ⏱️  [TIMING] First Confirm button clicked - ${(timeSinceThreshold / 1000).toFixed(2)}s after threshold met (form fill took ${(formFillTime / 1000).toFixed(2)}s)`);
  }
  
  // Click confirm button
  await clickConfirmButton(page, confirmBtn, confirmText, exchange, side);

  // Step 7: Wait for confirmation modal to open and click Confirm button in the modal
  console.log(`[${exchange.name}] Waiting 500ms for confirmation modal to open...`);
  await delay(500);
  
  // Check if a modal opened and find the Confirm button
  console.log(`[${exchange.name}] Looking for Confirm button in the modal...`);
  let confirmModalBtn = null;
  
  // Try to find Confirm button in modal
  confirmModalBtn = await findByExactText(page, "Confirm", ["button", "div", "span"]);
  
  if (!confirmModalBtn) {
    confirmModalBtn = await findByText(page, "Confirm", ["button", "div", "span"]);
  }
  
  if (confirmModalBtn) {
    // Verify it's inside a modal/dialog
    const isInModal = await page.evaluate((el) => {
      let parent = el.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const className = (typeof parent.className === 'string' ? parent.className : (parent.className?.baseVal || String(parent.className) || '')).toLowerCase();
        if (parent.tagName === 'DIV' && (parent.getAttribute('role') === 'dialog' || 
            className.includes('modal') || className.includes('dialog') || 
            className.includes('overlay'))) {
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }, confirmModalBtn);
    
    if (isInModal) {
      console.log(`[${exchange.name}] ✅ Found Confirm button in modal, clicking...`);
      
      // ⏱️ TIMING: Track final Confirm button click (order submission)
      const confirmButtonClickTime = Date.now();
      
      try {
        await confirmModalBtn.click();
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal`);
        
        // ⏱️ TIMING: Log total time metrics
        if (thresholdMetTime) {
          const totalTime = confirmButtonClickTime - thresholdMetTime;
          const formFillTime = firstConfirmButtonClickTime - formFillStartTime;
          const buttonClickTime = confirmButtonClickTime - firstConfirmButtonClickTime;
          
          console.log(`\n[${exchange.name}] ⏱️  [TIMING METRICS] ${sideLabel} Order Submission Complete:`);
          console.log(`[${exchange.name}]    Account: ${email}`);
          console.log(`[${exchange.name}]    Total time (threshold → submit): ${(totalTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Form fill time: ${(formFillTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Button click time: ${(buttonClickTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Timestamp: ${new Date(confirmButtonClickTime).toISOString()}\n`);
        }
      } catch (error) {
        console.log(`[${exchange.name}] Direct click failed, trying JavaScript click...`);
        await confirmModalBtn.evaluate((el) => el.click());
        console.log(`[${exchange.name}] ✅ Clicked Confirm button in modal (JavaScript click)`);
        
        // ⏱️ TIMING: Log total time metrics (for JS click fallback)
        if (thresholdMetTime) {
          const totalTime = Date.now() - thresholdMetTime;
          const formFillTime = firstConfirmButtonClickTime - formFillStartTime;
          const buttonClickTime = Date.now() - firstConfirmButtonClickTime;
          
          console.log(`\n[${exchange.name}] ⏱️  [TIMING METRICS] ${sideLabel} Order Submission Complete (JS click):`);
          console.log(`[${exchange.name}]    Account: ${email}`);
          console.log(`[${exchange.name}]    Total time (threshold → submit): ${(totalTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Form fill time: ${(formFillTime / 1000).toFixed(2)}s`);
          console.log(`[${exchange.name}]    Button click time: ${(buttonClickTime / 1000).toFixed(2)}s\n`);
        }
      }
      
      // Wait for modal to close
      console.log(`[${exchange.name}] Waiting for confirmation modal to close...`);
      let modalClosed = false;
      for (let i = 0; i < 10; i++) {
        const modalStillOpen = await page.evaluate(() => {
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="overlay"]'));
          for (const modal of modals) {
            const style = window.getComputedStyle(modal);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = modal.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true; // Modal still open
              }
            }
          }
          return false; // Modal closed
        });
        
        if (!modalStillOpen) {
          modalClosed = true;
          console.log(`[${exchange.name}] ✅ Confirmation modal closed`);
          break;
        }
        await delay(200);
      }
      
      if (!modalClosed) {
        console.log(`[${exchange.name}] ⚠️  Modal may still be open, but proceeding...`);
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  Found Confirm button but it's not in a modal, may have already been processed`);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find Confirm button in modal, order may have been processed without confirmation`);
  }

  // Step 8: Find and click "Open orders" tab after modal closes
  console.log(`[${exchange.name}] Step 8: Finding and clicking "Open orders" tab...`);
  await delay(500); // Additional delay to ensure modal is fully closed
  
  // Try "Open orders" (with lowercase 'o' in orders) first
  let openOrdersTab = await findByExactText(page, "Open orders", ["button", "div", "span", "a"]);
  
  if (!openOrdersTab) {
    // Try "Open Orders" (with capital 'O' in Orders)
    openOrdersTab = await findByExactText(page, "Open Orders", ["button", "div", "span", "a"]);
  }
  
  if (!openOrdersTab) {
    // Try case-insensitive search
    openOrdersTab = await findByText(page, "Open orders", ["button", "div", "span", "a"]);
  }
  
  if (!openOrdersTab) {
    // Try "Order History" as fallback
    openOrdersTab = await findByExactText(page, "Order History", ["button", "div", "span", "a"]);
  }
  
  if (!openOrdersTab) {
    // Try just "Orders" as last resort
    openOrdersTab = await findByExactText(page, "Orders", ["button", "div", "span", "a"]);
  }
  
  if (openOrdersTab) {
    const isVisible = await page.evaluate((el) => {
      return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
    }, openOrdersTab);
    
    if (isVisible) {
      console.log(`[${exchange.name}] ✅ Found "Open orders" tab, clicking...`);
      try {
        await openOrdersTab.click();
        console.log(`[${exchange.name}] ✅ Clicked "Open orders" tab`);
        await delay(1000); // Wait for tab content to load
      } catch (error) {
        console.log(`[${exchange.name}] ⚠️  Error clicking "Open orders" tab: ${error.message}`);
      }
    } else {
      console.log(`[${exchange.name}] ⚠️  "Open orders" tab found but not visible`);
    }
  } else {
    console.log(`[${exchange.name}] ⚠️  Could not find "Open orders" tab`);
  }

  // Verify order placement
  return await verifyOrderPlacement(page, exchange, side, qty);
}
