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
  console.error('Missing API credentials.');
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

// Get positions and orders for a symbol
async function getOrdersAndPositions(symbol) {
  const productType = 'USDT-FUTURES';
  const marginCoin = 'USDT';

  try {
    // Fetch open positions
    const positionsResult = await restClientV2.getFuturesPositions(productType, marginCoin);
    console.log('Positions Result:', positionsResult);
    const positions = positionsResult.data;

    // Check for open positions
    console.log('Open positions:', positions.length > 0 ? positions : 'None');

    // Fetch open orders
    const openOrdersResult = await restClientV2.getFuturesOpenOrders(symbol, productType);
    console.log('Open Orders Result:', openOrdersResult);
    const openOrders = openOrdersResult.data;

    // Check for open orders
    console.log('Open orders:', openOrders.length > 0 ? openOrders : 'None');

    // Optionally, get details for each open order
    for (const order of openOrders) {
      const orderDetail = await restClientV2.getFuturesOrder(symbol, productType, order.orderId, order.clientOid);
      console.log('Order Detail:', orderDetail);
    }

    // Optionally, get fills for each order
    for (const order of openOrders) {
      const fills = await restClientV2.getFuturesFills(order.orderId, symbol, productType);
      console.log('Fills for Order:', fills);
    }

  } catch (e) {
    console.error('Error fetching open positions or orders:', e.response ? e.response.data : e.message);
    throw e;
  }
}

// Cancel all open orders for a given symbol
async function cancelAllOpenOrders(symbol) {
  const productType = 'USDT-FUTURES';
  const marginCoin = 'USDT';

  try {
    // Fetch open orders
    const pendingOrdersResult = await restClientV2.getFuturesOpenOrders(symbol, productType);
    console.log('Pending Orders Result:', pendingOrdersResult);
    const pendingOrders = pendingOrdersResult.data;

    if (pendingOrders.length > 0) {
      console.log('Pending orders found. Canceling all pending orders.');
      for (const order of pendingOrders) {
        await promiseSleep(100); // Optional small delay between cancel requests
        const cancelResponse = await restClientV2.futuresCancelOrder({
          symbol,
          productType,
          marginCoin,
          orderId: order.orderId
        });
        console.log('Cancel Order Response:', cancelResponse);
      }
    } else {
      console.log('No pending orders found.');
    }
  } catch (e) {
    console.error('Error canceling orders:', e.message);
    throw e;
  }
}

// Manage trading assets by closing positions and canceling orders
async function manageTradingAssets(symbol) {
  const productType = 'USDT-FUTURES'; // Define the product type for Bitget futures
  const marginCoin = 'USDT';   // Define the margin coin

  try {
    // Retrieve current positions
    const positionsResult = await restClientV2.getFuturesPositions(productType, marginCoin);
    const positions = positionsResult.data;

    let holdSide = '';

    // Determine the hold side based on existing positions
    if (positions.some(pos => pos.symbol === symbol && pos.side === 'long')) {
      holdSide = 'long';
    } else if (positions.some(pos => pos.symbol === symbol && pos.side === 'short')) {
      holdSide = 'short';
    }

    // Close positions if any are open
    if (holdSide) {
      console.log(`Closing ${holdSide} positions for ${symbol}.`);
      await restClientV2.flashClosePositions(symbol, holdSide, productType);
    } else {
      console.log(`No positions to close for ${symbol}.`);
    }

    // Cancel all open orders
    console.log(`Canceling all open orders for ${symbol}.`);
    await cancelAllOpenOrders(symbol);

  } catch (e) {
    console.error('Error managing trading assets:', e.message);
    throw new Error('Failed to manage trading assets.');
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

async function startupCheck() {
  const symbol = 'BTCUSDT'; // Specify symbol or fetch from a list as needed

  try {
    await getOrdersAndPositions(symbol); // Display positions and orders for a specific symbol
  } catch (e) {
    console.error(`Startup check failed for ${symbol}:`, e.message);
  }

  try {
    await restClientV2.getBalances(); // Fetch and display account assets
  } catch (e) {
    console.error('Failed to fetch account assets during startup:', e.message);
  }
}

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

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });

    // Perform startup checks after subscribing to WebSocket topics
    await startupCheck();
  } catch (e) {
    console.error('WebSocket client error:', e.message);
  }
})();
