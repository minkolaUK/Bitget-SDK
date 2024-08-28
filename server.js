const express = require('express');
const {
  isWsFuturesAccountSnapshotEvent,
  isWsFuturesPositionsSnapshotEvent,
  WebsocketClientV2,
  RestClientV2
} = require('bitget-api');
require('dotenv').config(); // Load environment variables

const app = express();
app.use(express.json()); // Middleware to parse JSON bodies

// Read from environmental variables
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const API_PASSPHRASE = process.env.API_PASSPHRASE;

// Ensure API credentials are set
if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
  console.error('Missing API credentials. Please check your environment variables.');
  process.exit(1);
}

const wsClient = new WebsocketClientV2({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  apiPass: API_PASSPHRASE,
});

const restClientV2 = new RestClientV2({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  apiPass: API_PASSPHRASE,
});

function logWSEvent(type, data) {
  console.log(new Date(), `WS ${type} event:`, data);
}

// Simple sleep function
function promiseSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// WARNING: for sensitive math you should be using a library such as decimal.js!
function roundDown(value, decimals) {
  return Number(
    Math.floor(parseFloat(value + 'e' + decimals)) + 'e-' + decimals
  );
}

// Function to manage open positions and orders
async function manageTradingAssets(symbol) {
  const productType = "USDT-FUTURES";
  const marginCoin = "USDT";

  try {
    // Close all open positions
    await closeOpenPositions(symbol, productType);

    // Cancel all open orders
    await cancelAllOrders(symbol, productType, marginCoin);
    
  } catch (e) {
    console.error('Error managing trading assets:', e.message);
    throw new Error('Failed to manage trading assets.');
  }
}

// Function to close open positions
async function closeOpenPositions(symbol, productType) {
  try {
    const positionsResult = await restClientV2.getFuturesPositions({ productType, marginCoin: "USDT" });
    const positions = positionsResult.data;

    if (positions.length > 0) {
      console.log('Open positions found. Closing all positions.');
      for (const position of positions) {
        if (position.symbol === symbol) {
          const holdSide = position.holdSide; // Determine if the position is long or short
          const closeResponse = await restClientV2.futuresFlashClosePositions({
            symbol,
            productType,
            holdSide,
          });
          console.log(`Position closed for ${symbol} on ${holdSide} side.`, closeResponse);
        }
      }
    } else {
      console.log('No open positions found.');
    }
  } catch (e) {
    console.error('Error closing open positions:', e.message);
    throw e; // Rethrow error to handle it in the parent function
  }
}

// Function to cancel all orders
async function cancelAllOrders(symbol, productType, marginCoin) {
  try {
    const pendingOrdersResult = await restClientV2.getFuturesOpenOrders({ productType, marginCoin: "USDT" });
    const pendingOrders = pendingOrdersResult.data;

    if (pendingOrders.length > 0) {
      console.log('Pending orders found. Canceling all pending orders.');
      for (const order of pendingOrders) {
        const cancelResponse = await restClientV2.futuresCancelOrder({
          symbol,
          marginCoin,
        });
        console.log(`Pending order canceled for ${symbol}.`, cancelResponse);
      }
    } else {
      console.log('No pending orders found.');
    }
  } catch (e) {
    console.error('Error canceling orders:', e.message);
    throw e; // Rethrow error to handle it in the parent function
  }
}

/** WS event handler that uses type guards to narrow down event type */
async function handleWsUpdate(event) {
  if (isWsFuturesAccountSnapshotEvent(event)) {
    console.log(new Date(), 'ws update (account balance):', event);
    return;
  }

  if (isWsFuturesPositionsSnapshotEvent(event)) {
    console.log(new Date(), 'ws update (positions):', event);
    return;
  }

  logWSEvent('update (unhandled)', event);
}

// Webhook endpoint to place an order
app.post('/webhook', async (req, res) => {
  const {
    symbol,
    price,
    size,
    orderType,
    marginCoin,
    force,
    side,
    leverage,
    presetTakeProfitPrice,
    presetStopLossPrice,
    triggerPrice,
    triggerType = 'fill_price' // Trigger type, defaults to 'fill_price' (market price)
  } = req.body;

  // Validate request data
  if (!symbol || !price || !size || !orderType || !marginCoin || !force || !side) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Manage open positions and orders before placing a new order
    await manageTradingAssets(symbol);

    // Fetch account balance
    const balanceResult = await restClientV2.getFuturesAccountAsset({ symbol, marginCoin });
    const accountBalance = balanceResult.data;
    const availableBalance = accountBalance.available;

    // Check if the order size is within the available balance
    if (parseFloat(size) > parseFloat(availableBalance)) {
      return res.status(400).json({ error: 'Order amount exceeds available balance' });
    }

    // Set leverage if provided
    if (leverage) {
      try {
        await restClientV2.setFuturesLeverage({ symbol, marginCoin, leverage });
      } catch (e) {
        console.error('Error setting leverage:', e.message);
        return res.status(500).json({ error: 'Failed to set leverage' });
      }
    }

    // Place the order
    const order = {
      symbol,
      price,
      size,
      orderType,
      marginCoin,
      force,
      side,
      leverage, 
      presetTakeProfitPrice, 
      presetStopLossPrice, 
      triggerPrice, 
      triggerType 
    };

    console.log('Placing order: ', order);
    const result = await restClientV2.futuresSubmitOrder(order);
    console.log('Order result: ', result);

    res.status(200).json(result);
  } catch (e) {
    console.error('Error placing order:', e.message);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// Start WebSocket client and handle events
(async () => {
  try {
    // Add event listeners to log websocket events on account
    wsClient.on('update', (data) => handleWsUpdate(data));
    wsClient.on('open', (data) => logWSEvent('open', data));
    wsClient.on('response', (data) => logWSEvent('response', data));
    wsClient.on('reconnect', (data) => logWSEvent('reconnect', data));
    wsClient.on('reconnected', (data) => logWSEvent('reconnected', data));
    wsClient.on('authenticated', (data) => logWSEvent('authenticated', data));
    wsClient.on('exception', (data) => logWSEvent('exception', data));

    // Subscribe to private account topics
    wsClient.subscribeTopic('USDT-FUTURES', 'account');
    wsClient.subscribeTopic('USDT-FUTURES', 'positions');
    wsClient.subscribeTopic('USDT-FUTURES', 'trade');
    wsClient.subscribeTopic('USDT-FUTURES', 'ticker');
    wsClient.subscribeTopic('USDT-FUTURES', 'fill');
    wsClient.subscribeTopic('USDT-FUTURES', 'orders');
    wsClient.subscribeTopic('USDT-FUTURES', 'orders-algo');
    wsClient.subscribeTopic('USDT-FUTURES', 'positions-history');

    // Wait briefly for ws to be ready
    await promiseSleep(2.5 * 1000);

    console.log('WebSocket client connected and subscribed to topics.');
  } catch (e) {
    console.error('Error setting up WebSocket client:', e);
  }
})();

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
