const express = require('express');
const {
  isWsFuturesAccountSnapshotEvent,
  isWsFuturesPositionsSnapshotEvent,
  WebsocketClientV2,
  RestClientV2,
} = require('bitget-api');
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

// Log WebSocket events
function logWSEvent(type, data) {
  console.log(new Date(), `WS ${type} event:`, data);
}

// Function to fetch historical candle data
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

// Simplified example function to calculate Stochastic RSI
function calculateStochasticRSI(candles) {
  return candles.map(candle => (candle[4] - candle[1]) / (candle[2] - candle[1])); // Placeholder logic
}

// Function to send webhook notifications
async function sendWebhook(signal) {
  const webhookUrl = 'http://localhost:3000/webhook'; // Your actual webhook endpoint
  try {
    const { symbol, price, side } = signal;
    const size = '0.001'; // Size for the order, can be made dynamic if needed
    const leverage = '10';

    // Calculate take profit and stop loss
    const presetTakeProfitPrice = side === 'buy' ? (price * 1.05).toFixed(2) : (price * 0.95).toFixed(2);
    const presetStopLossPrice = side === 'buy' ? (price * 0.95).toFixed(2) : (price * 1.05).toFixed(2);

    console.log(`Preparing to send ${side} webhook...`);
    console.log(`Details: Symbol: ${symbol}, Price: ${price}, Size: ${size}, Order Type: limit, Margin Coin: SUSDT, Leverage: ${leverage}, TP: ${presetTakeProfitPrice}, SL: ${presetStopLossPrice}`);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        symbol,
        price,
        size,
        orderType: 'limit',
        marginCoin: 'SUSDT',
        side,
        leverage,
        presetTakeProfitPrice,
        presetStopLossPrice,
      }),
    });

    if (response.ok) {
      console.log(`Webhook sent successfully for ${side} at price ${price}.`);
    } else {
      console.error(`Failed to send webhook: ${response.statusText}. Response: ${await response.text()}`);
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
      candle[0], // timestamp
      parseFloat(candle[1]), // open
      parseFloat(candle[2]), // high
      parseFloat(candle[3]), // low
      parseFloat(candle[4]), // close
      parseFloat(candle[5])  // volume
    ]);

    const marketData = {
      price: candles[candles.length - 1][4], // Close price of the latest candle
      candles: candles,
    };

    const { buySignal, sellSignal } = calculateMarketCipherSignals(marketData.candles);

    // Trigger webhook based on buy/sell signal
    if (buySignal) {
      console.log(`Buy signal detected at price: ${marketData.price}`);
      await sendWebhook({
        symbol: 'SBTCSUSDT', // Ensure the correct symbol is used here
        price: marketData.price,
        side: 'buy',
      });
    } else if (sellSignal) {
      console.log(`Sell signal detected at price: ${marketData.price}`);
      await sendWebhook({
        symbol: 'SBTCSUSDT', // Ensure the correct symbol is used here
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

// Start a periodic candle data fetch every minute for logging and signal checking
setInterval(async () => {
  const symbol = 'SBTCSUSDT'; // Adjust symbol as needed
  console.log(`Fetching current candle data for ${symbol}...`);
  
  const candles = await fetchCandleData(symbol);
  
  if (candles) {
    const { buySignal, sellSignal } = calculateMarketCipherSignals(candles);
    console.log(`Current market data processed. Buy signal: ${buySignal}, Sell signal: ${sellSignal}`);
  }
}, 60000); // 60,000 ms = 1 minute
