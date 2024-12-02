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
  console.error('Missing API credentials! Please check your environment variables!');
  process.exit(1);
}

const restClientV2 = new RestClientV2({
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  apiPass: API_PASSPHRASE,
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Setting Server to run on port ${PORT}`);
});

//////////// - Candle Data - ///////////////////////////

// Function to fetch candle data for a given symbol and timeframe
async function fetchCandleData(symbol = "SBTCSUSDT", granularity) {
    try {
        // Fetch candle data from Bitget for the given symbol and timeframe
        const candleData = await restClientV2.getFuturesCandles({
            symbol,
            granularity,
            limit: 100,
            productType: 'SUSDT-FUTURES',
        });

        // Verify and map the returned candle data
        if (!candleData.data) {
            console.error(`No data returned for ${granularity} candle data`);
            return null;
        }

        // Only log the number of entries fetched once after data is obtained
        // console.log(`Fetched ${candleData.data.length} candle entries for ${granularity} timeframe`);

        // Format candle data for processing
        return candleData.data.map(candle => [
            candle[0], // timestamp
            parseFloat(candle[1]),
            parseFloat(candle[2]),
            parseFloat(candle[3]),
            parseFloat(candle[4]),
            parseFloat(candle[5]),
        ]);
    } catch (error) {
        console.error(`Error fetching ${granularity} candle data:`, error.response ? error.response.data : error.message);
        return null;
    }
}

//////////// - Indicator Calculations - ///////////////////////////

// Calculate Exponential Moving Average (EMA)
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

// Calculate Volume-Weighted Average Price (VWAP)
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

// Calculate Average True Range (ATR)
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

// Calculate Relative Strength Index (RSI)
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

/////////////////////// - Trading Logic - /////////////////////////////

// Calculate trading signals (buy/sell) based on indicators
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

/////////////////////// - Main Trading Loop - /////////////////////////////

// Main Trading Loop
const ticker = 'SBTCSUSDT';
const timeframes = ['5m', '15m', '30m', '1H', '2H', '4H'];

setInterval(async () => {
    try {
        console.log("Starting trading loop");

        // Initialize signals for all timeframes
        let activeBuySignal = false;
        let activeSellSignal = false;
        let latestPrice = 0;  // Track latest price from the last processed timeframe

        // Start fetching all candle data once
        console.log("Fetching candle data");

        // Loop through each timeframe to evaluate signals
        for (const timeframe of timeframes) {
            const candles = await fetchCandleData(ticker, timeframe);
            if (!candles) {
                console.error(`Failed to fetch candles for ${timeframe}! Skipping`);
                continue;
            }

            const signals = calculateTradingSignals(candles);  // Define signals here

            // Track the latest buy/sell signal and price
            if (signals.buySignal) {
                console.log(`Buy signal detected on ${timeframe} timeframe`);
                activeBuySignal = true;
            }

            if (signals.sellSignal) {
                console.log(`Sell signal detected on ${timeframe} timeframe`);
                activeSellSignal = true;
            }

            latestPrice = signals.latestPrice;
        }

        // Check if there is an active buy or sell signal and place corresponding order
        if (activeBuySignal && !activeSellSignal) {
            console.log("Placing buy order");
            await placeTrade({
                symbol: ticker,
                price: latestPrice,
                size: 0.001,
                side: 'buy',
                leverage: 10,
            });
        } else if (activeSellSignal && !activeBuySignal) {
            console.log("Placing sell order");
            await placeTrade({
                symbol: ticker,
                price: latestPrice,
                size: 0.001,
                side: 'sell',
                leverage: 10,
            });
        } else {
            console.log("No actionable signals found. No trades placed.");
        }
    } catch (error) {
        console.error("Error in trading loop:", error.message);
    }
}, 60 * 1000);  // Repeat the loop every minute

/////////////////////////// - Place Trade - ///////////////////////////////////////////

// Fetch open positions and pending orders
const fetchOpenPositionsAndOrders = async () => {
    try {
        console.log("Setting System to fetch open position and orders");
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
        console.log(`Cancelling all orders!`);
        const response = await restClientV2.futuresCancelAllOrders({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' });
        console.log(`Cancelled all orders!`, response);
    } catch (error) {
        console.error("Error cancelling all orders:", error.message);
    }
};

// Function to close open positions
const closeOpenPositions = async (symbol, holdSide) => {
    try {
        console.log(`Closing ${holdSide} position`);
        const response = await restClientV2.futuresFlashClosePositions({
            symbol: 'SBTCSUSDT',
            holdSide,
            productType: 'SUSDT-FUTURES'
        });
        console.log(`Closed ${holdSide} position`, response);
    } catch (error) {
        console.error(`Error closing ${holdSide} position:`, error.message);
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
    const size = '0.001';
    const leverage = '10';

    // Calculate take profit and stop loss
    const stopLossPercentage = 0.01; // 1% stop loss
    const takeProfitPercentage = 1.05; // 100% take profit

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
          throw new Error("Invalid trade side, Must be 'buy' or 'sell'");
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
      //presetStopSurplusPrice: takeProfitPrice,
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

////////////////////////// - PnL - /////////////////////////////////////////

// Function to fetch open positions and calculate PnL in selected currency
const fetchPnLEveryIntervalWithCurrency = (intervalMinutes = 1, currency = 'USD') => {
    console.log(`Setting PnL in ${currency}`);

    // Set interval to fetch PnL at specified intervals
    setInterval(async () => {
        try {
            // Fetch open positions
            const positionsResponse = await restClientV2.getFuturesPosition({ symbol: 'SBTCSUSDT', productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' });
            const positions = positionsResponse.data || [];

            // Get conversion rate for the selected currency
            const conversionRate = await getConversionRate(currency);

            if (positions.length === 0) {
            
            } else {
                console.log("PnL Open position details:");
                positions.forEach((position) => {
                    const { symbol = 'SBTCSUSDT', holdSide, openPriceAvg, markPrice, breakEvenPrice, unrealizedPL } = position;
                    const pnlInCurrency = unrealizedPL * conversionRate;

                    console.log(`${symbol}: ${markPrice}, Entry Price: ${openPriceAvg}, Break Even: ${breakEvenPrice}`);
                    console.log(`PnL: ${pnlInCurrency.toFixed(2)} ${currency}, Side: ${holdSide}`);
                });
            }
        } catch (error) {
            console.error("Error fetching PnL with currency conversion:", error.message);
        }
    }, intervalMinutes * 60 * 1000);
};

// Call the function immediately to start the interval
fetchPnLEveryIntervalWithCurrency(1, 'GBP');

// Mock function to get conversion rate from SUSDT to USD or GBP
const getConversionRate = async (currency) => {
    // Replace with actual API call to fetch the conversion rate
    if (currency === 'USD') return 1.0; 
    if (currency === 'GBP') return 0.75;
};

////////////////////// - Manage Break Even & Stoploss - ///////////////////////////////////////

// Cancel existing stop loss orders
const cancelPreviousStopLoss = async (symbol, holdSide) => {
    try {
        const stopLossOrders = await hasExistingStopLoss(symbol, holdSide);

        if (stopLossOrders.length > 0) {
            console.log(`Cancelling ${stopLossOrders.length} Stop Loss orders`);
            for (const order of stopLossOrders) {
                const orderId = order.orderId;
                const cancelResponse = await restClientV2.futuresCancelPlanOrder({
                    symbol,
                    productType: 'SUSDT-FUTURES',
                    marginCoin: 'SUSDT',
                    orderId,
                    clientOid: `${Date.now()}`,
                });

                if (cancelResponse?.code === '00000') {
                    console.log(`Stop Loss order with ID ${orderId} cancelled successfully`);
                } else {
                    console.error(`Failed to cancel Stop Loss order with ID ${orderId}: ${cancelResponse?.msg}`);
                }
            }
        }
    } catch (error) {
        console.error("Error canceling Stop Loss orders:", error.message);
    }
};

// Check for existing stop loss orders
const hasExistingStopLoss = async (symbol) => {
    try {
        const params = {
            productType: "SUSDT-FUTURES",
            planType: "profit_loss", 
            symbol,
        };

        console.log(`Checking for stop loss orders`);
        const response = await restClientV2.getFuturesPlanOrders(params);

        if (!response || response?.code !== "00000") {
            console.error(
                `Failed to fetch stop loss orders: ${response?.msg || "Unknown error"}`
            );
            return [];
        }

        const orders = response?.data?.entrustedList || [];
        if (orders.length > 0) {
            console.log(`Found ${orders.length} stop loss orders`);
        } else {
            console.log(`No stop loss orders found`);
        }

        return orders;
    } catch (error) {
        console.error(`Error fetching stop loss orders:`, error.message);
        return [];
    }
};

// Adjust Stop Loss to Break Even Price
const adjustStopLossToBreakEven = (intervalMinutes = 5, profitWaitMinutes = 15) => {
    console.log(`Setting Stop Loss adjustment to run every ${intervalMinutes} minutes`);

    setInterval(async () => {
        try {
            // Fetch open positions
            const positionsResponse = await restClientV2.getFuturesPosition({
                symbol: 'SBTCSUSDT',
                productType: 'SUSDT-FUTURES',
                marginCoin: 'SUSDT',
            });

            if (!positionsResponse || positionsResponse.code !== '00000') {
                console.error(`Failed to fetch positions: ${positionsResponse?.msg || "Unknown error"}`);
                return;
            }

            const positions = positionsResponse.data || [];
            if (positions.length === 0) {
                console.log("No open positions found, Skipping");
                return;
            }

            for (const position of positions) {
                const { symbol, holdSide, unrealizedPL, available, breakEvenPrice } = position;

                if (!breakEvenPrice || unrealizedPL <= 0) {
                    console.log(`Position not in profit or break even price unavailable`);
                    continue;
                }

                // Check for existing stop loss orders
                const stopLossOrders = await hasExistingStopLoss(symbol, holdSide);
                const initialSLOrder = stopLossOrders.find(order => order.planType === 'loss_plan');

                if (!initialSLOrder) {
                    console.error(`Initial Stop Loss not found, Ensure an initial Stop Loss is set`);
                    continue;
                }

                console.log(`Initial SL found, Trigger Price: ${initialSLOrder.triggerPrice}`);

                const existingBreakEvenOrder = stopLossOrders.find(order => order.planType === 'pos_loss');
                const breakEvenPriceFloat = parseFloat(breakEvenPrice).toFixed(1);

                if (existingBreakEvenOrder) {
                    const currentSLPrice = parseFloat(existingBreakEvenOrder.triggerPrice).toFixed(1);

                    if (currentSLPrice === breakEvenPriceFloat) {
                        console.log(`Stop Loss already set to Break Even Price`);
                        continue;
                    } else {
                        console.log(`Stop Loss does not match Break Even Price (${currentSLPrice} !== ${breakEvenPriceFloat}). Cancelling existing SL`);
                        await cancelPreviousStopLoss(symbol, holdSide);
                    }
                }

                console.log(`Setting Stop Loss to Break Even Price (${breakEvenPriceFloat}) in ${profitWaitMinutes} minutes`);
                setTimeout(async () => {
                    const stopLossPrice = parseFloat(breakEvenPrice).toFixed(1);

                    if (isNaN(stopLossPrice) || stopLossPrice <= 0) {
                        console.error(`Invalid break even price: ${breakEvenPrice}`);
                        return;
                    }

                    const payload = {
                        marginCoin: 'SUSDT',
                        productType: 'SUSDT-FUTURES',
                        symbol,
                        planType: 'pos_loss',
                        triggerPrice: stopLossPrice,
                        triggerType: 'fill_price',
                        executePrice: '0',
                        holdSide,
                        size: available,
                        clientOid: `${Date.now()}`,
                    };

                    try {
                        const response = await restClientV2.futuresSubmitTPSLOrder(payload);

                        if (response?.code === '00000') {
                            console.log(`Stop Loss successfully set to Break Even Price`);
                            console.log(`Trigger Price: ${payload.triggerPrice}, Size: ${payload.size}`);
                        } else {
                            console.error(`Failed to set Stop Loss: ${response?.msg}`);
                        }
                    } catch (error) {
                        console.error(`Error setting Stop Loss:`, error.response?.data || error.message);
                    }
                }, profitWaitMinutes * 60 * 1000);
            }
        } catch (error) {
            console.error("Error during Stop Loss adjustment:", error.response?.data || error.message);
        }
    }, intervalMinutes * 60 * 1000);
};

// Start function with interval and profit wait time
adjustStopLossToBreakEven(5, 15);

// Calculate Take Profit Orders
const calculateTPOrders = async (symbol) => {
    try {
        const positionResponse = await restClientV2.getFuturesPosition({
            symbol,
            productType: 'SUSDT-FUTURES',
            marginCoin: 'SUSDT',
        });

        if (!positionResponse || positionResponse.code !== '00000') {
            console.error(`Failed to fetch position: ${positionResponse?.msg || "Unknown error"}`);
            return;
        }

        const position = positionResponse.data[0];
        if (!position || parseFloat(position.available) <= 0) {
            console.log(`No available amount! Available: ${position?.available}`);
            return;
        }

        const { available, openPriceAvg, holdSide, unrealizedPL, marginSize } = position;
        const tpAmount = parseFloat(available);
        const maxTPOrders = Math.min(3, Math.floor(tpAmount / 0.001));

        console.log(`Amount: ${tpAmount}`);

        // Ensure PnL meets the margin threshold before setting TP orders
        if (parseFloat(unrealizedPL) < parseFloat(marginSize) * 0.50) {
            console.log(`PnL: ${unrealizedPL} is below 50% of Available: ${marginSize} to set Take Profit`);
            return;
        }

        const tpPercentages = [];
        if (parseFloat(unrealizedPL) >= parseFloat(marginSize) * 0.50) {
            tpPercentages.push(1.05);
        }

        if (parseFloat(unrealizedPL) >= parseFloat(marginSize) * 1.5) {
            tpPercentages.push(1.10);
        }

        const tpOrdersToPlace = Math.min(maxTPOrders, tpPercentages.length);

        console.log(`Placing up to ${tpOrdersToPlace} TP orders`);

        for (let i = 0; i < tpOrdersToPlace; i++) {
            const percent = tpPercentages[i];
            const tpPrice = holdSide === 'long'
                ? (openPriceAvg * percent).toFixed(2)
                : (openPriceAvg * (1 - (percent - 1))).toFixed(2);

            const tpSize = (tpAmount / tpOrdersToPlace).toFixed(6);

            const tpPayload = {
                planType: 'normal_plan',
                symbol,
                productType: 'SUSDT-FUTURES',
                marginMode: "isolated",
                marginCoin: 'SUSDT',
                size: tpSize.toString(),
                price: tpPrice.toString(),
                triggerPrice: tpPrice.toString(),
                triggerType: 'mark_price',
                side: holdSide === 'long' ? 'sell' : 'buy', // Opposite side to close the position
                tradeSide: 'close',
                orderType: 'limit',
                clientOid: `${Date.now()}_${i}`,
                reduceOnly: 'YES',
            };

            try {
                console.log(`Submitting TP Order #${i + 1}:`, JSON.stringify(tpPayload, null, 2));
                const tpResponse = await restClientV2.futuresSubmitPlanOrder(tpPayload);

                if (tpResponse?.code === '00000') {
                    console.log(`TP Order #${i + 1} placed successfully:`, tpResponse.data);
                } else {
                    console.error(`Failed to place TP Order #${i + 1}:`, tpResponse?.msg);
                }
            } catch (error) {
                console.error(`Exception while placing TP Order #${i + 1}:`, error.message);
            }
        }

        console.log(`TP order placement completed.`);
    } catch (error) {
        console.error(`Exception in calculateTPOrders:`, error.message);
    }
};

setInterval(async () => {
    try {
        await calculateTPOrders("SBTCSUSDT");
    } catch (error) {
        console.error(`Error during TP monitoring: ${error.message}`);
    }
}, 5 * 60 * 1000);
