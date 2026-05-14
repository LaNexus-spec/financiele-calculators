// bank-callback.js
// After the user authorizes their bank in Nordigen, this function is called
// with the requisition ID. It fetches the account IDs and saves them.
// Called from bank-koppeling.html: GET /.netlify/functions/bank-callback?ref={requisitionId}&bank={bank}

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
  if (!res.ok) {
    const err = await res.text();
    throw new Error("Nordigen token error " + res.status + ": " + err);
  }
  const data = await res.json();
  return data.access;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const { ref: requisitionId, bank } = event.queryStringParameters || {};

  if (!requisitionId || !bank) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Ontbrekende parameters: ref en bank zijn verplicht." })
    };
  }

  try {
    const token = await getNordigenToken();

    const reqRes = await fetch(NORDIGEN_BASE + "/requisitions/" + requisitionId + "/", {
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/json"
      }
    });

    if (!reqRes.ok) {
      const err = await reqRes.text();
      throw new Error("Requisition fetch error " + reqRes.status + ": " + err);
    }

    const req = await reqRes.json();

    if (!req.accounts || req.accounts.length === 0) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({
          success: false,
          message: "Geen rekeningen gevonden. Mogelijk nog niet geautoriseerd."
        })
      };
    }

    const store = getStore("bank-accounts");
    const existing = JSON.parse(await store.get("sandra") || "{}");
    existing[bank] = {
      requisition_id: requisitionId,
      accounts:       req.accounts,
      linked_at:      new Date().toISOString()
    };
    await store.set("sandra", JSON.stringify(existing));

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success:        true,
        bank:           bank,
        accounts_found: req.accounts.length,
        message:        req.accounts.length + " rekening(en) gekoppeld voor " + bank + "."
      })
    };

  } catch (e) {
    console.error("bank-callback error:", e.message);
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
