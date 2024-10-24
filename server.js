const express = require('express');
const {
  isWsFuturesAccountSnapshotEvent,
  isWsFuturesPositionsSnapshotEvent,
  WebsocketClientV2,
  RestClientV2,
} = require('bitget-api');
require('dotenv').config();

const app = express();
app.use(express.json());

// Load environment variables
const { API_KEY, API_SECRET, API_PASSPHRASE, PORT = 3000 } = process.env;

// Check API credentials
if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
  console.error('Missing API credentials. Please check your environment variables.');
  process.exit(1);
}

// Initialize WebSocket and REST clients
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

// Log WebSocket events
function logWSEvent(type, data) {
  console.log(new Date(), `WS ${type} event:`, data);
}

// Fetch open positions and pending orders
const fetchOpenPositionsAndOrders = async () => {
  try {
    // Fetch open positions
    const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
    const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES' });

    const positions = positionsResponse.data || [];
    const pendingOrders = pendingOrdersResponse.data || [];

    // Log the number of open positions
    if (positions.length === 0) {
      console.log("No open positions.");
    } else {
      console.log(`Open positions found: ${positions.length}`);
      console.log("Open positions details:", positions);
    }

    // Log the number of pending orders
    if (pendingOrders.length === 0) {
      console.log("No pending orders.");
    } else {
      console.log(`Pending orders found: ${pendingOrders.length}`);
      console.log("Pending orders details:", pendingOrders);
    }
  } catch (error) {
    console.error("Error fetching open positions or pending orders:", error.message);
  }
};

// Fetch positions and orders on startup
(async () => {
  try {
    await fetchOpenPositionsAndOrders();
  } catch (error) {
    console.error('Error during startup:', error.message);
  }
})();

// Close all open positions
const closeOpenPositions = async () => {
  try {
    const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
    const positions = positionsResponse.data || [];

    if (positions.length === 0) {
      console.log("No positions to close.");
      return;
    }

    for (const position of positions) {
      const holdSide = position.holdSide === 'long' ? 'long' : 'short'; // Complies with API spec
      const params = {
        symbol: position.symbol,
        holdSide, // Specify direction unless in one-way mode
        productType: 'SUSDT-FUTURES',
      };
      
      await restClientV2.futuresFlashClosePositions(params)
        .then((response) => {
          const { successList, failureList } = response.data;
          if (successList.length > 0) {
            console.log(`Successfully closed position(s):`, successList);
          }
          if (failureList.length > 0) {
            console.error(`Failed to close position(s):`, failureList);
          }
        })
        .catch((error) => {
          console.error(`Error closing position ${position.symbol}:`, error.message);
        });
    }
  } catch (error) {
    console.error("Error fetching positions:", error.message);
  }
};

// Function to cancel all open orders
const cancelAllOrders = async (symbol) => {
  try {
    console.log(`Cancelling all orders for symbol: ${symbol}`);
    
    await restClientV2.futuresCancelAllOrders({ symbol, productType: 'SUSDT-FUTURES' })
      .then((response) => {
        console.log(`Cancelled all orders for symbol: ${symbol}`, response);
      })
      .catch((error) => {
        console.error(`Error cancelling orders for symbol: ${symbol}`, error.message);
      });
  } catch (error) {
    console.error("Error cancelling all orders:", error.message);
  }
};

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

// WebSocket event handling
async function handleWsUpdate(event) {
  if (isWsFuturesAccountSnapshotEvent(event)) {
    logWSEvent('account balance', event);
  } else if (isWsFuturesPositionsSnapshotEvent(event)) {
    logWSEvent('positions', event);
  } else {
    logWSEvent('unhandled', event); // Log unhandled events
  }
}

// WebSocket client setup
(async () => {
  try {
    // Log WebSocket events
    wsClient.on('update', handleWsUpdate);
    wsClient.on('open', data => logWSEvent('open', data));
    wsClient.on('response', data => logWSEvent('response', data));
    wsClient.on('reconnect', data => logWSEvent('reconnect', data));
    wsClient.on('authenticated', data => logWSEvent('authenticated', data));
    wsClient.on('error', data => logWSEvent('error', data));
    wsClient.on('disconnect', data => logWSEvent('disconnect', data));

    // Subscribe to WebSocket topics
    const topics = ['account', 'positions', 'orders', 'orders-algo'];
    topics.forEach(topic => {
      wsClient.subscribeTopic('SUSDT-FUTURES', topic);
      logWSEvent('subscribed', { topic });
    });
  } catch (error) {
    console.error('Error setting up WebSocket client:', error.message);
  }
})();

// Webhook endpoint to handle incoming trading signals
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
    // Close all open positions and cancel all orders before placing a new trade
    await closeOpenPositions();
    await cancelAllOrders(symbol);

    // Place the trade
    const result = await placeTrade(symbol, price, size, orderType, marginCoin, side, leverage, presetTakeProfitPrice, presetStopLossPrice);
    
    return res.status(200).json({ success: true, result });
  } catch (error) {
    console.error('Error processing webhook:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
