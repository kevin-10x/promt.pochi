require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  BUSINESS_SHORT_CODE,
  PASSKEY,
  TRANSACTION_TYPE,
  DARAJA_ENV,
  CALLBACK_URL,
  PORT,
} = process.env;

const BASE_URL =
  DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// In-memory store of pending transactions, keyed by CheckoutRequestID.
// Swap this for a real database in production.
const transactions = new Map();

/**
 * Formats a Kenyan phone number to the 2547XXXXXXXX / 2541XXXXXXXX format
 * that Daraja requires. Accepts 07..., 01..., +254..., 254... inputs.
 */
function formatPhoneNumber(rawNumber) {
  let n = String(rawNumber).trim().replace(/\s+/g, '').replace(/^\+/, '');
  if (n.startsWith('0')) {
    n = '254' + n.slice(1);
  } else if (n.startsWith('7') || n.startsWith('1')) {
    n = '254' + n;
  }
  if (!/^254(7|1)\d{8}$/.test(n)) {
    throw new Error('Invalid Kenyan phone number format');
  }
  return n;
}

function getTimestamp() {
  const d = new Date();
  const pad = (num) => String(num).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function getAccessToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

// --- Route: serve the simple form (public/index.html) ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Route: initiate STK push ---
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phoneNumber, amount, accountReference, transactionDesc } = req.body;

    if (!phoneNumber || !amount) {
      return res.status(400).json({ error: 'phoneNumber and amount are required' });
    }

    const formattedPhone = formatPhoneNumber(phoneNumber);
    const amountInt = Math.round(Number(amount));
    if (!amountInt || amountInt <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const timestamp = getTimestamp();
    const password = Buffer.from(
      `${BUSINESS_SHORT_CODE}${PASSKEY}${timestamp}`
    ).toString('base64');

    const accessToken = await getAccessToken();

    const payload = {
      BusinessShortCode: BUSINESS_SHORT_CODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: TRANSACTION_TYPE, // CustomerBuyGoodsOnline (Till) or CustomerPayBillOnline
      Amount: amountInt,
      PartyA: formattedPhone,       // customer's number - who is being charged
      PartyB: BUSINESS_SHORT_CODE,  // your till/paybill - who receives the money
      PhoneNumber: formattedPhone,  // number that receives the STK push prompt
      CallBackURL: CALLBACK_URL,
      AccountReference: (accountReference || 'Payment').slice(0, 12),
      TransactionDesc: (transactionDesc || 'Payment').slice(0, 13),
    };

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Track the transaction so the callback can update its status,
    // and so the frontend can poll for the result.
    transactions.set(data.CheckoutRequestID, {
      status: 'pending',
      phoneNumber: formattedPhone,
      amount: amountInt,
      createdAt: new Date().toISOString(),
      merchantRequestId: data.MerchantRequestID,
    });

    res.json({
      message: 'STK push sent. Ask the customer to check their phone and enter their M-Pesa PIN.',
      checkoutRequestId: data.CheckoutRequestID,
    });
  } catch (err) {
    console.error('STK push error:', err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.errorMessage || err.message || 'Failed to initiate STK push',
    });
  }
});

// --- Route: Safaricom posts the payment result here ---
app.post('/api/mpesa/callback', (req, res) => {
  const callback = req.body?.Body?.stkCallback;
  if (!callback) {
    return res.status(400).json({ error: 'Malformed callback payload' });
  }

  const { CheckoutRequestID, ResultCode, ResultDesc } = callback;
  const existing = transactions.get(CheckoutRequestID) || {};

  if (ResultCode === 0) {
    const items = callback.CallbackMetadata?.Item || [];
    const get = (name) => items.find((i) => i.Name === name)?.Value;

    transactions.set(CheckoutRequestID, {
      ...existing,
      status: 'success',
      mpesaReceiptNumber: get('MpesaReceiptNumber'),
      amountPaid: get('Amount'),
      payerPhone: get('PhoneNumber'),
      completedAt: new Date().toISOString(),
    });
    console.log(`Payment received: ${get('MpesaReceiptNumber')} - KES ${get('Amount')}`);
  } else {
    // Common non-zero codes: 1032 = cancelled by user, 1037 = timeout, 1 = insufficient funds
    transactions.set(CheckoutRequestID, {
      ...existing,
      status: 'failed',
      resultCode: ResultCode,
      resultDesc: ResultDesc,
    });
    console.log(`Payment failed for ${CheckoutRequestID}: ${ResultDesc}`);
  }

  // Safaricom just needs a 200 acknowledging receipt of the callback.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// --- Route: frontend polls this to check if payment completed ---
app.get('/api/mpesa/status/:checkoutRequestId', (req, res) => {
  const tx = transactions.get(req.params.checkoutRequestId);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  res.json(tx);
});

app.listen(PORT || 3000, () => {
  console.log(`Server running on port ${PORT || 3000} (${DARAJA_ENV} mode)`);
});
