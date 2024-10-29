const express = require('express');
const { WebsocketClientV2, RestClientV2 } = require('bitget-api');
require('dotenv').config();
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Load environment variables
const { API_KEY, API_SECRET, API_PASSPHRASE, PORT = 3001 } = process.env;

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

// Ticker and books definition
const ticker = 'SBTCSUSDT'; // Adjust symbol as needed
const books = {
  symbol: ticker,
  price: null,
  candles: [],
};

// Log WebSocket events
function logWSEvent(type, data) {
  console.log(new Date(), `WS ${type} event:`, data);
}

// Fetch candle data
async function fetchCandleData(symbol) {
  try {
    console.log(`Fetching historical candle data for ${symbol}...`);
    const candleData = await restClientV2.getFuturesHistoricCandles({
      granularity: '1m',
      limit: 200,
      productType: 'SUSDT-FUTURES',
      symbol: symbol,
    });

    console.log('Fetched candle data successfully.');
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

// Function to calculate Market Cipher signals based on the fetched data
function calculateMarketCipherSignals(candles) {
  console.log('Calculating Market Cipher signals...');
  
  const hlc3 = candles.map(candle => (candle[1] + candle[2] + candle[3]) / 3); // HLC3 calculation
  
  // Example simplified logic for Money Flow and Stochastic RSI
  const moneyFlow = calculateMoneyFlow(hlc3);
  const stochasticRSI = calculateStochasticRSI(candles);

  // Combine your logic to generate buy/sell signals
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

// Send webhook notifications
async function sendWebhook(signal) {
    const webhookUrl = 'http://localhost:3000/webhook'; // Replace with your actual webhook endpoint
    try {
      const { symbol, price, side } = signal;
      const size = '0.001'; // Can be made dynamic
      const leverage = '10';
  
      const presetTakeProfitPrice = side === 'buy' ? (price * 1.05).toFixed(2) : (price * 0.95).toFixed(2);
      const presetStopLossPrice = side === 'buy' ? (price * 0.95).toFixed(2) : (price * 1.05).toFixed(2);
  
      const payload = {
        symbol,
        price,
        size,
        orderType: 'limit',
        marginCoin: 'USDT',
        side,
        leverage,
        presetTakeProfitPrice,
        presetStopLossPrice,
      };
  
      console.log(`Preparing to send ${side} webhook...`);
      console.log('Webhook Payload:', JSON.stringify(payload, null, 2));
  
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
  
      // Check response status
      if (!response.ok) {
        console.error(`Failed to send webhook. Status: ${response.status}, Response: ${await response.text()}`);
      } else {
        console.log(`Webhook sent successfully: ${await response.text()}`);
      }
    } catch (error) {
      console.error('Error sending webhook:', error.message);
    }
}

// WebSocket event handling
async function handleWsUpdate(event) {
  if (event.arg.instType === 'candle1m') {
    logWSEvent('candle update', event);
    
    const candles = event.data.map(candle => [
      parseInt(candle[0]), // timestamp
      parseFloat(candle[1]), // open
      parseFloat(candle[2]), // high
      parseFloat(candle[3]), // low
      parseFloat(candle[4]), // close
      parseFloat(candle[5]), // volume
    ]);

    books.candles = candles; // Store candle data in books

    const marketData = {
      price: candles[candles.length - 1][4], // Close price of the latest candle
      candles,
    };

    const { buySignal, sellSignal } = calculateMarketCipherSignals(marketData.candles);

    // Trigger webhook based on buy/sell signal
    if (buySignal) {
      console.log(`Buy signal detected at price: ${marketData.price}`);
      await sendWebhook({
        symbol: ticker, // Ensure the correct symbol is used here
        price: marketData.price,
        side: 'buy',
      });
    } else if (sellSignal) {
      console.log(`Sell signal detected at price: ${marketData.price}`);
      await sendWebhook({
        symbol: ticker, // Ensure the correct symbol is used here
        price: marketData.price,
        side: 'sell',
      });
    }
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

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
      const topics = ['ticker', 'candle1m'];
      topics.forEach(topic => {
        wsClient.subscribeTopic('SUSDT-FUTURES', topic);
        logWSEvent('subscribed', { topic });
      });
    } catch (error) {
      console.error('Error setting up WebSocket client:', error.message);
    }
 });

// Start a periodic candle data fetch every minute for logging and signal checking
setInterval(async () => {
    console.log(`Fetching current candle data for ${ticker}...`);
  
    const candles = await fetchCandleData(ticker);
  
    if (candles) {
      books.candles = candles; // Store the latest candle data in books
      const { buySignal, sellSignal } = calculateMarketCipherSignals(candles);
      console.log(`Current market data processed. Buy signal: ${buySignal}, Sell signal: ${sellSignal}`);
    }
  }, 60000); // 60,000 ms = 1 minute
