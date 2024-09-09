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

// Main function to manage trading assets by closing positions and canceling orders
async function manageTradingAssets(symbol) {
  const productType = "USDT-FUTURES";
  const marginCoin = "USDT";

  try {
    // Close all open positions for the symbol
    await closeOpenPositions(symbol, productType);

    // Cancel all orders for the symbol
    await futuresCancelAllOrders(symbol, productType, marginCoin);
  } catch (e) {
    console.error('Error managing trading assets:', e.message);
    throw new Error('Failed to manage trading assets.');
  }
}

// Function to fetch and log all open positions
async function getFuturesPositions(productType, marginCoin) {
  try {
    console.log(`Fetching futures positions with productType=${productType} and marginCoin=${marginCoin}`);
    const positionsResult = await restClientV2.getFuturesPositions(productType, marginCoin);
    const positions = positionsResult.data;

    if (positions.length > 0) {
      console.log('Open positions:');
      positions.forEach(position => {
        console.log(`Symbol: ${position.symbol}, Side: ${position.side}, Size: ${position.size}`);
      });
    } else {
      console.log('No open positions found.');
    }
  } catch (e) {
    console.error('Error fetching open positions:', e.message);
    throw e;
  }
}

// Function to fetch and log all open orders
async function getFuturesOpenOrders(symbol, productType) {
  try {
    console.log(`Fetching open orders for symbol=${symbol} and productType=${productType}`);
    const pendingOrdersResult = await restClientV2.getFuturesOpenOrders(symbol, productType);
    const pendingOrders = pendingOrdersResult.data;

    if (pendingOrders.length > 0) {
      console.log('Open orders:');
      pendingOrders.forEach(order => {
        console.log(`Symbol: ${order.symbol}, OrderId: ${order.orderId}, Side: ${order.side}, Price: ${order.price}, Size: ${order.size}`);
      });
    } else {
      console.log('No open orders found.');
    }
  } catch (e) {
    console.error('Error fetching open orders:', e.message);
    throw e;
  }
}

// Close all open positions for a given symbol
async function closeOpenPositions(symbol, productType) {
  try {
    const positionsResult = await restClientV2.getFuturesPositions(productType, 'USDT');
    const positions = positionsResult.data;

    if (positions.length > 0) {
      console.log('Open positions found. Closing all positions.');
      for (const position of positions) {
        if (position.symbol === symbol) {
          const holdSide = position.side === 'buy' ? 'long' : 'short'; // Assuming 'buy' is long and 'sell' is short
          const closeResponse = await restClientV2.futuresFlashClosePositions({
            symbol,
            holdSide,
            productType,
          });

          if (closeResponse.code === '00000') {
            console.log(`Position closed for ${symbol} on ${holdSide}.`, closeResponse);
          } else {
            console.error(`Error closing position for ${symbol}.`, closeResponse);
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
async function futuresCancelAllOrders(symbol, productType, marginCoin) {
  try {
    const cancelResponse = await restClientV2.futuresCancelAllOrders(symbol, productType, marginCoin);

    if (cancelResponse.code === '00000') {
      console.log('All pending orders canceled successfully.', cancelResponse.data);
    } else {
      console.error('Error canceling all orders:', cancelResponse.msg);
    }
  } catch (e) {
    console.error('Error canceling orders:', e.message);
    throw e;
  }
}

// Cancel a specific order
async function futuresCancelOrder(symbol, productType, marginCoin, orderId, clientOid) {
  try {
    const cancelResponse = await restClientV2.futuresCancelOrder(symbol, productType, marginCoin, orderId, clientOid);

    if (cancelResponse.code === '00000') {
      console.log(`Order ${orderId || clientOid} canceled successfully.`, cancelResponse.data);
    } else {
      console.error('Error canceling order:', cancelResponse.msg);
    }
  } catch (e) {
    console.error('Error canceling order:', e.message);
    throw e;
  }
}

// Handle WebSocket updates based on event type
async function handleWsUpdate(event) {
  if (isWsFuturesAccountSnapshotEvent(event)) {
    console.log(new Date(), 'WS update (account balance):', event);
    return;
  }

  if (isWsFuturesPositionsSnapshotEvent(event)) {
    console.log(new Date(), 'WS update (positions):', event);
    return;
  }

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

// Perform startup checks to log current positions and orders
async function startupCheck(symbol = 'BTCUSDT') {
  const productType = 'USDT-FUTURES';
  const marginCoin = 'USDT';

  try {
    console.log('Starting up...');
    
    // Fetch and log open positions
    await getFuturesPositions(productType, marginCoin);
    
    // Fetch and log open orders for the specified symbol
    await getFuturesOpenOrders(symbol, productType);
  } catch (e) {
    console.error('Error during startup check:', e.message);
  }
}

// Start WebSocket connection and perform startup checks
wsClient.connect();
startupCheck();

// Set up WebSocket event handlers
wsClient.on('update', handleWsUpdate);

// Start the Express server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
