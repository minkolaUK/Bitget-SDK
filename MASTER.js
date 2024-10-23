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

// INDICATORS ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Fetch candle data
async function fetchCandleData(symbol) {
  try {
    console.log(`Fetching historical candle data for ${symbol}...`);
    const candleData = await restClientV2.getFuturesHistoricCandles({
      granularity: '5m',
      limit: 100,
      productType: 'SUSDT-FUTURES',
      symbol: symbol,
    });

    console.log(`Fetched ${candleData.data.length} candle entries for ${symbol}.`);  // Log only the count of candles, not the data itself
    return candleData.data.map(candle => [
      candle[0], // timestamp
      parseFloat(candle[1]), // open
      parseFloat(candle[2]), // high
      parseFloat(candle[3]), // low
      parseFloat(candle[4]), // close
      parseFloat(candle[5]), // volume
    ]);
  } catch (error) {
    console.error('Error fetching candle data:', error.message);
    return null;
  }
}

// Calculate Market Cipher signals
function calculateMarketCipherSignals(candles) {
  const hlc3 = candles.map(candle => (candle[1] + candle[2] + candle[3]) / 3); // HLC3 calculation

  const moneyFlow = calculateMoneyFlow(hlc3);
  const stochasticRSI = calculateStochasticRSI(candles);

  const buySignal = moneyFlow[moneyFlow.length - 1] > 0 && stochasticRSI[stochasticRSI.length - 1] < 0.2;
  const sellSignal = moneyFlow[moneyFlow.length - 1] < 0 && stochasticRSI[stochasticRSI.length - 1] > 0.8;

  console.log('Signal calculation complete. Buy signal:', buySignal, 'Sell signal:', sellSignal);
  return { buySignal, sellSignal, latestPrice: candles[candles.length - 1][4] };
}

// Simplified example function to calculate Money Flow
function calculateMoneyFlow(hlc3) {
  return hlc3.map((value, index) => {
    return index === 0 ? 0 : (value > hlc3[index - 1] ? 1 : -1); // Placeholder logic
  });
}

// Simplified Stochastic RSI calculation
function calculateStochasticRSI(candles) {
  return candles.map(candle => (candle[4] - candle[1]) / (candle[2] - candle[1])); // Placeholder logic
}

// Periodically fetch candle data and check signals every minute
const ticker = 'SBTCSUSDT'; // Adjust the ticker as necessary
setInterval(async () => {
  try {
    console.log("Starting trading loop...");
    const candles = await fetchCandleData(ticker);
    
    if (!candles) {
      console.error("No candles returned. Skipping signal calculation.");
      return;
    }

    const signals = calculateMarketCipherSignals(candles);
    
    if (signals.buySignal || signals.sellSignal) {
      console.log("Signal detected, attempting to place trade...");
      await placeTrade({
        symbol: ticker,
        price: signals.latestPrice,
        side: signals.buySignal ? 'buy' : 'sell',
        leverage: 10, // Replace with actual leverage logic
      });
    } else {
      console.log("No actionable signals at this time.");
    }
  } catch (error) {
    console.error('Error in trading loop:', error.message);
  }
}, 60 * 1000); // Run every minute

// POSITIONS ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Fetch open positions and pending orders
const fetchOpenPositionsAndOrders = async () => {
  try {
    console.log("Fetching open positions and pending orders...");
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
  await fetchOpenPositionsAndOrders();
})();

// Close all open positions
const closeOpenPositions = async () => {
  try {
    console.log("Closing all open positions...");
    const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
    const positions = positionsResponse.data || [];

    if (positions.length === 0) {
      console.log("No positions to close.");
      return;
    }

    for (const position of positions) {
      console.log(`Attempting to close position: ${position.symbol}`);
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

// Function to place a trade
async function placeTrade(signal) {
  const { symbol, price, side } = signal;

  // Close opposing positions or cancel orders before placing a new trade
  await closeOpposingPositions(signal);

  const productType = 'UMCBL'; 
  const marginMode = 'isolated';
  const tradeSide = 'open';
  const force = 'gtc';
  const marginCoin = 'SUSDT';
  const orderType = 'limit';
  const size = '0.001'; // Can be made dynamic
  const leverage = '10'; // Can be made dynamic as well

  // Calculate take profit and stop loss prices based on the side
  const presetTakeProfitPrice = side === 'buy' ? Math.floor(price * 1.05) : Math.floor(price * 0.95);
  const presetStopLossPrice = side === 'buy' ? Math.floor(price * 0.95) : Math.floor(price * 1.05);
  
  try {
    // Set the leverage for the trade
    const holdSide = side === 'buy' ? 'long' : 'short';
    await restClientV2.setFuturesLeverage({
      symbol,
      productType,
      marginCoin,
      leverage,
      holdSide
    });

    // Create the order object
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

// Function to close opposing positions or cancel orders
const closeOpposingPositions = async (signal) => {
  const { symbol, side } = signal;
  const opposingSide = side === 'buy' ? 'short' : 'long'; // Opposing position logic

  try {
    console.log(`Checking for opposing positions or orders before placing ${side} order...`);

    // Fetch open positions
    const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
    const positions = positionsResponse.data || [];

    // Close opposing position if it exists
    for (const position of positions) {
      if (position.holdSide === opposingSide && position.symbol === symbol) {
        console.log(`Opposing ${opposingSide} position detected. Attempting to close it...`);
        await closeOpenPositions(); // Close the position
        console.log(`Successfully closed ${opposingSide} position for ${symbol}.`);
      }
    }

    // Fetch open orders and cancel opposing orders
    const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol, productType: 'SUSDT-FUTURES' });
    const pendingOrders = pendingOrdersResponse.data?.entrustedList || [];

    for (const order of pendingOrders) {
      if (order.side !== side && order.symbol === symbol) {
        console.log(`Opposing ${order.side} order detected. Cancelling it...`);
        await cancelAllOrders(symbol); // Cancel the opposing order
        console.log(`Successfully cancelled opposing ${order.side} orders for ${symbol}.`);
      }
    }

  } catch (error) {
    console.error('Error while closing opposing positions or cancelling orders:', error.message);
  }
};

// WEBSOCKET ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// WebSocket event handling
async function handleWsUpdate(event) {
  if (isWsFuturesAccountSnapshotEvent(event)) {
    logWSEvent('account balance', event);
  } else if (isWsFuturesPositionsSnapshotEvent(event)) {
    logWSEvent('positions', event);
  } else if (event.arg.instType === 'candle1m') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle5m') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle15m') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle30m') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle1H') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle4H') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle12H') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle1D') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle1W') {
    logWSEvent('candle update', event);
  } else if (event.arg.instType === 'candle1M') {
    logWSEvent('candle update', event);
  } else {
    logWSEvent('unhandled', event);
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
    const topics = ['account', 'positions', 'trade', 'ticker', 'fill', 'orders-algo'];
    topics.forEach(topic => {
      wsClient.subscribeTopic('SUSDT-FUTURES', topic);
      logWSEvent('subscribed', { topic });
    });
  } catch (error) {
    console.error('Error setting up WebSocket client:', error.message);
  }
})();

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
