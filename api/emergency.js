import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

// -------------------------------------------------------
// INIT FIREBASE (SAFE FOR VERCEL)
// -------------------------------------------------------
function initFirebase() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
}

// -------------------------------------------------------
// MIDDLEWARE API KEY
// -------------------------------------------------------
function checkApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// -------------------------------------------------------
// Helper: Extract token(s) dari satu entry priority
// -------------------------------------------------------
function extractTokens(item) {
  if (!item) return [];

  if (typeof item === "string") return [item];
  if (item.token) return [item.token];
  if (Array.isArray(item.tokens)) return item.tokens;

  return [];
}

// -------------------------------------------------------
// ROUTE 1: CREATE EMERGENCY
// POST /api/emergency
// -------------------------------------------------------
app.post("/api/emergency", checkApiKey, async (req, res) => {
  try {
    initFirebase();
    const db = admin.database().ref();

    let payload = req.body;
    if (typeof payload === "string") payload = JSON.parse(payload);

    const { senderUid, type, condition, need, location, priorities } = payload;

    if (!type || !need || !Array.isArray(priorities) || priorities.length === 0) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const nowIso = new Date().toISOString();

    const emergencyRef = db.child("emergencies").push();
    const emergencyData = {
      senderUid: senderUid || "unknown",
      type,
      condition: condition || "",
      need,
      location: location || {},
      mapsUrl: location?.mapsUrl || "",
      priorities,
      currentPriorityIndex: 0,
      status: "pending",
      createdAt: nowIso,
      lastSentAt: nowIso
    };

    await emergencyRef.set(emergencyData);
    const emergencyId = emergencyRef.key;

    // ---------------------------------------------------
    // Send notification to first priority
    // ---------------------------------------------------
    const firstPriority = priorities[0];
    const tokens = extractTokens(firstPriority);

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
      await admin.messaging().sendMulticast({
        tokens,
        notification: message.notification,
        data: message.data
      });
    }

    return res.json({ ok: true, emergencyId });

  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------
// ROUTE 2: DIRECT NOTIFICATION
// POST /api/sendEmergency
// -------------------------------------------------------
app.post("/api/sendEmergency", checkApiKey, async (req, res) => {
  try {
    initFirebase();

    const { token, title, body } = req.body;

    const msg = {
      token,
      notification: { title, body }
    };

    const result = await admin.messaging().send(msg);
    return res.json({ ok: true, result });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// -------------------------------------------------------
// ROUTE 3: ESCALATION PROCESSING (CRON EACH 2 MINUTES)
// POST /api/escalatedPending
// -------------------------------------------------------
app.post("/api/escalatedPending", checkApiKey, async (req, res) => {
  try {
    initFirebase();
    const db = admin.database().ref();

    const now = Date.now();
    const timeoutMs = Number(process.env.ESCALATION_TIMEOUT_MS || 2 * 60 * 1000);

    const snap = await db.child("emergencies")
      .orderByChild("status")
      .equalTo("pending")
      .once("value");

    const emergencies = snap.val() || {};
    const toProcess = [];

    // ----------------------------------------------------
    // Ambil emergency yang waktunya escalation
    // ----------------------------------------------------
    for (const [id, data] of Object.entries(emergencies)) {
      if (!data) continue;

      // Skip: emergency sudah dijawab
      if (data.status !== "pending") continue;

      const createdAt = new Date(data.createdAt).getTime();
      const lastSent = data.lastSentAt ? new Date(data.lastSentAt).getTime() : createdAt;

      if (now - lastSent >= timeoutMs) {
        toProcess.push({ id, data });
      }
    }

    const results = [];

    // ----------------------------------------------------
    // Process escalation
    // ----------------------------------------------------
    for (const item of toProcess) {
      const { id, data } = item;

      const currentIndex = data.currentPriorityIndex || 0;
      const nextIndex = currentIndex + 1;

      // Jika tidak ada lagi prioritas
      if (nextIndex >= data.priorities.length) {
        await db.child(`emergencies/${id}/status`).set("all_tried");
        results.push({ id, result: "all_tried" });
        continue;
      }

      const nextPriority = data.priorities[nextIndex];
      const tokens = extractTokens(nextPriority);

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
        } else if (tokens.length > 1) {
          await admin.messaging().sendMulticast({
            tokens,
            notification: message.notification,
            data: message.data
          });
        }

        // Update index + timestamp
        await db.child(`emergencies/${id}`).update({
          currentPriorityIndex: nextIndex,
          lastSentAt: new Date().toISOString()
        });

        results.push({ id, result: "sent", nextIndex });

      } catch (err) {
        results.push({ id, result: "failed", error: err.message });
      }
    }

    return res.json({
      ok: true,
      processed: results.length,
      details: results
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------
// EXPORT HANDLER (VERCEL)
// -------------------------------------------------------
export default app;
