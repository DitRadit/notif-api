import admin from "firebase-admin";

// Initialize Firebase Admin
function initFirebase() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
}

export default async (req, res) => {
  try {
    // API Key Security
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    initFirebase();
    const db = admin.database().ref();

    const now = Date.now();
    const timeoutMs = Number(process.env.ESCALATION_TIMEOUT_MS || 2 * 60 * 1000);

    // Fetch pending emergencies
    const snap = await db.child("emergencies")
      .orderByChild("status")
      .equalTo("pending")
      .once("value");

    const emergencies = snap.val() || {};

    const toProcess = [];

    for (const [id, data] of Object.entries(emergencies)) {
      const createdAt = new Date(data.createdAt).getTime();
      const lastSent = data.lastSentAt
        ? new Date(data.lastSentAt).getTime()
        : createdAt;

      if (now - lastSent >= timeoutMs) {
        toProcess.push({ id, data });
      }
    }

    const results = [];

    for (const item of toProcess) {
      const { id, data } = item;
      const currentIndex = data.currentPriorityIndex || 0;
      const nextIndex = currentIndex + 1;

      // If no more priorities left
      if (nextIndex >= data.priorities.length) {
        await db.child(`emergencies/${id}/status`).set("all_tried");
        results.push({ id, result: "all_tried" });
        continue;
      }

      const nextPriority = data.priorities[nextIndex];
      let tokens = [];

      if (typeof nextPriority === "string") tokens = [nextPriority];
      else if (nextPriority.fcmToken) tokens = [nextPriority.fcmToken];
      else if (Array.isArray(nextPriority.tokens)) tokens = nextPriority.tokens;

      if (!tokens.length) {
        await db.child(`emergencies/${id}`).update({
          currentPriorityIndex: nextIndex,
          lastSentAt: new Date().toISOString()
        });

        results.push({ id, result: "no_token_skip" });
        continue;
      }

      const message = {
        notification: {
          title: `Emergency Escalation: ${data.type}`,
          body: `${data.need}${data.condition ? " — " + data.condition : ""}`
        },
        data: {
          emergencyId: id,
          mapsUrl: data.mapsUrl || ""
        }
      };

      try {
        if (tokens.length === 1) {
          await admin.messaging().sendToDevice(tokens[0], message);
        } else {
          await admin.messaging().sendMulticast({ tokens, ...message });
        }

        await db.child(`emergencies/${id}`).update({
          currentPriorityIndex: nextIndex,
          lastSentAt: new Date().toISOString()
        });

        results.push({ id, result: "sent", nextIndex });

      } catch (err) {
        results.push({
          id,
          result: "failed",
          error: err.message
        });
      }
    }

    return res.status(200).json({
      ok: true,
      processed: results.length,
      details: results
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || err.toString()
    });
  }
};
