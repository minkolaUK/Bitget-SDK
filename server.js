const express = require('express');
const {
  isWsFuturesAccountSnapshotEvent,
  isWsFuturesPositionsSnapshotEvent,
  WebsocketClientV2,
  RestClientV2
} = require('bitget-api');
require('dotenv').config();

const app = express();
app.use(express.json());

// Load environment variables
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const API_PASSPHRASE = process.env.API_PASSPHRASE;

// Check API credentials
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

// Helper to log WebSocket events
function logWSEvent(type, data) {
  console.log(new Date(), `WS ${type} event:`, data);
}

// Simple sleep function for waiting
function promiseSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Helper function to round down values
function roundDown(value, decimals) {
  return Number(
    Math.floor(parseFloat(value + 'e' + decimals)) + 'e-' + decimals
  );
}

// Manage trading assets by closing positions and canceling orders
async function manageTradingAssets(symbol) {
  const productType = "USDT-FUTURES";
  const marginCoin = "USDT";

  try {
    await closeOpenPositions(symbol, productType);
    await cancelAllOrders(symbol, productType, marginCoin);
  } catch (e) {
    console.error('Error managing trading assets:', e.message);
    throw new Error('Failed to manage trading assets.');
  }
}

// Function to fetch account assets
async function getAccountAssets() {
  try {
    const accountAssets = await restClientV2.getFuturesAccountAsset({});
    console.log('Account assets:', accountAssets.data);
    return accountAssets.data;
  } catch (e) {
    console.error('Error fetching account assets:', e.message);
    throw e;
  }
}

// Close all open positions for a given symbol
async function closeOpenPositions(symbol, productType) {
  try {
    const positionsResult = await restClientV2.getFuturesPositions({ productType });
    const positions = positionsResult.data;

    if (positions.length > 0) {
      console.log('Open positions found. Closing all positions.');
      for (const position of positions) {
        if (position.symbol === symbol) {
          const holdSide = position.side === 'buy' ? 'short' : 'long';  // Opposite side to close
          const closeResponse = await restClientV2.futuresClosePositions({
            symbol,
            productType,
            holdSide,
          });

          if (closeResponse.code === 0) {
            console.log(`Position closed for ${symbol} on ${holdSide} side.`, closeResponse);
          } else {
            const flashCloseResponse = await restClientV2.futuresFlashClosePositions({
              symbol,
              productType,
              holdSide,
            });
            console.log(`Flash close for ${symbol} on ${holdSide} side.`, flashCloseResponse);
          }
        }
      }
    } else {
      console.log('No open positions found.');
    }
  } catch (e) {
    console.error('Error closing open positions:', e.message);
    throw e;
  }
}

// Cancel all open orders for a given symbol
async function cancelAllOrders(symbol, productType, marginCoin) {
  try {
    const pendingOrdersResult = await restClientV2.getFuturesOpenOrders({ symbol, productType });
    const pendingOrders = pendingOrdersResult.data;

    if (pendingOrders.length > 0) {
      console.log('Pending orders found. Canceling all pending orders.');
      for (const order of pendingOrders) {
        // Optionally introduce a small delay to avoid rate limits
        await promiseSleep(100); // 100ms delay between cancel requests
        const cancelResponse = await restClientV2.futuresCancelOrder({
          symbol,
          orderId: order.orderId,
        });
        console.log(`Pending order canceled for ${symbol}.`, cancelResponse);
      }
    } else {
      console.log('No pending orders found.');
    }
  } catch (e) {
    console.error('Error canceling orders:', e.message);
    throw e;
  }
}

// Handle WebSocket updates based on event type
async function handleWsUpdate(event) {
  if (isWsFuturesAccountSnapshotEvent(event)) {
    console.log(new Date(), 'ws update (account balance):', event);
    return;
  }

  if (isWsFuturesPositionsSnapshotEvent(event)) {
    console.log(new Date(), 'ws update (positions):', event);
    return;
  }

  // Log any unhandled events for debugging
  logWSEvent('update (unhandled)', event);
}

// Function to place a trade with stop-loss and take-profit
async function placeTrade(symbol, price, size, orderType, marginCoin, side, leverage, presetTakeProfitPrice, presetStopLossPrice) {
  const productType = 'UMCBL'; // Use 'UMCBL' for USDT perpetual futures
  const marginMode = 'isolated'; // Ensure marginMode is correctly defined
  const tradeSide = 'open'; // 'open' for new positions, 'close' for closing positions
  const force = 'gtc'; // Default force, can be 'ioc', 'fok', etc.

  try {
    // Set leverage
    const holdSide = side === 'buy' ? 'long' : 'short';
    await restClientV2.setFuturesLeverage({
      symbol,
      productType,
      marginCoin,
      leverage,
      holdSide
    });

    // Place the order
    const order = {
      symbol,
      productType,
      marginMode,
      marginCoin,
      size,
      price,
      side,
      tradeSide,
      orderType,
      force,
      presetTakeProfitPrice, 
      presetStopLossPrice   
    };

    console.log('Placing order: ', order);
    const result = await restClientV2.futuresSubmitOrder(order);
    console.log('Order result: ', result);
    return result;
  } catch (e) {
    console.error('Error placing order:', e.message);
    throw e;
  }
}

// Webhook endpoint to place an order
app.post('/webhook', async (req, res) => {
  const {
    symbol,
    price,
    size,
    orderType,
    marginCoin,
    side,
    leverage,
    presetTakeProfitPrice,
    presetStopLossPrice
  } = req.body;

  // Validate request data
  if (!symbol || !price || !size || !orderType || !marginCoin || !side) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Manage open positions and orders before placing a new order
    await manageTradingAssets(symbol);

    // Place the trade
    const result = await placeTrade(symbol, price, size, orderType, marginCoin, side, leverage, presetTakeProfitPrice, presetStopLossPrice);

    res.status(200).json(result);
  } catch (e) {
    console.error('Error placing order:', e.message);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// Start WebSocket client and handle events
(async () => {
  try {
    // Add event listeners to log websocket events
    wsClient.on('update', handleWsUpdate);
    wsClient.on('open', (data) => logWSEvent('open', data));
    wsClient.on('response', (data) => logWSEvent('response', data));
    wsClient.on('reconnect', (data) => logWSEvent('reconnect', data));
    wsClient.on('reconnected', (data) => logWSEvent('reconnected', data));
    wsClient.on('authenticated', (data) => logWSEvent('authenticated', data));
    wsClient.on('exception', (data) => logWSEvent('exception', data));

    // Subscribe to WebSocket topics
    wsClient.subscribeTopic('USDT-FUTURES', 'account');
    wsClient.subscribeTopic('USDT-FUTURES', 'positions');
    wsClient.subscribeTopic('USDT-FUTURES', 'trade');
    wsClient.subscribeTopic('USDT-FUTURES', 'ticker');
    wsClient.subscribeTopic('USDT-FUTURES', 'fill');
    wsClient.subscribeTopic('USDT-FUTURES', 'orders');
    wsClient.subscribeTopic('USDT-FUTURES', 'orders-algo');
    wsClient.subscribeTopic('USDT-FUTURES', 'liquidation');
  } catch (e) {
    console.error('WebSocket client error:', e.message);
  }
})();

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
