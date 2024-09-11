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

// Simple sleep function for waiting
function promiseSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Function to round down values
function roundDown(value, decimals) {
  return Number(Math.floor(parseFloat(value + 'e' + decimals)) + 'e-' + decimals);
}

// Get positions and orders for a symbol
async function getOrdersAndPositions(symbol) {
  const productType = 'UMCBL';
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

// Flash close open positions
async function flashClosePositions(symbol, holdSide) {
  const productType = 'USDT-FUTURES';

  try {
    const closeResponse = await restClientV2.futuresFlashClosePositions({
      symbol,
      holdSide,
      productType
    });

    console.log('Flash Close Positions Response:', closeResponse);

    if (closeResponse.code === '00000') {
      console.log(`Positions closed for ${symbol} on ${holdSide} side.`);
    } else {
      console.error(`Failed to close positions for ${symbol}. Response:`, closeResponse);
    }
  } catch (e) {
    console.error('Error closing positions:', e.message);
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
  const productType = 'USDT-FUTURES';
  const marginCoin = 'USDT';

  try {
    // Determine position direction for flash close
    const positionsResult = await restClientV2.getFuturesPositions(productType, marginCoin);
    const positions = positionsResult.data;
    
    let holdSide = '';
    if (positions.some(pos => pos.symbol === symbol && pos.side === 'long')) {
      holdSide = 'long';
    } else if (positions.some(pos => pos.symbol === symbol && pos.side === 'short')) {
      holdSide = 'short';
    }
    
    await flashClosePositions(symbol, holdSide);
    await cancelAllOpenOrders(symbol);
  } catch (e) {
    console.error('Error managing trading assets:', e.message);
    throw new Error('Failed to manage trading assets.');
  }
}

// WebSocket event handlers
function handleWsUpdate(data) {
  console.log('WebSocket update:', data);
}

function logWSEvent(eventType, data) {
  console.log(`WebSocket event [${eventType}]:`, data);
}

// Startup check to retrieve initial orders and positions
async function startupCheck() {
  const symbols = await fetchAvailableSymbols(); // Fetch or define available symbols

  for (const symbol of symbols) {
    try {
      await getOrdersAndPositions(symbol);
    } catch (e) {
      console.error(`Startup check failed for ${symbol}:`, e.message);
    }
  }
}

// Example function to fetch available symbols
async function fetchAvailableSymbols() {
  // Example static list; replace with dynamic fetch as needed
  return ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
}

async function postLongOrderEntry() {
  tradeDirection = 'long';

  await getAccountBalance();
  await createOrder('long', size) // direction, positionSize
};

// setTimeout(postLongOrderEntry, 5000);

async function postShortOrderEntry() {
  tradeDirection = 'short';

  await getAccountBalance();
  await createOrder('short', size)  // direction, positionSize
};
// setTimeout(postShortOrderEntry, 5000);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Perform startup checks after subscribing to WebSocket topics
await startupCheck();