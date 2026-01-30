import { delay, findByText, findByExactText } from '../utils/helpers.js';
import { verifyOrderPlaced } from './orders.js';

/**
 * Shared base functions for trade execution across all exchanges
 */

/**
 * Fetch current market price from the page
 */
export async function getCurrentMarketPrice(page, exchangeConfig = null) {
  const exchangeName = exchangeConfig?.name || 'Unknown Exchange';
  console.log(`[${exchangeName}] Fetching current market price...`);

  try {
    // First, check if any modal is open and blocking the page
    const modalOpen = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
      if (modal) {
        const style = window.getComputedStyle(modal);
        const isVisible = modal.offsetParent !== null && 
                         style.display !== 'none' && 
                         style.visibility !== 'hidden';
        return isVisible;
      }
      return false;
    });
    
    if (modalOpen) {
      console.log(`[${exchangeName}] ⚠️  Modal detected on page - attempting to close before fetching price...`);
      // Try to close modal
      const closed = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
        if (modal) {
          const buttons = Array.from(modal.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
          const cancelBtn = buttons.find(btn => {
            const text = btn.textContent?.trim().toLowerCase();
            return text === 'cancel' || text === 'close' || text === 'x' || text === '×';
          });
          if (cancelBtn) {
            cancelBtn.click();
            return true;
          }
        }
        return false;
      });
      
      if (closed) {
        console.log(`[${exchangeName}] ✅ Clicked Cancel/Close button to close modal`);
        await delay(1000); // Wait for modal to close
      } else {
        console.log(`[${exchangeName}] ⚠️  Could not find Cancel/Close button in modal, trying Escape key...`);
        await page.keyboard.press('Escape');
        await delay(1000);
      }
    }

    // Try to get the current price from the page
    const price = await page.evaluate(() => {
      // Look for price displays - common patterns on trading interfaces
      const priceSelectors = [
        // Try to find the main price ticker
        '[class*="price"]',
        '[class*="ticker"]',
        '[class*="mark-price"]',
        '[class*="last-price"]',
        '[data-testid*="price"]',
      ];

      // Check all possible price elements
      for (const selector of priceSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim();
          // Look for USD prices (format: $XX,XXX.XX or XX,XXX.XX)
          const match = text?.match(
            /\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/
          );
          if (match) {
            const priceStr = match[1].replace(/,/g, "");
            const price = parseFloat(priceStr);
            // Validate it's a reasonable BTC price (between $1,000 and $500,000)
            if (price >= 1000 && price <= 500000) {
              return price;
            }
          }
        }
      }

      // Fallback: look for any large number that looks like a BTC price
      const allText = document.body.innerText;
      const priceMatches = allText.match(
        /\$?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)/g
      );
      if (priceMatches) {
        for (const match of priceMatches) {
          const priceStr = match.replace(/[$,]/g, "");
          const price = parseFloat(priceStr);
          if (price >= 1000 && price <= 500000) {
            return price;
          }
        }
      }

      return null;
    });

    if (price) {
      console.log(`[${exchangeName}] ✓ Current market price: $${price.toLocaleString()}`);
      return price;
    } else {
      console.log(`[${exchangeName}] ⚠ Could not find market price on page`);
      return null;
    }
  } catch (error) {
    console.error(`[${exchangeName}] Error fetching market price:`, error.message);
    return null;
  }
}

/**
 * Select Buy or Sell button
 */
export async function selectBuyOrSell(page, side, exchange) {
  if (side === "sell") {
    // Try exact match first
    let sellBtn = await findByExactText(page, exchange.selectors.sellButton, ["button", "div"]);
    
    // If exact match fails, try partial match (for GRVT "Sell / Short")
    if (!sellBtn) {
      sellBtn = await findByText(page, exchange.selectors.sellButton, ["button", "div"]);
    }
    
    // Fallback: Try matching just "Sell" or "Short"
    if (!sellBtn) {
      sellBtn = await findByText(page, "Sell", ["button", "div"]);
      if (!sellBtn) {
        sellBtn = await findByText(page, "Short", ["button", "div"]);
      }
    }
    
    if (sellBtn) {
      await sellBtn.click();
      console.log(`[${exchange.name}] Selected SELL`);
      await delay(300);
      return true;
    }
  } else {
    // Try exact match first
    let buyBtn = await findByExactText(page, exchange.selectors.buyButton, ["button", "div"]);
    
    // If exact match fails, try partial match (for GRVT "Buy / Long")
    if (!buyBtn) {
      buyBtn = await findByText(page, exchange.selectors.buyButton, ["button", "div"]);
    }
    
    // Fallback: Try matching just "Buy" or "Long"
    if (!buyBtn) {
      buyBtn = await findByText(page, "Buy", ["button", "div"]);
      if (!buyBtn) {
        buyBtn = await findByText(page, "Long", ["button", "div"]);
      }
    }
    
    if (buyBtn) {
      await buyBtn.click();
      console.log(`[${exchange.name}] Selected BUY`);
      await delay(300);
      return true;
    }
  }
  return false;
}

/**
 * Select Market or Limit order type
 */
export async function selectOrderType(page, orderType, exchange) {
  console.log(`[${exchange.name}] selectOrderType: Looking for ${orderType.toUpperCase()} button...`);
  try {
    if (orderType === "limit") {
      console.log(`[${exchange.name}] Searching for Limit button with text: "${exchange.selectors.limitButton}"`);
      const limitBtn = await findByExactText(page, exchange.selectors.limitButton, ["button", "div"]);
      if (limitBtn) {
        console.log(`[${exchange.name}] Found Limit button, clicking...`);
        await limitBtn.click();
        console.log(`[${exchange.name}] Selected LIMIT order`);
        await delay(300);
        return true;
      } else {
        console.log(`[${exchange.name}] ⚠️  Limit button not found`);
      }
    } else {
      console.log(`[${exchange.name}] Searching for Market button with text: "${exchange.selectors.marketButton}"`);
      const marketBtn = await findByExactText(page, exchange.selectors.marketButton, ["button", "div"]);
      if (marketBtn) {
        console.log(`[${exchange.name}] Found Market button, clicking...`);
        await marketBtn.click();
        console.log(`[${exchange.name}] Selected MARKET order`);
        await delay(300);
        return true;
      } else {
        console.log(`[${exchange.name}] ⚠️  Market button not found`);
      }
    }
  } catch (error) {
    console.log(`[${exchange.name}] ⚠️  Error in selectOrderType: ${error.message}`);
  }
  return false;
}

/**
 * Find size and price input fields
 */
export async function findSizeAndPriceInputs(page, orderType) {
  const inputs = await page.$$('input[type="text"], input[type="number"], input:not([type])');
  let sizeInput = null;
  let priceInput = null;

  console.log(`Found ${inputs.length} text input elements on page`);

  // Get screen width for percentage-based filtering (works for all screen sizes)
  const screenWidth = await page.evaluate(() => window.innerWidth);
  const rightSideThreshold = screenWidth * 0.4; // Right 60% of screen (relaxed from 50% for better compatibility)

  for (const input of inputs) {
    const rect = await input.boundingBox();
    if (!rect) continue;

    // Look for inputs in the right panel (trading panel is on the right side)
    // Use percentage-based approach for screen-size independence
    // Skip inputs on the far left (likely navigation/menu)
    if (rect.x < rightSideThreshold) {
      console.log(`  Skipping input at x=${Math.round(rect.x)} (left side of screen)`);
      continue;
    }

    const inputInfo = await page.evaluate((el) => {
      // Get all text content around this input
      let parent = el.parentElement;
      let parentText = "";
      let labelText = "";
      let siblingText = "";

      // Check for label using multiple methods
      const labels = document.querySelectorAll("label");
      for (const label of labels) {
        // Method 1: label.control points to input
        if (label.control === el) {
          labelText = label.textContent?.trim() || "";
          break;
        }
        // Method 2: label's 'for' attribute matches input id
        if (label.getAttribute('for') === el.id && el.id) {
          labelText = label.textContent?.trim() || "";
          break;
        }
        // Method 3: label contains the input
        if (label.contains(el)) {
          labelText = label.textContent?.trim() || "";
          break;
        }
      }

      // Check previous sibling for label text (Kraken uses this pattern)
      let prevSibling = el.previousElementSibling;
      for (let i = 0; i < 3 && prevSibling; i++) {
        const text = prevSibling.textContent?.trim() || "";
        if (text && (text.toLowerCase().includes('quantity') || text.toLowerCase().includes('size'))) {
          siblingText = text;
          break;
        }
        prevSibling = prevSibling.previousElementSibling;
      }

      // Get parent text (more thorough search)
      for (let i = 0; i < 7 && parent; i++) {
        if (parent.innerText) {
          parentText = parent.innerText;
          break;
        }
        parent = parent.parentElement;
      }

      return {
        placeholder: el.placeholder || "",
        value: el.value || "",
        id: el.id || "",
        name: el.name || "",
        parentText: parentText,
        labelText: labelText,
        siblingText: siblingText,
      };
    }, input);

    console.log(`Input at (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
    console.log(
      `  ID: "${inputInfo.id}", Name: "${inputInfo.name}", Placeholder: "${inputInfo.placeholder}"`
    );
    console.log(
      `  Label: "${inputInfo.labelText}", Sibling: "${inputInfo.siblingText}", Parent: "${inputInfo.parentText.substring(0, 60)}"`
    );
    console.log(`  Current value: "${inputInfo.value}"`);

    // Check if this is the Size input (case-insensitive for better matching)
    // For GRVT: placeholder is "Quantity"
    // For Kraken: label/sibling text is "Quantity"
    const parentTextLower = inputInfo.parentText.toLowerCase();
    const labelTextLower = inputInfo.labelText.toLowerCase();
    const siblingTextLower = inputInfo.siblingText.toLowerCase();
    const placeholderLower = inputInfo.placeholder.toLowerCase();
    const idLower = inputInfo.id.toLowerCase();
    const nameLower = inputInfo.name.toLowerCase();
    
    const isSizeInput =
      parentTextLower.includes("size") ||
      labelTextLower.includes("size") ||
      siblingTextLower.includes("size") ||
      placeholderLower.includes("size") ||
      idLower.includes("size") ||
      nameLower.includes("size") ||
      // Also check for "quantity" (GRVT uses "Quantity" placeholder, Kraken uses "Quantity" label)
      parentTextLower.includes("quantity") ||
      labelTextLower.includes("quantity") ||
      siblingTextLower.includes("quantity") ||
      placeholderLower.includes("quantity") ||
      placeholderLower === "quantity" || // Exact match for GRVT
      labelTextLower === "quantity" || // Exact match for Kraken label
      siblingTextLower === "quantity" || // Exact match for Kraken sibling
      idLower.includes("quantity") ||
      nameLower.includes("quantity");

    // Check if this is the Price input
    // For GRVT: Also check for "Price" in lowercase and variations
    // For GRVT: Price input has "Mid" in value or parent text (similar to "BTC" for quantity)
    const isPriceInput =
      inputInfo.parentText.toLowerCase().includes("price") ||
      inputInfo.labelText.toLowerCase().includes("price") ||
      inputInfo.placeholder.toLowerCase().includes("price") ||
      inputInfo.id.toLowerCase().includes("price") ||
      inputInfo.name.toLowerCase().includes("price") ||
      // For GRVT: Check for "Mid" in value or parent text
      inputInfo.value.toLowerCase().includes("mid") ||
      inputInfo.parentText.toLowerCase().includes("mid") ||
      inputInfo.siblingText.toLowerCase().includes("mid") ||
      // Also check for price-like patterns (numbers with $ or commas)
      (inputInfo.value && inputInfo.value.match(/^\$?[0-9,]+(\.[0-9]+)?$/)) ||
      // Check if input is near "Price" text
      (inputInfo.siblingText.toLowerCase().includes("price"));

    if (isSizeInput && !sizeInput) {
      sizeInput = input;
      console.log("✓ Found size input!");
    } else if (isPriceInput && !priceInput && orderType === "limit") {
      priceInput = input;
      console.log("✓ Found price input!");
    }
  }
  
  // For GRVT: If we found size input but not price input, look for input positioned near size input
  if (sizeInput && !priceInput && orderType === "limit") {
    console.log("⚠️  Price input not found via text search, trying position-based search...");
    const sizeRect = await sizeInput.boundingBox();
    if (sizeRect) {
      for (const input of inputs) {
        if (input === sizeInput) continue; // Skip the size input itself
        const rect = await input.boundingBox();
        if (!rect) continue;
        
        // Check if input is on the same row (Y within 50px) and close horizontally (within 400px)
        const sameRow = Math.abs(rect.y - sizeRect.y) < 50;
        const closeHorizontally = Math.abs(rect.x - sizeRect.x) < 400 && rect.x !== sizeRect.x;
        
        if (sameRow && closeHorizontally) {
          // This is likely the Price input - verify it's not disabled/readonly
          const isEnabled = await page.evaluate((el) => {
            return el.offsetParent !== null && !el.disabled && !el.readOnly;
          }, input);
          
          if (isEnabled) {
            priceInput = input;
            console.log("✓ Found price input via position-based search (near quantity input)!");
            break;
          }
        }
      }
    }
  }

  // Fallback 1: If size input not found, look for input with "BTC" in value or nearby text (right side only)
  if (!sizeInput) {
    console.log("⚠️  Size input not found with standard methods, trying fallback 1 (looking for input with BTC on right side)...");
    for (const input of inputs) {
      const rect = await input.boundingBox();
      if (!rect || rect.x < rightSideThreshold) continue;

      const inputInfo = await page.evaluate((el) => {
        const value = el.value || "";
        const placeholder = el.placeholder || "";
        let parent = el.parentElement;
        let parentText = "";
        let prevSibling = el.previousElementSibling;
        let siblingText = "";
        
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.innerText) {
            parentText = parent.innerText;
            break;
          }
          parent = parent.parentElement;
        }
        
        if (prevSibling) {
          siblingText = prevSibling.textContent?.trim() || "";
        }
        
        return {
          value: value,
          placeholder: placeholder,
          parentText: parentText,
          siblingText: siblingText,
          hasBtc: value.toLowerCase().includes("btc") || 
                  placeholder.toLowerCase().includes("btc") ||
                  parentText.toLowerCase().includes("btc") ||
                  siblingText.toLowerCase().includes("btc")
        };
      }, input);

      // If input has BTC in value or nearby, and it's not the price input, it's likely the size input
      if (inputInfo.hasBtc && !inputInfo.value.match(/^\$?[0-9,]+(\.[0-9]+)?$/)) {
        // Not a price format (price would be like $84,742.3)
        sizeInput = input;
        console.log("✓ Found size input via BTC fallback!");
        
        // After finding size input, try to find price input nearby (for GRVT)
        if (!priceInput && orderType === "limit") {
          const sizeRect = await sizeInput.boundingBox();
          if (sizeRect) {
            for (const otherInput of inputs) {
              if (otherInput === sizeInput) continue;
              const otherRect = await otherInput.boundingBox();
              if (!otherRect || otherRect.x < rightSideThreshold) continue;
              
              const sameRow = Math.abs(otherRect.y - sizeRect.y) < 50;
              const closeHorizontally = Math.abs(otherRect.x - sizeRect.x) < 400 && otherRect.x !== sizeRect.x;
              
              if (sameRow && closeHorizontally) {
                const isEnabled = await page.evaluate((el) => {
                  return el.offsetParent !== null && !el.disabled && !el.readOnly;
                }, otherInput);
                
                if (isEnabled) {
                  priceInput = otherInput;
                  console.log("✓ Found price input via position-based search (near quantity from BTC fallback)!");
                  break;
                }
              }
            }
          }
        }
        break;
      }
    }
  }

  // Fallback 2: If still not found, search ALL inputs without position filter (for Kraken)
  if (!sizeInput) {
    console.log("⚠️  Size input still not found, trying fallback 2 (searching all inputs without position filter)...");
    for (const input of inputs) {
      const rect = await input.boundingBox();
      if (!rect) continue;

      const inputInfo = await page.evaluate((el) => {
        const value = el.value || "";
        const placeholder = el.placeholder || "";
        let parent = el.parentElement;
        let parentText = "";
        let labelText = "";
        let prevSibling = el.previousElementSibling;
        let siblingText = "";
        
        // Check for label
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          if (label.control === el || label.getAttribute('for') === el.id || label.contains(el)) {
            labelText = label.textContent?.trim() || "";
            break;
          }
        }
        
        if (prevSibling) {
          siblingText = prevSibling.textContent?.trim() || "";
        }
        
        for (let i = 0; i < 7 && parent; i++) {
          if (parent.innerText) {
            parentText = parent.innerText;
            break;
          }
          parent = parent.parentElement;
        }
        
        const allText = (value + " " + placeholder + " " + labelText + " " + siblingText + " " + parentText).toLowerCase();
        
        return {
          value: value,
          placeholder: placeholder,
          labelText: labelText,
          siblingText: siblingText,
          parentText: parentText,
          hasQuantity: allText.includes("quantity"),
          hasSize: allText.includes("size"),
          hasBtc: allText.includes("btc"),
          isNumeric: /^[0-9.,]+$/.test(value.replace(/[^0-9.,]/g, ""))
        };
      }, input);

      // Check if this looks like a size/quantity input
      if ((inputInfo.hasQuantity || inputInfo.hasSize || inputInfo.hasBtc) && 
          inputInfo.isNumeric && 
          !inputInfo.value.match(/^\$?[0-9,]+(\.[0-9]+)?$/)) {
        // Has quantity/size/BTC text and numeric value, not a price format
        sizeInput = input;
        console.log(`✓ Found size input via fallback 2! (hasQuantity: ${inputInfo.hasQuantity}, hasSize: ${inputInfo.hasSize}, hasBtc: ${inputInfo.hasBtc})`);
        break;
      }
    }
  }

  return { sizeInput, priceInput };
}

/**
 * Enter price into price input field
 */
export async function enterPrice(page, priceInput, price, orderType) {
  if (orderType === "limit" && price) {
    if (priceInput) {
      console.log(`Clearing and entering price: ${price}`);
      
      // Get current value
      const currentValue = await page.evaluate((el) => el.value || '', priceInput);
      console.log(`Current price value: "${currentValue}"`);
      
      // Focus the input
      await priceInput.focus();
      await delay(200);
      
      // Method 1: Triple click to select all, then Backspace
      await priceInput.click({ clickCount: 3 });
      await delay(200);
      await page.keyboard.press("Backspace");
      await delay(200);
      
      // Verify it's cleared
      let clearedValue = await page.evaluate((el) => el.value || '', priceInput);
      console.log(`Price value after clearing: "${clearedValue}"`);
      
      // If not cleared, use JavaScript to clear
      if (clearedValue && clearedValue.trim() !== '') {
        console.log(`Price not fully cleared, using JavaScript to clear...`);
        await page.evaluate((el) => {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, priceInput);
        await delay(200);
        clearedValue = await page.evaluate((el) => el.value || '', priceInput);
        console.log(`Price value after JavaScript clear: "${clearedValue}"`);
      }
      
      // Type the new price value
      const priceStr = String(price);
      console.log(`Typing price value: "${priceStr}"`);
      await priceInput.type(priceStr, { delay: 50 });
      await delay(300);
      
      // Verify the value was set
      const finalValue = await page.evaluate((el) => el.value || '', priceInput);
      console.log(`Final price value: "${finalValue}"`);
      
      // Trigger input/change events to ensure UI updates
      await page.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, priceInput);
      await delay(200);
      
      console.log(`✅ Price entered: ${price}`);
    } else {
      console.log(`⚠️  Price input not provided, trying fallback...`);
      const allInputs = await page.$$("input");
      for (const inp of allInputs) {
        const rect = await inp.boundingBox();
        if (rect && rect.x > 1000 && rect.y > 150 && rect.y < 300) {
          await inp.focus();
          await delay(200);
          await inp.click({ clickCount: 3 });
          await delay(100);
          await page.keyboard.press("Backspace");
          await delay(200);
          await page.evaluate((el) => {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, inp);
          await delay(200);
          await inp.type(String(price), { delay: 50 });
          console.log(`Entered price: ${price} (fallback)`);
          break;
        }
      }
    }
    await delay(300);
  }
}

/**
 * Enter size/quantity into size input field
 */
export async function enterSize(page, sizeInput, qty, exchange) {
  if (!sizeInput) {
    console.log(`[${exchange.name}] ❌ Size input not found! Cannot proceed with trade.`);
    return { success: false, error: "Size input field not found" };
  }

  console.log(`\n[${exchange.name}] === Entering Size ===`);
  console.log(`[${exchange.name}] Target size from env: ${qty}`);

  const desiredQtyStr = String(qty).trim();
  const desiredQtyNum = parseFloat(desiredQtyStr);
  
  // Get current value before clearing
  const currentValue = await page.evaluate((el) => el.value || '', sizeInput);
  console.log(`[${exchange.name}] Current size value in input: "${currentValue}"`);

  // Method 1: Triple click to select all, then Backspace to clear, then type new value
  console.log(`[${exchange.name}] Method 1: Triple click + Backspace + Type new value...`);
  await sizeInput.focus();
  await delay(200);
  
  // Triple click to select all text (platform-independent)
  await sizeInput.click({ clickCount: 3 });
  await delay(200);
  
  // Press Backspace to delete selected text
  await page.keyboard.press("Backspace");
  await delay(200);
  
  // Verify it's cleared
  let clearedValue = await page.evaluate((el) => el.value || '', sizeInput);
  console.log(`[${exchange.name}] Value after triple click + Backspace: "${clearedValue}"`);
  
  // If not cleared, try JavaScript clear
  if (clearedValue && clearedValue.trim() !== '') {
    console.log(`[${exchange.name}] Input not fully cleared, using JavaScript clear...`);
    await page.evaluate((el) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(200);
    clearedValue = await page.evaluate((el) => el.value || '', sizeInput);
    console.log(`[${exchange.name}] Value after JavaScript clear: "${clearedValue}"`);
  }
  
  // Type the new value from env
  console.log(`[${exchange.name}] Typing new size value: "${desiredQtyStr}"...`);
  await sizeInput.type(desiredQtyStr, { delay: 50 });
  await delay(300);
  
  // Trigger input/change events to ensure UI updates
  await page.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }, sizeInput);
  await delay(300);

  // Verify the value was set correctly
  let actualValue = await page.evaluate((el) => el.value || '', sizeInput);
  console.log(`[${exchange.name}] Size input value after typing: "${actualValue}"`);
  
  // Check if value matches (allowing for small floating point differences)
  const actualValueNum = parseFloat(actualValue.replace(/,/g, ''));
  const isMatch = actualValueNum && !isNaN(actualValueNum) && 
                  Math.abs(actualValueNum - desiredQtyNum) < 0.0001;
  
  // If value wasn't set properly, try alternative method
  if (!isMatch) {
    console.log(`[${exchange.name}] ⚠️  First attempt failed (expected: "${desiredQtyStr}", got: "${actualValue}"), trying alternative method...`);

    // Method 2: Focus, clear with JS, then type
    await sizeInput.focus();
    await delay(200);

    // Clear using JavaScript
    await page.evaluate((el) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(200);
    
    // Triple click again to ensure selection
    await sizeInput.click({ clickCount: 3 });
    await delay(100);
    await page.keyboard.press("Backspace");
    await delay(100);

    // Type again
    await sizeInput.type(desiredQtyStr, { delay: 50 });
    await delay(300);
    
    // Trigger events
    await page.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sizeInput);
    await delay(300);

    actualValue = await page.evaluate((el) => el.value || '', sizeInput);
    const actualValueNum2 = parseFloat(actualValue.replace(/,/g, ''));
    const isMatch2 = actualValueNum2 && !isNaN(actualValueNum2) && 
                     Math.abs(actualValueNum2 - desiredQtyNum) < 0.0001;
    console.log(`[${exchange.name}] Size input value after second attempt: "${actualValue}" (match: ${isMatch2})`);
    
    if (!isMatch2) {
      // Method 3: Direct value assignment as last resort
      console.log(`[${exchange.name}] Second attempt failed, using direct assignment...`);

      await page.evaluate(
        (el, value) => {
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        },
        sizeInput,
        desiredQtyStr
      );
      await delay(500);

      actualValue = await page.evaluate((el) => el.value || '', sizeInput);
      const actualValueNum3 = parseFloat(actualValue.replace(/,/g, ''));
      const isMatch3 = actualValueNum3 && !isNaN(actualValueNum3) && 
                       Math.abs(actualValueNum3 - desiredQtyNum) < 0.0001;
      console.log(`[${exchange.name}] Size input value after direct assignment: "${actualValue}" (match: ${isMatch3})`);
      
      if (!isMatch3) {
        console.log(`[${exchange.name}] ❌ Failed to set size value after all methods!`);
        return { success: false, error: `Failed to enter size value. Expected: "${desiredQtyStr}", got: "${actualValue}"` };
      }
    }
  }

  // Final verification
  const finalValue = await page.evaluate((el) => el.value || '', sizeInput);
  const finalValueNum = parseFloat(finalValue.replace(/,/g, ''));
  if (!finalValue || finalValue.trim() === "" || !finalValueNum || isNaN(finalValueNum)) {
    console.log(`[${exchange.name}] ❌ Failed to set size value! Final value: "${finalValue}"`);
    return { success: false, error: "Failed to enter size value" };
  }
  
  console.log(`[${exchange.name}] ✅ Successfully set size to: "${finalValue}" (target: "${desiredQtyStr}")`);
  return { success: true };
}

/**
 * Click confirm button (generic implementation)
 */
export async function clickConfirmButton(page, confirmBtn, confirmText, exchange, side) {
  // Log which exchange and button before clicking
  console.log(`[${exchange.name}] 🖱️  Clicking "${confirmText}" button now...`);
  
  // Scroll button into view and ensure it's not hidden behind footer
  const buttonInfo = await page.evaluate((btn) => {
    const rect = btn.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    
    // Check if button is in viewport
    const isInViewport = rect.top >= 0 && 
                        rect.left >= 0 && 
                        rect.bottom <= viewportHeight && 
                        rect.right <= viewportWidth;
    
    // Check if button might be covered by footer (in bottom 15% of viewport)
    const isNearFooter = rect.bottom > viewportHeight * 0.85;
    
    // Get element at button's center point to check if something is covering it
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    
    // Check if the element at the point is the button itself or inside it
    const isCovered = elementAtPoint && 
                    !btn.contains(elementAtPoint) && 
                    elementAtPoint !== btn &&
                    !elementAtPoint.closest('button, [role="button"]');
    
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      isInViewport,
      isNearFooter,
      isCovered,
      viewportHeight,
      viewportWidth,
      centerX,
      centerY
    };
  }, confirmBtn);
  
  console.log(`Button position: (${Math.round(buttonInfo.x)}, ${Math.round(buttonInfo.y)}), Viewport: ${buttonInfo.viewportWidth}x${buttonInfo.viewportHeight}`);
  
  // Scroll button into view if needed
  if (!buttonInfo.isInViewport || buttonInfo.isNearFooter) {
    console.log(`📜 Scrolling button into view (isInViewport: ${buttonInfo.isInViewport}, isNearFooter: ${buttonInfo.isNearFooter})...`);
    await confirmBtn.evaluate((btn) => {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    });
    await delay(500); // Wait for scroll to complete
    
    // Re-check position after scroll
    const newButtonInfo = await page.evaluate((btn) => {
      const rect = btn.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      return {
        y: rect.y,
        bottom: rect.bottom,
        viewportHeight,
        isInViewport: rect.top >= 0 && rect.bottom <= viewportHeight
      };
    }, confirmBtn);
    
    console.log(`After scroll: y=${Math.round(newButtonInfo.y)}, bottom=${Math.round(newButtonInfo.bottom)}, viewport=${newButtonInfo.viewportHeight}`);
    
    // If still too close to footer, scroll up a bit more
    if (newButtonInfo.bottom > newButtonInfo.viewportHeight * 0.9) {
      console.log(`⚠️  Button still too close to footer, scrolling up more...`);
      await page.evaluate(() => {
        window.scrollBy(0, -100); // Scroll up 100px
      });
      await delay(300);
    }
  }
  
  // Check if button is covered by another element
  if (buttonInfo.isCovered) {
    console.log(`⚠️  Button might be covered by another element, trying to click anyway...`);
  }
  
  // Use JavaScript click as fallback if element might be covered
  // First try Puppeteer's click, which handles some coverage cases
  try {
    await confirmBtn.click({ delay: 100 });
    console.log(`✓ Successfully clicked "${confirmText}" button`);
  } catch (clickError) {
    console.log(`⚠️  Puppeteer click failed: ${clickError.message}, trying JavaScript click...`);
    // Fallback to JavaScript click
    await confirmBtn.evaluate((btn) => {
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
      btn.click();
    });
    console.log(`✓ Successfully clicked "${confirmText}" button (via JavaScript)`);
  }
  await delay(2000); // Wait for order submission to process
}

/**
 * Verify order was placed successfully
 */
export async function verifyOrderPlacement(page, exchange, side, qty) {
  // Check for error messages first
  const errorMsg = await page.evaluate(() => {
    const errors = document.querySelectorAll(
      '[class*="error"], [class*="Error"]'
    );
    for (const err of errors) {
      if (err.textContent) return err.textContent;
    }
    return null;
  });

  if (errorMsg) {
    console.log(`[${exchange.name}] Trade error:`, errorMsg);
    return { success: false, error: errorMsg };
  }

  // Verify order was placed and is pending
  console.log(`[${exchange.name}] Verifying order placement...`);
  // Use shorter timeout for Extended Exchange (3 seconds) since it confirms quickly
  const timeout = exchange.name?.toLowerCase().includes('extended') ? 3000 : 10000;
  const orderVerified = await verifyOrderPlaced(page, exchange, side, qty, timeout);
  
  if (orderVerified.success) {
    console.log(`[${exchange.name}] ✓ Order confirmed as ${orderVerified.status || 'pending'}`);
    console.log(`[${exchange.name}] Order verification completed, returning success...`);
    return { success: true, message: "Trade submitted and order confirmed", orderStatus: orderVerified.status };
  } else {
    console.log(`[${exchange.name}] ⚠️  Order verification: ${orderVerified.reason || 'Could not verify order placement'}`);
    // Still return success if no error was found (order might be placed but not yet visible)
    console.log(`[${exchange.name}] Order verification inconclusive, returning success anyway...`);
    return { success: true, message: "Trade submitted (verification inconclusive)", warning: orderVerified.reason };
  }
}
