const express = require('express');
const { WebsocketClientV2, RestClientV2 } = require('bitget-api');
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

// Get open positions for a specific product type and margin coin
async function getAllPositions(productType, marginCoin) {
  try {
    console.log(`Requesting all positions for productType: ${productType}, marginCoin: ${marginCoin}`);
    
    const positionResult = await restClientV2.getFuturesPositions(productType, marginCoin);
    
    if (!positionResult || positionResult.code !== 200) {
      console.error('No position data returned from API:', positionResult.msg);
      return [];
    }
    
    console.log('All Positions API Response:', positionResult);
    
    const positions = positionResult.data;
    console.log('Open positions:', positions.length > 0 ? positions : 'None');
    
    return positions;
  } catch (e) {
    handleError(e, 'fetching all positions');
    return [];
  }
}

// Get open orders for a specific symbol and product type
async function getOpenOrders(symbol, productType) {
  try {
    console.log(`Requesting open orders for symbol: ${symbol}, productType: ${productType}`);

    const openOrdersResult = await restClientV2.getFuturesOpenOrders(symbol, productType);
    
    if (!openOrdersResult || openOrdersResult.code !== 200) {
      console.error('No open order data returned from API:', openOrdersResult.msg);
      return [];
    }
    
    console.log('Open Orders API Response:', openOrdersResult);

    const openOrders = openOrdersResult.data;
    console.log('Open orders:', openOrders.length > 0 ? openOrders : 'None');
    
    return openOrders;
  } catch (e) {
    handleError(e, 'fetching open orders');
    return [];
  }
}

// Centralized error handling function
function handleError(error, context) {
  console.error(`Error ${context}:`);
  if (error.response) {
    console.error('Response Data:', error.response.data);
    console.error('Response Status:', error.response.status);
    if (error.response.data.msg) {
      console.error('Error Message:', error.response.data.msg);
    }
  } else {
    console.error('Error Message:', error.message);
  }
}

// Startup check to retrieve initial orders and positions
async function startupCheck() {
  try {
    const productType = 'USDT-FUTURES'; // Confirm this is correct for your account
    const marginCoin = 'USDT';
    const symbol = 'BTCUSDT'; // Adjust symbol if needed

    console.log(`Starting startup check with productType: ${productType}, marginCoin: ${marginCoin}, symbol: ${symbol}`);

    const positions = await getAllPositions(productType, marginCoin);
    const openOrders = await getOpenOrders(symbol, productType);

    if (positions.length === 0 && openOrders.length === 0) {
      console.log('No open positions or orders.');
    }
    console.log('Startup Check Complete.');
  } catch (e) {
    console.error(`Startup check failed:`, e.message);
  }
}

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`Server is running on port ${port}`);
  try {
    await startupCheck();
  } catch (e) {
    console.error('Error during startup check:', e.message);
  }
});
