// transactions.js
// Fetches transactions from all linked bank accounts (Rabobank + Bunq)
// Called from the calculator: GET /.netlify/functions/transactions?days=30
// Returns: { transactions: [...], linked_banks: [...] }

import { getStore } from "@netlify/blobs";

const NORDIGEN_BASE = "https://bankaccountdata.gocardless.com/api/v2";

async function getNordigenToken() {
  const res = await fetch(NORDIGEN_BASE + "/token/new/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      secret_id:  process.env.NORDIGEN_SECRET_ID,
      secret_key: process.env.NORDIGEN_SECRET_KEY
    })
  });
  if (!res.ok) throw new Error("Nordigen token error " + res.status);
  const data = await res.json();
  return data.access;
}

async function getTransactionsForAccount(token, accountId, dateFrom) {
  const url = NORDIGEN_BASE + "/accounts/" + accountId + "/transactions/?date_from=" + dateFrom;
  const res = await fetch(url, {
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/json"
    }
  });
  if (!res.ok) {
    console.warn("Transaction fetch failed for account " + accountId + ": " + res.status);
    return [];
  }
  const data = await res.json();
  const booked = (data.transactions && data.transactions.booked) || [];
  return booked.map(t => ({
    date:        t.bookingDate || t.valueDate || "",
    amount:      parseFloat((t.transactionAmount && t.transactionAmount.amount) || 0),
    currency:    (t.transactionAmount && t.transactionAmount.currency) || "EUR",
    description: t.remittanceInformationUnstructured
                 || t.remittanceInformationStructured
                 || t.creditorName
                 || t.debtorName
                 || "",
    creditor:    t.creditorName || "",
    debtor:      t.debtorName || "",
    account_id:  accountId
  }));
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const days = parseInt((event.queryStringParameters && event.queryStringParameters.days) || "30", 10);

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  const dateFromStr = dateFrom.toISOString().split("T")[0];

  try {
    const store = getStore("bank-accounts");
    const raw = await store.get("sandra");
    if (!raw) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({
          transactions:  [],
          linked_banks:  [],
          message:       "Geen bankrekeningen gekoppeld. Ga naar bank-koppeling.html om je bank te koppelen."
        })
      };
    }

    const bankData = JSON.parse(raw);
    const linkedBanks = Object.keys(bankData);

    if (linkedBanks.length === 0) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ transactions: [], linked_banks: [], message: "Geen banken gekoppeld." })
      };
    }

    const token = await getNordigenToken();
    let allTransactions = [];

    for (const bank of linkedBanks) {
      const info = bankData[bank];
      const accounts = info.accounts || [];

      for (const accountId of accounts) {
        const txs = await getTransactionsForAccount(token, accountId, dateFromStr);
        txs.forEach(t => { t.bank = bank; });
        allTransactions = allTransactions.concat(txs);
      }
    }

    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    allTransactions = allTransactions.slice(0, 200);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        transactions: allTransactions,
        linked_banks: linkedBanks,
        date_from:    dateFromStr,
        count:        allTransactions.length
      })
    };

  } catch (e) {
    console.error("transactions error:", e.message);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: e.message })
    };
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}
