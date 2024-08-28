const express = require('express');
const {
  FuturesClient,
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

// Initialize clients
const futuresClient = new FuturesClient({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  apiPass: API_PASSPHRASE,
});

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

// Function to check and manage open positions and orders
async function manageTradingAssets(symbol) {
  const productType = "USDT-FUTURES"; // Specify the product type
  const marginCoin = "USDT"; // Specify the margin coin

  try {
    // Check for open positions
    const positionsResult = await restClientV2.getFuturesPositions({ symbol });
    const positions = positionsResult.data;

    if (positions.length > 0) {
      console.log('Open positions found. Closing all positions.');
      for (const position of positions) {
        if (position.symbol === symbol) {
          const holdSide = position.holdSide; // Determine if the position is long or short
          const closeResponse = await restClientV2.futuresFlashClosePositions({
            symbol: position.symbol,
            productType: productType,
            holdSide: holdSide === 'long' ? 'long' : 'short'
          });
          console.log('Flash close response:', closeResponse);
        }
      }
    } else {
      console.log('No open positions found.');
    }

    // Check for pending orders
    const pendingOrdersResult = await restClientV2.getOpenOrders({ symbol, productType });
    const pendingOrders = pendingOrdersResult.data;

    if (pendingOrders.length > 0) {
      console.log('Pending orders found. Canceling all pending orders.');
      for (const order of pendingOrders) {
        if (order.symbol === symbol) {
          const cancelResponse = await restClientV2.cancelOrder({
            symbol: order.symbol,
            productType: productType,
            marginCoin: marginCoin,
            orderId: order.orderId
          });
          console.log('Cancel order response:', cancelResponse);
        }
      }
    } else {
      console.log('No pending orders found.');
    }

    // Check for limit orders
    const limitOrdersResult = await restClientV2.getOpenOrders({ symbol, productType });
    const limitOrders = limitOrdersResult.data;

    if (limitOrders.length > 0) {
      console.log('Limit orders found. Canceling all limit orders.');
      for (const order of limitOrders) {
        if (order.symbol === symbol) {
          const cancelResponse = await restClientV2.cancelOrder({
            symbol: order.symbol,
            productType: productType,
            marginCoin: marginCoin,
            orderId: order.orderId
          });
          console.log('Cancel limit order response:', cancelResponse);
        }
      }
    } else {
      console.log('No limit orders found.');
    }

    // Final check to ensure all orders and positions are closed
    await ensureAllClosed(symbol, productType, marginCoin);
    
  } catch (e) {
    console.error('Error managing trading assets:', e.message);
    throw new Error('Failed to manage trading assets.');
  }
}

// Function to ensure all orders and positions are closed
async function ensureAllClosed(symbol, productType, marginCoin) {
  try {
    const positionsResult = await restClientV2.getFuturesPositions({ symbol });
    const positions = positionsResult.data;

    if (positions.length > 0) {
      throw new Error('Not all positions are closed.');
    }

    const ordersResult = await restClientV2.getFuturesOpenOrders({ symbol, productType });
    const orders = ordersResult.data;

    if (orders.length > 0) {
      throw new Error('Not all orders are canceled.');
    }

    console.log('All positions and orders are closed.');
  } catch (e) {
    console.error('Error ensuring all are closed:', e.message);
    throw new Error('Failed to ensure all orders and positions are closed.');
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
    const balanceResult = await futuresClient.getAccount({ symbol, marginCoin });
    const accountBalance = balanceResult.data;
    const availableBalance = accountBalance.available;

    // Check if the order size is within the available balance
    if (parseFloat(size) > parseFloat(availableBalance)) {
      return res.status(400).json({ error: 'Order amount exceeds available balance' });
    }

    // Set leverage if provided
    if (leverage) {
      try {
        await futuresClient.setLeverage({ symbol, marginCoin, leverage });
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
      leverage, // Apply leverage if provided
      presetTakeProfitPrice, // Apply take profit if provided
      presetStopLossPrice, // Apply stop loss if provided
      triggerPrice, // Apply trigger price if provided
      triggerType // Apply trigger type
    };

    console.log('Placing order: ', order);
    const result = await futuresClient.submitOrder(order);
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
    // Add event listeners to log websocket events
    wsClient.on('update', (data) => handleWsUpdate(data));
    wsClient.on('open', (data) => logWSEvent('open', data));
    wsClient.on('response', (data) => logWSEvent('response', data));
    wsClient.on('reconnect', (data) => logWSEvent('reconnect', data));
    wsClient.on('reconnected', (data) => logWSEvent('reconnected', data));
    wsClient.on('authenticated', (data) => logWSEvent('authenticated', data));
    wsClient.on('error', (data) => logWSEvent('error', data));

    // Connect to WebSocket
    wsClient.connect();

    // Start the server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (e) {
    console.error('Error starting WebSocket client or server:', e.message);
  }
})();
