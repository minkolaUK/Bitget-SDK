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

// Read from environmental variables
const { API_KEY, API_SECRET, API_PASSPHRASE, PORT = 3000 } = process.env;

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
  console.log(`[${new Date().toISOString()}] WS ${type} event:`, data);
}

// Simple sleep function
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// WARNING: for sensitive math you should be using a library such as decimal.js!
function roundDown(value, decimals) {
  return Number(
    Math.floor(parseFloat(value + 'e' + decimals)) + 'e-' + decimals
  );
}

// Function to close open limit orders and positions
async function manageTradingAssets(symbol) {
  const productType = "USDT-FUTURES";
  const marginCoin = "USDT";

  try {
    // Fetch and cancel all open orders
    await cancelAllOrders(symbol, productType, marginCoin);
    
    // Close open positions
    await closeOpenPositions(symbol, productType, marginCoin);

    console.log('Successfully managed trading assets for', symbol);
  } catch (error) {
    console.error('Error managing trading assets:', error.message);
    throw new Error('Failed to manage trading assets.');
  }
}

// Function to close open positions
async function closeOpenPositions(symbol, productType) {
  try {
    const { data: positions } = await restClientV2.getFuturesPositions({ productType, marginCoin: "USDT" });

    if (positions.length > 0) {
      console.log('Open positions found. Closing all positions.');
      for (const position of positions) {
        if (position.symbol === symbol) {
          const holdSide = position.holdSide; // Determine if the position is long or short
          const closeResponse = await restClientV2.futuresFlashClosePositions({
            symbol,
            holdSide,
            productType,
          });
          console.log(`Position closed for ${symbol} on ${holdSide} side.`, closeResponse);
        }
      }
    } else {
      console.log('No open positions found.');
    }
  } catch (error) {
    console.error('Error closing open positions:', error.message);
    throw error; // Rethrow error to handle it in the parent function
  }
}

// Function to cancel all open orders
async function cancelAllOrders(symbol, productType, marginCoin) {
  try {
    const { data: pendingOrders } = await restClientV2.getFuturesOpenOrders({ symbol, productType });

    if (pendingOrders.length > 0) {
      console.log('Pending orders found. Canceling all pending orders.');
      for (const order of pendingOrders) {
        const cancelResponse = await restClientV2.futuresCancelOrder({
          symbol,
          productType,
          marginCoin,
          orderId: order.orderId,
        });
        console.log(`Pending order canceled for ${symbol}.`, cancelResponse);
      }
    } else {
      console.log('No pending orders found.');
    }
  } catch (error) {
    console.error('Error canceling orders:', error.message);
    throw error; // Rethrow error to handle it in the parent function
  }
}

// WS event handler that uses type guards to narrow down event type
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

// Function to place a trade with stop-loss and take-profit
async function placeTrade(symbol, price, size, side, leverage, presetTakeProfitPrice, presetStopLossPrice) {
  const productType = 'UMCBL';
  const marginCoin = 'USDT';
  const orderType = 'limit';
  const force = 'gtc';
  const holdSide = side === 'buy' ? 'long' : 'short';

  try {
    // Set leverage
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
      marginCoin,
      size,
      price,
      side,
      orderType,
      force,
      presetTakeProfitPrice,
      presetStopLossPrice
    };

    console.log('Placing order: ', order);
    const result = await restClientV2.futuresSubmitOrder(order);
    console.log('Order result: ', result);
    return result;
  } catch (error) {
    console.error('Error placing order:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Webhook endpoint to place an order
app.post('/webhook', async (req, res) => {
  const {
    symbol,
    price,
    size,
    side,
    leverage,
    presetTakeProfitPrice,
    presetStopLossPrice
  } = req.body;

  // Validate request data
  if (!symbol || !price || !size || !side || !leverage) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Manage open positions and orders before placing a new order
    await manageTradingAssets(symbol);

    // Place the trade
    const result = await placeTrade(symbol, price, size, side, leverage, presetTakeProfitPrice, presetStopLossPrice);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error placing order:', error.message);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// Start WebSocket client and handle events
(async () => {
  try {
    // Add event listeners to log websocket events on account
    wsClient.on('update', handleWsUpdate);
    wsClient.on('open', (data) => logWSEvent('open', data));
    wsClient.on('response', (data) => logWSEvent('response', data));
    wsClient.on('reconnect', (data) => logWSEvent('reconnect', data));
    wsClient.on('reconnected', (data) => logWSEvent('reconnected', data));
    wsClient.on('authenticated', (data) => logWSEvent('authenticated', data));
    wsClient.on('exception', (data) => logWSEvent('exception', data));

    // Subscribe to private account topics
    const topics = [
      'account', 'positions', 'trade', 'ticker',
      'fill', 'orders', 'orders-algo', 'positions-history'
    ];

    for (const topic of topics) {
      wsClient.subscribeTopic('USDT-FUTURES', topic);
    }

    // Wait briefly for ws to be ready
    await sleep(2500);

    console.log('WebSocket client connected and subscribed to topics.');
  } catch (error) {
    console.error('Error setting up WebSocket client:', error);
  }
})();

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
