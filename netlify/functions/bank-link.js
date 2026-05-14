// bank-link.js
// Creates a Nordigen bank authorization URL for Rabobank or Bunq
// Called from bank-koppeling.html: GET /.netlify/functions/bank-link?bank=rabobank
// Returns: { link: "https://...", requisition_id: "..." }

const NORDIGEN_BASE = "https://bankaccountdata.gocardless.com/api/v2";

// Nordigen institution IDs
const BANK_IDS = {
  rabobank: "RABOBANK_RABONL2U",
  bunq:     "BUNQ_BUNQNL2A"
};

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

  const bank = (event.queryStringParameters?.bank || "").toLowerCase();
  const institutionId = BANK_IDS[bank];

  if (!institutionId) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Onbekende bank: " + bank + ". Gebruik 'rabobank' of 'bunq'." })
    };
  }

  try {
    const token = await getNordigenToken();
    const host = event.headers.host || "localhost";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const redirectUrl = proto + "://" + host + "/bank-koppeling.html?callback=1&bank=" + bank;

    const reqRes = await fetch(NORDIGEN_BASE + "/requisitions/", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        redirect:       redirectUrl,
        institution_id: institutionId,
        reference:      "sandra_" + bank + "_" + Date.now(),
        agreement:      "",
        user_language:  "NL"
      })
    });

    if (!reqRes.ok) {
      const err = await reqRes.text();
      throw new Error("Requisition error " + reqRes.status + ": " + err);
    }

    const req = await reqRes.json();

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        link:           req.link,
        requisition_id: req.id
      })
    };

  } catch (e) {
    console.error("bank-link error:", e.message);
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
