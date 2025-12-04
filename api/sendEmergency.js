import admin from "firebase-admin";

function initFirebase() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
}

export default async function handler(req, res) {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    initFirebase();
    const db = admin.database().ref();

    let payload = req.body;
    if (typeof payload === "string") payload = JSON.parse(payload);

    const { type, condition, need, location, priorities } = payload;

    if (!type || !need || !Array.isArray(priorities) || priorities.length === 0) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const nowIso = new Date().toISOString();

    const emergencyRef = db.child("emergencies").push();
    const emergencyData = {
      senderUid: payload.senderUid || "unknown",
      type,
      condition: condition || "",
      need,
      location: location || {},
      mapsUrl: (location && location.mapsUrl) || "",
      priorities,
      currentPriorityIndex: 0,
      status: "pending",
      createdAt: nowIso,
      lastSentAt: nowIso
    };

    await emergencyRef.set(emergencyData);

    const emergencyId = emergencyRef.key;

    const firstPriority = priorities[0];
    let tokens = [];

    if (typeof firstPriority === "string") tokens = [firstPriority];
    else if (firstPriority.fcmToken) tokens = [firstPriority.fcmToken];
    else if (Array.isArray(firstPriority.tokens)) tokens = firstPriority.tokens;

    const message = {
      notification: {
        title: `Emergency: ${type}`,
        body: `${need}${condition ? " — " + condition : ""}`
      },
      data: {
        emergencyId,
        mapsUrl: emergencyData.mapsUrl
      }
    };

    if (tokens.length === 1) {
      await admin.messaging().sendToDevice(tokens[0], message);
    } else if (tokens.length > 1) {
      await admin.messaging().sendMulticast({ tokens, ...message });
    }

    return res.status(200).json({ ok: true, emergencyId });
  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
}
