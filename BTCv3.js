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

const restClientV2 = new RestClientV2({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  apiPass: API_PASSPHRASE,
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

//////////// - Candle Data - ///////////////////////////

async function fetchCandleData(symbol = "SBTCSUSDT", granularity) {
    try {
        console.log(`Fetching ${granularity} candle data for ${symbol}`);
        
        // Fetch candle data from Bitget for given symbol and timeframe
        const candleData = await restClientV2.getFuturesCandles({
            symbol,
            granularity,
            limit: 100,
            productType: 'SUSDT-FUTURES',
        });

        // Verify and map the returned candle data
        if (!candleData.data) {
            console.error(`No data returned for ${granularity} candle data on ${symbol}`);
            return null;
        }
        
        console.log(`Fetched ${candleData.data.length} candle entries for ${symbol} on ${granularity} timeframe.`);
        
        // Format candle data for processing
        return candleData.data.map(candle => [
            candle[0], // timestamp
            parseFloat(candle[1]), // open
            parseFloat(candle[2]), // high
            parseFloat(candle[3]), // low
            parseFloat(candle[4]), // close
            parseFloat(candle[5]), // volume
        ]);
    } catch (error) {
        console.error(`Error fetching ${granularity} candle data for ${symbol}:`, error.response ? error.response.data : error.message);
        return null;
    }
}

//////////// - Indicator Calculations - ///////////////////////////

function calculateEMA(candles, period) {
    const multiplier = 2 / (period + 1);
    const ema = [];
    let sma = candles.slice(0, period).reduce((sum, candle) => sum + candle[4], 0) / period;
    ema.push(sma);

    for (let i = period; i < candles.length; i++) {
        const close = candles[i][4];
        ema.push((close - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }

    return ema;
}

function calculateVWAP(candles) {
    let cumulativeVolume = 0;
    let cumulativePriceVolume = 0;

    return candles.map(candle => {
        const typicalPrice = (candle[2] + candle[3] + candle[4]) / 3;
        cumulativeVolume += candle[5];
        cumulativePriceVolume += typicalPrice * candle[5];
        return cumulativePriceVolume / cumulativeVolume;
    });
}

function calculateATR(candles, period) {
    const trueRanges = candles.map((candle, index) => {
        if (index === 0) return candle[2] - candle[3];
        const prevClose = candles[index - 1][4];
        return Math.max(
            candle[2] - candle[3],
            Math.abs(candle[2] - prevClose),
            Math.abs(candle[3] - prevClose)
        );
    });

    return trueRanges.map((_, i) => {
        if (i < period - 1) return null;
        const rangeSlice = trueRanges.slice(i - period + 1, i + 1);
        return rangeSlice.reduce((sum, val) => sum + val, 0) / period;
    });
}

function calculateRSI(candles, period) {
    const gains = [];
    const losses = [];

    for (let i = 1; i < candles.length; i++) {
        const change = candles[i][4] - candles[i - 1][4];
        gains.push(Math.max(change, 0));
        losses.push(Math.abs(Math.min(change, 0)));
    }

    const avgGain = gains.slice(0, period).reduce((sum, gain) => sum + gain, 0) / period;
    const avgLoss = losses.slice(0, period).reduce((sum, loss) => sum + loss, 0) / period;

    return gains.map((_, i) => {
        if (i < period - 1) return null;
        const currentGain = avgGain + gains[i];
        const currentLoss = avgLoss + losses[i];
        const rs = currentGain / currentLoss;
        return 100 - 100 / (1 + rs);
    });
}

//////////// - Trading Logic - ///////////////////////////

function calculateTradingSignals(candles) {
    const ema9 = calculateEMA(candles, 9);
    const ema21 = calculateEMA(candles, 21);
    const vwap = calculateVWAP(candles);
    const atr = calculateATR(candles, 14);
    const rsi = calculateRSI(candles, 14);

    const latestPrice = candles[candles.length - 1][4];
    const latestATR = atr[atr.length - 1];
    const latestRSI = rsi[rsi.length - 1];
    const latestVWAP = vwap[vwap.length - 1];

    const buySignal =
        latestPrice > ema9[ema9.length - 1] &&
        ema9[ema9.length - 1] > ema21[ema21.length - 1] &&
        latestRSI < 70 &&
        latestPrice > latestVWAP;

    const sellSignal =
        latestPrice < ema9[ema9.length - 1] &&
        ema9[ema9.length - 1] < ema21[ema21.length - 1] &&
        latestRSI > 30 &&
        latestPrice < latestVWAP;

    const stopLoss = latestATR * 1.5;
    const takeProfit = stopLoss * 2;

    return {
        buySignal,
        sellSignal,
        stopLoss,
        takeProfit,
        latestPrice,
    };
}

//////////// - Main Trading Loop - ///////////////////////////

const ticker = 'SBTCSUSDT';
const timeframes = ['5m'];

setInterval(async () => {
    try {
        console.log("Starting trading loop");
        const candles = await fetchCandleData(ticker, timeframes[0]);
        if (!candles) {
            console.error("Failed to fetch candles. Exiting trading loop.");
            return;
        }

        const signals = calculateTradingSignals(candles);

        if (signals.buySignal || signals.sellSignal) {
            console.log("Signal detected, attempting to place trade");
            await placeTrade({
                symbol: ticker,
                price: signals.latestPrice,
                size: 0.001,
                side: signals.buySignal ? 'buy' : 'sell',
                leverage: 10,
            });
        } else {
            console.log("No actionable signals at this time");
        }
    } catch (error) {
        console.error("Error in trading loop:", error.message);
    }
}, 60 * 1000);

//////////// - Place Trade - Check Positions & Orders - ///////////////////////

// Fetch open positions and pending orders
const fetchOpenPositionsAndOrders = async () => {
    try {
        console.log("Fetching open positions and pending orders");
        // Fetch open positions
        const positionsResponse = await restClientV2.getFuturesPosition({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' });
        const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES' });

        const positions = positionsResponse.data || [];
        const pendingOrders = pendingOrdersResponse.data || [];

        if (positions.length === 0) {
            console.log("No open positions!");
        } else {
            console.log(`Open positions found: ${positions.length}`, positions);
        }

        if (pendingOrders.length === 0) {
            console.log("No pending orders!");
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
        const response = await restClientV2.futuresCancelAllOrders({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' });
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
            symbol: 'SBTCSUSDT',
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
        console.log(`Checking for opposing positions or orders before placing ${side} order`);

        // Fetch open positions
        const positionsResponse = await restClientV2.getFuturesPosition({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' });
        const positions = positionsResponse.data || [];

        for (const position of positions) {
            if (position.holdSide === opposingSide && position.symbol === symbol) {
                console.log(`Opposing ${opposingSide} position detected, Attempting to close it!`);
                await closeOpenPositions(symbol, opposingSide);
                console.log(`Successfully closed ${opposingSide} position for ${symbol}`);
            }
        }

        // Fetch open orders and cancel opposing orders
        const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES' });
        const pendingOrders = pendingOrdersResponse.data?.entrustedList || [];

        for (const order of pendingOrders) {
            if (order.side !== side && order.symbol === symbol) {
                console.log(`Opposing ${order.side} order detected, Cancelling it!`);
                await cancelAllOrders(symbol);
                console.log(`Successfully cancelled opposing ${order.side} orders for ${symbol}`);
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
    const positionsResponse = await restClientV2.getFuturesPosition({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' });
    const pendingOrdersResponse = await restClientV2.getFuturesOpenOrders({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES' });

    const positions = positionsResponse.data || [];
    const pendingOrders = pendingOrdersResponse.data?.entrustedList || [];

    // Check if there is already a matching position
    const existingPosition = positions.find(pos => pos.holdSide === (side === 'buy' ? 'long' : 'short') && pos.symbol === symbol);
    if (existingPosition) {
        console.log(`A matching ${side} position already exists, No action taken!`);
        return;
    }

    // Check if there is already a matching pending order
    const existingOrder = pendingOrders.find(order => order.side === side && order.symbol === symbol);
    if (existingOrder) {
        console.log(`A matching ${side} limit order already exists, No action taken!`);
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

    // Calculate take profit and stop loss
    const stopLossPercentage = 0.01; // 1% stop loss
    const takeProfitPercentage = 0.05; // 5% take profit

   /**
   * Calculate take profit and stop loss prices dynamically.
   * @param {number} entryPrice - The entry price of the trade.
   * @param {string} tradeSide - 'buy' or 'sell'.
   * @returns {{ takeProfitPrice: number, stopLossPrice: number }}
   */
  function calculateRiskLevels(entryPrice, tradeSide) {
      let takeProfitPrice, stopLossPrice;

      if (tradeSide === 'buy') {
          takeProfitPrice = Math.round(entryPrice * (1 + takeProfitPercentage));
          stopLossPrice = Math.round(entryPrice * (1 - stopLossPercentage));
      } else if (tradeSide === 'sell') {
          takeProfitPrice = Math.round(entryPrice * (1 - takeProfitPercentage));
          stopLossPrice = Math.round(entryPrice * (1 + stopLossPercentage));
      } else {
          throw new Error("Invalid trade side, Must be 'buy' or 'sell'.");
      }

      console.log(`Calculated Risk Levels for ${tradeSide.toUpperCase()} order:`);
      console.log(`  Entry Price: ${entryPrice}`);
      console.log(`  Take Profit Price: ${takeProfitPrice}`);
      console.log(`  Stop Loss Price: ${stopLossPrice}`);

      return { takeProfitPrice, stopLossPrice };
  }

  // Calculate dynamic risk levels
  const { takeProfitPrice, stopLossPrice } = calculateRiskLevels(price, side);

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
      presetTakeProfitPrice: takeProfitPrice,
      presetStopLossPrice: stopLossPrice
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
    console.log(`Setting PnL in ${currency}`);

    // Set interval to fetch PnL at specified intervals
    setInterval(async () => {
        try {
            console.log("Fetching open position");

            // Fetch open positions
            const positionsResponse = await restClientV2.getFuturesPosition({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' });
            const positions = positionsResponse.data || [];

            // Get conversion rate for the selected currency
            const conversionRate = await getConversionRate(currency);

            if (positions.length === 0) {
                console.log("No open position!");
            } else {
                console.log("Open position PnL in " + currency + ":");
                positions.forEach((position) => {
                    const { symbol = 'SBTCSUSDT', holdSide, unrealizedPL } = position;
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
fetchPnLEveryIntervalWithCurrency(1, 'GBP');

///////////////////// TESTING ////////////////////////////////////////////

const adjustStopLossToBreakEven = (intervalMinutes = 2, profitWaitMinutes = 5) => {
    console.log(`Setting Stop Loss adjustment to run every ${intervalMinutes} minutes`);

    // Store adjusted positions to ensure SL is set only once
    const adjustedPositions = new Set();

    setInterval(async () => {
        console.log("Checking open positions for stop loss adjustment...");
        try {
            const positionsResponse = await restClientV2.getFuturesPosition({
                symbol: 'SBTCSUSDT', // Adjust symbol as necessary
                productType: 'SUSDT-FUTURES', // Ensure correct product type
                marginCoin: 'SUSDT' // Ensure correct margin coin
            });

            if (!positionsResponse || positionsResponse.code !== '00000') {
                console.error(`Failed to fetch positions: ${positionsResponse?.msg || "Unknown error"}`);
                console.log("Full response:", JSON.stringify(positionsResponse, null, 2));
                return;
            }

            const positions = positionsResponse?.data || [];
            if (positions.length === 0) {
                console.log("No open positions found. Skipping stop loss adjustment.");
                adjustedPositions.clear(); // Clear if no positions are open
                return;
            }

            for (const position of positions) {
                const { symbol, holdSide, unrealizedPL, available, breakEvenPrice } = position;

                console.log(`Position Details - Symbol: ${symbol}, Side: ${holdSide}, PnL: ${unrealizedPL}`);
                console.log(`Break-Even Price: ${breakEvenPrice}`);

                // Check if stop loss already set
                if (adjustedPositions.has(symbol)) {
                    console.log(`Stop loss for ${symbol} already adjusted. Skipping.`);
                    continue;
                }

                if (unrealizedPL > 0) {
                    console.log(`Position is in profit. Monitoring for stop loss adjustment for ${symbol}.`);

                    // Delay setting stop loss to breakeven
                    setTimeout(async () => {
                        if (adjustedPositions.has(symbol)) return; // Stop if already set

                        console.log(`Setting stop loss for ${symbol} after ${profitWaitMinutes} minutes.`);
                        const stopLossPrice = parseFloat(breakEvenPrice).toFixed(1); // Format to 1 decimal place
                        if (isNaN(stopLossPrice) || stopLossPrice <= 0) {
                            console.error(`Invalid break-even price for ${symbol}: ${breakEvenPrice}`);
                            return;
                        }

                        const payload = {
                            marginCoin: 'SUSDT',
                            productType: 'SUSDT-FUTURES',
                            symbol: symbol,
                            planType: 'pos_loss',
                            triggerPrice: stopLossPrice, // Trigger price at break-even
                            triggerType: 'fill_price',
                            executePrice: '0', // Market execution
                            holdSide: holdSide, // Use 'long' or 'short' based on the position
                            size: available, // Quantity from the position
                            clientOid: `${Date.now()}` // Unique identifier
                        };

                        console.log("Stop Loss Adjustment Payload:", JSON.stringify(payload, null, 2));

                        try {
                            const modifyResponse = await restClientV2.futuresSubmitTPSLOrder(payload);

                            if (modifyResponse?.code === '00000') {
                                console.log(`Stop loss for ${symbol} successfully adjusted to break-even:`, JSON.stringify(modifyResponse.data, null, 2));
                                adjustedPositions.add(symbol); // Mark as adjusted
                            } else {
                                console.error(`Failed to adjust stop loss for ${symbol}: ${modifyResponse?.msg}`);
                                console.log("Full response:", JSON.stringify(modifyResponse, null, 2));
                            }
                        } catch (error) {
                            console.error(`Error while modifying stop loss for ${symbol}:`, error.response?.data || error.message);
                            console.log("Error details:", error);
                        }
                    }, profitWaitMinutes * 60 * 1000); // Wait before setting SL
                } else {
                    console.log(`Position for ${symbol} is not in profit. No stop loss adjustment needed.`);
                }
            }
        } catch (error) {
            console.error("Error during stop loss adjustment process:", error.response?.data || error.message);
            console.log("Error details:", error);
        }
    }, intervalMinutes * 60 * 1000);
};

// Start the function immediately with a 2-minute interval and 5-minute profit wait
adjustStopLossToBreakEven(2, 5);
