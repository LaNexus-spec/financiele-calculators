// bunq-install.js
// Eerste keer Bunq koppelen via directe Bunq API (geen PSD2 tussenpersoon).
// Vereist: BUNQ_API_KEY omgevingsvariabele (wildcard API-sleutel uit de Bunq-app).
// GET /.netlify/functions/bunq-install

import { getStore } from "@netlify/blobs";
import { generateKeyPairSync, createSign } from "crypto";

const BUNQ_API = "https://api.bunq.com";

function sign(privateKeyPem, data) {
  const s = createSign("SHA256");
  s.update(data || "");
  return s.sign(privateKeyPem, "base64");
}

async function bunqRequest(method, path, body, authToken, privateKeyPem) {
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "User-Agent": "FinancieleCalculator/1.0",
    "X-Bunq-Language": "nl_NL",
    "X-Bunq-Region": "nl_NL",
    "X-Bunq-Geolocation": "0 0 0 0 000",
  };
  if (authToken) {
    headers["X-Bunq-Client-Authentication"] = authToken;
    headers["X-Bunq-Client-Signature"] = sign(privateKeyPem, bodyStr);
  }
  const res = await fetch(`${BUNQ_API}${path}`, {
    method,
    headers,
    body: bodyStr || undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bunq ${method} ${path} fout ${res.status}: ${text}`);
  return JSON.parse(text);
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  const apiKey = process.env.BUNQ_API_KEY;
  if (!apiKey || apiKey === "VEREIST_INVULLEN") {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({
        error: "BUNQ_API_KEY is niet ingesteld. Voeg je Bunq API-sleutel toe als omgevingsvariabele in Netlify en herstart de deploy."
      })
    };
  }

  try {
    // Stap 1: RSA sleutelpaar genereren
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding:  { type: "spki",  format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });

    // Stap 2: Installatie aanmaken (geen auth nodig)
    const installRes = await bunqRequest("POST", "/v1/installation", {
      client_public_key: publicKey
    }, null, null);

    const installToken = installRes.Response?.find(r => r.Token)?.Token?.token;
    if (!installToken) throw new Error("Geen installation token ontvangen van Bunq.");

    // Stap 3: Apparaat registreren
    await bunqRequest("POST", "/v1/device-server", {
      description: "Financiele Calculator",
      secret: apiKey,
      permitted_ips: ["*"]
    }, installToken, privateKey);

    // Stap 4: Sessie aanmaken om gebruikers-ID op te halen
    const sessionRes = await bunqRequest("POST", "/v1/session-server", {
      secret: apiKey
    }, installToken, privateKey);

    const sessionToken = sessionRes.Response?.find(r => r.Token)?.Token?.token;
    const userObj = sessionRes.Response?.find(r => r.UserPerson || r.UserCompany || r.UserApiKey);
    const userId =
      userObj?.UserPerson?.id ||
      userObj?.UserCompany?.id ||
      userObj?.UserApiKey?.id;

    if (!userId) throw new Error("Kon gebruikers-ID niet ophalen uit Bunq sessie.");

    // Rekeningen ophalen
    const accountsRes = await bunqRequest(
      "GET", `/v1/user/${userId}/monetary-account`,
      null, sessionToken, privateKey
    );
    const accountIds = (accountsRes.Response || [])
      .map(r => r.MonetaryAccountBank || r.MonetaryAccountSavings)
      .filter(a => a && a.status === "ACTIVE")
      .map(a => a.id);

    // Opslaan in Netlify Blobs
    const store = getStore("bank-accounts");
    const existing = JSON.parse(await store.get("sandra") || "{}");
    existing.bunq = {
      type:              "direct",
      installation_token: installToken,
      private_key:        privateKey,
      user_id:            userId,
      accounts:           accountIds,
      linked_at:          new Date().toISOString()
    };
    await store.set("sandra", JSON.stringify(existing));

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        success: true,
        accounts_found: accountIds.length,
        message: `Bunq gekoppeld! ${accountIds.length} rekening(en) gevonden.`
      })
    };

  } catch (e) {
    console.error("bunq-install fout:", e.message);
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: e.message })
    };
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}
