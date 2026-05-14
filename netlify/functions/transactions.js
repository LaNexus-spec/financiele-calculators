// transactions.js
// Haalt transacties op van gekoppelde bankrekeningen (Rabobank via Nordigen, Bunq direct).
// GET /.netlify/functions/transactions?days=30

import { getStore } from "@netlify/blobs";
import { createSign } from "crypto";

const NORDIGEN_BASE = "https://bankaccountdata.gocardless.com/api/v2";
const BUNQ_API      = "https://api.bunq.com";

// ── Nordigen/GoCardless helpers ──────────────────────────────────────────────

async function getNordigenToken() {
  const res = await fetch(`${NORDIGEN_BASE}/token/new/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      secret_id:  process.env.NORDIGEN_SECRET_ID,
      secret_key: process.env.NORDIGEN_SECRET_KEY
    })
  });
  if (!res.ok) throw new Error(`Nordigen token fout ${res.status}`);
  return (await res.json()).access;
}

async function getNordigenTransactions(token, accountId, dateFrom) {
  const url = `${NORDIGEN_BASE}/accounts/${accountId}/transactions/?date_from=${dateFrom}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" }
  });
  if (!res.ok) {
    console.warn(`Nordigen transacties mislukt voor ${accountId}: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return (data.transactions?.booked || []).map(t => ({
    date:        t.bookingDate || t.valueDate || "",
    amount:      parseFloat(t.transactionAmount?.amount || 0),
    currency:    t.transactionAmount?.currency || "EUR",
    description: t.remittanceInformationUnstructured
                 || t.remittanceInformationStructured
                 || t.creditorName || t.debtorName || "",
    creditor:    t.creditorName  || "",
    debtor:      t.debtorName    || "",
    account_id:  accountId
  }));
}

// ── Bunq direct helpers ──────────────────────────────────────────────────────

function bunqSign(privateKeyPem, data) {
  const s = createSign("SHA256");
  s.update(data || "");
  return s.sign(privateKeyPem, "base64");
}

async function bunqReq(method, path, body, authToken, privateKeyPem) {
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "User-Agent":    "FinancieleCalculator/1.0",
    "X-Bunq-Language":   "nl_NL",
    "X-Bunq-Region":     "nl_NL",
    "X-Bunq-Geolocation":"0 0 0 0 000",
    "X-Bunq-Client-Authentication": authToken,
    "X-Bunq-Client-Signature":      bunqSign(privateKeyPem, bodyStr)
  };
  const res = await fetch(`${BUNQ_API}${path}`, {
    method,
    headers,
    body: bodyStr || undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bunq ${method} ${path} fout ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function getBunqTransactions(bunqData, dateFrom) {
  const { installation_token, private_key, user_id } = bunqData;

  // Nieuwe sessie aanmaken
  const apiKey = process.env.BUNQ_API_KEY;
  if (!apiKey || apiKey === "VEREIST_INVULLEN") {
    console.warn("BUNQ_API_KEY niet ingesteld, Bunq transacties overgeslagen.");
    return [];
  }

  const sessionRes = await bunqReq("POST", "/v1/session-server",
    { secret: apiKey }, installation_token, private_key);
  const sessionToken = sessionRes.Response?.find(r => r.Token)?.Token?.token;
  if (!sessionToken) throw new Error("Geen Bunq sessie token ontvangen.");

  // Rekeningen ophalen
  const accountsRes = await bunqReq("GET",
    `/v1/user/${user_id}/monetary-account`, null, sessionToken, private_key);

  const txs = [];
  for (const r of (accountsRes.Response || [])) {
    const acct = r.MonetaryAccountBank || r.MonetaryAccountSavings;
    if (!acct || acct.status !== "ACTIVE") continue;

    // Betalingen ophalen (max 200 per rekening)
    let olderUrl = `/v1/user/${user_id}/monetary-account/${acct.id}/payment?count=50`;
    let hasMore  = true;

    while (hasMore) {
      const pmtRes = await bunqReq("GET", olderUrl, null, sessionToken, private_key);
      hasMore = false;

      for (const p of (pmtRes.Response || [])) {
        const pmt = p.Payment;
        if (!pmt) continue;
        const date = (pmt.created || "").split("T")[0];
        if (date < dateFrom) { hasMore = false; break; }

        const rawAmount = parseFloat(pmt.amount?.value || 0);
        txs.push({
          date,
          amount:      rawAmount,   // negatief = uitgave, positief = inkomst
          currency:    pmt.amount?.currency || "EUR",
          description: pmt.description || "",
          creditor:    rawAmount < 0 ? (pmt.counterparty_alias?.display_name || "") : "",
          debtor:      rawAmount > 0 ? (pmt.counterparty_alias?.display_name || "") : "",
          account_id:  String(acct.id),
          bank:        "bunq"
        });
      }

      // Paginering via Pagination header
      const pagination = pmtRes.Pagination;
      if (pagination?.future_url) {
        olderUrl = pagination.older_url || "";
        hasMore  = !!olderUrl;
      }
    }
  }
  return txs;
}

// ── Hoofdfunctie ─────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const days     = parseInt(event.queryStringParameters?.days || "30", 10);
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  const dateFromStr = dateFrom.toISOString().split("T")[0];

  try {
    const store = getStore("bank-accounts");
    const raw   = await store.get("sandra");

    if (!raw) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({
          transactions: [],
          linked_banks: [],
          message: "Geen bankrekeningen gekoppeld. Ga naar bank-koppeling.html."
        })
      };
    }

    const bankData    = JSON.parse(raw);
    const linkedBanks = Object.keys(bankData);
    let allTxs        = [];

    // Bunq direct
    if (bankData.bunq?.type === "direct") {
      try {
        const bunqTxs = await getBunqTransactions(bankData.bunq, dateFromStr);
        allTxs = allTxs.concat(bunqTxs);
      } catch (e) {
        console.error("Bunq direct fout:", e.message);
      }
    }

    // Nordigen banken (Rabobank en evt. andere)
    const nordigenBanks = linkedBanks.filter(
      b => b !== "bunq" || bankData[b]?.type !== "direct"
    );

    if (nordigenBanks.length > 0) {
      const nordigenId  = process.env.NORDIGEN_SECRET_ID;
      const nordigenKey = process.env.NORDIGEN_SECRET_KEY;

      if (nordigenId && nordigenKey &&
          nordigenId !== "VEREIST_INVULLEN" &&
          nordigenKey !== "VEREIST_INVULLEN") {
        try {
          const token = await getNordigenToken();
          for (const bank of nordigenBanks) {
            for (const accountId of (bankData[bank]?.accounts || [])) {
              const txs = await getNordigenTransactions(token, accountId, dateFromStr);
              txs.forEach(t => { t.bank = bank; });
              allTxs = allTxs.concat(txs);
            }
          }
        } catch (e) {
          console.error("Nordigen fout:", e.message);
        }
      }
    }

    allTxs.sort((a, b) => new Date(b.date) - new Date(a.date));
    allTxs = allTxs.slice(0, 200);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        transactions: allTxs,
        linked_banks: linkedBanks,
        date_from:    dateFromStr,
        count:        allTxs.length
      })
    };

  } catch (e) {
    console.error("transactions fout:", e.message);
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
