import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

app.post("/", async (req, res) => {
  try {
    const { token, title, body } = req.body;

    const message = {
      token: token,
      notification: { title, body }
    };

    const response = await admin.messaging().send(message);

    return res.json({ success: true, response });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default app;
