const express = require('express');
const {
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

// Start the Express server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Log WebSocket events
function logWSEvent(type, data) {
  console.log(new Date(), `WS ${type} event:`, data);
}

//////////// - Indicators - ///////////////////////
  
// Fetch candle data for multiple timeframes
async function fetchCandleData(symbol, granularity) {
    try {
        console.log(`Fetching ${granularity} historical candle data for ${symbol}`);
        const candleData = await restClientV2.getFuturesHistoricCandles({
            granularity,
            limit: 100,
            productType: 'SUSDT-FUTURES',
            symbol: symbol,
        });

        console.log(`Fetched ${candleData.data.length} candle entries for ${symbol} on ${granularity} timeframe.`);
        return candleData.data.map(candle => [
            candle[0], // timestamp
            parseFloat(candle[1]), // open
            parseFloat(candle[2]), // high
            parseFloat(candle[3]), // low
            parseFloat(candle[4]), // close
            parseFloat(candle[5]), // volume
        ]);
    } catch (error) {
        console.error(`Error fetching ${granularity} candle data:`, error.message);
        return null;
    }
}

// Calculate Market Cipher signals with additional indicators
function calculateMarketCipherSignals(candles) {
    const hlc3 = candles.map(candle => (candle[1] + candle[2] + candle[3]) / 3); // HLC3 calculation
    
    const moneyFlow = calculateMoneyFlow(hlc3);
    const stochasticRSI = calculateStochasticRSI(candles);
    const ema = calculateEMA(candles, 9); // Example EMA indicator

    const buySignal = moneyFlow[moneyFlow.length - 1] > 0 && stochasticRSI[stochasticRSI.length - 1] < 0.2 && candles[candles.length - 1][4] > ema[ema.length - 1];
    const sellSignal = moneyFlow[moneyFlow.length - 1] < 0 && stochasticRSI[stochasticRSI.length - 1] > 0.8 && candles[candles.length - 1][4] < ema[ema.length - 1];

    console.log('Indicator Values - Money Flow:', moneyFlow[moneyFlow.length - 1], 'Stochastic RSI:', stochasticRSI[stochasticRSI.length - 1], 'EMA:', ema[ema.length - 1]);
    console.log('Signal calculation complete. Buy signal:', buySignal, 'Sell signal:', sellSignal);
    
    return { buySignal, sellSignal, latestPrice: candles[candles.length - 1][4] };
}

// Example function to calculate Money Flow
function calculateMoneyFlow(hlc3) {
    return hlc3.map((value, index) => {
        return index === 0 ? 0 : (value > hlc3[index - 1] ? 1 : -1); // Placeholder logic
    });
}

// Simplified Stochastic RSI calculation
function calculateStochasticRSI(candles) {
    return candles.map(candle => (candle[4] - candle[1]) / (candle[2] - candle[1])); // Placeholder logic
}

// Example EMA calculation
function calculateEMA(candles, period) {
    let ema = [];
    let multiplier = 2 / (period + 1);
    let sma = candles.slice(0, period).reduce((sum, candle) => sum + candle[4], 0) / period;

    ema.push(sma); // Start EMA with SMA value
    for (let i = period; i < candles.length; i++) {
        let close = candles[i][4];
        ema.push((close - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    return ema;
}

// Periodically fetch candle data across multiple timeframes and check signals
const ticker = 'SBTCSUSDT'; // Adjust the ticker as necessary
const timeframes = ['1m', '5m', '15m', '30m']; // Array of timeframes to fetch

setInterval(async () => {
    try {
        console.log("Starting trading loop");
        let candlesByTimeframe = {};

        for (const timeframe of timeframes) {
            candlesByTimeframe[timeframe] = await fetchCandleData(ticker, timeframe);
            if (!candlesByTimeframe[timeframe]) {
                console.error(`No candles returned for ${timeframe}. Skipping this timeframe.`);
                return;
            }
        }

        const signals = calculateMarketCipherSignals(candlesByTimeframe['15m']); // Use 15m candles for Market Cipher

        if (signals.buySignal || signals.sellSignal) {
            console.log("Signal detected, attempting to place trade");
            await placeTrade({
                symbol: ticker,
                price: signals.latestPrice,
                size: 0.001, // Replace with actual size logic
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


//////////// - Positions & Orders - ///////////////////////

// Fetch open positions and pending orders
const fetchOpenPositionsAndOrders = async () => {
    try {
        console.log("Fetching open positions and pending orders...");
        // Fetch open positions
        const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
        const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES' });

        const positions = positionsResponse.data || [];
        const pendingOrders = pendingOrdersResponse.data || [];

        if (positions.length === 0) {
            console.log("No open positions.");
        } else {
            console.log(`Open positions found: ${positions.length}`, positions);
        }

        if (pendingOrders.length === 0) {
            console.log("No pending orders.");
        } else {
            console.log(`Pending orders found: ${pendingOrders.length}`, pendingOrders);
        }
    } catch (error) {
        console.error("Error fetching open positions or pending orders:", error.message);
    }
};

// Function to cancel all open orders
const cancelAllOrders = async (symbol) => {
    try {
        console.log(`Cancelling all orders for symbol: ${symbol}`);
        const response = await restClientV2.futuresCancelAllOrders({ symbol, productType: 'SUSDT-FUTURES' });
        console.log(`Cancelled all orders for symbol: ${symbol}`, response);
    } catch (error) {
        console.error("Error cancelling all orders:", error.message);
    }
};

// Function to close open positions
const closeOpenPositions = async (symbol, holdSide) => {
    try {
        console.log(`Closing ${holdSide} position for ${symbol}`);
        const response = await restClientV2.futuresFlashClosePositions({
            symbol,
            holdSide,
            productType: 'SUSDT-FUTURES'
        });
        console.log(`Closed ${holdSide} position for ${symbol}`, response);
    } catch (error) {
        console.error(`Error closing ${holdSide} position for ${symbol}:`, error.message);
    }
};

// Function to close opposing positions or cancel orders
const closeOpposingPositions = async (signal) => {
    const { symbol, side } = signal;
    const opposingSide = side === 'buy' ? 'short' : 'long';

    try {
        console.log(`Checking for opposing positions or orders before placing ${side} order...`);

        // Fetch open positions
        const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
        const positions = positionsResponse.data || [];

        for (const position of positions) {
            if (position.holdSide === opposingSide && position.symbol === symbol) {
                console.log(`Opposing ${opposingSide} position detected. Attempting to close it...`);
                await closeOpenPositions(symbol, opposingSide);
                console.log(`Successfully closed ${opposingSide} position for ${symbol}.`);
            }
        }

        // Fetch open orders and cancel opposing orders
        const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol, productType: 'SUSDT-FUTURES' });
        const pendingOrders = pendingOrdersResponse.data?.entrustedList || [];

        for (const order of pendingOrders) {
            if (order.side !== side && order.symbol === symbol) {
                console.log(`Opposing ${order.side} order detected. Cancelling it...`);
                await cancelAllOrders(symbol);
                console.log(`Successfully cancelled opposing ${order.side} orders for ${symbol}.`);
            }
        }
    } catch (error) {
        console.error("Error while closing opposing positions or cancelling orders:", error.message);
    }
};

// Function to place a trade
async function placeTrade(signal) {
    const { symbol, price, side } = signal;

    // Close opposing positions or cancel orders before placing a new trade
    await closeOpposingPositions(signal);

    // Fetch current positions and pending orders
    const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
    const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol, productType: 'SUSDT-FUTURES' });

    const positions = positionsResponse.data || [];
    const pendingOrders = pendingOrdersResponse.data?.entrustedList || [];

    // Check if there is already a matching position
    const existingPosition = positions.find(pos => pos.holdSide === (side === 'buy' ? 'long' : 'short') && pos.symbol === symbol);
    if (existingPosition) {
        console.log(`A matching ${side} position already exists. No action taken.`);
        return;
    }

    // Check if there is already a matching pending order
    const existingOrder = pendingOrders.find(order => order.side === side && order.symbol === symbol);
    if (existingOrder) {
        console.log(`A matching ${side} limit order already exists. No action taken.`);
        return;
    }

    // No matching position/order, proceed with placing the trade
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

// Fetch positions and orders on startup
(async () => {
    await fetchOpenPositionsAndOrders();
})();

// Mock function to get conversion rate from SUSDT to USD or GBP
const getConversionRate = async (currency) => {
    // Replace with actual API call to fetch the conversion rate
    if (currency === 'USD') return 1.0; // Assuming 1 SUSDT = 1 USD as a stablecoin
    if (currency === 'GBP') return 0.75; // For example, 1 SUSDT = 0.75 GBP
};

// Function to fetch open positions and calculate PnL in selected currency
const fetchPnLEveryIntervalWithCurrency = (intervalMinutes = 1, currency = 'USD') => {
    console.log(`Setting up PnL fetch every ${intervalMinutes} minutes in ${currency}...`);

    // Set interval to fetch PnL at specified intervals
    setInterval(async () => {
        try {
            console.log("Fetching open positions...");

            // Fetch open positions
            const positionsResponse = await restClientV2.getFuturesPositions({ productType: 'SUSDT-FUTURES' });
            const positions = positionsResponse.data || [];

            // Get conversion rate for the selected currency
            const conversionRate = await getConversionRate(currency);

            if (positions.length === 0) {
                console.log("No open positions.");
            } else {
                console.log("Open positions PnL in " + currency + ":");
                positions.forEach((position) => {
                    const { symbol, holdSide, unrealizedPL } = position;
                    const pnlInCurrency = unrealizedPL * conversionRate;

                    console.log(`Symbol: ${symbol}, Side: ${holdSide}, PnL: ${pnlInCurrency.toFixed(2)} ${currency}`);
                });
            }
        } catch (error) {
            console.error("Error fetching PnL with currency conversion:", error.message);
        }
    }, intervalMinutes * 60 * 1000); // Convert minutes to milliseconds
};

// Call the function immediately to start the interval
fetchPnLEveryIntervalWithCurrency(5, 'USD');
